-- =============================================================================
-- MoonVape · миграция 0004 · цены, глобальные оптовые ступени, редактирование заказа
-- Запускать ПОСЛЕ 0003. Один Run в SQL Editor. Перед запуском — резервная копия БД.
-- Ничего не удаляет. Цены и ступени заполняются только там, где значения ещё пустые
-- (если владелец уже ввёл свои цены в админке, они не перезаписываются).
-- =============================================================================

do $$ begin
  if exists(select 1 from schema_migrations where version='0004') then raise exception 'migration 0004 already applied'; end if;
  if not exists(select 1 from schema_migrations where version='0003') then raise exception 'run 0003 first'; end if;
end $$;

-- ----------------------------------------------------------------- Поля
alter table products add column if not exists cost_price numeric(10,2);
do $$ begin
  if not exists(select 1 from pg_constraint where conname='products_cost_nonneg') then
    alter table products add constraint products_cost_nonneg check(cost_price is null or cost_price>=0);
  end if;
end $$;
-- Снимок себестоимости и ступени на момент заказа (не меняется при изменении прайса).
alter table order_items add column if not exists unit_cost numeric(10,2);
alter table order_items add column if not exists tier_label text;
alter table orders add column if not exists total_units int not null default 0;
alter table orders add column if not exists tier_label text;
alter table orders add column if not exists approval_required boolean not null default false;

-- ----------------------------------------------------------------- Оптовые ступени по товарам
-- Ступень выбирается по ОБЩЕМУ количеству единиц заказа; цена — из строки товара.
create table if not exists wholesale_tiers(
  product_id uuid not null references products(id) on delete cascade,
  tier_min int not null check(tier_min in (1,3,5,7,9,21)),
  tier_max int not null,
  price numeric(10,2) not null check(price>=0),
  primary key(product_id, tier_min)
);

-- История редактирования заказов и согласований (не удаляется).
create table if not exists order_edits(
  id bigserial primary key,
  order_id uuid not null references orders(id) on delete cascade,
  actor bigint not null,
  kind text not null check(kind in ('customer_edit','approval')),
  idempotency_key text unique,
  old_items jsonb not null default '[]'::jsonb,
  new_items jsonb not null default '[]'::jsonb,
  old_total numeric(10,2), new_total numeric(10,2),
  old_tier text, new_tier text,
  paid_amount numeric(10,2),
  created_at timestamptz not null default now()
);

