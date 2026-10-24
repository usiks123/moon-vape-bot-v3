-- 0015: возрастная проверка 18+ и названия снюса без крепости («66мг», «77 mg»).

-- Самообъявление 18+ (Telegram не передаёт возраст). Заполняется один раз при входе в магазин.
alter table users add column if not exists age_confirmed_at timestamptz;

-- Крепость убираем из названий снюса в каталоге.
update products
set name = trim(regexp_replace(name, '\s*\d+([.,]\d+)?\s*(мг|mg|%)\s*$', '', 'i'))
where (name ~* '(снюс|snus)' or category_id in (select id from categories where name ~* 'снюс'))
  and name ~* '\d+([.,]\d+)?\s*(мг|mg|%)\s*$';

-- То же в уже оформленных заказах (только название; суммы и история не меняются).
update order_items
set product_name = trim(regexp_replace(product_name, '\s*\d+([.,]\d+)?\s*(мг|mg|%)\s*$', '', 'i'))
where product_name ~* '\d+([.,]\d+)?\s*(мг|mg|%)\s*$'
  and (product_name ~* '(снюс|snus)'
       or product_id in (select p.id from products p join categories c on c.id = p.category_id where c.name ~* 'снюс'));
