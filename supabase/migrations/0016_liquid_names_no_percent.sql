-- 0016: из названий жидкостей убираем процент никотина («5%»). Объём («30ml») остаётся.
-- catalog_key и цены не меняются; это только отображаемое название.

update products
set name = trim(regexp_replace(name, '\s*\d+([.,]\d+)?\s*%\s*$', '', 'i'))
where (name ~* 'ml' or category_id in (select id from categories where name ~* 'жидкост'))
  and name ~* '\d+([.,]\d+)?\s*%\s*$';

-- Названия в уже оформленных заказах (суммы и история не меняются).
update order_items
set product_name = trim(regexp_replace(product_name, '\s*\d+([.,]\d+)?\s*%\s*$', '', 'i'))
where product_name ~* '\d+([.,]\d+)?\s*%\s*$'
  and (product_name ~* 'ml'
       or product_id in (select p.id from products p join categories c on c.id = p.category_id where c.name ~* 'жидкост'));