-- Журнал административных действий (цены, себестоимость, ступени, согласования).
create table if not exists audit_log(
  id bigserial primary key,
  actor bigint not null,
  action text not null,
  entity text not null,
  entity_id text,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

alter table wholesale_tiers enable row level security;
alter table order_edits enable row level security;
alter table audit_log enable row level security;

-- ----------------------------------------------------------------- Данные из ТЗ (только пустые поля)
-- Розничная цена и себестоимость за единицу.
update products p set price=v.retail
from (values
 ('elfliq-30ml-5',15.00),('chaser-black-30ml-5',17.00),('vozol-prime-30ml-5',15.00),
 ('snus-cuba-66mg',10.00),('snus-baron-77mg',10.00),('xros-4-mini',24.00),('xros-5-mini',27.00),
 ('xros-5',33.00),('xros-6',32.00),('xros-6-mini',35.00),('xros-cartridges',5.00),
 ('elfbar-2k',12.00),('elfbar-moon-night-40000',35.00),('elfbar-ice-king-30000',25.00)) v(k,retail)
where p.catalog_key=v.k and p.price is null;

update products p set cost_price=v.cost
from (values
 ('elfliq-30ml-5',3.40),('chaser-black-30ml-5',5.20),('vozol-prime-30ml-5',3.70),
 ('snus-cuba-66mg',2.50),('snus-baron-77mg',2.50),('xros-4-mini',11.00),('xros-5-mini',14.00),
 ('xros-5',16.50),('xros-6',17.50),('xros-6-mini',15.00),('xros-cartridges',2.80),
 ('elfbar-2k',5.30),('elfbar-moon-night-40000',8.30),('elfbar-ice-king-30000',8.30)) v(k,cost)
where p.catalog_key=v.k and p.cost_price is null;

-- Оптовые ступени: 1–2 (розница), 3–4, 5–6, 7–8, 9–20, 21–49. Уровень 50+ — согласование.
insert into wholesale_tiers(product_id,tier_min,tier_max,price)
select p.id, t.tmin, t.tmax, t.price from products p join (values
 ('elfliq-30ml-5',1,2,15.00),('elfliq-30ml-5',3,4,14.00),('elfliq-30ml-5',5,6,13.00),('elfliq-30ml-5',7,8,12.00),('elfliq-30ml-5',9,20,11.00),('elfliq-30ml-5',21,49,9.00),
 ('chaser-black-30ml-5',1,2,17.00),('chaser-black-30ml-5',3,4,16.00),('chaser-black-30ml-5',5,6,15.50),('chaser-black-30ml-5',7,8,15.00),('chaser-black-30ml-5',9,20,14.50),('chaser-black-30ml-5',21,49,13.50),
 ('vozol-prime-30ml-5',1,2,15.00),('vozol-prime-30ml-5',3,4,14.00),('vozol-prime-30ml-5',5,6,13.00),('vozol-prime-30ml-5',7,8,12.00),('vozol-prime-30ml-5',9,20,11.00),('vozol-prime-30ml-5',21,49,9.00),
 ('snus-cuba-66mg',1,2,10.00),('snus-cuba-66mg',3,4,9.50),('snus-cuba-66mg',5,6,9.00),('snus-cuba-66mg',7,8,9.00),('snus-cuba-66mg',9,20,8.50),('snus-cuba-66mg',21,49,8.00),
 ('snus-baron-77mg',1,2,10.00),('snus-baron-77mg',3,4,9.50),('snus-baron-77mg',5,6,9.00),('snus-baron-77mg',7,8,9.00),('snus-baron-77mg',9,20,8.50),('snus-baron-77mg',21,49,8.00),
 ('xros-4-mini',1,2,24.00),('xros-4-mini',3,4,23.00),('xros-4-mini',5,6,22.00),('xros-4-mini',7,8,21.50),('xros-4-mini',9,20,20.50),('xros-4-mini',21,49,19.50),
 ('xros-5-mini',1,2,27.00),('xros-5-mini',3,4,25.50),('xros-5-mini',5,6,25.00),('xros-5-mini',7,8,24.00),('xros-5-mini',9,20,23.00),('xros-5-mini',21,49,21.50),
 ('xros-5',1,2,33.00),('xros-5',3,4,31.50),('xros-5',5,6,30.50),('xros-5',7,8,29.50),('xros-5',9,20,28.00),('xros-5',21,49,26.50),
 ('xros-6',1,2,32.00),('xros-6',3,4,30.50),('xros-6',5,6,29.50),('xros-6',7,8,28.50),('xros-6',9,20,27.00),('xros-6',21,49,25.50),
 ('xros-6-mini',1,2,35.00),('xros-6-mini',3,4,33.00),('xros-6-mini',5,6,32.00),('xros-6-mini',7,8,31.50),('xros-6-mini',9,20,30.00),('xros-6-mini',21,49,28.00),
 ('xros-cartridges',1,2,5.00),('xros-cartridges',3,4,4.50),('xros-cartridges',5,6,4.50),('xros-cartridges',7,8,4.50),('xros-cartridges',9,20,4.50),('xros-cartridges',21,49,4.50),
 ('elfbar-2k',1,2,12.00),('elfbar-2k',3,4,11.50),('elfbar-2k',5,6,11.00),('elfbar-2k',7,8,10.50),('elfbar-2k',9,20,10.00),('elfbar-2k',21,49,9.50),
 ('elfbar-moon-night-40000',1,2,35.00),('elfbar-moon-night-40000',3,4,33.50),('elfbar-moon-night-40000',5,6,32.00),('elfbar-moon-night-40000',7,8,31.50),('elfbar-moon-night-40000',9,20,30.00),('elfbar-moon-night-40000',21,49,28.00),
 ('elfbar-ice-king-30000',1,2,25.00),('elfbar-ice-king-30000',3,4,24.00),('elfbar-ice-king-30000',5,6,23.00),('elfbar-ice-king-30000',7,8,22.50),('elfbar-ice-king-30000',9,20,21.00),('elfbar-ice-king-30000',21,49,20.00)
) t(k,tmin,tmax,price) on p.catalog_key=t.k
on conflict(product_id,tier_min) do nothing;

-- ============================================================================
-- Расчёт заказа (единственный источник цен для оформления и редактирования)
-- ============================================================================
create or replace function _tier_of(p_units int) returns jsonb language sql immutable as $$
select case
  when p_units<=2  then jsonb_build_object('min',1,'max',2,'label','1–2 шт.')
  when p_units<=4  then jsonb_build_object('min',3,'max',4,'label','3–4 шт.')
  when p_units<=6  then jsonb_build_object('min',5,'max',6,'label','5–6 шт.')
  when p_units<=8  then jsonb_build_object('min',7,'max',8,'label','7–8 шт.')
  when p_units<=20 then jsonb_build_object('min',9,'max',20,'label','9–20 шт.')
  when p_units<=49 then jsonb_build_object('min',21,'max',49,'label','21–49 шт.')
  else jsonb_build_object('min',50,'max',null,'label','50+ шт. — по согласованию') end
$$;

-- Общее количество единиц заказа определяет ступень для ВСЕХ позиций заказа.
-- Проверяет: город, активность товара, наличие цены, количество. Остатки здесь не меняет.
create or replace function _pricing(p_city text, p_items jsonb) returns jsonb
language plpgsql stable set search_path=public as $$
declare
  units int; t jsonb; tmin int; approval boolean; tot numeric := 0; retail_tot numeric := 0;
  r record; unit numeric; tp numeric; lt numeric; lines jsonb := '[]'::jsonb; n_req int; n_exist int; n_city int; is_wh boolean;
begin
  if p_city is null then raise exception 'city_required'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'empty_order'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) e where (e->>'quantity') is null or (e->>'quantity')::int<=0 or (e->>'quantity')::int>1000)
    then raise exception 'bad_quantity'; end if;
  select coalesce(sum((e->>'quantity')::int),0) into units from jsonb_array_elements(p_items) e;
  select count(distinct (e->>'inventory_id')::uuid) into n_req from jsonb_array_elements(p_items) e;
  select count(*) into n_exist from inventory i join products pr on pr.id=i.product_id and pr.active
    where i.id in (select (e->>'inventory_id')::uuid from jsonb_array_elements(p_items) e);
  if n_exist<>n_req then raise exception 'item_not_found'; end if;
  select count(*) into n_city from inventory where city_id=p_city and id in (select (e->>'inventory_id')::uuid from jsonb_array_elements(p_items) e);
  if n_city<>n_req then raise exception 'city_mismatch'; end if;

  t := _tier_of(units);
  tmin := (t->>'min')::int;
  approval := tmin>=50;
  is_wh := tmin>=3;

  for r in
    select x.iid, x.q, i.product_id, pr.name pname, v.name vname, coalesce(v.price,pr.price) retail, pr.cost_price cost
    from (select (e->>'inventory_id')::uuid iid, sum((e->>'quantity')::int)::int q from jsonb_array_elements(p_items) e group by 1) x
    join inventory i on i.id=x.iid
    join products pr on pr.id=i.product_id
    left join product_variants v on v.id=i.variant_id
    order by x.iid
  loop
    if r.retail is null then raise exception 'price_missing'; end if;
    unit := null; lt := null;
    if not approval then
      if tmin=1 then
        unit := r.retail;
      else
        select w.price into tp from wholesale_tiers w where w.product_id=r.product_id and w.tier_min=tmin;
        if tp is null then raise exception 'tier_price_missing'; end if;
        unit := tp;
      end if;
      lt := unit*r.q;
      tot := tot + lt;
    end if;
    retail_tot := retail_tot + r.retail*r.q;
    lines := lines || jsonb_build_object('inventory_id',r.iid,'product_id',r.product_id,'product_name',r.pname,'variant_name',r.vname,
      'quantity',r.q,'retail_price',r.retail,'unit_price',unit,'line_total',lt,'unit_cost',r.cost,'is_wholesale',is_wh);
  end loop;

  return jsonb_build_object('city',p_city,'total_units',units,'tier_min',tmin,'tier_label',t->>'label',
    'approval_required',approval,'total',case when approval then null else tot end,
    'retail_total',retail_tot,'discount',case when approval then null else retail_tot-tot end,'lines',lines);
