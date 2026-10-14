create extension if not exists pgcrypto;
create type order_status as enum ('new','processing','completed','cancelled');
create type inv_op as enum ('reserve','release','writeoff','adjust');

create table users(id uuid primary key default gen_random_uuid(), telegram_id bigint unique not null, username text, first_name text, last_name text, photo_url text, created_at timestamptz default now(), updated_at timestamptz default now());
create table categories(id serial primary key, name text unique not null, sort int default 0);
create table products(id uuid primary key default gen_random_uuid(), category_id int not null references categories(id), name text not null, description text default '', price numeric(10,2) not null check(price>=0), image_path text, wholesale_enabled boolean not null default false, active boolean not null default true, created_at timestamptz default now());
create table product_variants(id uuid primary key default gen_random_uuid(), product_id uuid not null references products(id) on delete cascade, name text not null, price numeric(10,2) check(price>=0), unique(product_id,name));
create table product_flavors(id uuid primary key default gen_random_uuid(), product_id uuid not null references products(id) on delete cascade, name text not null, unique(product_id,name));
create table inventory(id uuid primary key default gen_random_uuid(), product_id uuid not null references products(id) on delete cascade, variant_id uuid references product_variants(id) on delete cascade, flavor_id uuid references product_flavors(id) on delete cascade,
  quantity int not null default 0 check(quantity>=0), reserved_quantity int not null default 0 check(reserved_quantity>=0), check(reserved_quantity<=quantity),
  unique nulls not distinct (product_id,variant_id,flavor_id));
create table wholesale_prices(id serial primary key, min_qty int not null unique, max_qty int, price numeric(10,2));
create table orders(id uuid primary key default gen_random_uuid(), number text unique not null, user_id uuid not null references users(id), telegram_id bigint not null, status order_status not null default 'new', total numeric(10,2) not null default 0,
  contact text not null, address text not null, delivery_service text not null, comment text default '', idempotency_key text unique not null, created_at timestamptz default now(), updated_at timestamptz default now());
create table order_items(id uuid primary key default gen_random_uuid(), order_id uuid not null references orders(id) on delete cascade, product_id uuid not null references products(id), inventory_id uuid not null references inventory(id),
  product_name text not null, variant_name text, flavor_name text, quantity int not null check(quantity>0), unit_price numeric(10,2) not null, base_price numeric(10,2) not null default 0, is_wholesale boolean not null default false);
create table order_status_history(id bigserial primary key, order_id uuid not null references orders(id) on delete cascade, old_status order_status, new_status order_status not null, actor text, created_at timestamptz default now());
create table inventory_transactions(id bigserial primary key, inventory_id uuid not null references inventory(id), order_id uuid references orders(id), op inv_op not null, quantity int not null, created_at timestamptz default now());
create table carts(id uuid primary key default gen_random_uuid(), user_id uuid unique not null references users(id) on delete cascade, updated_at timestamptz default now());
create table cart_items(id uuid primary key default gen_random_uuid(), cart_id uuid not null references carts(id) on delete cascade, inventory_id uuid not null references inventory(id) on delete cascade, quantity int not null check(quantity>0 and quantity<=1000), unique(cart_id,inventory_id));
create index on orders(user_id, created_at desc); create index on order_items(order_id); create index on order_items(product_id); create index on inventory(product_id); create index on products(category_id); create index on cart_items(cart_id);

-- RLS: anon/authenticated читают только публичный каталог; всё остальное доступно только backend (service role).
alter table carts enable row level security; alter table cart_items enable row level security;
alter table users enable row level security; alter table orders enable row level security; alter table order_items enable row level security;
alter table inventory enable row level security; alter table order_status_history enable row level security; alter table inventory_transactions enable row level security;
alter table categories enable row level security; alter table products enable row level security; alter table product_variants enable row level security;
alter table product_flavors enable row level security; alter table wholesale_prices enable row level security;
create policy pub_read on categories for select using (true);
create policy pub_read on products for select using (active);
create policy pub_read on product_variants for select using (true);
create policy pub_read on product_flavors for select using (true);
create policy pub_read on wholesale_prices for select using (true);

