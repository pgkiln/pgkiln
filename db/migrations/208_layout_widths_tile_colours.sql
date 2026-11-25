-- =====================================================================
-- 208: content width per page, a colour per list entry (sprint 254, MG-32, MG-34)
--
-- meta.page.content_width   how wide the page's content gets: 'full' (the
--                           whole window, with the usual gutter) or a
--                           maximum in px (320 to 3840), centred. Null: the
--                           application's setting (theme.content_width, the
--                           same values), else the default (1500 px, left).
-- meta.list_entry.color     a #rrggbb background for the entry's tile (list
--                           template "tiles"); a sql list gives it as its
--                           color column. Text on it is white or black,
--                           whichever has the better contrast.
-- Both are exported (to_jsonb of the row) and nullable, so older exports
-- import unchanged.
-- =====================================================================

alter table meta.page add column content_width text
  check (content_width = 'full' or (content_width ~ '^[0-9]{3,4}$' and content_width::int between 320 and 3840));
comment on column meta.page.content_width is
  'Content width (208): full, or a maximum in px (320 to 3840, centred); null: the application''s theme.content_width';

alter table meta.list_entry add column color text check (color ~ '^#[0-9a-fA-F]{6}$');
comment on column meta.list_entry.color is 'Tile background #rrggbb (208, list template tiles)';
