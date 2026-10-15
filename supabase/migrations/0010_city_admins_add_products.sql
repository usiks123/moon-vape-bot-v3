-- 0010: админы городов могут добавлять товары и вкусы (каталог общий).
-- Остатки по-прежнему меняет только свой город: admin_set_stock проверяет город через _assert_role.
-- Цены, оптовые ступени, категории, исключения из акции и переводы между городами остаются за владельцем.

create or replace function admin_create_product(p_actor bigint, p_name text, p_category int, p_price numeric, p_description text, p_wholesale boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare pid uuid; c text;
begin
  if not _is_admin(p_actor) then raise exception 'forbidden'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'bad_name'; end if;
  if p_price is not null and p_price<0 then raise exception 'bad_price'; end if;
  if not exists(select 1 from categories where id=p_category) then raise exception 'bad_category'; end if;
  insert into products(category_id,name,description,price,wholesale_enabled,active)
  values(p_category,trim(p_name),coalesce(p_description,''),p_price,coalesce(p_wholesale,false),true) returning id into pid;
  -- Новый товар: остаток 0 в каждом городе. Остатки админ города меняет только у себя.
  for c in select id from cities where active loop
    insert into inventory(product_id,variant_id,city_id,quantity) values(pid,null,c,0);
  end loop;
  return jsonb_build_object('id',pid);
end $$;

create or replace function admin_add_variant(p_actor bigint, p_product uuid, p_name text, p_price numeric)
returns jsonb language plpgsql security definer set search_path=public as $$
declare vid uuid; c text;
begin
  if not _is_admin(p_actor) then raise exception 'forbidden'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'bad_name'; end if;
  if p_price is not null and p_price<0 then raise exception 'bad_price'; end if;
  if not exists(select 1 from products where id=p_product) then raise exception 'item_not_found'; end if;
  insert into product_variants(product_id,name,price) values(p_product,trim(p_name),p_price) returning id into vid;
  for c in select id from cities where active loop
    insert into inventory(product_id,variant_id,city_id,quantity) values(p_product,vid,c,0);
  end loop;
  delete from inventory i
  where i.product_id = p_product and i.variant_id is null
    and i.quantity = 0 and i.reserved_quantity = 0
    and not exists (select 1 from inventory_transactions t where t.inventory_id = i.id)
    and not exists (select 1 from order_items oi where oi.inventory_id = i.id)
    and not exists (select 1 from cart_items ci where ci.inventory_id = i.id);
  return jsonb_build_object('id',vid);
end $$;
