-- Автотесты миграций 0002–0003. Выполнять в SQL Editor ПОСЛЕ 0002 и 0003.
-- Всё откатывается (rollback). Успех: сообщение "ALL TESTS PASSED".
-- Владелец 7858672760, admin Hannover 7050120446 — как в migrations/0003.
begin;

create function pg_temp.fails(q text, expected text) returns void language plpgsql as $$
begin
  execute q;
  raise exception 'expected error %', expected;
exception when others then
  if sqlerrm <> expected then raise exception 'wanted error "%", got "%"', expected, sqlerrm; end if;
end $$;

create function pg_temp.inv(prod text, vname text, city text) returns uuid language sql as $$
  select i.id from inventory i join products p on p.id=i.product_id left join product_variants v on v.id=i.variant_id
  where p.name=prod and v.name=vname and i.city_id=city $$;

do $$
declare
  OWNER bigint := 7858672760; HANN bigint := 7050120446;
  u uuid; u2 uuid; r jsonb; oid uuid; oid2 uuid; iq int; rq int; cnt int; tot numeric; s jsonb; ts timestamptz; exp_rcp int;
  em_m uuid; em_h uuid; ch_h uuid;
begin
  -- ---------------------------------------------------------------- КАТАЛОГ
  select count(*) into cnt from products where catalog_key is not null; assert cnt=14, 'new products: '||cnt;
  select count(*) into cnt from product_variants v join products p on p.id=v.product_id where p.catalog_key is not null; assert cnt=200, 'new variants: '||cnt;
  select count(*) into cnt from inventory i join products p on p.id=i.product_id where p.catalog_key is not null; assert cnt=400, 'new inventory rows: '||cnt;
  select count(*) into cnt from inventory i join products p on p.id=i.product_id
    where p.catalog_key is not null and (i.quantity<>0 or i.reserved_quantity<>0); assert cnt=0, 'new stock must be 0 in both cities';
  select count(*) into cnt from products where catalog_key is null and active; assert cnt=0, 'legacy products must be archived';
  select count(*) into cnt from inventory i join products p on p.id=i.product_id
    where p.catalog_key is null and i.quantity<>i.reserved_quantity; assert cnt=0, 'legacy stock must be zeroed';
  select count(*) into cnt from product_variants v join products p on p.id=v.product_id
    where p.catalog_key='elfliq-30ml-5'; assert cnt=57, 'Elfliq variants: '||cnt;

  -- ---------------------------------------------------------------- ПОКУПАТЕЛИ
  insert into users(telegram_id,first_name,city_id,bot_started_at) values(999000111,'test','muenchen',now()) returning id into u;
  insert into users(telegram_id,first_name,city_id) values(999000222,'other','hannover') returning id into u2;

  em_m := pg_temp.inv('Elfliq 30ml 5%','Apple Peach','muenchen');
  em_h := pg_temp.inv('Elfliq 30ml 5%','Apple Peach','hannover');
  ch_h := pg_temp.inv('Chaser Black 30ml 5%','BALI','hannover');
  update products set price=15 where catalog_key='elfliq-30ml-5';

  -- ---------------------------------------------------------------- НЕЗАВИСИМЫЕ ОСТАТКИ
  perform admin_set_stock(OWNER, em_m, 10, 'receipt', 'тест поступления');
  select quantity into iq from inventory where id=em_h; assert iq=0, 'Hannover must stay 0 after Munich receipt';
  s := get_catalog('muenchen'); assert jsonb_array_length(s->'products')=1, 'Munich must show Elfliq';
  assert jsonb_array_length(s->'categories')=1, 'Munich must show category';
  s := get_catalog('hannover'); assert jsonb_array_length(s->'products')=0, 'Hannover must hide everything';
  assert jsonb_array_length(s->'categories')=0, 'empty category must be hidden in Hannover';

  -- ---------------------------------------------------------------- СКРЫТИЕ И ПОЯВЛЕНИЕ КАТЕГОРИИ
  perform admin_set_stock(OWNER, em_m, 0, 'adjust', 'распродано');
  s := get_catalog('muenchen'); assert jsonb_array_length(s->'categories')=0, 'category must hide when empty';
  select count(*) into cnt from products where catalog_key='elfliq-30ml-5' and active; assert cnt=1, 'category data must not be deleted';
  perform admin_set_stock(OWNER, em_m, 10, 'receipt', 'вернули');
  s := get_catalog('muenchen'); assert jsonb_array_length(s->'categories')=1, 'category must reappear after receipt';

  -- ---------------------------------------------------------------- ПРАВА
  perform pg_temp.fails(format('select admin_set_stock(%s, %L, 5, ''adjust'', null)', HANN, em_m), 'forbidden');
  perform pg_temp.fails(format('select admin_set_stock(%s, %L, 5, ''adjust'', null)', 123456, em_m), 'forbidden');
  perform pg_temp.fails(format('select admin_transfer_stock(%s, %L, %L, 1, null)', HANN, em_m, em_h), 'forbidden');
  perform pg_temp.fails(format('select record_cash_transfer(%s, %L, 1, ''x'', ''k-hann'')', HANN, 'hannover'), 'forbidden');
  perform admin_set_stock(HANN, em_h, 3, 'receipt', 'приёмка Hannover');
  select quantity into iq from inventory where id=em_m; assert iq=10, 'Munich untouched by Hannover admin';

  -- ---------------------------------------------------------------- ОШИБКИ ЗАКАЗА
  perform pg_temp.fails(format('select create_order(%L,%L,%L::jsonb,''@t'','''',''k-city'')', u, 'hannover',
    jsonb_build_array(jsonb_build_object('inventory_id',em_h,'quantity',1))::text), 'city_mismatch');
  perform admin_set_stock(OWNER, ch_h, 5, 'receipt', 'тест без цены');
  update products set price=null where catalog_key='chaser-black-30ml-5';  -- с 0004 у товаров есть цены: снимаем для теста
  perform pg_temp.fails(format('select create_order(%L,%L,%L::jsonb,''@t'','''',''k-price'')', u2, 'hannover',
    jsonb_build_array(jsonb_build_object('inventory_id',ch_h,'quantity',1))::text), 'price_missing');

  -- ---------------------------------------------------------------- ОПТ
  perform admin_set_stock(OWNER, em_m, 60, 'receipt', 'опт');
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em_m,'quantity',3)),'@t','','k-opt3');
  select total into tot from orders where id=(r->>'id')::uuid; assert tot=42, 'wholesale 3 x 14 must be 42, got '||tot;
  perform change_order_status((r->>'id')::uuid,'cancelled',OWNER);
  -- с 0004: 50+ единиц не отклоняются, а сохраняются как заказ на согласование (цена не назначена)
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em_m,'quantity',50)),'@t','','k-opt50');
  assert (r->>'approval_required')::boolean, '50 units must require approval';
  perform change_order_status((r->>'id')::uuid,'cancelled',OWNER);
  perform admin_set_stock(OWNER, em_m, 10, 'adjust', 'возврат к 10');

  -- ---------------------------------------------------------------- ЗАКАЗ, РЕЗЕРВ, ИДЕМПОТЕНТНОСТЬ
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em_m,'quantity',2)),'@t','','k-A');
  oid := (r->>'id')::uuid; assert (r->>'duplicate')::boolean = false;
  select quantity, reserved_quantity into iq, rq from inventory where id=em_m; assert iq=10 and rq=2, 'reserve 10/2';
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em_m,'quantity',2)),'@t','','k-A');
  assert (r->>'duplicate')::boolean and (r->>'id')::uuid=oid, 'same key must return same order';
  select reserved_quantity into rq from inventory where id=em_m; assert rq=2, 'duplicate must not reserve twice';
  select total into tot from orders where id=oid; assert tot=30, 'total 2 x 15 = 30';
  select count(*) into cnt from orders where city_id='muenchen' and paid_at is null and status='new';
  assert cnt>=1, 'order must be stored with city';

  -- ---------------------------------------------------------------- ОПЛАТА → ВЫДАЧА → ВОЗВРАТ
  -- Не оплачен — статус сам по себе не делает заказ оплаченным
  select paid_at into ts from orders where id=oid; assert ts is null, 'new order must not be paid';
  perform mark_order_paid(oid, OWNER);
  perform pg_temp.fails(format('select mark_order_paid(%L,%s)', oid, OWNER), 'already_paid');
  perform change_order_status(oid,'confirmed',OWNER);
  perform change_order_status(oid,'prepared',OWNER);
  perform change_order_status(oid,'issued',OWNER);
  select quantity, reserved_quantity into iq, rq from inventory where id=em_m; assert iq=8 and rq=0, 'issued: 8/0, got '||iq||'/'||rq;
  perform pg_temp.fails(format('select change_order_status(%L,''cancelled'',%s)', oid, HANN), 'forbidden');
  perform change_order_status(oid,'returned',OWNER);
  select quantity into iq from inventory where id=em_m; assert iq=10, 'return restores stock to 10';
  select refunded_amount into tot from orders where id=oid; assert tot=30, 'refund must equal paid amount';

  -- ---------------------------------------------------------------- ОТМЕНА ОСВОБОЖДАЕТ РЕЗЕРВ
  r := create_order(u2,'hannover',jsonb_build_array(jsonb_build_object('inventory_id',em_h,'quantity',2)),'@t','','k-H1');
  oid2 := (r->>'id')::uuid;
  select reserved_quantity into rq from inventory where id=em_h; assert rq=2, 'hannover reserve 2';
  perform change_order_status(oid2,'cancelled',HANN);
  select quantity, reserved_quantity into iq, rq from inventory where id=em_h; assert iq=3 and rq=0, 'cancel releases: 3/0';

  -- ---------------------------------------------------------------- ВЗАИМОРАСЧЁТЫ
  r := create_order(u,'muenchen',jsonb_build_array(jsonb_build_object('inventory_id',em_m,'quantity',1)),'@t','','k-B');
  perform mark_order_paid((r->>'id')::uuid, OWNER);
  perform change_order_status((r->>'id')::uuid,'confirmed',OWNER);
  s := city_settlement(OWNER,'muenchen');
  assert (s->>'collected')::numeric = 45, 'collected 30+15=45, got '||(s->>'collected');
  assert (s->>'refunded')::numeric = 30, 'refunded 30';
  assert (s->>'owed')::numeric = 15, 'owed 15';
  perform pg_temp.fails(format('select record_cash_transfer(%s,%L,20,''много'',''t-over'')', OWNER, 'muenchen'), 'exceeds_balance');
  r := record_cash_transfer(OWNER,'muenchen',15,'передача','t-1');
  assert (r->>'duplicate')::boolean = false, 'first transfer';
  r := record_cash_transfer(OWNER,'muenchen',15,'передача','t-1');
  assert (r->>'duplicate')::boolean = true, 'same key must not double-count';
  s := city_settlement(OWNER,'muenchen'); assert (s->>'owed')::numeric = 0, 'owed must be 0 after transfer';
  -- Hannover: неоплаченный заказ не попадает в сумму к передаче
  s := city_settlement(HANN,'hannover'); assert (s->>'owed')::numeric = 0, 'unpaid orders are not collected money';

  -- ---------------------------------------------------------------- РАССЫЛКА
  select count(*) into exp_rcp from users where city_id='muenchen' and bot_started_at is not null and notify_stock and not bot_blocked;
  r := create_broadcast(OWNER,'muenchen','Новое поступление','{}'::uuid[],'bc-1');
  assert (r->>'recipients')::int = exp_rcp, 'recipients must match eligible users: '||(r->>'recipients')||' vs '||exp_rcp;
  assert exp_rcp>=1, 'test user must be eligible';
  r := create_broadcast(OWNER,'muenchen','Новое поступление','{}'::uuid[],'bc-1');
  assert (r->>'duplicate')::boolean, 'same key must not send twice';
  perform pg_temp.fails(format('select create_broadcast(%s,%L,''x'',''{}''::uuid[],''bc-2'')', OWNER, 'muenchen'), 'broadcast_cooldown');
  perform pg_temp.fails(format('select create_broadcast(%s,%L,''x'',''{}''::uuid[],''bc-3'')', HANN, 'muenchen'), 'forbidden');

  -- ---------------------------------------------------------------- ИСТОРИЯ СКЛАДА
  select count(*) into cnt from inventory_transactions where inventory_id=em_m and op='return'; assert cnt=1, 'return must be journaled';
  select count(*) into cnt from inventory_transactions where inventory_id=em_m and op='receipt' and reason='вернули'; assert cnt=1, 'receipt must be journaled with reason';

  raise notice 'ALL TESTS PASSED';
end $$;

rollback;
