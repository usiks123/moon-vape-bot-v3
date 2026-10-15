-- 0009: реферальная акция «Приведи друга» (только Мюнхен).
-- Тот, кто пригласил, получает одну любую жидкость бесплатно после первой выдачи заказа друга.
-- Друг должен быть новым клиентом. Картриджи и Elfbar 2000 не засчитываются и не выдаются бонусом.
-- Подписка на канал проверяется в боте (getChatMember) до выдачи бонуса, в базе её нет.

-- 1. Товары, которые не участвуют в акции (ни как покупка друга, ни как бонус).
alter table products add column if not exists referral_excluded boolean not null default false;
update products set referral_excluded = true
where name ilike '%elfbar%2000%'
   or category_id in (select id from categories where name ilike '%картридж%');

-- 2. Заказы, созданные как бонус. Они не засчитываются как покупка друга.
alter table orders add column if not exists is_bonus boolean not null default false;

-- 3. Рефералы. Один друг — один пригласивший.
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_tg bigint not null,
  referred_tg bigint not null unique,
  city_id text not null,
  status text not null default 'pending' check (status in ('pending','eligible','redeemed')),
  first_order_id uuid references orders(id),
  reward_order_id uuid references orders(id),
  created_at timestamptz not null default now(),
  eligible_at timestamptz,
  redeemed_at timestamptz,
  check (referrer_tg <> referred_tg)
);
create index if not exists referrals_referrer_idx on referrals(referrer_tg, status);

-- 4. Засчитывается ли заказ как покупка друга: есть хотя бы одна позиция не из исключённых.
create or replace function _referral_qualifies(p_order uuid) returns boolean
language sql stable set search_path=public as $$
  select exists(select 1 from order_items oi join products p on p.id=oi.product_id
                where oi.order_id=p_order and not p.referral_excluded)
$$;

-- 5. Регистрация перехода по ссылке ?start=ref_<id>. Проверку «новый клиент» делает бот до вызова.
create or replace function referral_register(p_referrer bigint, p_referred bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare u users;
begin
  if p_referrer = p_referred then return jsonb_build_object('ok',false,'reason','self'); end if;
  select * into u from users where telegram_id=p_referrer;
  if not found or u.city_id is distinct from 'muenchen' then
    return jsonb_build_object('ok',false,'reason','referrer_not_munich');
  end if;
  insert into referrals(referrer_tg,referred_tg,city_id) values(p_referrer,p_referred,'muenchen')
  on conflict (referred_tg) do nothing;
  return jsonb_build_object('ok',true);
end $$;

-- 6. Первая выдача заказа друга (в Мюнхене, засчитываемые позиции) → бонус становится доступен.
create or replace function _referral_on_issue() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.status='issued' and old.status is distinct from 'issued'
     and new.city_id='muenchen' and not new.is_bonus and _referral_qualifies(new.id) then
    update referrals set status='eligible', first_order_id=new.id, eligible_at=now()
    where referred_tg=new.telegram_id and status='pending' and city_id='muenchen';
  end if;
  return new;
end $$;

drop trigger if exists trg_referral_on_issue on orders;
create trigger trg_referral_on_issue after update of status on orders
for each row execute function _referral_on_issue();

-- 7. Что можно выбрать в подарок: остаток в Мюнхене, не исключённые, с ценой.
create or replace function referral_options(p_city text) returns jsonb
language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('inventory_id',i.id,'name',p.name,'variant',pv.name,
                                               'available',i.quantity-i.reserved_quantity)
                            order by p.name, pv.name), '[]'::jsonb)
  from inventory i
  join products p on p.id=i.product_id
  left join product_variants pv on pv.id=i.variant_id
  where i.city_id=p_city and i.quantity-i.reserved_quantity>0
    and p.active and not p.referral_excluded and coalesce(pv.price, p.price) is not null
$$;

