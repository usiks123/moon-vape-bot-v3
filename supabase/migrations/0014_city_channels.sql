-- 0014: ссылка и ID канала хранятся у города. Владелец меняет их в админке (раздел «Города и каналы»).
-- channel_link — ссылка, которую видит покупатель в боте.
-- channel_id — ID канала для проверки подписки (нужен только городу, где есть акция «Приведи друга»).

alter table cities add column if not exists channel_link text;
alter table cities add column if not exists channel_id bigint;

update cities set channel_link = 'https://t.me/+IZorGodXayg0Yjk6', channel_id = -1003727349034 where id = 'muenchen';
update cities set channel_link = 'https://t.me/+feogqxiDQtBhNmEy' where id = 'hannover';
