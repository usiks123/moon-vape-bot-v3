-- =============================================================================
-- MoonVape · миграция 0018 · финансы: журнал операций, отчёты по выручке и прибыли
-- Запускать ПОСЛЕ 0017. Один Run в SQL Editor. Перед запуском — резервная копия БД.
--
-- Модель учёта (единая):
--   * Выручка = сумма строк выданных заказов (status='issued'), дата признания = paid_at
--     (выдача одновременно отмечает оплату, см. миграции 0006 и 0012).
--   * Себестоимость продаж = сумма order_items.unit_cost * quantity по тем же строкам.
--     unit_cost — снимок себестоимости товара на момент создания заказа (миграция 0004).
--   * Валовая прибыль = выручка − себестоимость продаж.
--   * Чистая прибыль = валовая прибыль − расходы (журнал, op_type='expense').
--   * Продажи в журнал НЕ дублируются: они уже есть в заказах. Журнал хранит ручные операции:
--     расходы, внесения и изъятия из кассы. Неоплаченные заказы выручкой не считаются.
--   * Журнал неизменяем: записи не удаляются и не редактируются. Ошибка исправляется
--     сторно-записью (reverses_id): исходная запись остаётся в истории и в своём периоде,
--     сторно уменьшает итог в периоде исправления.
--
-- Доступ: все функции отчётов и журнала — только владелец (как и себестоимость).
-- Права выполнения — только service_role (backend).
-- =============================================================================

do $$ begin
  if exists(select 1 from schema_migrations where version='0018') then raise exception 'migration 0018 already applied'; end if;
  if not exists(select 1 from schema_migrations where version='0017') then raise exception 'run 0017 first'; end if;
end $$;

-- ----------------------------------------------------------------- Журнал финансовых операций
create table if not exists finance_entries(
  id bigserial primary key,
  op_type text not null check (op_type in ('expense','cash_in','cash_out')),
  amount numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  currency text not null default 'EUR' check (currency = 'EUR'),
  occurred_at timestamptz not null default now(),
  city_id text references cities(id),                 -- null = операция по всей сети
  category text not null default '',
  description text not null default '',
  reason text not null default '',                    -- обязательна для сторно
  actor bigint not null,
  status text not null default 'posted' check (status in ('posted','reversed')),
  reverses_id bigint references finance_entries(id),  -- сторно ссылается на исходную запись
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  check (op_type <> 'expense' or nullif(trim(category),'') is not null),
  check (reverses_id is null or length(trim(reason)) > 0),
  check (reverses_id is null or reverses_id <> id)
);
create index if not exists finance_entries_period_idx on finance_entries(occurred_at);
create index if not exists finance_entries_city_idx on finance_entries(city_id, occurred_at);

-- Защита журнала: нельзя удалить запись, нельзя менять её поля.
-- Единственное допустимое изменение — статус posted → reversed (после сторно).
create or replace function _finance_guard() returns trigger language plpgsql set search_path=public as $$
begin
  if tg_op = 'DELETE' then raise exception 'finance_immutable'; end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then raise exception 'finance_immutable'; end if;
  if old.status = 'reversed' and new.status is distinct from 'reversed' then raise exception 'finance_immutable'; end if;
  return new;
end $$;

drop trigger if exists trg_finance_guard on finance_entries;
create trigger trg_finance_guard before update or delete on finance_entries
for each row execute function _finance_guard();

alter table finance_entries enable row level security;   -- без политик: доступ только через service_role

-- ----------------------------------------------------------------- Проверки и периоды
create or replace function _finance_owner(p_actor bigint) returns void language plpgsql stable set search_path=public as $$
begin
  if not exists(select 1 from admins where telegram_id=p_actor and role='owner' and is_active) then raise exception 'forbidden'; end if;
end $$;

-- Период в днях по Берлину: [начало первого дня, начало дня после последнего).
create or replace function _fin_window(p_from date, p_to date) returns table(win_from timestamptz, win_to timestamptz)
language plpgsql stable set search_path=public as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'bad_period'; end if;
  return query select (p_from::timestamp) at time zone 'Europe/Berlin', ((p_to + 1)::timestamp) at time zone 'Europe/Berlin';
end $$;

