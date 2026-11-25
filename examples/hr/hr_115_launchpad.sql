-- =====================================================================
-- HR example, part 115: a launchpad (sprint 254, MG-32 … MG-35;
-- migration 208; docs/guide/04-pages-and-regions.md "Content width",
-- "Tiles", "Inline dialog options"; 05-items.md "Display image").
--
-- Page 78 "Launchpad", a home screen as low-code tools draw one:
-- - content width "full": the page uses the whole window (with the usual
--   gutter) instead of stopping at 1500 px;
-- - a banner: a Display Image item in a box 140 px high that the picture
--   covers ({"height": 140, "fit": "cover"}), from #APP_FILES#banner.svg;
-- - a greeting: a static region with the template options Centre the
--   text, Bold text and Large text;
-- - the list HR_LAUNCHPAD with the template "tiles": a coloured tile per
--   entry (its Tile colour), an icon (an icon name, or the picture
--   #APP_FILES#tile-team.svg) and the label as text; 3 columns, 90 px high;
-- - the tile "Before you start" opens an inline dialog region (its URL is
--   #launch-reminder, the region's static id) shown as a notification:
--   no header, a green background, large bold text, small. A click
--   outside it, Esc or its OK link closes it.
-- =====================================================================

insert into meta.static_file (app_id, name, mime, content)
select a.id, f.name, 'image/svg+xml', convert_to(f.body, 'UTF8')
  from meta.app a, (values
  ('banner.svg', $svg$<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 400"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#13294b"/><stop offset="1" stop-color="#0b63c5"/></linearGradient></defs><rect width="1600" height="400" fill="url(#g)"/><circle cx="1350" cy="120" r="180" fill="#ffffff" opacity=".08"/><circle cx="250" cy="380" r="220" fill="#ffffff" opacity=".06"/><text x="800" y="225" fill="#ffffff" font-family="system-ui, sans-serif" font-size="96" font-weight="700" text-anchor="middle">HR launchpad</text></svg>$svg$),
  ('tile-team.svg', $svg$<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"><circle cx="17" cy="16" r="7"/><circle cx="34" cy="18" r="5"/><path d="M4 40c1-8 7-12 13-12s12 4 13 12"/><path d="M30 29c6 0 12 3 13 10"/></svg>$svg$)
  ) as f (name, body)
 where a.alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page, content_width)
select id, 78, 'Launchpad', 'Launchpad', 1, 'full' from meta.app where alias = 'hr';

insert into meta.list (app_id, name, type, description)
select id, 'HR_LAUNCHPAD', 'static', 'The tiles of the launchpad (page 78)' from meta.app where alias = 'hr';

insert into meta.list_entry (app_id, list_name, seq, label, icon, color, target_page, target_url)
select a.id, 'HR_LAUNCHPAD', e.seq, e.label, e.icon, e.color, e.page, e.url
  from meta.app a, (values
  (10, 'Employees', '#APP_FILES#tile-team.svg', '#2f5597', 2, null),
  (20, 'Departments', 'building', '#2f5597', 4, null),
  (30, 'Leave requests', 'calendar', '#17794a', 14, null),
  (40, 'Analytics', 'chart', '#71717a', 15, null),
  (50, 'Search', 'search', '#98d9eb', 42, null),
  (60, 'Before you start', 'info', '#dd4b34', null, '#launch-reminder')
  ) as e (seq, label, icon, color, page, url)
 where a.alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, static_id, config, template_options)
select p.id, r.seq, r.title, r.type, 12, r.template, r.source, r.sid, r.config::jsonb, r.opts::text[]
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Banner', 'static', 'plain', null, 'launch-banner', '{}', '{}'),
  (20, 'Greeting', 'static', 'plain', '<p>Hello &APP_USER., what would you like to do?</p>', null, '{}', '{to-center,to-bold,to-text-large}'),
  (30, 'Launchpad', 'list', 'plain', null, null, '{"list": "HR_LAUNCHPAD", "template": "tiles", "tile_columns": 3, "tile_height": 90, "tile_gap": 8}', '{to-hide-header}'),
  (40, 'Before you start', 'static', 'inline_dialog',
   '<p>Check your open leave requests before you plan new work.</p><p><a class="btn" href="#" data-region-close>OK</a></p>',
   'launch-reminder', '{}', '{to-hide-header,to-tone-success,to-bold,to-text-large,to-dialog-small}')
  ) as r (seq, title, type, template, source, sid, config, opts)
 where a.alias = 'hr' and p.page_no = 78;

insert into meta.item (page_id, region_id, seq, name, label, type, default_value, config, template_options)
select p.id, r.id, 10, 'P78_BANNER', 'HR launchpad', 'image', '#APP_FILES#banner.svg',
       '{"height": 140, "fit": "cover", "position": "center", "alt": "HR launchpad"}', '{to-hide-label,to-stretch}'
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.static_id = 'launch-banner'
 where a.alias = 'hr' and p.page_no = 78;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq + 1, 'Launchpad', 'home', 78
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Dashboard' and n.parent_id is null
 where a.alias = 'hr';
