-- =====================================================================
-- HR example, part 96: a region's other properties (migration 188,
-- sprint 230; docs/guide/04-pages-and-regions.md "Region properties")
--
-- Page 57 "Region layout" (Administration):
--   - Layout: a region that starts a new row with Row CSS Classes, two
--     regions side by side with a gap (the second one starts in column 9),
--     a region that starts in column 4;
--   - Appearance: CSS classes, icons, items above their region's content;
--   - Accessibility: a navigation landmark with its own label, a region
--     that is no landmark;
--   - Advanced: an HTML DOM ID, custom attributes (with an &ITEM. value),
--     a title left out of the translation;
--   - Header and footer text;
--   - Read Only: the "Notes" region's items are read-only while the mode
--     is View;
--   - Customization: "Tips" (shown) and "Shortcuts" (hidden until a user
--     shows it on the page's Customize link);
--   - Comments.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 57, 'Region layout', 'Region layout', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, static_id, new_row, grid_column, row_css_classes, column_css_classes,
                         column_attributes, css_classes, icon, render_components, use_landmark, landmark_type, landmark_label, dom_id, custom_attributes,
                         title_no_translate, header_text, footer_text, readonly_type, readonly_expr, readonly_value, customization, customization_name, comments)
select p.id, r.seq, r.title, 'static', r.columns, r.template, r.source, r.static_id, r.new_row, r.grid_column, r.row_css, r.col_css,
       r.col_attrs, r.css, r.icon, r.render, r.landmark, r.landmark_type, r.landmark_label, r.dom_id, r.attrs,
       r.no_translate, r.header, r.footer, r.ro_type, r.ro_expr, r.ro_value, r.custom, r.custom_name, r.comments
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Mode', 4, 'standard', '<p>Choose View to make the notes below read-only.</p>', 'mode', true, null::int, 'hr-row-intro', null, null,
   'hr-mode', 'eye', 'above', null::boolean, null, null, null, null, null::boolean, null, null, null, null, null, null, null,
   'Starts a new row: the row is <div class="t-row hr-row-intro">. Its item (above the text) submits the page.'),
  (20, 'A gap to the left', 4, 'standard', '<p>This region starts in column 9: columns 5 to 8 stay empty.</p>', 'gap', null, 9, null, 'hr-gap-column', 'data-column="9"',
   null, 'arrow-right', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
  (30, 'Notes', 6, 'standard', null, 'notes', true, 4, null, null, null,
   'hr-notes', 'pencil', null, null, null, null, 'hr-region-notes', 'data-kind="notes" title="Notes of &APP_USER." aria-describedby="hr-notes-help"', null,
   '<p id="hr-notes-help">Starts in column 4 of a new row. Read-only while the mode is <strong>View</strong>.</p>',
   '<p>Footer text, for &APP_USER.: HTML with escaped substitutions.</p>', 'item_equals', 'P57_MODE', 'VIEW', null, null, null),
  (40, 'Related pages', 12, 'standard',
   '<ul><li><a href="53">Department overview</a></li><li><a href="2">Employees</a></li></ul>', 'related', true, null, null, null, null,
   null, 'link', null, null, 'navigation', 'Related HR pages', null, null, null, null, null, null, null, null, null, null, null),
  (50, 'Tips', 6, 'standard', '<p>Users can hide this region: <em>Customize</em> under the page.</p>', 'tips', true, null, null, null, null,
   null, 'info', null, null, null, null, null, null, null, null, null, null, null, null, 'shown', 'Tips for this page', null),
  (60, 'Shortcuts', 6, 'standard', '<p>Hidden until a user shows it on the Customize link.</p>', 'shortcuts', null, null, null, null, null,
   null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'hidden', null, null),
  (70, 'KPI', 12, 'plain', '<p class="muted">A plain region without a landmark; its title "KPI" stays as it is in every language.</p>', 'kpi', true, null, null, null, null,
   null, null, null, false, null, null, null, null, true, null, null, null, null, null, null, null, null)
  ) as r (seq, title, columns, template, source, static_id, new_row, grid_column, row_css, col_css, col_attrs,
          css, icon, render, landmark, landmark_type, landmark_label, dom_id, attrs, no_translate, header, footer, ro_type, ro_expr, ro_value, custom, custom_name, comments)
 where a.alias = 'hr' and p.page_no = 57;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, default_value, config)
select p.id, (select x.id from meta.region x where x.page_id = p.id and x.static_id = i.region), i.seq, i.name, i.label, i.type, i.lov, i.dflt, i.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('mode', 10, 'P57_MODE', 'Mode', 'select', 'STATIC:Edit;EDIT,View;VIEW', 'EDIT', '{"submit_on_change": true}'),
  ('notes', 10, 'P57_NOTE', 'Note', 'textarea', null, null, '{}'),
  ('notes', 20, 'P57_OWNER', 'Owner', 'text', null, null, '{}')
  ) as i (region, seq, name, label, type, lov, dflt, config)
 where a.alias = 'hr' and p.page_no = 57;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 57, 'Region layout', 'layout-grid', 57
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Region layout', 'Regio-indeling'),
  ('Mode', 'Modus'),
  ('A gap to the left', 'Een ruimte links'),
  ('Notes', 'Notities'),
  ('Related pages', 'Verwante pagina''s'),
  ('Related HR pages', 'Verwante HR-pagina''s'),
  ('Tips', 'Tips'),
  ('Tips for this page', 'Tips voor deze pagina'),
  ('Shortcuts', 'Snelkoppelingen'),
  ('KPI', 'KPI (vertaald)')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
