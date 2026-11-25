-- =====================================================================
-- HR example, part 116: labels beside the fields (sprint 255;
-- docs/guide/04-pages-and-regions.md "Template options").
--
-- Page 76 "Find an employee" (part 113): its region gets the template
-- option "Labels beside the fields" (to-labels-left): one field per row,
-- the label in the left third, also on phones.
-- =====================================================================

update meta.region r set template_options = array_append(coalesce(r.template_options, '{}'), 'to-labels-left')
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 76 and r.static_id = 'find-employee';