end $$;

-- Строки заказа из расчёта. Для заказа на согласование unit_price = 0 (до согласования).
create or replace function _insert_lines(p_order uuid, p_lines jsonb, p_tier text) returns void
language sql as $$
insert into order_items(order_id,product_id,inventory_id,product_name,variant_name,flavor_name,quantity,unit_price,base_price,is_wholesale,tier_label,unit_cost)
select p_order, (x->>'product_id')::uuid, (x->>'inventory_id')::uuid, x->>'product_name', x->>'variant_name', null,
       (x->>'quantity')::int, coalesce((x->>'unit_price')::numeric,0), (x->>'retail_price')::numeric,
       (x->>'is_wholesale')::boolean, p_tier, (x->>'unit_cost')::numeric
from jsonb_array_elements(p_lines) x
$$;

-- Предварительный расчёт для корзины покупателя (город — из его профиля на сервере).
create or replace function pricing_preview(p_city text, p_items jsonb) returns jsonb
language sql stable set search_path=public as $$ select _pricing(p_city,p_items) $$;

-- ============================================================================
-- Каталог: добавляем ступени по товарам; старую общую сетку не показываем
-- ============================================================================
drop function if exists get_catalog(text, text);
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
  'products', (select coalesce(jsonb_agg(jsonb_build_object(
      'id',pl.id,'name',pl.name,'description',pl.description,'category_id',pl.category_id,'image_path',pl.image_path,
      'sold',coalesce((select sum(oi.quantity) from order_items oi join orders o on o.id=oi.order_id
                       where oi.product_id=pl.id and o.status='issued'),0),
      'tiers',(select coalesce(jsonb_agg(jsonb_build_object('min',w.tier_min,'max',w.tier_max,'price',w.price) order by w.tier_min),'[]'::jsonb)
               from wholesale_tiers w where w.product_id=pl.id),
      'items',(select coalesce(jsonb_agg(jsonb_build_object('id',vis.id,'variant',vis.variant,'flavor',null,
                                   'price',vis.price,'available',vis.available) order by vis.variant),'[]'::jsonb)
               from vis where vis.product_id=pl.id)
    ) order by pl.name),'[]'::jsonb) from pl)
);
$$;

