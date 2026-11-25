-- =====================================================================
-- HR example, part 117: highlights the developer sets (sprint 257;
-- docs/guide/04-pages-and-regions.md "Interactive report", attribute
-- highlights).
--
-- Page 6 "Requests you can see": a pending request's status cell is
-- yellow, a rejected request's row red. They are always on (users add
-- their own highlights in Actions → Format → Highlight; a user's
-- highlight wins for the row).
-- =====================================================================

update meta.region r set config = r.config || '{"highlights": [
    {"column": "status", "op": "eq", "value": "PENDING", "color": "yellow", "scope": "cell"},
    {"column": "status", "op": "eq", "value": "REJECTED", "color": "red"}]}'::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 6 and r.title = 'Requests you can see';
