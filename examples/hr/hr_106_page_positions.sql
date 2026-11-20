-- =====================================================================
-- HR example, part 106: the Standard page template's other display
-- positions (migration 199, sprint 234; docs/guide/04-pages-and-regions.md
-- "Side columns and display positions")
--
-- Page 70 "Page positions" (Administration) has a region in each of them:
--   - After logo: a short "Positions" tag next to the application's name;
--   - Before navigation bar: a link to the Region layout page;
--   - After navigation bar: the help desk's number, after the user menu;
--   - Top navigation: a bar of links under the header;
--   - Full width content: a hero over the content's whole width;
--   - Body: what the page shows, with a button that opens …
--   - Dialogs, drawers and popups: an inline dialog (dynamic action Open
--     region).
-- The header's regions use the plain template (no title, one line).
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 70, 'Page positions', 'Page positions', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, position, source, static_id, config)
select p.id, r.seq, r.title, 'static', 12, r.template, r.position, r.source, r.static_id, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Positions tag', 'plain', 'after_logo', '<p class="hr-pos-tag">Positions</p>', 'pos-logo', '{}'),
  (20, 'Region layout link', 'plain', 'before_navigation_bar', '<p><a href="57">Region layout</a></p>', 'pos-before-nav', '{}'),
  (30, 'Help desk', 'plain', 'after_navigation_bar', '<p>Help desk 1234</p>', 'pos-after-nav', '{}'),
  (40, 'Quick links', 'plain', 'top_navigation',
   '<ul class="hr-pos-links"><li><a href="2">Employees</a></li><li><a href="53">Department overview</a></li><li><a href="44">Region templates</a></li></ul>', 'pos-top-nav', '{}'),
  (50, 'Every position of the page', 'hero', 'full_width',
   '<p>Each region on this page is in another display position of the Standard page template.</p>', 'pos-full-width', '{"icon": "layers"}'),
  (60, 'About the positions', 'standard', null,
   '<p>The header holds three: after the logo, before the navigation bar and after it (after the user menu). The bar of links under the header is the top navigation, the hero above is full width content, and the dialog behind the button below sits in the dialogs, drawers and popups position.</p>', 'pos-body', '{}'),
  (70, 'Positions in short', 'standard', 'footer', '<p class="muted">Page Designer → region → Layout → Position.</p>', 'pos-footer', '{}'),
  (80, 'About this page', 'inline_dialog', 'dialogs',
   '<p>An inline dialog in the Dialogs, drawers and popups position: after the footer, hidden until the button opens it.</p>', 'pos-dialog', '{}')
  ) as r (seq, title, template, position, source, static_id, config)
 where a.alias = 'hr' and p.page_no = 70;

insert into meta.button (page_id, region_id, seq, name, label, action)
select p.id, (select r.id from meta.region r where r.page_id = p.id and r.static_id = 'pos-body'), 10, 'ABOUT', 'About this page', 'da'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 70;

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select p.id, 10, 'Open the dialog', 'click', 'ABOUT', 'open_region', (select r.id from meta.region r where r.page_id = p.id and r.static_id = 'pos-dialog')
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 70;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 70, 'Page positions', 'layout-grid', 70
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Page positions', 'Paginaposities'),
  ('Every position of the page', 'Elke positie van de pagina'),
  ('About the positions', 'Over de posities'),
  ('Positions in short', 'Posities in het kort'),
  ('About this page', 'Over deze pagina')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
