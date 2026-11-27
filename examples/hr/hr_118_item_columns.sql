-- =====================================================================
-- HR example, part 118: items in rows and columns (sprint 258;
-- docs/guide/05-items.md "Placing items in rows and columns").
--
-- Page 24 "Planner", region "Meeting": the title on a row of its own
-- (no span: the whole row), start and end side by side (6 + 6), then
-- "Private" and the organizer (6 + 6).
-- =====================================================================

update meta.item i set config = i.config || v.cfg::jsonb
  from (values ('P24_STARTS_AT', '{"column_span": 6}'), ('P24_ENDS_AT', '{"column_span": 6}'),
               ('P24_PRIVATE', '{"column_span": 6, "new_row": true}'), ('P24_ORGANIZER', '{"column_span": 6}')) v(name, cfg),
       meta.region r, meta.page p, meta.app a
 where i.name = v.name and r.id = i.region_id and p.id = r.page_id and a.id = p.app_id and a.alias = 'hr' and p.page_no = 24;
