-- Автотесты бизнес-логики. Выполнять в Supabase SQL Editor ПОСЛЕ schema.sql и seed.sql.
-- Всё выполняется в транзакции и откатывается (rollback) — данные не меняются.
-- Успех: в конце сообщение "ALL TESTS PASSED". Ошибка: исключение с описанием проваленной проверки.
begin;

create function pg_temp.inv(p text, f text) returns uuid language sql as $$
  select i.id from inventory i join products pr on pr.id=i.product_id left join product_flavors fl on fl.id=i.flavor_id
  where pr.name=p and (f is null or fl.name=f) limit 1 $$;
create function pg_temp.it(a uuid, n int) returns jsonb language sql as $$ select jsonb_build_object('inventory_id',a,'quantity',n) $$;
create function pg_temp.mk(u uuid, items jsonb, k text) returns jsonb language sql as $$ select create_order(u,items,'c','a','d','',k) $$;
-- создаёт заказ, возвращает цену оптовой позиции и отменяет заказ (освобождая резерв)
create function pg_temp.chk(u uuid, items jsonb, k text) returns numeric language plpgsql as $$
declare r jsonb; p numeric;
begin
  r := pg_temp.mk(u, items, k);
  select max(unit_price) into p from order_items where order_id=(r->>'id')::uuid and is_wholesale;
  perform change_order_status((r->>'id')::uuid,'cancelled','test');
  return p;
end $$;
create function pg_temp.fails(q text, expected text) returns void language plpgsql as $$
begin
  execute q;
  raise exception 'expected error %', expected;
exception when others then
  if sqlerrm <> expected then raise exception 'wanted error "%", got "%"', expected, sqlerrm; end if;
end $$;

do $$
declare
  u uuid; u2 uuid; r jsonb; oid uuid; num text; q int; rq int; sold int; cnt int; tot numeric;
  em uuid := pg_temp.inv('Elfliq','Mango'); eb uuid := pg_temp.inv('Elfliq','Berry Mix');
  vg uuid := pg_temp.inv('Vozol','Grape Ice'); x5 uuid := pg_temp.inv('Vaporesso XROS 5',null);
  ch uuid := pg_temp.inv('Chaser','Mint'); wm uuid := pg_temp.inv('Elfbar Ice King 30000','Watermelon Ice');