-- ============================================================================
-- Оформление заказа (пересобрано на едином расчёте)
-- ============================================================================
create or replace function create_order(p_user uuid, p_city text, p_items jsonb, p_contact text, p_comment text, p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o orders; tg bigint; uc text; pr jsonb; l jsonb;
begin
  select * into o from orders where idempotency_key=p_key;
  if found then return jsonb_build_object('id',o.id,'number',o.number,'duplicate',true); end if;
  select telegram_id, city_id into tg, uc from users where id=p_user;
  if tg is null then raise exception 'user_not_found'; end if;
  if uc is null or p_city is distinct from uc then raise exception 'city_mismatch'; end if;

  pr := _pricing(p_city, p_items);
  perform 1 from inventory where id in (select (x->>'inventory_id')::uuid from jsonb_array_elements(pr->'lines') x) order by id for update;
  for l in select x from jsonb_array_elements(pr->'lines') x loop
    if (select quantity-reserved_quantity from inventory where id=(l->>'inventory_id')::uuid) < (l->>'quantity')::int then
      raise exception 'insufficient_stock';
    end if;
  end loop;

  loop
    begin
      insert into orders(number,user_id,telegram_id,city_id,contact,address,delivery_service,comment,idempotency_key,
                         total,total_units,tier_label,approval_required)
      values('MOON-'||to_char(now() at time zone 'utc','YYYYMMDD')||'-'||lpad((floor(random()*10000))::int::text,4,'0'),
             p_user,tg,p_city,p_contact,'','',coalesce(p_comment,''),p_key,
             coalesce((pr->>'total')::numeric,0),(pr->>'total_units')::int,pr->>'tier_label',(pr->>'approval_required')::boolean)
      returning * into o;
      exit;
    exception when unique_violation then
      select * into o from orders where idempotency_key=p_key;
      if found then return jsonb_build_object('id',o.id,'number',o.number,'duplicate',true); end if;
    end;
  end loop;

  perform _insert_lines(o.id, pr->'lines', pr->>'tier_label');
  for l in select x from jsonb_array_elements(pr->'lines') x loop
    insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,reason)
    select i.id,o.id,'reserve'::inv_op,(l->>'quantity')::int,i.quantity,i.quantity,i.city_id,'Резерв под заказ '||o.number
    from inventory i where i.id=(l->>'inventory_id')::uuid;
    update inventory set reserved_quantity=reserved_quantity+(l->>'quantity')::int where id=(l->>'inventory_id')::uuid;
  end loop;

  delete from cart_items where cart_id in (select id from carts where user_id=p_user)
    and inventory_id in (select id from inventory where city_id=p_city);
  insert into order_status_history(order_id,old_status,new_status,actor) values(o.id,null,'new','customer');
  return jsonb_build_object('id',o.id,'number',o.number,'duplicate',false,'total',o.total,
    'total_units',o.total_units,'tier_label',o.tier_label,'approval_required',o.approval_required);