-- ----------------------------------------------------------------- Запись в журнал
-- Расход, внесение или изъятие. Повтор с тем же ключом не создаёт вторую запись.
create or replace function finance_post_entry(p_actor bigint, p_op text, p_amount numeric, p_city text,
                                              p_category text, p_description text, p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e finance_entries%rowtype; cat text := nullif(trim(coalesce(p_category,'')),''); desc_t text := trim(coalesce(p_description,''));
begin
  perform _finance_owner(p_actor);
  select * into e from finance_entries where idempotency_key=p_key;
  if found then return jsonb_build_object('id',e.id,'duplicate',true); end if;
  if p_op is null or p_op not in ('expense','cash_in','cash_out') then raise exception 'bad_op'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'bad_amount'; end if;
  if p_op = 'expense' and cat is null then raise exception 'category_required'; end if;
  if length(desc_t) > 300 or length(coalesce(cat,'')) > 60 then raise exception 'bad_text'; end if;
  if p_city is not null and not exists(select 1 from cities where id=p_city) then raise exception 'bad_city'; end if;
  begin
    insert into finance_entries(op_type,amount,city_id,category,description,actor,idempotency_key)
    values(p_op, round(p_amount,2), p_city, coalesce(cat,''), desc_t, p_actor, p_key)
    returning * into e;
  exception when unique_violation then
    -- Параллельный повтор с тем же ключом: возвращаем уже созданную запись.
    select * into e from finance_entries where idempotency_key=p_key;
    return jsonb_build_object('id',e.id,'duplicate',true);
  end;
  return jsonb_build_object('id',e.id,'duplicate',false);
end $$;

-- Сторно: новая запись с теми же суммой и разрезом, reverses_id = исходная. Исходная → status='reversed'.
create or replace function finance_reverse_entry(p_actor bigint, p_entry bigint, p_reason text, p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o finance_entries%rowtype; r finance_entries%rowtype; rs text := trim(coalesce(p_reason,''));
begin
  perform _finance_owner(p_actor);
  select * into r from finance_entries where idempotency_key=p_key;
  if found then return jsonb_build_object('id',r.id,'duplicate',true); end if;
  if length(rs) < 5 or length(rs) > 300 then raise exception 'reason_required'; end if;
  -- Блокировка исходной записи: два параллельных сторно одной записи не пройдут оба.
  select * into o from finance_entries where id=p_entry for update;
  if not found then raise exception 'entry_not_found'; end if;
  if o.reverses_id is not null then raise exception 'cannot_reverse_reversal'; end if;
  if o.status <> 'posted' then raise exception 'already_reversed'; end if;
  begin
    insert into finance_entries(op_type,amount,city_id,category,description,reason,actor,reverses_id,idempotency_key)
    values(o.op_type, o.amount, o.city_id, o.category, 'Сторно записи #'||o.id, rs, p_actor, o.id, p_key)
    returning * into r;
  exception when unique_violation then
    select * into r from finance_entries where idempotency_key=p_key;
    return jsonb_build_object('id',r.id,'duplicate',true);
  end;
  update finance_entries set status='reversed' where id=o.id;
  return jsonb_build_object('id',r.id,'reversed_id',o.id,'duplicate',false);
end $$;

-- Журнал за период (новые сверху). Сторно-записи видны как есть.
create or replace function finance_entries_list(p_actor bigint, p_city text, p_date_from date, p_date_to date, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare wf timestamptz; wt timestamptz; res jsonb;
begin
  perform _finance_owner(p_actor);
  select w.win_from, w.win_to into wf, wt from _fin_window(p_date_from, p_date_to) w;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'op_type',e.op_type,'amount',e.amount,'occurred_at',e.occurred_at,
           'city_id',e.city_id,'category',e.category,'description',e.description,'reason',e.reason,'status',e.status,
           'reverses_id',e.reverses_id,'actor',e.actor) order by e.occurred_at desc, e.id desc), '[]'::jsonb)
  into res
  from (select * from finance_entries
        where occurred_at >= wf and occurred_at < wt and (p_city is null or city_id = p_city)
        order by occurred_at desc, id desc
        limit least(greatest(coalesce(p_limit,200),1),500)) e;
  return res;
end $$;