create function get_catalog(p_q text default '') returns jsonb language sql stable as $$
select jsonb_build_object(
 'categories',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by sort),'[]'::jsonb) from categories),
 'wholesale',(select coalesce(jsonb_agg(jsonb_build_object('min',min_qty,'max',max_qty,'price',price) order by min_qty),'[]'::jsonb) from wholesale_prices),
 'products',(select coalesce(jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,'category_id',pr.category_id,'image_path',pr.image_path,'wholesale_enabled',pr.wholesale_enabled,
   'sold',coalesce((select sum(oi.quantity) from order_items oi join orders o on o.id=oi.order_id where oi.product_id=pr.id and o.status='completed'),0),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'variant',v.name,'flavor',f.name,'price',coalesce(v.price,pr.price),'available',i.quantity-i.reserved_quantity) order by v.name,f.name),'[]'::jsonb)
            from inventory i left join product_variants v on v.id=i.variant_id left join product_flavors f on f.id=i.flavor_id where i.product_id=pr.id)) order by pr.name),'[]'::jsonb)
  from products pr where pr.active and (coalesce(trim(p_q),'')='' or pr.name ilike '%'||trim(p_q)||'%' or exists(
    select 1 from inventory i left join product_variants v on v.id=i.variant_id left join product_flavors f on f.id=i.flavor_id
    where i.product_id=pr.id and (v.name ilike '%'||trim(p_q)||'%' or f.name ilike '%'||trim(p_q)||'%')))))
$$;

