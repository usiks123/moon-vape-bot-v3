-- 0013: бонус только Elfliq или Vozol. Снюс снова засчитывается как покупка друга.
-- Засчитываются категории Жидкости, Pod-системы, Снюс, Одноразки; исключены картриджи и Elf Bar 2000 (2000 / 2K).

-- Снюс участвует в покупке друга (раньше был исключён).
update products set referral_excluded = false
where name ~* '(снюс|snus)' or category_id in (select id from categories where name ~* 'снюс');

-- Картриджи и Elf Bar 2000 не засчитываются.
update products set referral_excluded = true
where name ~* 'elf\s*bar\s*(2000|2k)'
   or category_id in (select id from categories where name ~* 'картридж');

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
    and p.name ~* '(elfliq|vozol)'
$$;

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
  if not found or inv.city_id<>'muenchen' or not inv.active or inv.excl or inv.price is null
     or inv.pname !~* '(elfliq|vozol)' then
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
