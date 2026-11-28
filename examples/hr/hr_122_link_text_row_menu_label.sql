-- =====================================================================
-- HR example, part 122: a link column with text where the link doesn't
-- show, and a row actions menu with a label of its own (sprint 261/262;
-- docs/guide/04-pages-and-regions.md "Link columns and row actions").
--
-- Page 66 "Row links": the Employees button shows only in departments
-- with staff; elsewhere (and for users who may not open page 2) its label
-- is plain text ("else": "text"). The row actions menu is a primary
-- button "Options" instead of ⋮.
-- =====================================================================

update meta.region r set config = jsonb_set(r.config, '{link_columns,1,else}', '"text"')
       || jsonb_build_object('row_actions', r.config -> 'row_actions' || '{"label": "Options", "style": "hot"}')
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 66 and r.static_id = 'departments';