end $$;

-- ============================================================================
-- Смена статуса: добавлена проверка согласования крупного заказа
-- ============================================================================
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
  -- Заказ с неопределённой ценой нельзя подтвердить и выдать до согласования.
  if o.approval_required and p_new in ('confirmed','prepared','issued') then raise exception 'approval_required'; end if;

  if p_new='cancelled' then
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      select i.id,p_order,'release'::inv_op,r.q,i.quantity,i.quantity,i.city_id,p_actor,'Отмена заказа '||o.number from inventory i where i.id=r.inventory_id;
      update inventory set reserved_quantity=reserved_quantity-r.q where id=r.inventory_id;
    end loop;
  elsif p_new='issued' then
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      select i.id,p_order,'writeoff'::inv_op,r.q,i.quantity,i.quantity-r.q,i.city_id,p_actor,'Выдача по заказу '||o.number from inventory i where i.id=r.inventory_id;
      update inventory set quantity=quantity-r.q, reserved_quantity=reserved_quantity-r.q where id=r.inventory_id;
    end loop;
  elsif p_new='returned' then
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

-- ============================================================================
-- Редактирование заказа покупателем (только статусы «Новый» и «Подтверждён» = «В обработке»)
-- ============================================================================
create or replace function _edit_guard(p_user uuid, p_order uuid, p_lock boolean) returns orders
language plpgsql security definer set search_path=public as $$
declare o orders;
begin
  if p_lock then select * into o from orders where id=p_order for update;
  else select * into o from orders where id=p_order; end if;
  -- Чужой заказ неотличим от несуществующего: не раскрываем факт существования.
  if not found or o.user_id<>p_user then raise exception 'order_not_found'; end if;
  if o.status not in ('new','confirmed') or o.city_id is null then raise exception 'edit_not_allowed'; end if;
  return o;
end $$;

