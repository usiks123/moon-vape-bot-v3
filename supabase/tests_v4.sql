-- Тесты миграции 0004: цены, общие оптовые ступени, редактирование заказа, согласование 50+, права.
-- Выполнять ПОСЛЕ 0004 и tests_v2.sql. Всё откатывается. Успех: "ALL TESTS PASSED".
begin;

create function pg_temp.fails(q text, expected text) returns void language plpgsql as $$
begin
  execute q;
  raise exception 'expected error %', expected;
exception when others then
  if sqlerrm <> expected then raise exception 'wanted error "%", got "%"', expected, sqlerrm; end if;
end $$;

create function pg_temp.k(ck text, vname text, city text) returns uuid language sql as $$
  select i.id from inventory i join products p on p.id=i.product_id join product_variants v on v.id=i.variant_id
  where p.catalog_key=ck and v.name=vname and i.city_id=city $$;

do $$
declare
  OWNER bigint := 7858672760; HANN bigint := 7050120446;
  u uuid; u2 uuid; r jsonb; oid uuid; oid2 uuid; oid3 uuid; oi uuid; pid uuid; cnt int; tot numeric; rq int; n0 int; bal numeric;
  em uuid; xr uuid; ptxt text;
begin
  -- ---------------------------------------------------------------- ДАННЫЕ ТЗ
  select count(*) into cnt from products where catalog_key is not null and price is not null and cost_price is not null; assert cnt=14, 'prices+cost for 14 products: '||cnt;
  select count(*) into cnt from wholesale_tiers w join products p on p.id=w.product_id where p.catalog_key is not null; assert cnt=84, 'tiers 14x6: '||cnt;
  select count(*) into cnt from products where catalog_key='elfliq-30ml-5' and price=15 and cost_price=3.40; assert cnt=1, 'Elfliq price/cost from spec';

  -- ---------------------------------------------------------------- ГРАНИЦЫ СТУПЕНЕЙ
  assert (select array_agg((_tier_of(n)->>'min')::int order by n) from unnest(array[1,2,3,4,5,6,7,8,9,20,21,49,50]) n)
         = array[1,1,3,3,5,5,7,7,9,9,21,21,50], 'tier boundaries';

  em := pg_temp.k('elfliq-30ml-5','Apple Peach','muenchen');
  xr := pg_temp.k('xros-5','Blue Silk','muenchen');
  -- 2 Elfliq + 1 XROS 5 = 3 единицы → ступень 3–4 для ВСЕХ позиций
  r := _pricing('muenchen', jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',2), jsonb_build_object('inventory_id',xr,'quantity',1)));
  assert (r->>'total')::numeric = 59.5, 'mixed 3 units: 2x14 + 1x31.50 = 59.50, got '||(r->>'total');
  assert r->>'tier_label' = '3–4 шт.', 'tier label 3–4';
  -- 1 + 1 = 2 единицы → розница
  r := _pricing('muenchen', jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',1), jsonb_build_object('inventory_id',xr,'quantity',1)));
  assert (r->>'total')::numeric = 48, 'retail 15+33=48, got '||(r->>'total');
  -- 4 + 5 = 9 единиц → ступень 9–20: 4x11 + 5x28 = 184
  r := _pricing('muenchen', jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',4), jsonb_build_object('inventory_id',xr,'quantity',5)));
  assert (r->>'total')::numeric = 184, '9 units: 44+140=184, got '||(r->>'total');
  -- 50 единиц → согласование, итог не назначен
  r := _pricing('muenchen', jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',50)));
  assert (r->>'approval_required')::boolean and r->'total' = 'null'::jsonb, '50 units: approval, total null';
  -- товар из другого города
  perform pg_temp.fails(format('select _pricing(%L,%L::jsonb)', 'hannover', jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',1))::text), 'city_mismatch');

  -- ---------------------------------------------------------------- ПОЛЬЗОВАТЕЛИ И СКЛАД
  insert into users(telegram_id,first_name,city_id) values(999000333,'edit','muenchen') returning id into u;
  insert into users(telegram_id,first_name,city_id) values(999000444,'other','muenchen') returning id into u2;
  perform admin_set_stock(OWNER, em, 20, 'receipt', 'тест');

  -- ---------------------------------------------------------------- СНИМОК ЦЕНЫ
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',2)),'@e','','ek-1');
  oid := (r->>'id')::uuid;
  select total into tot from orders where id=oid; assert tot=30, 'order 2x15=30';
  select count(*) into cnt from order_items where order_id=oid and unit_cost=3.40; assert cnt=1, 'unit_cost snapshot';
  update products set price=99 where catalog_key='elfliq-30ml-5';
  select count(*) into cnt from order_items where order_id=oid and unit_price=15; assert cnt=1, 'old order keeps its price';
  update products set price=15 where catalog_key='elfliq-30ml-5';

  -- ---------------------------------------------------------------- РЕДАКТИРОВАНИЕ (new)
  r := customer_edit_order(u, oid, jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',9)), 'ek-edit-1');
  assert (r->>'total')::numeric = 99, 'edit to 9 units = 9x11 = 99, got '||(r->>'total');
  assert r->>'tier_label' = '9–20 шт.', 'tier after edit';
  select reserved_quantity into rq from inventory where id=em; assert rq=9, 'reserve follows edit: '||rq;
  r := customer_edit_order(u, oid, jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',9)), 'ek-edit-1');
  assert (r->>'duplicate')::boolean, 'same edit key must not apply twice';
  select reserved_quantity into rq from inventory where id=em; assert rq=9, 'duplicate edit must not reserve again';
  -- нехватка остатка: всё откатывается
  perform pg_temp.fails(format('select customer_edit_order(%L,%L,%L::jsonb,%L)', u, oid,
    jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',21))::text, 'ek-short'), 'insufficient_stock');
  select reserved_quantity into rq from inventory where id=em; assert rq=9, 'failed edit must leave reserve unchanged';
  select total into tot from orders where id=oid; assert tot=99, 'failed edit must leave total unchanged';
  -- чужой заказ
  perform pg_temp.fails(format('select customer_edit_order(%L,%L,%L::jsonb,%L)', u2, oid,
    jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',1))::text, 'ek-other'), 'order_not_found');
  -- уменьшение обратно до 2 единиц: резерв освобождается
  r := customer_edit_order(u, oid, jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',2)), 'ek-edit-2');
  assert (r->>'total')::numeric = 30, 'back to 2 units = 30';
  select reserved_quantity into rq from inventory where id=em; assert rq=2, 'release on decrease';
  -- журнал изменений
  select count(*) into cnt from order_edits where order_id=oid and kind='customer_edit'; assert cnt=2, 'two edit rows';

  -- ---------------------------------------------------------------- СТАТУСЫ РЕДАКТИРОВАНИЯ
  r := customer_edit_order(u, oid, jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',3)), 'ek-conf');
  assert (r->>'total')::numeric = 42, 'editable in new: 3x14=42';
  perform change_order_status(oid,'prepared',OWNER);
  perform pg_temp.fails(format('select customer_edit_order(%L,%L,%L::jsonb,%L)', u, oid,
    jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',1))::text, 'ek-prep'), 'edit_not_allowed');

  -- ---------------------------------------------------------------- ОПЛАТА: доплата
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',2)),'@e','','ek-2');
  oid2 := (r->>'id')::uuid;
  r := customer_edit_order(u, oid2, jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',9)), 'ek-unpaid');
  assert r->>'balance' is null, 'unpaid order has no balance before issue';

  -- ---------------------------------------------------------------- СОГЛАСОВАНИЕ 50+
  perform admin_set_stock(OWNER, em, 80, 'receipt', 'для 50+');
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em,'quantity',50)),'@e','','ek-50');
  oid3 := (r->>'id')::uuid;
  assert (r->>'approval_required')::boolean, '50 creates approval order';
  perform pg_temp.fails(format('select change_order_status(%L,''prepared'',%s)', oid3, OWNER), 'approval_required');
  perform pg_temp.fails(format('select approve_order_prices(%L,%s,%L::jsonb)', oid3, HANN,
    jsonb_build_array(jsonb_build_object('order_item_id',(select id from order_items where order_id=oid3),'unit_price',12))::text), 'forbidden');
  select id into oi from order_items where order_id=oid3;
  perform pg_temp.fails(format('select approve_order_prices(%L,%s,%L::jsonb)', oid3, OWNER, '[]'), 'prices_incomplete');
  perform approve_order_prices(oid3, OWNER, jsonb_build_array(jsonb_build_object('order_item_id',oi,'unit_price',12)));
  select total into tot from orders where id=oid3; assert tot=600, 'approved total 50x12=600, got '||tot;
  assert not (select approval_required from orders where id=oid3), 'approval flag cleared';
  perform change_order_status(oid3,'prepared',OWNER);
  perform change_order_status(oid3,'cancelled',OWNER);

  -- ---------------------------------------------------------------- ПРАВА ВЛАДЕЛЬЦА/АДМИНА
  select id into pid from products where catalog_key='elfliq-30ml-5';
  perform pg_temp.fails(format('select admin_set_product_prices(%s,%L,1,1)', HANN, pid), 'forbidden');
  perform pg_temp.fails(format('select admin_set_tiers(%s,%L,%L::jsonb)', HANN, pid, '[]'), 'forbidden');
  select count(*) into n0 from audit_log;
  perform admin_set_product_prices(OWNER, pid, 15, 3.40);
  select count(*) into cnt from audit_log; assert cnt=n0+1, 'price change must be audited';
  assert (admin_catalog(HANN)->>'is_owner')::boolean = false, 'hannover is not owner';
  assert (select (p->>'cost_price') is null from jsonb_array_elements(admin_catalog(HANN)->'products') p where p->>'catalog_key'='elfliq-30ml-5'),
         'hannover must not see cost price';
  assert (select (p->>'cost_price')::numeric from jsonb_array_elements(admin_catalog(OWNER)->'products') p where p->>'catalog_key'='elfliq-30ml-5') = 3.40,
         'owner sees cost price';
  perform admin_set_tiers(OWNER, pid, jsonb_build_array(jsonb_build_object('min',3,'price',14)));

  raise notice 'ALL TESTS PASSED';
end $$;

rollback;
