-- =============================================================================
-- MoonVape · миграция 0017 · полное удаление акции «Приведи друга»
-- Запускать ПОСЛЕ 0016. Один Run в SQL Editor. Перед запуском — резервная копия БД.
--
-- Что делает:
--   * удаляет триггер и функции реферальной акции (0009, 0013);
--   * переопределяет admin_catalog без поля referral_excluded.
--
-- Что НЕ делает (исторические данные сохраняются, ничего не удаляется):
--   * таблица referrals;
--   * колонки products.referral_excluded, orders.is_bonus, cities.channel_id;
--   * заказы, в том числе бонусные (is_bonus = true), и история статусов.
-- Удалить эти объекты можно отдельной миграцией, после проверки и резервной копии.
-- Применённые миграции 0009–0016 не изменяются.
-- =============================================================================

do $$ begin
  if exists(select 1 from schema_migrations where version='0017') then raise exception 'migration 0017 already applied'; end if;
  if not exists(select 1 from schema_migrations where version='0016') then raise exception 'run 0016 first'; end if;
end $$;

-- ----------------------------------------------------------------- Триггер и функции акции
drop trigger if exists trg_referral_on_issue on orders;
drop function if exists _referral_on_issue();
drop function if exists _referral_qualifies(uuid);
drop function if exists referral_register(bigint, bigint);
drop function if exists referral_options(text);
drop function if exists redeem_referral(bigint, uuid, text);
drop function if exists admin_referrals(bigint, text);

-- ----------------------------------------------------------------- Каталог для админки без реферальных полей
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

-- Новая функция по умолчанию доступна PUBLIC: закрываем её, как и остальные RPC (только service_role).
revoke execute on function admin_catalog(bigint) from public, anon, authenticated;
grant execute on function admin_catalog(bigint) to service_role;

-- ----------------------------------------------------------------- Пометки об устаревших объектах (данные не меняются)
comment on table referrals is 'Устарело: акция «Приведи друга» удалена миграцией 0017. Данные сохранены.';
comment on column products.referral_excluded is 'Устарело (0017): не используется. Значение сохранено.';
comment on column orders.is_bonus is 'Устарело (0017): признак бонусного заказа акции, которой больше нет. Значение сохранено.';
comment on column cities.channel_id is 'Устарело (0017): ID канала использовался только для проверки подписки в акции. Значение сохранено.';

insert into schema_migrations(version) values('0017');