-- ----------------------------------------------------------------- Отчёт: показатели за период
-- Выручка, себестоимость, валовая прибыль по строкам выданных заказов в периоде.
-- Расходы учитываются только без фильтра по категории/товару (расход не привязан к товару).
create or replace function _fin_metrics(p_city text, p_from timestamptz, p_to timestamptz, p_category int, p_product uuid)
returns jsonb language sql stable set search_path=public as $$
with lines as (
  select o.id order_id, oi.quantity qty, oi.unit_price*oi.quantity rev, coalesce(oi.unit_cost,0)*oi.quantity cost,
         (oi.unit_cost is null) miss
  from order_items oi
  join orders o on o.id = oi.order_id
  join products pr on pr.id = oi.product_id
  where o.status = 'issued' and o.paid_at >= p_from and o.paid_at < p_to
    and (p_city is null or o.city_id = p_city)
    and (p_category is null or pr.category_id = p_category)
    and (p_product is null or oi.product_id = p_product)
),
agg as (
  select coalesce(sum(rev),0) revenue, coalesce(sum(cost),0) cogs, count(*) filter (where miss) miss_lines,
         coalesce(sum(qty),0) units, count(distinct order_id) orders
  from lines
),
ex as (
  select coalesce(sum(case when reverses_id is null then amount else -amount end),0) expenses
  from finance_entries
  where op_type = 'expense' and occurred_at >= p_from and occurred_at < p_to and (p_city is null or city_id = p_city)
)
select jsonb_build_object(
  'revenue',      round(agg.revenue,2),
  'orders',       agg.orders,
  'units',        agg.units,
  'avg_check',    case when agg.orders > 0 then round(agg.revenue / agg.orders, 2) end,
  'cogs',         round(agg.cogs,2),
  'cogs_missing_lines', agg.miss_lines,
  'gross_profit', round(agg.revenue - agg.cogs, 2),
  'margin_pct',   case when agg.revenue > 0 then round((agg.revenue - agg.cogs) / agg.revenue * 100, 1) end,
  'expenses',     case when p_category is null and p_product is null then round(ex.expenses,2) end,
  'net_profit',   case when p_category is null and p_product is null then round(agg.revenue - agg.cogs - ex.expenses,2) end
)
from agg, ex
$$;

