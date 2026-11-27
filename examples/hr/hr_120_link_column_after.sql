-- =====================================================================
-- HR example, part 120: a link column between the report's own columns
-- (sprint 260; docs/guide/04-pages-and-regions.md "Link columns and row
-- actions").
--
-- Page 66 "Locations": the "First department" link sits right after the
-- location (attribute "after": "loc"), before the department count.
-- =====================================================================

update meta.region r set config = jsonb_set(r.config, '{link_columns,0,after}', '"loc"')
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 66 and r.static_id = 'locations';