create or replace function customer_edit_preview(p_user uuid, p_order uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders;
begin
  o := _edit_guard(p_user, p_order, false);
  return _pricing(o.city_id, p_items);
end $$;

create or replace function customer_edit_order(p_user uuid, p_order uuid, p_items jsonb, p_key text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders; pr jsonb; tg bigint; old_items jsonb; new_tot numeric; dup order_edits%rowtype;
        cq int; cr int; d int; rr record;
begin
  select * into dup from order_edits where idempotency_key=p_key;
  if found then return jsonb_build_object('duplicate',true,'id',dup.order_id); end if;
  o := _edit_guard(p_user, p_order, true);
  pr := _pricing(o.city_id, p_items);

  -- Блокируем все затронутые строки склада в фиксированном порядке (без взаимоблокировок).
  perform 1 from inventory where id in (
    select (x->>'inventory_id')::uuid from jsonb_array_elements(pr->'lines') x
    union select inventory_id from order_items where order_id=p_order) order by id for update;

  for rr in
    select coalesce(n.iid,oq.iid) iid, coalesce(n.q,0)-coalesce(oq.q,0) delta
    from (select (x->>'inventory_id')::uuid iid, (x->>'quantity')::int q from jsonb_array_elements(pr->'lines') x) n
    full join (select inventory_id iid, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id) oq on oq.iid=n.iid
    order by 1
  loop
    d := rr.delta;
    if d=0 then continue; end if;
    select quantity, reserved_quantity into cq, cr from inventory where id=rr.iid;
    if d>0 and (cq-cr) < d then raise exception 'insufficient_stock'; end if;
    if d>0 then
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      values(rr.iid,p_order,'reserve'::inv_op,d,cq,cq,(select city_id from inventory where id=rr.iid),null,'Изменение заказа '||o.number);
    else
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      values(rr.iid,p_order,'release'::inv_op,-d,cq,cq,(select city_id from inventory where id=rr.iid),null,'Изменение заказа '||o.number);
    end if;
    update inventory set reserved_quantity=reserved_quantity+d where id=rr.iid;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('inventory_id',inventory_id,'quantity',quantity,'unit_price',unit_price,
           'product_name',product_name,'variant_name',variant_name,'tier_label',tier_label) order by product_name),'[]'::jsonb)
  into old_items from order_items where order_id=p_order;
  select telegram_id into tg from users where id=p_user;

  delete from order_items where order_id=p_order;
  perform _insert_lines(p_order, pr->'lines', pr->>'tier_label');
  new_tot := coalesce((pr->>'total')::numeric,0);
  update orders set total=new_tot, total_units=(pr->>'total_units')::int, tier_label=pr->>'tier_label',
                    approval_required=(pr->>'approval_required')::boolean, updated_at=now()
  where id=p_order;
  -- Оплаченная сумма не меняется. Разница показывается отдельно (balance).
  insert into order_edits(order_id,actor,kind,idempotency_key,old_items,new_items,old_total,new_total,old_tier,new_tier,paid_amount)
  values(p_order,tg,'customer_edit',p_key,old_items,pr->'lines',o.total,new_tot,o.tier_label,pr->>'tier_label',o.paid_amount);

  return jsonb_build_object('id',p_order,'number',o.number,'duplicate',false,'total',new_tot,
    'total_units',(pr->>'total_units')::int,'tier_label',pr->>'tier_label','approval_required',(pr->>'approval_required')::boolean,
    'paid_amount',o.paid_amount,
    -- balance > 0: доплата покупателя; balance < 0: переплата (кандидат к возврату, решает владелец)
    'balance', case when o.paid_at is null then null else new_tot-o.paid_amount end);
end $$;

