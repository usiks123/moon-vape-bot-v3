-- =============================================================================
-- MoonVape · миграция 0002 · значения enum
-- Запускать ОТДЕЛЬНО (отдельным Run в SQL Editor), ДО 0003.
-- Причина: новые значения enum нельзя использовать в той же транзакции, где они добавлены.
-- Перед запуском: сделайте резервную копию БД (Supabase → Database → Backups).
-- =============================================================================

create table if not exists schema_migrations(version text primary key, applied_at timestamptz not null default now());
do $$ begin
  if exists(select 1 from schema_migrations where version='0002') then raise exception 'migration 0002 already applied'; end if;
end $$;

-- Статусы заказа: processing -> confirmed («Подтверждён»), completed -> issued («Выдан»).
-- Значения переименовываются, поэтому исторические заказы и история статусов сохраняются.
do $$ begin
  if exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='order_status' and e.enumlabel='processing') then
    alter type order_status rename value 'processing' to 'confirmed';
  end if;
  if exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='order_status' and e.enumlabel='completed') then
    alter type order_status rename value 'completed' to 'issued';
  end if;
end $$;
alter type order_status add value if not exists 'prepared';
alter type order_status add value if not exists 'returned';

-- Складские операции: поступление, возврат, перемещение между городами.
alter type inv_op add value if not exists 'receipt';
alter type inv_op add value if not exists 'return';
alter type inv_op add value if not exists 'transfer';

insert into schema_migrations(version) values('0002');
