-- =====================================================================
-- HR example, part 119: a row that opens its record, a button above the
-- report, a highlight in a colour of its own, a default from SQL
-- (sprint 259; docs/guide/04-pages-and-regions.md "Button positions" and
-- "Interactive report", docs/guide/05-items.md "Properties").
--
-- Page 6 "Requests you can see": a click anywhere on a row opens the
-- request (row_link); "New" is a full-width bar above the report (button
-- position Top of Region, template option Full width); an approved
-- request's status cell is #dcfce7.
-- Page 37 "Leave assistant": the start date is today when empty
-- (default_sql).
-- =====================================================================

update meta.region r set config = jsonb_set(r.config || '{"row_link": true}', '{highlights}',
         coalesce(r.config->'highlights', '[]') || '[{"column": "status", "op": "eq", "value": "APPROVED", "color": "#dcfce7", "scope": "cell"}]')
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 6 and r.title = 'Requests you can see';

update meta.button b set slot = 'top_of_region', template_options = array_append(coalesce(b.template_options, '{}'), 'to-block')
  from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
 where b.region_id = r.id and a.alias = 'hr' and p.page_no = 6 and r.title = 'Requests you can see' and b.name = 'NEW';

update meta.item i set config = i.config || '{"default_sql": "select current_date"}'
  from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
 where i.region_id = r.id and a.alias = 'hr' and p.page_no = 37 and i.name = 'P37_START_DATE';
