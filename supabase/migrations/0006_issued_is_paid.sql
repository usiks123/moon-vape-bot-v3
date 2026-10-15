-- 0006: выдача заказа автоматически отмечает его оплаченным.
-- Оплату до выдачи по-прежнему можно отметить вручную (mark_order_paid).
-- Заодно убираем статус 'returned' из проверки в mark_order_paid.

create or replace function change_order_status(p_order uuid, p_new order_status, p_actor bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders; r record; ok boolean;
begin
  select * into o from orders where id=p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  perform _assert_role(p_actor, o.city_id);
  ok := (o.status='new' and p_new in ('confirmed','cancelled'))
     or (o.status='confirmed' and p_new in ('prepared','cancelled'))
     or (o.status='prepared' and p_new in ('issued','cancelled'));
  if not ok then raise exception 'bad_transition'; end if;
  -- Заказ с неопределённой ценой нельзя подтвердить и выдать до согласования.
  if o.approval_required and p_new in ('confirmed','prepared','issued') then raise exception 'approval_required'; end if;

  if p_new='cancelled' then
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      select i.id,p_order,'release'::inv_op,r.q,i.quantity,i.quantity,i.city_id,p_actor,'Отмена заказа '||o.number from inventory i where i.id=r.inventory_id;
      update inventory set reserved_quantity=reserved_quantity-r.q where id=r.inventory_id;
    end loop;
  elsif p_new='issued' then
    for r in select inventory_id, sum(quantity)::int q from order_items where order_id=p_order group by inventory_id order by inventory_id loop
      insert into inventory_transactions(inventory_id,order_id,op,quantity,qty_before,qty_after,city_id,actor,reason)
      select i.id,p_order,'writeoff'::inv_op,r.q,i.quantity,i.quantity-r.q,i.city_id,p_actor,'Выдача по заказу '||o.number from inventory i where i.id=r.inventory_id;
      update inventory set quantity=quantity-r.q, reserved_quantity=reserved_quantity-r.q where id=r.inventory_id;
    end loop;
  end if;

  -- Выдача = оплата: если заказ ещё не отмечен оплаченным, он считается оплаченным на сумму заказа.
  update orders set status=p_new, updated_at=now(),
    paid_at         = case when p_new='issued' then coalesce(paid_at, now()) else paid_at end,
    paid_amount     = case when p_new='issued' and paid_at is null then o.total else paid_amount end,
    paid_by         = case when p_new='issued' and paid_at is null then p_actor else paid_by end,
    refunded_amount = case when p_new='cancelled' and paid_at is not null then coalesce(paid_amount,0) else refunded_amount end,
    refunded_at     = case when p_new='cancelled' and paid_at is not null and refunded_at is null then now() else refunded_at end
  where id=p_order;
  insert into order_status_history(order_id,old_status,new_status,actor) values(p_order,o.status,p_new,p_actor::text);
  return jsonb_build_object('id',p_order,'status',p_new,'number',o.number,'city_id',o.city_id);
end $$;

create or replace function mark_order_paid(p_order uuid, p_actor bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o orders;
begin
  select * into o from orders where id=p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  perform _assert_role(p_actor, o.city_id);
  if o.status='cancelled' then raise exception 'bad_status'; end if;
  if o.paid_at is not null then raise exception 'already_paid'; end if;
  update orders set paid_at=now(), paid_amount=o.total, paid_by=p_actor, updated_at=now() where id=p_order;
  return jsonb_build_object('id',p_order,'paid_amount',o.total);
end $$;