-- ============================================================================
-- Согласование крупного заказа (50+): владелец задаёт цену каждой позиции
-- ============================================================================
create or replace function approve_order_prices(p_order uuid, p_actor bigint, p_prices jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders; x jsonb; new_tot numeric; n_items int; n_distinct int;
begin
  perform _assert_role(p_actor, null);
  select * into o from orders where id=p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if not o.approval_required then raise exception 'not_approval_order'; end if;
  if o.status not in ('new','confirmed','prepared') then raise exception 'bad_status'; end if;
  if jsonb_typeof(p_prices)<>'array' then raise exception 'bad_prices'; end if;
  select count(*) into n_items from order_items where order_id=p_order;
  select count(distinct (e->>'order_item_id')) into n_distinct from jsonb_array_elements(p_prices) e;
  if n_distinct<>n_items or jsonb_array_length(p_prices)<>n_items then raise exception 'prices_incomplete'; end if;
  for x in select e from jsonb_array_elements(p_prices) e loop
    if (x->>'unit_price') is null or (x->>'unit_price')::numeric<0 then raise exception 'bad_price'; end if;
    update order_items set unit_price=(x->>'unit_price')::numeric
      where id=(x->>'order_item_id')::uuid and order_id=p_order;
    if not found then raise exception 'item_not_found'; end if;
  end loop;
  select coalesce(sum(unit_price*quantity),0) into new_tot from order_items where order_id=p_order;
  update orders set total=new_tot, approval_required=false, updated_at=now() where id=p_order;
  insert into order_edits(order_id,actor,kind,new_items,old_total,new_total,old_tier,new_tier,paid_amount)
  select p_order,p_actor,'approval',coalesce(jsonb_agg(jsonb_build_object('order_item_id',id,'unit_price',unit_price,'quantity',quantity) order by id),'[]'::jsonb),
         o.total,new_tot,o.tier_label,o.tier_label,o.paid_amount
  from order_items where order_id=p_order;
  perform _audit(p_actor,'order_approve_prices','order',p_order::text,jsonb_build_object('total',o.total),jsonb_build_object('total',new_tot));
  return jsonb_build_object('id',p_order,'total',new_tot,'approval_required',false);
end $$;

-- ============================================================================
-- Аудит и управление ценами (только владелец)
-- ============================================================================
create or replace function _audit(p_actor bigint, p_action text, p_entity text, p_entity_id text, p_old jsonb, p_new jsonb) returns void
language sql as $$ insert into audit_log(actor,action,entity,entity_id,old_value,new_value) values(p_actor,p_action,p_entity,p_entity_id,p_old,p_new) $$;

create or replace function admin_set_product_prices(p_actor bigint, p_product uuid, p_price numeric, p_cost numeric) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o products%rowtype;
begin
  perform _assert_role(p_actor, null);
  select * into o from products where id=p_product for update;
  if not found then raise exception 'item_not_found'; end if;
  if (p_price is not null and p_price<0) or (p_cost is not null and p_cost<0) then raise exception 'bad_price'; end if;
  update products set price=p_price, cost_price=p_cost where id=p_product;
  perform _audit(p_actor,'product_prices','product',p_product::text,
                 jsonb_build_object('price',o.price,'cost_price',o.cost_price),
                 jsonb_build_object('price',p_price,'cost_price',p_cost));
  return jsonb_build_object('id',p_product,'price',p_price,'cost_price',p_cost);
end $$;

create or replace function admin_set_tiers(p_actor bigint, p_product uuid, p_tiers jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare x jsonb; old_t jsonb;
begin
  perform _assert_role(p_actor, null);
  if not exists(select 1 from products where id=p_product) then raise exception 'item_not_found'; end if;
  if jsonb_typeof(p_tiers)<>'array' then raise exception 'bad_tiers'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('min',tier_min,'price',price) order by tier_min),'[]'::jsonb) into old_t
    from wholesale_tiers where product_id=p_product;
  for x in select e from jsonb_array_elements(p_tiers) e loop
    if (x->>'price') is null or (x->>'price')::numeric<0 then raise exception 'bad_price'; end if;
    update wholesale_tiers set price=(x->>'price')::numeric where product_id=p_product and tier_min=(x->>'min')::int;
    if not found then raise exception 'bad_tier'; end if;
  end loop;
  perform _audit(p_actor,'product_tiers','product',p_product::text,old_t,p_tiers);
  return jsonb_build_object('id',p_product);
end $$;

-- Каталог для админки. Себестоимость — только владельцу. Ступени видны всем админам (только чтение для admin города).
create or replace function admin_catalog(p_actor bigint) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare is_owner boolean;
begin
  if not _is_admin(p_actor) then raise exception 'forbidden'; end if;
  is_owner := exists(select 1 from admins where telegram_id=p_actor and role='owner' and is_active);
  return jsonb_build_object(
    'is_owner', is_owner,
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort',c.sort) order by c.sort,c.id),'[]'::jsonb) from categories c),
    'cities',     (select coalesce(jsonb_agg(jsonb_build_object('id',ci.id,'name',ci.name,'manager_link',ci.manager_link) order by ci.sort),'[]'::jsonb) from cities ci),
    'products',   (select coalesce(jsonb_agg(jsonb_build_object(
        'id',pr.id,'name',pr.name,'description',pr.description,'category_id',pr.category_id,'price',pr.price,
        'cost_price', case when is_owner then pr.cost_price else null end,
        'active',pr.active,'wholesale_enabled',pr.wholesale_enabled,'catalog_key',pr.catalog_key,'image_path',pr.image_path,
        'tiers',(select coalesce(jsonb_agg(jsonb_build_object('min',w.tier_min,'max',w.tier_max,'price',w.price) order by w.tier_min),'[]'::jsonb)
                 from wholesale_tiers w where w.product_id=pr.id),
        'variants',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'price',v.price) order by v.name),'[]'::jsonb)
                    from product_variants v where v.product_id=pr.id)
      ) order by pr.active desc, pr.name),'[]'::jsonb) from products pr));
end $$;

-- ============================================================================
-- Права: только backend (service_role)
-- ============================================================================
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

insert into schema_migrations(version) values('0004');
