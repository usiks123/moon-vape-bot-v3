-- =============================================================================
-- MoonVape · миграция 0003 · города, роли, склад по городам, новый каталог
-- Запускать ПОСЛЕ 0002_enums.sql. Один Run в SQL Editor.
-- Перед запуском: резервная копия БД. Миграция ничего не удаляет:
--   старые товары архивируются (active=false), старые заказы и история остаются.
-- Повторный запуск блокируется (schema_migrations).
-- =============================================================================

do $$ begin
  if exists(select 1 from schema_migrations where version='0003') then raise exception 'migration 0003 already applied'; end if;
  if not exists(select 1 from schema_migrations where version='0002') then raise exception 'run 0002_enums.sql first'; end if;
end $$;

-- ----------------------------------------------------------------- Города
create table cities(
  id text primary key,
  name text not null,
  sort int not null default 0,
  active boolean not null default true,
  manager_contact text,            -- например '@manager_hannover' — заполняется владельцем
  manager_link text                -- например 'https://t.me/manager_hannover' — заполняется владельцем
);
insert into cities(id,name,sort) values ('muenchen','München',1),('hannover','Hannover',2);

-- ----------------------------------------------------------------- Роли
-- owner: все города. city_admin: только свой город. Покупатель — всё, что не в admins.
create table admins(
  telegram_id bigint primary key,
  role text not null check(role in ('owner','city_admin')),
  city_id text references cities(id),
  username text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check((role='owner' and city_id is null) or (role='city_admin' and city_id is not null))
);
-- Владелец: ID из текущей конфигурации (OWNER_TELEGRAM_ID в backend/render.yaml).
-- Администратор Hannover: ID из ТЗ.
insert into admins(telegram_id,role,city_id) values (7858672760,'owner',null),(7050120446,'city_admin','hannover');

-- ----------------------------------------------------------------- Пользователи
alter table users add column if not exists city_id text references cities(id);
alter table users add column if not exists bot_started_at timestamptz;
alter table users add column if not exists bot_blocked boolean not null default false;
alter table users add column if not exists notify_stock boolean not null default true;

-- ----------------------------------------------------------------- Товары
-- Цена может быть не заполнена: такой товар не показывается покупателю и не продаётся.
alter table products alter column price drop not null;
alter table products add column if not exists catalog_key text unique;

-- ----------------------------------------------------------------- Склад по городам
alter table inventory add column if not exists city_id text references cities(id);
-- Старый склад не привязан к городу. Он принадлежит архивируемому ассортименту, поэтому
-- назначаем München технически (чтобы поставить NOT NULL) и сразу обнуляем доступный остаток.
update inventory set city_id='muenchen' where city_id is null;

alter table inventory_transactions add column if not exists city_id text references cities(id);
alter table inventory_transactions add column if not exists actor bigint;
alter table inventory_transactions add column if not exists reason text;
alter table inventory_transactions add column if not exists qty_before int;
alter table inventory_transactions add column if not exists qty_after int;

-- Журнал обнуления старого остатка (до изменения quantity).
insert into inventory_transactions(inventory_id,op,quantity,qty_before,qty_after,city_id,reason)
select id,'adjust'::inv_op,quantity-reserved_quantity,quantity,reserved_quantity,city_id,
       'Замена каталога (0003): старый остаток обнулён, зарезервированное сохранено'
from inventory where quantity<>reserved_quantity;
update inventory set quantity=reserved_quantity where quantity<>reserved_quantity;

-- Старое ограничение уникальности не учитывает город. Заменяем его.
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.inventory'::regclass and contype='u' loop
    execute format('alter table inventory drop constraint %I', c.conname);
  end loop;
end $$;
alter table inventory alter column city_id set not null;
create unique index inventory_slot_uq on inventory(product_id, variant_id, flavor_id, city_id) nulls not distinct;
create index inventory_city_idx on inventory(city_id);

-- ----------------------------------------------------------------- Заказы
alter table orders add column if not exists city_id text references cities(id);
alter table orders alter column address drop not null;
alter table orders alter column address set default '';
alter table orders alter column delivery_service drop not null;
alter table orders alter column delivery_service set default '';
alter table orders add column if not exists paid_at timestamptz;
alter table orders add column if not exists paid_amount numeric(10,2);
alter table orders add column if not exists paid_by bigint;
alter table orders add column if not exists refunded_amount numeric(10,2) not null default 0;
alter table orders add column if not exists refunded_at timestamptz;
create index if not exists orders_city_created_idx on orders(city_id, created_at desc);
-- Старые заказы без города остаются как есть (city_id = null). Видит только владелец.

-- ----------------------------------------------------------------- Новые таблицы
create table cash_transfers(
  id bigserial primary key,
  city_id text not null references cities(id),
  amount numeric(10,2) not null check(amount>0),
  note text not null default '',
  idempotency_key text not null unique,
  created_by bigint not null,
  created_at timestamptz not null default now()
);

