-- =============================================================================
-- MoonVape · автотесты миграций 0017 (удаление рефералки) и 0018 (финансы)
-- Запускать ТОЛЬКО на тестовой базе, после 0018. Всё откатывается (rollback в конце).
-- Требует: в каталоге есть активный товар в городе muenchen с ценой и cost_price.
-- В конце должно появиться сообщение: ALL FINANCE TESTS PASSED.
-- Если упало — ничего не сохранится: rollback выполняется всегда.
--
-- СТАТУС: этот файл НЕ запускался (в среде разработки нет PostgreSQL).
-- =============================================================================

begin;

do $$
declare
  owner bigint := 7858672760;
  inv record;
  uid uuid; oid uuid; e1 bigint;
  r jsonb; s0 jsonb; s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb;
  today date := (now() at time zone 'Europe/Berlin')::date;
  ok boolean;
begin
  -- 1. Рефералка удалена из БД (функции и триггер); миграции записаны
  assert (select count(*) from pg_proc where proname in
          ('referral_register','referral_options','redeem_referral','admin_referrals','_referral_on_issue','_referral_qualifies')) = 0,
         'referral functions must be removed';
  assert not exists(select 1 from pg_trigger where tgname = 'trg_referral_on_issue'), 'referral trigger must be removed';
  assert exists(select 1 from schema_migrations where version = '0017') and exists(select 1 from schema_migrations where version = '0018'),
         'migrations 0017 and 0018 must be recorded';

  -- 2. Фикстура: активный товар с ценой и себестоимостью в München
  select i.id inv_id, i.product_id, pr.name pname, coalesce(v.price, pr.price) price, pr.cost_price cost
    into inv
    from inventory i
    join products pr on pr.id = i.product_id and pr.active
    left join product_variants v on v.id = i.variant_id
    where i.city_id = 'muenchen' and coalesce(v.price, pr.price) is not null and pr.cost_price is not null
    limit 1;
  assert inv.inv_id is not null, 'fixture: need a priced product with cost in muenchen';

  insert into users(telegram_id, first_name, city_id)
  values(990001, 'FinanceTest', 'muenchen')
  on conflict (telegram_id) do update set city_id = 'muenchen'
  returning id into uid;

  -- Базовые значения отчёта за сегодня (сравниваем разницу, а не абсолютные числа)
  s0 := finance_summary(owner, 'muenchen', today, today, null, null);

  -- 3. Выданный оплаченный заказ: 2 шт. по цене inv.price, себестоимость inv.cost
  insert into orders(number, user_id, telegram_id, city_id, contact, address, delivery_service, comment,
                     idempotency_key, status, total, paid_at, paid_amount)
  values('TEST-PAID-' || gen_random_uuid()::text, uid, 990001, 'muenchen', 'test', '', '', '',
         'test-paid-' || gen_random_uuid()::text, 'issued', inv.price * 2, now(), inv.price * 2)
  returning id into oid;
  insert into order_items(order_id, product_id, inventory_id, product_name, variant_name, flavor_name, quantity,
                          unit_price, base_price, is_wholesale, tier_label, unit_cost)
  values(oid, inv.product_id, inv.inv_id, inv.pname, null, null, 2, inv.price, inv.price, false, '1-2', inv.cost);

  s1 := finance_summary(owner, 'muenchen', today, today, null, null);
  assert (s1->'current'->>'revenue')::numeric - (s0->'current'->>'revenue')::numeric = inv.price * 2,
         'revenue must equal sum of issued line amounts';
  assert (s1->'current'->>'cogs')::numeric - (s0->'current'->>'cogs')::numeric = inv.cost * 2,
         'cogs must equal unit_cost * quantity';
  assert (s1->'current'->>'gross_profit')::numeric - (s0->'current'->>'gross_profit')::numeric = (inv.price - inv.cost) * 2,
         'gross profit = revenue - cogs';

  -- 4. Неоплаченный открытый заказ: в выручку не входит, показывается отдельно
  insert into orders(number, user_id, telegram_id, city_id, contact, address, delivery_service, comment,
                     idempotency_key, status, total)
  values('TEST-OPEN-' || gen_random_uuid()::text, uid, 990001, 'muenchen', 'test', '', '', '',
         'test-open-' || gen_random_uuid()::text, 'new', 99);
  s2 := finance_summary(owner, 'muenchen', today, today, null, null);
  assert (s2->'current'->>'revenue')::numeric = (s1->'current'->>'revenue')::numeric, 'unpaid order must not be revenue';
  assert (s2->'unpaid_open'->>'amount')::numeric - (s1->'unpaid_open'->>'amount')::numeric = 99, 'unpaid order must be shown separately';

  -- 5. Расход: проведение, повтор с тем же ключом не создаёт вторую запись
  r := finance_post_entry(owner, 'expense', 100, 'muenchen', 'Тест', 'тестовый расход', 'test-key-000001');
  assert (r->>'duplicate') = 'false', 'first posting is not a duplicate';
  e1 := (r->>'id')::bigint;
  r := finance_post_entry(owner, 'expense', 100, 'muenchen', 'Тест', 'тестовый расход', 'test-key-000001');
  assert (r->>'duplicate') = 'true', 'same idempotency key must not create a second entry';
  assert (select count(*) from finance_entries where idempotency_key = 'test-key-000001') = 1, 'exactly one entry for the key';

  s3 := finance_summary(owner, 'muenchen', today, today, null, null);
  assert (s3->'current'->>'expenses')::numeric - (s2->'current'->>'expenses')::numeric = 100, 'expense must reduce net profit';
  assert (s3->'current'->>'net_profit')::numeric - (s2->'current'->>'net_profit')::numeric = -100, 'net = gross - expenses';

  -- 6. Журнал неизменяем: нельзя менять сумму и удалять
  ok := false;
  begin update finance_entries set amount = 1 where id = e1; exception when others then ok := true; end;
  assert ok, 'finance entry amount must not be updatable';
  ok := false;
  begin delete from finance_entries where id = e1; exception when others then ok := true; end;
  assert ok, 'finance entry must not be deletable';

  -- 7. Сторно: исходная помечается reversed, сумма за период обнуляется, повтор запрещён
  r := finance_reverse_entry(owner, e1, 'Ошибочная сумма', 'test-rev-000001');
  assert (r->>'duplicate') = 'false', 'first reversal is not a duplicate';
  assert (select status from finance_entries where id = e1) = 'reversed', 'original must be marked reversed';
  s4 := finance_summary(owner, 'muenchen', today, today, null, null);
  assert (s4->'current'->>'expenses')::numeric = (s2->'current'->>'expenses')::numeric, 'original + reversal net to zero';

  ok := false;
  begin perform finance_reverse_entry(owner, e1, 'Повторно', 'test-rev-000002');
  exception when others then ok := sqlerrm = 'already_reversed'; end;
  assert ok, 'second reversal of the same entry must be refused';

  ok := false;
  begin perform finance_reverse_entry(owner, (select id from finance_entries where reverses_id = e1), 'Сторно сторно', 'test-rev-000003');
  exception when others then ok := sqlerrm = 'cannot_reverse_reversal'; end;
  assert ok, 'reversal of a reversal must be refused';

  -- 8. Права: не владелец не может провести или отчитаться (сообщение forbidden)
  ok := false;
  begin perform finance_post_entry(12345, 'expense', 5, null, 'Тест', '', 'test-key-000009');
  exception when others then ok := sqlerrm = 'forbidden'; end;
  assert ok, 'non-owner must not post entries';
  ok := false;
  begin perform finance_summary(12345, 'muenchen', today, today, null, null);
  exception when others then ok := sqlerrm = 'forbidden'; end;
  assert ok, 'non-owner must not read finance summary';

  -- 9. Некорректный период
  ok := false;
  begin perform finance_summary(owner, 'muenchen', today, today - 1, null, null);
  exception when others then ok := sqlerrm = 'bad_period'; end;
  assert ok, 'reversed period must be refused';

  raise notice 'ALL FINANCE TESTS PASSED';
end $$;

rollback;