begin
  insert into users(telegram_id,first_name) values(999000111,'test') returning id into u;
  insert into users(telegram_id,first_name) values(999000222,'other') returning id into u2;

  -- ОПТОВАЯ СИСТЕМА
  assert pg_temp.chk(u, jsonb_build_array(pg_temp.it(em,1)), 'w1') = 15, '1 Elfliq must be 15';
  assert pg_temp.chk(u, jsonb_build_array(pg_temp.it(em,2)), 'w2') = 15, '2 Elfliq must be 15';
  assert pg_temp.chk(u, jsonb_build_array(pg_temp.it(em,3)), 'w3') = 14, '3 Elfliq must be 14';
  assert pg_temp.chk(u, jsonb_build_array(pg_temp.it(em,2), pg_temp.it(vg,3)), 'w4') = 13, '2 Elfliq + 3 Vozol must be 13';
  assert pg_temp.chk(u, jsonb_build_array(pg_temp.it(em,4), pg_temp.it(vg,5)), 'w5') = 11, '4 Elfliq + 5 Vozol must be 11';
  assert pg_temp.chk(u, jsonb_build_array(pg_temp.it(em,10), pg_temp.it(vg,15)), 'w6') = 9, '10 Elfliq + 15 Vozol must be 9';
  perform pg_temp.fails(format('select pg_temp.mk(%L,%L::jsonb,%L)', u, jsonb_build_array(pg_temp.it(em,20), pg_temp.it(eb,20), pg_temp.it(vg,10))::text, 'w50'), 'wholesale_manager');

  -- прочие товары не участвуют в опте: 2 Elfliq (15) + XROS 5 (33) = 63; 3 Elfliq (14) + XROS 5 = 75
  r := pg_temp.mk(u, jsonb_build_array(pg_temp.it(em,2), pg_temp.it(x5,1)), 'o1');
  select total into tot from orders where id=(r->>'id')::uuid; assert tot = 63, 'mixed order total must be 63, got '||tot;
  perform change_order_status((r->>'id')::uuid,'cancelled','test');
  r := pg_temp.mk(u, jsonb_build_array(pg_temp.it(em,3), pg_temp.it(x5,1)), 'o2');
  select total into tot from orders where id=(r->>'id')::uuid; assert tot = 75, 'mixed order total must be 75, got '||tot;
  perform change_order_status((r->>'id')::uuid,'cancelled','test');

  -- СКЛАД: нет в наличии / нельзя заказать больше доступного
  perform pg_temp.fails(format('select pg_temp.mk(%L,%L::jsonb,%L)', u, jsonb_build_array(pg_temp.it(wm,1))::text, 's0'), 'insufficient_stock');
  perform set_stock(ch, 3);
  perform pg_temp.fails(format('select pg_temp.mk(%L,%L::jsonb,%L)', u, jsonb_build_array(pg_temp.it(ch,4))::text, 's4'), 'insufficient_stock');

  -- РЕЗЕРВ: quantity=5, заказ 3
  perform set_stock(ch, 5);
  r := pg_temp.mk(u, jsonb_build_array(pg_temp.it(ch,3)), 'r1'); oid := (r->>'id')::uuid; num := r->>'number';
  assert num ~ '^MOON-[0-9]{8}-[0-9]{4}$', 'bad order number '||num;
  select quantity, reserved_quantity into q, rq from inventory where id=ch; assert q=5 and rq=3, 'after create: 5/3';
  perform pg_temp.fails(format('select pg_temp.mk(%L,%L::jsonb,%L)', u, jsonb_build_array(pg_temp.it(ch,3))::text, 'r1b'), 'insufficient_stock'); -- доступно только 2
  perform change_order_status(oid,'processing','test');
  select quantity, reserved_quantity into q, rq from inventory where id=ch; assert q=5 and rq=3, 'processing keeps reserve 5/3';
  perform change_order_status(oid,'completed','test');
  select quantity, reserved_quantity into q, rq from inventory where id=ch; assert q=2 and rq=0, 'completed: 2/0';
  perform pg_temp.fails(format('select change_order_status(%L,''cancelled'')', oid), 'bad_transition');

  r := pg_temp.mk(u, jsonb_build_array(pg_temp.it(ch,2)), 'r2');
  perform pg_temp.fails(format('select change_order_status(%L,''completed'')', (r->>'id')::uuid), 'bad_transition'); -- new -> completed запрещён
  perform change_order_status((r->>'id')::uuid,'cancelled','test');
  select quantity, reserved_quantity into q, rq from inventory where id=ch; assert q=2 and rq=0, 'cancelled releases reserve: 2/0';

  -- ПОПУЛЯРНОСТЬ: считаются только выполненные заказы (3 шт.), отменённые — нет
  select (p->>'sold')::int into sold from jsonb_array_elements(get_catalog('')->'products') p where p->>'name'='Chaser';
  assert sold = 3, 'Chaser sold must be 3, got '||sold;

  -- ИСТОРИЯ СКЛАДА И СТАТУСОВ
  select count(*) into cnt from inventory_transactions where order_id=oid; assert cnt = 2, 'reserve + writeoff expected';
  select count(*) into cnt from order_status_history where order_id=oid; assert cnt = 3, 'new, processing, completed expected';

  -- IDEMPOTENCY
  perform set_stock(ch, 10);
  r := pg_temp.mk(u, jsonb_build_array(pg_temp.it(ch,1)), 'same-key'); oid := (r->>'id')::uuid;
  r := pg_temp.mk(u, jsonb_build_array(pg_temp.it(ch,1)), 'same-key');
  assert (r->>'duplicate')::boolean and (r->>'id')::uuid = oid, 'duplicate key must return the same order';
  select count(*) into cnt from orders where idempotency_key='same-key'; assert cnt = 1, 'only one order for same key';
  select reserved_quantity into rq from inventory where id=ch; assert rq = 1, 'duplicate must not reserve twice';

  -- КОРЗИНА: сохранение, чтение, очистка после заказа, изоляция пользователей
  perform save_cart(u, jsonb_build_array(pg_temp.it(em,2), pg_temp.it(ch,1)));
  assert jsonb_array_length(get_cart(u)) = 2, 'cart must hold 2 lines';
  assert jsonb_array_length(get_cart(u2)) = 0, 'other user cart must be empty';
  perform save_cart(u, jsonb_build_array(pg_temp.it(em,5)));
  assert jsonb_array_length(get_cart(u)) = 1, 'save_cart replaces content';
  perform pg_temp.mk(u, jsonb_build_array(pg_temp.it(em,1)), 'cart-clear');
  assert jsonb_array_length(get_cart(u)) = 0, 'cart must be cleared after order';

  -- НЕАКТИВНЫЙ ТОВАР нельзя заказать
  update products set active=false where name='Cuba';
  perform pg_temp.fails(format('select pg_temp.mk(%L,%L::jsonb,%L)', u, jsonb_build_array(pg_temp.it(pg_temp.inv('Cuba','Mint'),1))::text, 'inactive'), 'item_not_found');

  raise notice 'ALL TESTS PASSED';
end $$;

rollback;