-- ----------------------------------------------------------------- Отчёт: дашборд
create or replace function finance_summary(p_actor bigint, p_city text, p_date_from date, p_date_to date,
                                           p_category int default null, p_product uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare wf timestamptz; wt timestamptz; pf timestamptz; series jsonb; settle jsonb; unpaid jsonb; stock numeric; cash jsonb;
        filtered boolean := (p_category is not null or p_product is not null);
begin
  perform _finance_owner(p_actor);
  if p_city is not null and not exists(select 1 from cities where id=p_city) then raise exception 'bad_city'; end if;
  select w.win_from, w.win_to into wf, wt from _fin_window(p_date_from, p_date_to) w;
  pf := wf - (wt - wf);   -- предыдущий период той же длины

  -- Выручка и прибыль по дням (часовой пояс бизнеса)
  select coalesce(jsonb_agg(jsonb_build_object('day', to_char(s.day,'YYYY-MM-DD'), 'revenue', s.revenue,
           'gross_profit', s.gp, 'orders', s.n) order by s.day), '[]'::jsonb)
  into series
  from (
    select (o.paid_at at time zone 'Europe/Berlin')::date day,
           round(sum(oi.unit_price*oi.quantity),2) revenue,
           round(sum(oi.unit_price*oi.quantity - coalesce(oi.unit_cost,0)*oi.quantity),2) gp,
           count(distinct o.id) n
    from order_items oi
    join orders o on o.id = oi.order_id
    join products pr on pr.id = oi.product_id
    where o.status='issued' and o.paid_at >= wf and o.paid_at < wt
      and (p_city is null or o.city_id = p_city)
      and (p_category is null or pr.category_id = p_category)
      and (p_product is null or oi.product_id = p_product)
    group by 1
  ) s;

  -- Взаиморасчёты с городами (текущий остаток, не за период)
  select coalesce(jsonb_agg(jsonb_build_object('city_id', c.id, 'city', c.name,
           'collected', x.s->>'collected', 'transferred', x.s->>'transferred', 'owed', x.s->>'owed') order by c.sort), '[]'::jsonb)
  into settle
  from cities c cross join lateral (select _settlement(c.id) s) x
  where c.active and (p_city is null or c.id = p_city);

  -- Неоплаченные открытые заказы: это НЕ выручка, показываем отдельно
  select jsonb_build_object('orders', count(*), 'amount', round(coalesce(sum(o.total),0),2)) into unpaid
  from orders o
  where o.status in ('new','prepared') and o.paid_at is null and (p_city is null or o.city_id = p_city);

  -- Стоимость складских остатков по себестоимости (текущая)
  select coalesce(sum(i.quantity * coalesce(pr.cost_price,0)),0) into stock
  from inventory i join products pr on pr.id = i.product_id and pr.active
  where (p_city is null or i.city_id = p_city)
    and (p_category is null or pr.category_id = p_category)
    and (p_product is null or pr.id = p_product);

  -- Движение кассы за период (не относится к прибыли). Не показываем при фильтре по товару/категории.
  if filtered then cash := null;
  else
    select jsonb_build_object(
      'cash_in',  round(coalesce(sum(case when reverses_id is null then amount else -amount end) filter (where op_type='cash_in'),0),2),
      'cash_out', round(coalesce(sum(case when reverses_id is null then amount else -amount end) filter (where op_type='cash_out'),0),2))
    into cash
    from finance_entries
    where occurred_at >= wf and occurred_at < wt and (p_city is null or city_id = p_city);
  end if;

  return jsonb_build_object(
    'period',   jsonb_build_object('from', wf, 'to', wt, 'days', (p_date_to - p_date_from) + 1),
    'previous', jsonb_build_object('from', pf, 'to', wf),
    'current',  _fin_metrics(p_city, wf, wt, p_category, p_product),
    'previous_metrics', _fin_metrics(p_city, pf, wf, p_category, p_product),
    'series',   series,
    'settlement', settle,
    'unpaid_open', unpaid,
    'stock_cost', round(stock,2),
    'cash',     cash,
    'filtered', filtered
  );
end $$;

-- ----------------------------------------------------------------- Отчёт: прибыльность товаров
create or replace function finance_products(p_actor bigint, p_city text, p_date_from date, p_date_to date, p_category int default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare wf timestamptz; wt timestamptz; res jsonb;
begin
  perform _finance_owner(p_actor);
  if p_city is not null and not exists(select 1 from cities where id=p_city) then raise exception 'bad_city'; end if;
  select w.win_from, w.win_to into wf, wt from _fin_window(p_date_from, p_date_to) w;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.revenue desc, r.name), '[]'::jsonb) into res
  from (
    select pr.id product_id, pr.name, pr.category_id, pr.active,
           coalesce(s.units,0) units, coalesce(s.orders,0) orders,
           round(coalesce(s.revenue,0),2) revenue,
           round(coalesce(s.cogs,0),2) cogs,
           round(coalesce(s.revenue,0) - coalesce(s.cogs,0),2) gross_profit,
           case when coalesce(s.revenue,0) > 0 then round((s.revenue - s.cogs) / s.revenue * 100, 1) end margin_pct,
           coalesce(s.missing,0) cogs_missing_lines
    from products pr
    left join (
      select oi.product_id, sum(oi.quantity) units, count(distinct o.id) orders,
             sum(oi.unit_price*oi.quantity) revenue, sum(coalesce(oi.unit_cost,0)*oi.quantity) cogs,
             count(*) filter (where oi.unit_cost is null) missing
      from order_items oi join orders o on o.id = oi.order_id
      where o.status='issued' and o.paid_at >= wf and o.paid_at < wt and (p_city is null or o.city_id = p_city)
      group by oi.product_id
    ) s on s.product_id = pr.id
    where (pr.active or s.product_id is not null)
      and (p_category is null or pr.category_id = p_category)
  ) r;
  return res;
end $$;

-- ----------------------------------------------------------------- Права: только backend (service_role)
revoke execute on function _finance_owner(bigint), _fin_window(date, date), _fin_metrics(text, timestamptz, timestamptz, int, uuid),
  finance_post_entry(bigint, text, numeric, text, text, text, text), finance_reverse_entry(bigint, bigint, text, text),
  finance_entries_list(bigint, text, date, date, int), finance_summary(bigint, text, date, date, int, uuid),
  finance_products(bigint, text, date, date, int), _finance_guard()
  from public, anon, authenticated;
grant execute on function finance_post_entry(bigint, text, numeric, text, text, text, text), finance_reverse_entry(bigint, bigint, text, text),
  finance_entries_list(bigint, text, date, date, int), finance_summary(bigint, text, date, date, int, uuid),
  finance_products(bigint, text, date, date, int) to service_role;

insert into schema_migrations(version) values('0018');