create function create_order(p_user uuid, p_items jsonb, p_contact text, p_address text, p_delivery text, p_comment text, p_key text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders; r record; wq int:=0; wp numeric; tot numeric:=0; price numeric; n_found int; n_req int; tg bigint; cnt int:=0;
begin
  select * into o from orders where idempotency_key=p_key;
  if found then return jsonb_build_object('id',o.id,'number',o.number,'duplicate',true); end if;
  select telegram_id into tg from users where id=p_user; if tg is null then raise exception 'user_not_found'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'empty_order'; end if;
  perform 1 from inventory where id in (select (e->>'inventory_id')::uuid from jsonb_array_elements(p_items) e) order by id for update;
  select count(distinct (e->>'inventory_id')::uuid) into n_req from jsonb_array_elements(p_items) e;
  select count(*) into n_found from inventory where id in (select (e->>'inventory_id')::uuid from jsonb_array_elements(p_items) e);
  if n_req<>n_found then raise exception 'item_not_found'; end if;
  select coalesce(sum(x.q),0) into wq from (select sum((e->>'quantity')::int) q, i.product_id from jsonb_array_elements(p_items) e join inventory i on i.id=(e->>'inventory_id')::uuid group by i.product_id) x join products pr on pr.id=x.product_id where pr.wholesale_enabled;
  if wq>0 then
    select w.price into wp from wholesale_prices w where wq>=w.min_qty and (w.max_qty is null or wq<=w.max_qty);
    if not found or wp is null then raise exception 'wholesale_manager'; end if;
  end if;
  loop
    begin
      insert into orders(number,user_id,telegram_id,contact,address,delivery_service,comment,idempotency_key)
      values('MOON-'||to_char(now() at time zone 'utc','YYYYMMDD')||'-'||lpad((floor(random()*10000))::int::text,4,'0'),p_user,tg,p_contact,p_address,p_delivery,coalesce(p_comment,''),p_key) returning * into o;
      exit;
    exception when unique_violation then
      select * into o from orders where idempotency_key=p_key;
      if found then return jsonb_build_object('id',o.id,'number',o.number,'duplicate',true); end if;
    end;
  end loop;
  for r in
    select i.id inv_id, i.product_id, pr.name pname, v.name vname, f.name fname, pr.wholesale_enabled wh, coalesce(v.price,pr.price) base, x.q, i.quantity-i.reserved_quantity av
    from (select (e->>'inventory_id')::uuid iid, sum((e->>'quantity')::int)::int q from jsonb_array_elements(p_items) e group by 1) x
    join inventory i on i.id=x.iid join products pr on pr.id=i.product_id and pr.active
    left join product_variants v on v.id=i.variant_id left join product_flavors f on f.id=i.flavor_id order by i.id
  loop
    cnt:=cnt+1;
    if r.q<=0 then raise exception 'bad_quantity'; end if;
    if r.q>r.av then raise exception 'insufficient_stock'; end if;
    price:=case when r.wh then wp else r.base end;
    insert into order_items(order_id,product_id,inventory_id,product_name,variant_name,flavor_name,quantity,unit_price,base_price,is_wholesale) values(o.id,r.product_id,r.inv_id,r.pname,r.vname,r.fname,r.q,price,r.base,r.wh);
    update inventory set reserved_quantity=reserved_quantity+r.q where id=r.inv_id;
    insert into inventory_transactions(inventory_id,order_id,op,quantity) values(r.inv_id,o.id,'reserve',r.q);
    tot:=tot+price*r.q;
  end loop;
  if cnt<>n_req then raise exception 'item_not_found'; end if;
  update orders set total=tot where id=o.id;
  delete from cart_items where cart_id in (select id from carts where user_id=p_user);
  insert into order_status_history(order_id,old_status,new_status,actor) values(o.id,null,'new','customer');
  return jsonb_build_object('id',o.id,'number',o.number,'duplicate',false);
end $$;

create function change_order_status(p_order uuid, p_new order_status, p_actor text default 'owner') returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders; r record;
begin
  select * into o from orders where id=p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if not ((o.status='new' and p_new in ('processing','cancelled')) or (o.status='processing' and p_new in ('completed','cancelled'))) then raise exception 'bad_transition'; end if;
  if p_new in ('completed','cancelled') then
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      if p_new='completed' then update inventory set quantity=quantity-r.q, reserved_quantity=reserved_quantity-r.q where id=r.inventory_id;
      else update inventory set reserved_quantity=reserved_quantity-r.q where id=r.inventory_id; end if;
      insert into inventory_transactions(inventory_id,order_id,op,quantity) values(r.inventory_id,p_order,(case when p_new='completed' then 'writeoff' else 'release' end)::inv_op,r.q);
    end loop;
  end if;
  update orders set status=p_new, updated_at=now() where id=p_order;
  insert into order_status_history(order_id,old_status,new_status,actor) values(p_order,o.status,p_new,p_actor);
  return jsonb_build_object('id',p_order,'status',p_new,'number',o.number,'telegram_id',o.telegram_id);
end $$;

create function get_cart(p_user uuid) returns jsonb language sql stable security definer set search_path=public as $$
select coalesce(jsonb_agg(jsonb_build_object('inventory_id',ci.inventory_id,'quantity',ci.quantity)),'[]'::jsonb)
from carts c join cart_items ci on ci.cart_id=c.id where c.user_id=p_user
$$;

create function save_cart(p_user uuid, p_items jsonb) returns void language plpgsql security definer set search_path=public as $$
declare c uuid;
begin
  if jsonb_typeof(p_items)<>'array' then raise exception 'bad_items'; end if;
  insert into carts(user_id) values(p_user) on conflict(user_id) do update set updated_at=now() returning id into c;
  delete from cart_items where cart_id=c;
  insert into cart_items(cart_id,inventory_id,quantity)
  select c, i.id, least(x.q,1000) from (select (e->>'inventory_id')::uuid iid, sum((e->>'quantity')::int)::int q from jsonb_array_elements(p_items) e group by 1) x
  join inventory i on i.id=x.iid join products pr on pr.id=i.product_id and pr.active where x.q>0;
end $$;

create function set_stock(p_inventory uuid, p_qty int) returns void language plpgsql security definer set search_path=public as $$
begin
  if p_qty is null or p_qty<0 then raise exception 'bad_quantity'; end if;
  update inventory set quantity=p_qty where id=p_inventory;
  if not found then raise exception 'item_not_found'; end if;
  insert into inventory_transactions(inventory_id,op,quantity) values(p_inventory,'adjust',p_qty);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

insert into storage.buckets(id,name,public) values('product-images','product-images',true) on conflict do nothing;
create policy "public read product images" on storage.objects for select using (bucket_id='product-images');