-- 8. Оформление бонуса: заказ с одной позицией по цене 0, резерв как обычно.
--    Бонус гасится только если позиция выбрана и на складе есть остаток.
create or replace function redeem_referral(p_referrer bigint, p_inventory uuid, p_key text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders; u users; ref referrals; inv record; line jsonb;
begin
  select * into o from orders where idempotency_key=p_key;
  if found then return jsonb_build_object('id',o.id,'number',o.number,'duplicate',true); end if;

  select * into u from users where telegram_id=p_referrer;
  if not found then raise exception 'user_not_found'; end if;
  if u.city_id is distinct from 'muenchen' then raise exception 'city_mismatch'; end if;

  select * into ref from referrals where referrer_tg=p_referrer and status='eligible'
  order by eligible_at, created_at limit 1 for update;
  if not found then raise exception 'no_reward'; end if;

  select i.id, i.city_id, i.quantity, i.reserved_quantity, i.product_id, p.name pname,
         pv.name vname, coalesce(pv.price, p.price) price, p.cost_price cost, p.active, p.referral_excluded excl
    into inv
  from inventory i join products p on p.id=i.product_id left join product_variants pv on pv.id=i.variant_id
  where i.id=p_inventory for update of i;
  if not found or inv.city_id<>'muenchen' or not inv.active or inv.excl or inv.price is null then
    raise exception 'item_not_found';
  end if;
  if inv.quantity - inv.reserved_quantity < 1 then raise exception 'insufficient_stock'; end if;

  insert into orders(number,user_id,telegram_id,city_id,contact,address,delivery_service,comment,idempotency_key,
                     total,total_units,tier_label,approval_required,is_bonus)
  values('MOON-'||to_char(now() at time zone 'utc','YYYYMMDD')||'-'||lpad((floor(random()*10000))::int::text,4,'0'),
         u.id, p_referrer, 'muenchen',
         case when u.username is not null then '@'||u.username else coalesce(u.first_name,'Покупатель Telegram') end,
         '', '', 'Бонус за приглашение друга', p_key, 0, 1, null, false, true)
  returning * into o;

  line := jsonb_build_object('product_id',inv.product_id,'inventory_id',inv.id,'product_name',inv.pname,
                             'variant_name',inv.vname,'quantity',1,'retail_price',inv.price,'unit_price',0,
                             'unit_cost',inv.cost,'is_wholesale',false);
  perform _insert_lines(o.id, jsonb_build_array(line), null);

  insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,reason)
  select i.id,o.id,'reserve'::inv_op,1,i.quantity,i.quantity,i.city_id,'Бонус за друга, резерв '||o.number
  from inventory i where i.id=inv.id;
  update inventory set reserved_quantity=reserved_quantity+1 where id=inv.id;

  update referrals set status='redeemed', redeemed_at=now(), reward_order_id=o.id where id=ref.id;
  insert into order_status_history(order_id,old_status,new_status,actor) values(o.id,null,'new','referral');
  return jsonb_build_object('id',o.id,'number',o.number,'duplicate',false,'total',0);
end $$;

-- 9. Список рефералов для админки (владелец — все, админ города — свой город).
create or replace function admin_referrals(p_actor bigint, p_city text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  perform _assert_role(p_actor, p_city);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',r.id,'status',r.status,'created_at',r.created_at,'eligible_at',r.eligible_at,'redeemed_at',r.redeemed_at,
      'referrer', coalesce((select '@'||username from users where telegram_id=r.referrer_tg and username is not null),
                           (select first_name from users where telegram_id=r.referrer_tg), '—'),
      'referred', coalesce((select '@'||username from users where telegram_id=r.referred_tg and username is not null),
                           (select first_name from users where telegram_id=r.referred_tg), '—'),
      'reward_order', (select number from orders where id=r.reward_order_id),
      'first_order', (select number from orders where id=r.first_order_id)
    ) order by r.created_at desc)
    from referrals r where r.city_id=p_city), '[]'::jsonb);
end $$;

-- 10. admin_catalog: добавляем флаг исключения из акции (остальное без изменений, как в 0004).
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
        'referral_excluded',pr.referral_excluded,
        'tiers',(select coalesce(jsonb_agg(jsonb_build_object('min',w.tier_min,'max',w.tier_max,'price',w.price) order by w.tier_min),'[]'::jsonb)
                 from wholesale_tiers w where w.product_id=pr.id),
        'variants',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'price',v.price) order by v.name),'[]'::jsonb)
                    from product_variants v where v.product_id=pr.id)
      ) order by pr.active desc, pr.name),'[]'::jsonb) from products pr));
end $$;
