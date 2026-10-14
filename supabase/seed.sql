insert into categories(name,sort) values ('Жидкости',1),('Pod-системы',2),('Картриджи',3),('Снюс',4),('Одноразки',5);
insert into wholesale_prices(min_qty,max_qty,price) values (1,2,15),(3,4,14),(5,6,13),(7,8,12),(9,20,11),(21,49,9),(50,null,null);

create function _seed(cat text, nm text, pr numeric, wh boolean, vars text[], flv text[], qty int) returns void language plpgsql as $$
declare pid uuid; vid uuid; fid uuid; v text; f text;
begin
  insert into products(category_id,name,price,wholesale_enabled) values((select id from categories where name=cat),nm,pr,wh) returning id into pid;
  if flv is not null then foreach f in array flv loop insert into product_flavors(product_id,name) values(pid,f); end loop; end if;
  foreach v in array coalesce(vars,array[null]::text[]) loop
    vid:=null;
    if v is not null then insert into product_variants(product_id,name) values(pid,v) returning id into vid; end if;
    if flv is null then insert into inventory(product_id,variant_id,quantity) values(pid,vid,qty);
    else for fid in select id from product_flavors where product_id=pid loop insert into inventory(product_id,variant_id,flavor_id,quantity) values(pid,vid,fid,qty); end loop; end if;
  end loop;
end $$;

select _seed('Pod-системы','Vaporesso XROS 4 Mini',23,false,null,null,10);
select _seed('Pod-системы','Vaporesso XROS 5 Mini',27,false,null,null,10);
select _seed('Pod-системы','Vaporesso XROS 5',33,false,null,null,10);
select _seed('Одноразки','Elfbar Ice King 30000',25,false,null,array['Mango Ice','Blueberry Ice','Watermelon Ice'],5);
select _seed('Одноразки','Elfbar Moon Night 40000',30,false,null,array['Blue Razz','Peach Mango','Grape'],5);
select _seed('Одноразки','Elf Bar 2K',10,false,null,array['Strawberry','Cola','Mint'],10);
select _seed('Одноразки','Vozol',15,true,null,array['Grape Ice','Peach Ice','Strawberry Kiwi'],20);
select _seed('Снюс','Chaser',17,false,null,array['Mint','Cherry'],10);
select _seed('Снюс','Baron 77 mg',10,false,null,array['Mint','Berry'],10);
select _seed('Снюс','Cuba',10,false,null,array['Classic','Mint'],10);
select _seed('Жидкости','Elfliq',15,true,null,array['Mango','Berry Mix','Cola'],20);
select _seed('Картриджи','Vaporesso XROS картриджи',5,false,array['3 мл / 0.4 Ом','3 мл / 0.6 Ом','3 мл / 0.8 Ом'],null,20);
update inventory set quantity=0 where flavor_id in (select f.id from product_flavors f join products p on p.id=f.product_id where p.name='Elfbar Ice King 30000' and f.name='Watermelon Ice');
update products set description='Pod-система Vaporesso.' where name like 'Vaporesso XROS%' and name not like '%картриджи';
update products set description='Одноразовая электронная сигарета Elf Bar.' where name like 'Elf%bar%' or name like 'Elf Bar%';
update products set description='Одноразовая электронная сигарета Vozol.' where name='Vozol';
update products set description='Жидкость Elfliq.' where name='Elfliq';
update products set description='Сменные картриджи для Vaporesso XROS.' where name='Vaporesso XROS картриджи';
update products set description='Никотиновые пакетики.' where name in ('Chaser','Baron 77 mg','Cuba');
drop function _seed(text,text,numeric,boolean,text[],text[],int);
