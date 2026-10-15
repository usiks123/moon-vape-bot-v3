-- 0007: оплата отмечается только выдачей заказа (см. 0006). Ручная отметка оплаты убрана.
drop function if exists mark_order_paid(uuid, bigint);