create table broadcasts(
  id bigserial primary key,
  city_id text not null references cities(id),
  text text not null,
  product_ids uuid[] not null default '{}',
  recipients int not null default 0,
  created_by bigint not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

-- Очередь исходящих сообщений. Заказ остаётся в БД даже если Telegram не принял сообщение:
-- строка остаётся pending и повторяется backend'ом.
create table outbox(
  id bigserial primary key,
  chat_id bigint not null,
  kind text not null check(kind in ('order_admin','order_customer','broadcast')),
  text text,
  order_id uuid references orders(id) on delete cascade,
  broadcast_id bigint references broadcasts(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','sent','failed')),
  attempts int not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index outbox_pending_idx on outbox(status, next_attempt_at);
create index outbox_broadcast_idx on outbox(broadcast_id);

-- RLS: клиентские роли (anon/authenticated) не читают ничего из новых таблиц.
alter table cities enable row level security;
alter table admins enable row level security;
alter table cash_transfers enable row level security;
alter table broadcasts enable row level security;
alter table outbox enable row level security;
create policy pub_read on cities for select using (active);

-- ----------------------------------------------------------------- Каталог ТЗ (раздел 15)
-- Сгенерировано из catalog.py. Идемпотентно (on conflict do nothing).
-- Цены и остатки НЕ задаются: цена null, остаток 0 в обоих городах.
-- ===== Каталог из ТЗ (раздел 15). Идемпотентно: повторный запуск не создаёт дублей. =====
insert into categories(name,sort) values ('Жидкости',1),('Pod-системы',2),('Картриджи',3),('Снюс',4),('Одноразки',5) on conflict(name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('elfliq-30ml-5',(select id from categories where name='Жидкости'),'Elfliq 30ml 5%','',null,true,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Apple Peach'),('Apple Pear'),('Blackberry Lemon'),('Blackcurrant Aniseed'),('Blackcurrant Menthol'),('Blue Razz Cherry'),('Blue Razz Ice'),('Blue Razz Lemonade'),('Blueberry'),('Blueberry Cherry Cranberry'),('Blueberry Raspberry Pomegranate'),('Blueberry Rose Mint'),('Blueberry Sour Raspberry'),('Cherry'),('Cherry Lemon Peach'),('Cherry Sour raspberry'),('Cherry Сola'),('Cola'),('Cool Mint'),('Cuba Tobacco'),('Elf Jack'),('ElfBull Ice'),('Fizzy Cherry'),('Grape'),('Grape Cherry'),('Green Grape Rose'),('Jasmine Raspberry'),('Kiwi Passion Fruit Guava'),('Lemon Lime'),('Lemon Sherbet'),('Mr.Blue'),('Ocean Mint'),('PB Cloud'),('Peach Ice'),('Pina Colada'),('Pineapple Colada'),('Pineapple Ice'),('Pink Grapefruit'),('Pink Lemonade'),('Pink Lemonade Soda'),('Raspberry Lychee'),('Rhubarb Snoow'),('Snoow Tobacco'),('Sour Apple'),('Sour Watermelon Gummy'),('Spearmint'),('Strawberry Banana'),('Strawberry Cherry Lemon'),('Strawberry Ice'),('Strawberry Kiwi'),('Strawberry Raspberry Cherry Ice'),('Strawberry Razz Lemonade'),('Strawberry Snoow'),('Strawberry Watermelon'),('Very Menthol'),('Watermelon'),('Watermelon Cherry')) x(name) where p.catalog_key='elfliq-30ml-5' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('chaser-black-30ml-5',(select id from categories where name='Жидкости'),'Chaser Black 30ml 5%','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('BALI'),('BALI TRIPLE SHOT'),('BLACKBERRY SOUR RASPBERRY'),('BLACKCURRANT PEACH APPLE'),('COLA POMELO'),('ENERGY RASPBERRY'),('FLIRT'),('KIWI WILD STRAWBERRY'),('LEMON MINT'),('PINK LEMONADE'),('SHERBET'),('STRAWBERRY BLUEBERRY'),('TRIPLE BERRY'),('TRIPLE RASPBERRY'),('WATERMELON LEMON')) x(name) where p.catalog_key='chaser-black-30ml-5' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('vozol-prime-30ml-5',(select id from categories where name='Жидкости'),'Vozol Prime 30ml 5%','',null,true,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Berry'),('Berry Peach'),('Blue Cotton Candy'),('Blue Raspberry'),('Blue razz lemon'),('Blueberry Ice'),('blueberry watermelon'),('Cherry Cola'),('Cherry Lemon Peach'),('Cherry Vanilla Cream'),('Cola Gummies'),('Dragon Fruit Banana Cherry'),('Frozen Grape Soda'),('Grape cherry'),('Grape Ice'),('Kiwi Passion Fruit Guava'),('LavaFire'),('Lemon Grapefruit'),('Lemon Lime'),('Love 777'),('Lychee Mint'),('Mint Ice'),('Mixed Berries'),('Peach Ice'),('Peach Mango Watermelon'),('Perfume Lemon'),('Pineapple Passion Fruit Lime'),('Pomegranate Lemonade'),('Purple Candy'),('Sour Apple Ice'),('Strawberry ice'),('Strawberry Ice Cream'),('Strawberry Kiwi'),('Strawberry Watermelon'),('Vanilla Cream Tobacco'),('Watermelon Bubblegum'),('Watermelon Ice'),('Watermelon Plum'),('White Peach Jasmine')) x(name) where p.catalog_key='vozol-prime-30ml-5' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('snus-cuba-66mg',(select id from categories where name='Снюс'),'Снюс Cuba 66мг','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Apple Juice'),('Banana Hit'),('Black Currant'),('Blackberry'),('Blueberry'),('Cherry'),('Cola'),('Cold Dry'),('Double Fresh'),('Forest Berries'),('Grape'),('Ice Cherry'),('Ice Spearmint'),('Mango'),('Peach'),('Tropical Fruit'),('Watermelon')) x(name) where p.catalog_key='snus-cuba-66mg' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('snus-baron-77mg',(select id from categories where name='Снюс'),'Снюс Baron 77мг','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Classic'),('Eucalyptus'),('Fruit Cocktail'),('Menthol'),('Wintergreen')) x(name) where p.catalog_key='snus-baron-77mg' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('xros-4-mini',(select id from categories where name='Pod-системы'),'Vaporesso XROS 4 Mini','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Black'),('Space Grey'),('Ice Purple'),('Ice Green'),('Ice Blue'),('Champagne Gold'),('Camo Yellow'),('Camo Red'),('Camo Silver'),('Ice Pink')) x(name) where p.catalog_key='xros-4-mini' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('xros-5',(select id from categories where name='Pod-системы'),'Vaporesso XROS 5','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Blue Silk'),('Carbon Stripe'),('Coral Red'),('Cosmic Black'),('Grey Silk'),('Jade Green'),('Lavender Purple'),('Opal Pink'),('Opal White'),('Violet Silk')) x(name) where p.catalog_key='xros-5' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('xros-5-mini',(select id from categories where name='Pod-системы'),'Vaporesso XROS 5 Mini','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Black'),('Carbon Black'),('Flowing Blue'),('Flowing Green'),('Flowing Pink'),('Pastel Crystal'),('Purple'),('Rose Red'),('Sky Blue'),('Titanium Silver')) x(name) where p.catalog_key='xros-5-mini' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('xros-6',(select id from categories where name='Pod-системы'),'Vaporesso XROS 6','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Silk Brown'),('Silk Gray'),('Silk Green'),('Cosmic Black'),('Slate Black'),('Aurora Blue'),('Dreamy Pink'),('Abyssal Blue'),('Scorching Cloud'),('Pearl White'),('Carbon Fiber Gray')) x(name) where p.catalog_key='xros-6' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('xros-6-mini',(select id from categories where name='Pod-системы'),'Vaporesso XROS 6 Mini','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Jelly Orange'),('Jelly Pink'),('Jelly Green'),('Jelly Blue'),('Brown'),('Titanium Silver'),('Titanium Black'),('Plume White'),('Plume Pink'),('Plume Blue'),('Black')) x(name) where p.catalog_key='xros-6-mini' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('xros-cartridges',(select id from categories where name='Картриджи'),'Картриджи XROS','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Картридж Vaporesso Corex 3.0 XROS 3 мл, 0,4 Ω'),('Картридж Vaporesso Corex 3.0 XROS 3 мл, 0,6 Ω'),('Картридж Vaporesso Corex 3.0 XROS 3 мл, 0,8 Ω')) x(name) where p.catalog_key='xros-cartridges' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('elfbar-2k',(select id from categories where name='Одноразки'),'Elfbar 2K','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('blue razz ice'),('pineapple mango orange'),('pineapple ice'),('grape energy'),('kiwi berry')) x(name) where p.catalog_key='elfbar-2k' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('elfbar-moon-night-40000',(select id from categories where name='Одноразки'),'Elfbar Moon Night 40000','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Watermelon ice'),('Mango pech watermelon'),('Blue razz ice'),('Miami mint'),('kiwi passion fruit guava')) x(name) where p.catalog_key='elfbar-moon-night-40000' on conflict(product_id,name) do nothing;
insert into products(catalog_key,category_id,name,description,price,wholesale_enabled,active) values('elfbar-ice-king-30000',(select id from categories where name='Одноразки'),'Elfbar Ice King 30000','',null,false,true) on conflict(catalog_key) do nothing;
insert into product_variants(product_id,name) select p.id, x.name from products p, (values ('Watermelon ice'),('Banana cake')) x(name) where p.catalog_key='elfbar-ice-king-30000' on conflict(product_id,name) do nothing;

-- Новым вариантам создаём складские строки в каждом активном городе (остаток 0).
insert into inventory(product_id,variant_id,city_id,quantity)
select v.product_id, v.id, c.id, 0
from product_variants v
join products p on p.id=v.product_id and p.catalog_key is not null
cross join cities c
where c.active
  and not exists(select 1 from inventory i where i.product_id=v.product_id and i.variant_id=v.id and i.city_id=c.id);

-- Архивируем старый ассортимент (все товары без catalog_key). Ничего не удаляется.
update products set active=false where catalog_key is null and active;

-- ============================================================================
-- Вспомогательные функции доступа
-- ============================================================================
-- Возвращает роль или бросает forbidden.
--   p_city = null  → только владелец.
--   p_city = 'x'   → владелец (любой город) или city_admin только своего города.
create or replace function _assert_role(p_actor bigint, p_city text) returns text
language plpgsql stable set search_path=public as $$
declare r admins%rowtype;
begin
  select * into r from admins where telegram_id=p_actor and is_active;
  if not found then raise exception 'forbidden'; end if;
  if r.role='owner' then return 'owner'; end if;
  if p_city is null or p_city<>r.city_id then raise exception 'forbidden'; end if;
  return 'city_admin';
end $$;

create or replace function _is_admin(p_actor bigint) returns boolean
language sql stable set search_path=public as $$
  select exists(select 1 from admins where telegram_id=p_actor and is_active) $$;

-- ============================================================================
-- Каталог и корзина (покупатель)
-- ============================================================================
drop function if exists get_catalog(text);
-- Видимость: товар активен, на складе ГОРОДА есть свободный остаток > 0, и есть действующая цена.
-- Категория видна, если в ней есть хотя бы один видимый товар. Ничего в БД не удаляется и не скрывается.
create or replace function get_catalog(p_city text, p_q text default '') returns jsonb
language sql stable set search_path=public as $$
with q as (select nullif(trim(coalesce(p_q,'')),'') t),
vis as (
  select i.id, i.product_id, v.name variant, coalesce(v.price,pr.price) price, i.quantity-i.reserved_quantity available
  from inventory i
  join products pr on pr.id=i.product_id and pr.active
  left join product_variants v on v.id=i.variant_id
  where i.city_id=p_city and i.quantity-i.reserved_quantity>0 and coalesce(v.price,pr.price) is not null
),
pl as (
  select pr.* from products pr, q
  where pr.active and exists(select 1 from vis where vis.product_id=pr.id)
    and (q.t is null or pr.name ilike '%'||q.t||'%'
         or exists(select 1 from vis x where x.product_id=pr.id and x.variant ilike '%'||q.t||'%'))
)
select jsonb_build_object(
  'city', p_city,
  'categories', (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.sort,c.id),'[]'::jsonb)
                 from categories c where exists(select 1 from pl where pl.category_id=c.id)),
  'wholesale', (select coalesce(jsonb_agg(jsonb_build_object('min',w.min_qty,'max',w.max_qty,'price',w.price) order by w.min_qty),'[]'::jsonb) from wholesale_prices w),
  'products', (select coalesce(jsonb_agg(jsonb_build_object(
      'id',pl.id,'name',pl.name,'description',pl.description,'category_id',pl.category_id,'image_path',pl.image_path,
      'wholesale_enabled',pl.wholesale_enabled,
      'sold',coalesce((select sum(oi.quantity) from order_items oi join orders o on o.id=oi.order_id
                       where oi.product_id=pl.id and o.status='issued'),0),
      'items',(select coalesce(jsonb_agg(jsonb_build_object('id',vis.id,'variant',vis.variant,'flavor',null,
                                   'price',vis.price,'available',vis.available) order by vis.variant),'[]'::jsonb)
               from vis where vis.product_id=pl.id)
    ) order by pl.name),'[]'::jsonb) from pl)
);
$$;

create or replace function get_cart(p_user uuid) returns jsonb language sql stable security definer set search_path=public as $$
select coalesce(jsonb_agg(jsonb_build_object('inventory_id',ci.inventory_id,'quantity',ci.quantity,'city_id',i.city_id)),'[]'::jsonb)
from carts c join cart_items ci on ci.cart_id=c.id join inventory i on i.id=ci.inventory_id
where c.user_id=p_user
$$;

-- ============================================================================
-- Заказ (покупатель)
-- ============================================================================
drop function if exists create_order(uuid,jsonb,text,text,text,text,text);
create or replace function create_order(p_user uuid, p_city text, p_items jsonb, p_contact text, p_comment text, p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o orders; r record; wq int:=0; wp numeric; tot numeric:=0; price numeric; n_req int; n_exists int; n_city int;
        tg bigint; uc text; cnt int:=0;
begin
  select * into o from orders where idempotency_key=p_key;
  if found then return jsonb_build_object('id',o.id,'number',o.number,'duplicate',true); end if;
  select telegram_id, city_id into tg, uc from users where id=p_user;
  if tg is null then raise exception 'user_not_found'; end if;
  -- Город берётся из профиля пользователя (его выбрал сам покупатель). Клиент не может выбрать склад.
  if uc is null or p_city is distinct from uc then raise exception 'city_mismatch'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'empty_order'; end if;

  perform 1 from inventory where id in (select (e->>'inventory_id')::uuid from jsonb_array_elements(p_items) e) order by id for update;
  select count(distinct (e->>'inventory_id')::uuid) into n_req from jsonb_array_elements(p_items) e;
  select count(*) into n_exists from inventory where id in (select (e->>'inventory_id')::uuid from jsonb_array_elements(p_items) e);
  if n_req<>n_exists then raise exception 'item_not_found'; end if;
  select count(*) into n_city from inventory where city_id=p_city and id in (select (e->>'inventory_id')::uuid from jsonb_array_elements(p_items) e);
  if n_req<>n_city then raise exception 'city_mismatch'; end if;

  select coalesce(sum(x.q),0) into wq from (
    select sum((e->>'quantity')::int) q, i.product_id from jsonb_array_elements(p_items) e
    join inventory i on i.id=(e->>'inventory_id')::uuid group by i.product_id) x
  join products pr on pr.id=x.product_id where pr.wholesale_enabled;
  if wq>0 then
    select w.price into wp from wholesale_prices w where wq>=w.min_qty and (w.max_qty is null or wq<=w.max_qty);
    if not found or wp is null then raise exception 'wholesale_manager'; end if;
  end if;

  loop
    begin
      insert into orders(number,user_id,telegram_id,city_id,contact,address,delivery_service,comment,idempotency_key)
      values('MOON-'||to_char(now() at time zone 'utc','YYYYMMDD')||'-'||lpad((floor(random()*10000))::int::text,4,'0'),
             p_user,tg,p_city,p_contact,'','',coalesce(p_comment,''),p_key) returning * into o;
      exit;
    exception when unique_violation then
      select * into o from orders where idempotency_key=p_key;
      if found then return jsonb_build_object('id',o.id,'number',o.number,'duplicate',true); end if;
    end;
  end loop;

  for r in
    select i.id inv_id, i.product_id, pr.name pname, v.name vname, pr.wholesale_enabled wh,
           coalesce(v.price,pr.price) base, x.q, i.quantity-i.reserved_quantity av
    from (select (e->>'inventory_id')::uuid iid, sum((e->>'quantity')::int)::int q from jsonb_array_elements(p_items) e group by 1) x
    join inventory i on i.id=x.iid
    join products pr on pr.id=i.product_id and pr.active
    left join product_variants v on v.id=i.variant_id
    order by i.id
  loop
    cnt:=cnt+1;
    if r.q<=0 then raise exception 'bad_quantity'; end if;
    -- Товар без цены не продаётся (оптовая цена тоже требует базовой цены).
    if r.base is null then raise exception 'price_missing'; end if;
    if r.q>r.av then raise exception 'insufficient_stock'; end if;
    price:=case when r.wh then wp else r.base end;
    insert into order_items(order_id,product_id,inventory_id,product_name,variant_name,flavor_name,quantity,unit_price,base_price,is_wholesale)
    values(o.id,r.product_id,r.inv_id,r.pname,r.vname,null,r.q,price,r.base,r.wh);
    update inventory set reserved_quantity=reserved_quantity+r.q where id=r.inv_id;
    insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,reason)
    select i.id,o.id,'reserve'::inv_op,r.q,i.quantity,i.quantity,i.city_id,'Резерв под заказ '||o.number from inventory i where i.id=r.inv_id;
    tot:=tot+price*r.q;
  end loop;
  if cnt<>n_req then raise exception 'item_not_found'; end if;

  update orders set total=tot where id=o.id;
  delete from cart_items where cart_id in (select id from carts where user_id=p_user)
    and inventory_id in (select id from inventory where city_id=p_city);
  insert into order_status_history(order_id,old_status,new_status,actor) values(o.id,null,'new','customer');
  return jsonb_build_object('id',o.id,'number',o.number,'duplicate',false);
end $$;

-- ============================================================================
-- Статусы, оплата, возвраты (владелец и admin своего города)
-- ============================================================================
-- Старая сигнатура с text-актёром заменяется на bigint (Telegram ID из проверенного initData).
drop function if exists change_order_status(uuid, order_status, text);
create or replace function change_order_status(p_order uuid, p_new order_status, p_actor bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders; r record; ok boolean;
begin
  select * into o from orders where id=p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  perform _assert_role(p_actor, o.city_id);
  ok := (o.status='new' and p_new in ('confirmed','cancelled'))
     or (o.status='confirmed' and p_new in ('prepared','cancelled'))
     or (o.status='prepared' and p_new in ('issued','cancelled'))
     or (o.status='issued' and p_new='returned');
  if not ok then raise exception 'bad_transition'; end if;

  if p_new='cancelled' then
    -- Освобождаем резерв. Журнал пишем ДО изменения, чтобы qty_before/qty_after были верны.
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      select i.id,p_order,'release'::inv_op,r.q,i.quantity,i.quantity,i.city_id,p_actor,'Отмена заказа '||o.number from inventory i where i.id=r.inventory_id;
      update inventory set reserved_quantity=reserved_quantity-r.q where id=r.inventory_id;
    end loop;
  elsif p_new='issued' then
    -- Выдача: списываем физически и снимаем резерв.
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      select i.id,p_order,'writeoff'::inv_op,r.q,i.quantity,i.quantity-r.q,i.city_id,p_actor,'Выдача по заказу '||o.number from inventory i where i.id=r.inventory_id;
      update inventory set quantity=quantity-r.q, reserved_quantity=reserved_quantity-r.q where id=r.inventory_id;
    end loop;
  elsif p_new='returned' then
    -- Возврат: товар возвращается на склад того же города.
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      select i.id,p_order,'return'::inv_op,r.q,i.quantity,i.quantity+r.q,i.city_id,p_actor,'Возврат по заказу '||o.number from inventory i where i.id=r.inventory_id;
      update inventory set quantity=quantity+r.q where id=r.inventory_id;
    end loop;
  end if;

  update orders set status=p_new, updated_at=now(),
    refunded_amount = case when p_new in ('cancelled','returned') and paid_at is not null then coalesce(paid_amount,0) else refunded_amount end,
    refunded_at     = case when p_new in ('cancelled','returned') and paid_at is not null and refunded_at is null then now() else refunded_at end
  where id=p_order;
  insert into order_status_history(order_id,old_status,new_status,actor) values(p_order,o.status,p_new,p_actor::text);
  return jsonb_build_object('id',p_order,'status',p_new,'number',o.number,'city_id',o.city_id);
end $$;

-- Оплата фиксируется вручную: заказ не считается оплаченным по статусу.
-- Сумма всегда равна итогу заказа на сервере (клиент сумму не передаёт).
create or replace function mark_order_paid(p_order uuid, p_actor bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders;
begin
  select * into o from orders where id=p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  perform _assert_role(p_actor, o.city_id);
  if o.status in ('cancelled','returned') then raise exception 'bad_status'; end if;
  if o.paid_at is not null then raise exception 'already_paid'; end if;
  update orders set paid_at=now(), paid_amount=o.total, paid_by=p_actor, updated_at=now() where id=p_order;
  return jsonb_build_object('id',p_order,'paid_amount',o.total);
end $$;

-- ============================================================================
-- Склад (владелец и admin своего города)
-- ============================================================================
drop function if exists set_stock(uuid,int);
-- Ручная корректировка и поступление. Остаток не может стать меньше резерва.
create or replace function admin_set_stock(p_actor bigint, p_inventory uuid, p_new_qty int, p_kind text default 'adjust', p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare i inventory; qbefore int; delta int;
begin
  if p_new_qty is null or p_new_qty<0 then raise exception 'bad_quantity'; end if;
  if p_kind not in ('receipt','adjust') then raise exception 'bad_kind'; end if;
  select * into i from inventory where id=p_inventory for update;
  if not found then raise exception 'item_not_found'; end if;
  perform _assert_role(p_actor, i.city_id);
  if p_new_qty < i.reserved_quantity then raise exception 'below_reserved'; end if;
  qbefore := i.quantity; delta := p_new_qty - qbefore;
  if delta = 0 then return jsonb_build_object('id',p_inventory,'quantity',qbefore,'reserved',i.reserved_quantity,'changed',false); end if;
  if p_kind='receipt' and delta<0 then raise exception 'bad_kind'; end if;
  update inventory set quantity=p_new_qty where id=p_inventory;
  insert into inventory_transactions(inventory_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
  values(p_inventory, p_kind::inv_op, abs(delta), qbefore, p_new_qty, i.city_id, p_actor, nullif(trim(coalesce(p_reason,'')),''));
  return jsonb_build_object('id',p_inventory,'quantity',p_new_qty,'reserved',i.reserved_quantity,'changed',true);
end $$;

-- Перемещение между городами (только владелец). Себестоимость не меняется: это не закупка и не продажа.
create or replace function admin_transfer_stock(p_actor bigint, p_from uuid, p_to uuid, p_qty int, p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare f inventory; t inventory;
begin
  perform _assert_role(p_actor, null);
  if p_qty is null or p_qty<=0 or p_from=p_to then raise exception 'bad_quantity'; end if;
  perform 1 from inventory where id in (p_from,p_to) order by id for update;
  select * into f from inventory where id=p_from;
  select * into t from inventory where id=p_to;
  if f.id is null or t.id is null then raise exception 'item_not_found'; end if;
  if f.product_id<>t.product_id or f.variant_id is distinct from t.variant_id or f.city_id=t.city_id then raise exception 'bad_transfer'; end if;
  if f.quantity-f.reserved_quantity < p_qty then raise exception 'insufficient_stock'; end if;
  insert into inventory_transactions(inventory_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
  values(f.id,'transfer'::inv_op,p_qty,f.quantity,f.quantity-p_qty,f.city_id,p_actor,'Перемещение в '||t.city_id||': '||coalesce(nullif(trim(coalesce(p_reason,'')),''),'—'));
  insert into inventory_transactions(inventory_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
  values(t.id,'transfer'::inv_op,p_qty,t.quantity,t.quantity+p_qty,t.city_id,p_actor,'Перемещение из '||f.city_id||': '||coalesce(nullif(trim(coalesce(p_reason,'')),''),'—'));
  update inventory set quantity=quantity-p_qty where id=f.id;
  update inventory set quantity=quantity+p_qty where id=t.id;
  return jsonb_build_object('from',f.id,'to',t.id,'qty',p_qty);
end $$;

-- Наличие одного города (только активные товары). Владелец и admin своего города.
create or replace function admin_inventory(p_actor bigint, p_city text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare res jsonb;
begin
  perform _assert_role(p_actor, p_city);
  select coalesce(jsonb_agg(row_json order by pname, vname),'[]'::jsonb) into res from (
    select jsonb_build_object('inventory_id',i.id,'product_id',pr.id,'product_name',pr.name,'variant_name',v.name,
           'category_id',pr.category_id,'price',coalesce(v.price,pr.price),'quantity',i.quantity,'reserved',i.reserved_quantity,
           'available',i.quantity-i.reserved_quantity,'city_id',i.city_id) row_json,
           pr.name pname, coalesce(v.name,'') vname
    from inventory i join products pr on pr.id=i.product_id and pr.active left join product_variants v on v.id=i.variant_id
    where i.city_id=p_city) s;
  return res;
end $$;

-- Журнал складских операций по одной строке наличия.
create or replace function admin_stock_history(p_actor bigint, p_inventory uuid, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare c text; res jsonb;
begin
  select city_id into c from inventory where id=p_inventory;
  if c is null then raise exception 'item_not_found'; end if;
  perform _assert_role(p_actor, c);
  select coalesce(jsonb_agg(jsonb_build_object('op',t.op,'quantity',t.quantity,'qty_before',t.qty_before,'qty_after',t.qty_after,
         'reason',t.reason,'actor',t.actor,'order_id',t.order_id,'created_at',t.created_at) order by t.created_at desc, t.id desc),'[]'::jsonb)
  into res from (select * from inventory_transactions where inventory_id=p_inventory order by created_at desc, id desc limit least(greatest(p_limit,1),500)) t;
  return res;
end $$;

-- ============================================================================
-- Каталог для админки (чтение: все админы; изменения — владелец, см. ниже)
-- ============================================================================
create or replace function admin_catalog(p_actor bigint) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not _is_admin(p_actor) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort',c.sort) order by c.sort,c.id),'[]'::jsonb) from categories c),
    'wholesale',  (select coalesce(jsonb_agg(jsonb_build_object('min',w.min_qty,'max',w.max_qty,'price',w.price) order by w.min_qty),'[]'::jsonb) from wholesale_prices w),
    'cities',     (select coalesce(jsonb_agg(jsonb_build_object('id',ci.id,'name',ci.name,'manager_link',ci.manager_link) order by ci.sort),'[]'::jsonb) from cities ci),
    'products',   (select coalesce(jsonb_agg(jsonb_build_object(
        'id',pr.id,'name',pr.name,'description',pr.description,'category_id',pr.category_id,'price',pr.price,'active',pr.active,
        'wholesale_enabled',pr.wholesale_enabled,'catalog_key',pr.catalog_key,'image_path',pr.image_path,
        'variants',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'price',v.price) order by v.name),'[]'::jsonb)
                    from product_variants v where v.product_id=pr.id)
      ) order by pr.active desc, pr.name),'[]'::jsonb) from products pr));
end $$;

create or replace function admin_create_product(p_actor bigint, p_name text, p_category int, p_price numeric, p_description text, p_wholesale boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare pid uuid; c text;
begin
  perform _assert_role(p_actor, null);
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'bad_name'; end if;
  if p_price is not null and p_price<0 then raise exception 'bad_price'; end if;
  if not exists(select 1 from categories where id=p_category) then raise exception 'bad_category'; end if;
  insert into products(category_id,name,description,price,wholesale_enabled,active)
  values(p_category,trim(p_name),coalesce(p_description,''),p_price,coalesce(p_wholesale,false),true) returning id into pid;
  for c in select id from cities where active loop
    insert into inventory(product_id,variant_id,city_id,quantity) values(pid,null,c,0);
  end loop;
  return jsonb_build_object('id',pid);
end $$;

create or replace function admin_add_variant(p_actor bigint, p_product uuid, p_name text, p_price numeric)
returns jsonb language plpgsql security definer set search_path=public as $$
declare vid uuid; c text;
begin
  perform _assert_role(p_actor, null);
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'bad_name'; end if;
  if p_price is not null and p_price<0 then raise exception 'bad_price'; end if;
  if not exists(select 1 from products where id=p_product) then raise exception 'item_not_found'; end if;
  insert into product_variants(product_id,name,price) values(p_product,trim(p_name),p_price) returning id into vid;
  for c in select id from cities where active loop
    insert into inventory(product_id,variant_id,city_id,quantity) values(p_product,vid,c,0);
  end loop;
  return jsonb_build_object('id',vid);
end $$;

-- ============================================================================
-- Дашборд и взаиморасчёты
-- ============================================================================
-- p_city = null → вся сеть (только владелец). Иначе город (владелец или admin города).
create or replace function admin_dashboard(p_actor bigint, p_city text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare res jsonb;
begin
  perform _assert_role(p_actor, p_city);
  select jsonb_build_object(
    'orders', coalesce((select jsonb_object_agg(s.status::text, s.n) from
               (select status, count(*) n from orders where p_city is null or city_id=p_city group by status) s),'{}'::jsonb),
    'paid_revenue', (select coalesce(sum(paid_amount-refunded_amount),0) from orders where paid_at is not null and (p_city is null or city_id=p_city)),
    'stock', (select jsonb_build_object(
        'in_stock', count(*) filter (where i.quantity-i.reserved_quantity>0),
        'low', count(*) filter (where i.quantity-i.reserved_quantity between 1 and 2),
        'out', count(*) filter (where i.quantity-i.reserved_quantity<=0))
      from inventory i join products pr on pr.id=i.product_id and pr.active where p_city is null or i.city_id=p_city),
    'recent', (select coalesce(jsonb_agg(x order by x->>'created_at' desc),'[]'::jsonb) from (
        select jsonb_build_object('id',o.id,'number',o.number,'status',o.status,'total',o.total,'city_id',o.city_id,
               'created_at',o.created_at,'paid',o.paid_at is not null) x
        from orders o where p_city is null or o.city_id=p_city order by o.created_at desc limit 10) r)
  ) into res;
  return res;
end $$;

-- Сумма к передаче владельцу = оплаченные заказы − возвраты покупателям − уже переданное владельцу.
-- Закупка, неоплаченные заказы и расходы администратора сюда не входят.
create or replace function _settlement(p_city text) returns jsonb language sql stable set search_path=public as $$
select jsonb_build_object(
  'city_id', p_city,
  'collected', coalesce((select sum(paid_amount) from orders where city_id=p_city and paid_at is not null),0),
  'refunded',  coalesce((select sum(refunded_amount) from orders where city_id=p_city),0),
  'transferred', coalesce((select sum(amount) from cash_transfers where city_id=p_city),0),
  'owed', coalesce((select sum(paid_amount) from orders where city_id=p_city and paid_at is not null),0)
        - coalesce((select sum(refunded_amount) from orders where city_id=p_city),0)
        - coalesce((select sum(amount) from cash_transfers where city_id=p_city),0),
  'transfers', (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'amount',t.amount,'note',t.note,'created_at',t.created_at) order by t.created_at desc),'[]'::jsonb)
                from cash_transfers t where t.city_id=p_city)
)
$$;

create or replace function city_settlement(p_actor bigint, p_city text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  perform _assert_role(p_actor, p_city);
  return _settlement(p_city);
end $$;

-- Фиксирует передачу денег владельцу. Только владелец. Защита от двойного учёта — по idempotency_key.
create or replace function record_cash_transfer(p_actor bigint, p_city text, p_amount numeric, p_note text, p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owed numeric; dup cash_transfers%rowtype;
begin
  perform _assert_role(p_actor, null);
  select * into dup from cash_transfers where idempotency_key=p_key;
  if found then return jsonb_build_object('duplicate',true,'id',dup.id); end if;
  if p_amount is null or p_amount<=0 then raise exception 'bad_amount'; end if;
  if not exists(select 1 from cities where id=p_city) then raise exception 'bad_city'; end if;
  perform pg_advisory_xact_lock(hashtext('settlement:'||p_city));
  owed := (_settlement(p_city)->>'owed')::numeric;
  if p_amount > owed then raise exception 'exceeds_balance'; end if;
  insert into cash_transfers(city_id,amount,note,idempotency_key,created_by)
  values(p_city,p_amount,coalesce(p_note,''),p_key,p_actor);
  return jsonb_build_object('duplicate',false,'owed_before',owed,'owed_after',owed-p_amount);
end $$;

-- ============================================================================
-- Рассылка о наличии (ручная, с подтверждением в админке)
-- ============================================================================
create or replace function create_broadcast(p_actor bigint, p_city text, p_text text, p_product_ids uuid[], p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b broadcasts%rowtype; n int;
begin
  perform _assert_role(p_actor, p_city);
  select * into b from broadcasts where idempotency_key=p_key;
  if found then return jsonb_build_object('id',b.id,'recipients',b.recipients,'duplicate',true); end if;
  if nullif(trim(coalesce(p_text,'')),'') is null then raise exception 'empty_text'; end if;
  perform pg_advisory_xact_lock(hashtext('broadcast:'||p_city));
  if exists(select 1 from broadcasts where city_id=p_city and created_at > now()-interval '10 minutes') then
    raise exception 'broadcast_cooldown';
  end if;
  insert into broadcasts(city_id,text,product_ids,created_by,idempotency_key)
  values(p_city,p_text,coalesce(p_product_ids,'{}'),p_actor,p_key) returning * into b;
  insert into outbox(chat_id,kind,text,broadcast_id)
  select u.telegram_id,'broadcast',p_text,b.id from users u
  where u.city_id=p_city and u.bot_started_at is not null and u.notify_stock and not u.bot_blocked;
  get diagnostics n = row_count;
  update broadcasts set recipients=n where id=b.id;
  return jsonb_build_object('id',b.id,'recipients',n,'duplicate',false);
end $$;

-- ============================================================================
-- Права: вызываются только из backend (service_role)
-- ============================================================================
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

insert into schema_migrations(version) values('0003');
