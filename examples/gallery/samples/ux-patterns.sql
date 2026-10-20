-- =====================================================================
-- Sample app "UX Pattern Catalog" (App Gallery → Sample Apps)
--
-- The look of pgkiln's theme in one place, to copy from:
--   page 2  region templates (standard, plain, collapsible, title bar,
--           buttons container, hero, inline dialog and drawer, wizard,
--           carousel);
--   page 3  region template options;
--   page 4  buttons: hot, sizes, shapes, colours, a menu and a badge;
--   page 5  items and form layouts, with the item template options;
--   page 6  content patterns: alerts, badges and tags, colour classes,
--           text styles, lists, media lists, timelines, comments, avatars,
--           metric cards and empty states;
--   page 7  page patterns: a modal dialog (page 8), a drawer (page 9) and a
--           page with a side column (page 10).
-- Every page says which template, option or class it uses.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/ux-patterns.sql
-- then open /a/ux-patterns and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;
create or replace function pg_temp.region_id(p_alias text, p_page int, p_static text) returns int language sql stable as
  $$ select r.id from meta.region r where r.page_id = pg_temp.page_id(p_alias, p_page) and r.static_id = p_static $$;

-- 1. Schema and data ---------------------------------------------------------
create schema ux_patterns;

create table ux_patterns.person (
  id     int generated always as identity primary key,
  name   text not null,
  role   text not null,
  status text not null check (status in ('Active', 'Away', 'Left')),
  joined date not null,
  note   text
);

insert into ux_patterns.person (name, role, status, joined, note) values
  ('Alex Morgan', 'Product owner', 'Active', current_date - 400, 'Sets the priorities of the team.'),
  ('Sam Lee', 'Developer', 'Active', current_date - 200, 'Builds the reports.'),
  ('Robin Diaz', 'Designer', 'Away', current_date - 90, 'Back next week.'),
  ('Kim Novak', 'Tester', 'Active', current_date - 30, 'Writes the browser tests.'),
  ('Jo Park', 'Analyst', 'Left', current_date - 700, 'Moved to another team.');

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_ux_patterns') then create role app_ux_patterns nologin; end if;
end $$;
grant app_ux_patterns to pgkiln_runtime;
grant usage on schema ux_patterns to app_ux_patterns;
grant select on all tables in schema ux_patterns to app_ux_patterns;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('ux-patterns', 'UX Pattern Catalog', 1, 'app_users', 'app_ux_patterns');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'ux-patterns';

insert into meta.page (app_id, page_no, name, title, parent_page, mode, dialog_position, dialog_size, page_template)
select a.id, p.no, p.name, p.name, p.parent, p.mode, p.pos, p.size, p.tpl
  from meta.app a, (values
  (1, 'UX Pattern Catalog', null, 'normal', 'center', 'medium', 'standard'),
  (2, 'Region templates', 1, 'normal', 'center', 'medium', 'standard'),
  (3, 'Region options', 1, 'normal', 'center', 'medium', 'standard'),
  (4, 'Buttons', 1, 'normal', 'center', 'medium', 'standard'),
  (5, 'Items and forms', 1, 'normal', 'center', 'medium', 'standard'),
  (6, 'Content patterns', 1, 'normal', 'center', 'medium', 'standard'),
  (7, 'Page patterns', 1, 'normal', 'center', 'medium', 'standard'),
  (8, 'A modal dialog', 7, 'modal', 'center', 'small', 'standard'),
  (9, 'A drawer', 7, 'modal', 'right', 'medium', 'standard'),
  (10, 'A side column', 7, 'normal', 'center', 'medium', 'left_side_column')
  ) as p (no, name, parent, mode, pos, size, tpl)
 where a.alias = 'ux-patterns';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Region templates', 'layers', 2), (30, 'Region options', 'sliders', 3), (40, 'Buttons', 'target', 4),
  (50, 'Items and forms', 'edit', 5), (60, 'Content patterns', 'grid', 6), (70, 'Page patterns', 'file', 7)
  ) as n (seq, label, icon, page)
 where a.alias = 'ux-patterns';

insert into meta.list (app_id, name, type, description)
select a.id, l.name, 'static', l.description
  from meta.app a, (values
  ('UX_TOPICS', 'The pages of the catalog'),
  ('UX_STEPS', 'Steps of a wizard (wizard progress on page 2)'),
  ('UX_SHORTCUTS', 'A small list for the list templates on page 6')
  ) as l (name, description)
 where a.alias = 'ux-patterns';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, badge, description)
select a.id, e.list, e.seq, e.label, e.icon, e.page, e.badge, e.description
  from meta.app a, (values
  ('UX_TOPICS', 10, 'Region templates', 'layers', 2, null, 'Standard, plain, collapsible, title bar, buttons container, hero, inline dialog and drawer, wizard, carousel.'),
  ('UX_TOPICS', 20, 'Region options', 'sliders', 3, null, 'Accent border, flat, borderless, compact, no padding, scrolling, stretched, centred, hidden header.'),
  ('UX_TOPICS', 30, 'Buttons', 'target', 4, null, 'Hot and normal, small and large, pill, outline, link, full width, success and danger, a menu and a badge.'),
  ('UX_TOPICS', 40, 'Items and forms', 'edit', 5, null, 'Every common item type in a form, and the item template options.'),
  ('UX_TOPICS', 50, 'Content patterns', 'grid', 6, null, 'Alerts, badges, colours, text, lists, media lists, timelines, comments, avatars, metrics and empty states.'),
  ('UX_TOPICS', 60, 'Page patterns', 'file', 7, null, 'A modal dialog, a drawer and a page with a side column.'),
  ('UX_STEPS', 10, 'Choose', null, 2, null, null),
  ('UX_STEPS', 20, 'Details', null, 5, null, null),
  ('UX_STEPS', 30, 'Confirm', null, 7, null, null),
  ('UX_SHORTCUTS', 10, 'Buttons', 'target', 4, '9', 'Every button style.'),
  ('UX_SHORTCUTS', 20, 'Items', 'edit', 5, '18', 'Every common item type.'),
  ('UX_SHORTCUTS', 30, 'Pages', 'file', 7, '3', 'Dialogs, drawers and side columns.')
  ) as e (list, seq, label, icon, page, badge, description)
 where a.alias = 'ux-patterns';

insert into meta.region (page_id, seq, title, type, columns, template, template_options, source, config, static_id, position)
select pg_temp.page_id('ux-patterns', r.page), r.seq, r.title, r.type, r.cols, r.template, r.topts::text[], r.source, r.config::jsonb, r.sid, r.pos
  from (values
  -- 1 Home
  (1, 10, 'UX Pattern Catalog', 'static', 12, 'hero', '{}',
   '<p>The building blocks of pgkiln''s theme, each with the name of the template, option or class that makes it. Open a page in the Page Designer to see how it is made, or copy the HTML of a static region. Everything follows the application''s style (Theme Roller), light and dark mode, and fits a phone.</p>',
   '{"icon": "layers"}', null, null),
  (1, 20, 'Topics', 'list', 12, 'plain', '{}', null, '{"list": "UX_TOPICS", "template": "cards"}', null, null),

  -- 2 Region templates
  (2, 5, 'About this page', 'static', 12, 'plain', '{}',
   '<p class="lead">A region''s <strong>template</strong> (Page Designer → region → Appearance) sets its frame. The title of each region below names its template.</p>',
   '{}', null, null),
  (2, 10, 'Standard', 'static', 4, 'standard', '{}', '<p>A card with a header (title and buttons) and a body. The default.</p>', '{}', null, null),
  (2, 20, 'Plain', 'static', 4, 'plain', '{}', '<p><strong>Plain</strong>: no frame and no header, the content only. Good for introductions and KPI tiles.</p>', '{}', null, null),
  (2, 30, 'Collapsible', 'static', 4, 'collapsible', '{}', '<p>A standard card whose body folds away when you click its header.</p>', '{}', null, null),
  (2, 40, 'Title bar', 'static', 12, 'title_bar', '{}', '<p class="muted">The title and the buttons on one line over the content, without a card.</p>', '{}', 'title-bar', null),
  (2, 50, 'Hero', 'static', 12, 'hero', '{}', '<p>A large banner with an icon (the attribute <code>icon</code>), the title, a text and buttons: the start of a home page.</p>', '{"icon": "star"}', null, null),
  (2, 60, 'Buttons container', 'static', 12, 'buttons_container', '{}', '<p class="muted">Buttons only, after any text: the inline dialog and drawer open from here.</p>', '{}', 'buttons', null),
  (2, 70, 'Inline dialog', 'static', 12, 'inline_dialog', '{}', '<p>Hidden until a dynamic action <em>Open region</em> (or a link to its id) opens it. Escape closes it.</p>', '{}', 'dialog', null),
  (2, 80, 'Inline drawer', 'static', 12, 'inline_drawer', '{}', '<p>The same as an inline dialog, docked to the right edge of the screen.</p>', '{}', 'drawer', null),
  (2, 90, 'Carousel', 'display_selector', 12, 'plain', '{}', null, '{"style": "carousel", "interval": 8, "show_all": false}', null, null),
  (2, 91, 'First slide', 'static', 12, 'standard', '{}', '<p>A display selector with <code>"style": "carousel"</code> shows one region at a time and turns every few seconds.</p>', '{"display_selector": true}', null, null),
  (2, 92, 'Second slide', 'static', 12, 'standard', '{}', '<p>Its slides are the regions with <code>"display_selector": true</code> after it.</p>', '{"display_selector": true}', null, null),
  (2, 93, 'Third slide', 'static', 12, 'standard', '{}', '<p>Without the carousel style, the display selector shows tabs.</p>', '{"display_selector": true}', null, null),
  (2, 100, 'Wizard progress', 'list', 12, 'plain', '{}', null, '{"list": "UX_STEPS", "template": "wizard_progress"}', null, null),
  (2, 110, 'Wizard', 'static', 12, 'wizard', '{}', '<p>A narrow, centred card for one step of a wizard, under a list with the template <code>wizard_progress</code>.</p>', '{}', null, null),

  -- 3 Region options
  (3, 5, 'About this page', 'static', 12, 'plain', '{}',
   '<p class="lead"><strong>Template options</strong> (Page Designer → region → Appearance) add classes from a fixed list to a region. They combine: a region can be compact and flat at once.</p>',
   '{}', null, null),
  (3, 10, 'Accent top border (to-accent)', 'static', 4, 'standard', '{to-accent}', '<p>A top border in the accent colour.</p>', '{}', null, null),
  (3, 20, 'Flat (to-flat)', 'static', 4, 'standard', '{to-flat}', '<p>No shadow.</p>', '{}', null, null),
  (3, 30, 'No border or background (to-borderless)', 'static', 4, 'standard', '{to-borderless}', '<p>Transparent, no border or shadow.</p>', '{}', null, null),
  (3, 40, 'Compact (to-compact)', 'static', 4, 'standard', '{to-compact}', '<p>Less padding in the header and body.</p>', '{}', null, null),
  (3, 50, 'Centred text (to-center)', 'static', 4, 'standard', '{to-center}', '<p>The text of the body is centred.</p>', '{}', null, null),
  (3, 60, 'Hidden header (to-hide-header)', 'static', 4, 'standard', '{to-hide-header}', '<p>The header is hidden but still read by screen readers.</p>', '{}', null, null),
  (3, 70, 'Scrolling body (to-scroll)', 'static', 6, 'standard', '{to-scroll,to-stretch}',
   '<p>The body is at most 24 rem high and scrolls.</p><p>Line two.</p><p>Line three.</p><p>Line four.</p><p>Line five.</p><p>Line six.</p><p>Line seven.</p><p>Line eight.</p><p>Line nine.</p><p>Line ten.</p><p>Line eleven.</p><p>Line twelve.</p><p>Line thirteen.</p><p>Line fourteen.</p>',
   '{}', null, null),
  (3, 80, 'Stretched to the row height (to-stretch)', 'static', 6, 'standard', '{to-stretch}', '<p>Regions side by side get the same height: this one is as high as the scrolling region beside it.</p>', '{}', null, null),
  (3, 90, 'No body padding (to-no-padding)', 'report', 12, 'standard', '{to-no-padding}',
   E'select name, role, status from ux_patterns.person order by name', '{"searchable": false}', null, null),

  -- 4 Buttons
  (4, 5, 'About this page', 'static', 12, 'plain', '{}',
   '<p class="lead">A button is <strong>hot</strong> (the main action) or normal; its <strong>template options</strong> set the size, shape and colour. A button with action <em>Menu</em> opens a list of links, and a <strong>badge</strong> shows a short value on it. These buttons do nothing: their action is <em>Defined by dynamic action</em> and none is defined.</p>',
   '{}', null, null),
  (4, 10, 'Hot and normal', 'static', 6, 'standard', '{}', null, '{}', 'b-kind', null),
  (4, 20, 'Sizes', 'static', 6, 'standard', '{}', null, '{}', 'b-size', null),
  (4, 30, 'Shapes', 'static', 6, 'standard', '{}', null, '{}', 'b-shape', null),
  (4, 40, 'Colours', 'static', 6, 'standard', '{}', null, '{}', 'b-colour', null),
  (4, 50, 'Full width (to-block)', 'static', 6, 'standard', '{}', null, '{}', 'b-block', null),
  (4, 60, 'Menu and badge', 'static', 6, 'standard', '{}', null, '{}', 'b-menu', null),

  -- 5 Items and forms
  (5, 5, 'About this page', 'static', 12, 'plain', '{}',
   '<p class="lead">Items in a region form a grid of fields: two per row on wide screens, one on a phone. A textarea, rich text and items with <code>"wide": true</code> or the option <code>to-stretch</code> take the whole row. Required items are marked with a <strong>*</strong>; the help text goes under the field. Nothing here is saved.</p>',
   '{}', null, null),
  (5, 10, 'Text and numbers', 'static', 12, 'standard', '{}', null, '{}', 'f-text', null),
  (5, 20, 'Choices', 'static', 12, 'standard', '{}', null, '{}', 'f-choice', null),
  (5, 30, 'Dates and more', 'static', 12, 'standard', '{}', null, '{}', 'f-date', null),
  (5, 40, 'Item template options', 'static', 12, 'standard', '{}', null, '{}', 'f-options', null),

  -- 6 Content patterns
  (6, 5, 'About this page', 'static', 12, 'plain', '{}',
   '<p class="lead">Patterns for content. The first regions are static HTML with the theme''s classes (the content security policy allows no inline styles, so classes are the way to style); the others are list and template component regions on a query.</p>',
   '{}', null, null),
  (6, 10, 'Alerts', 'static', 6, 'standard', '{}',
   '<div class="alert alert-success u-mb1">Saved: <code>alert alert-success</code>.</div><div class="alert alert-warning u-mb1">Check this: <code>alert alert-warning</code>.</div><div class="alert alert-error u-mb1">Something went wrong: <code>alert alert-error</code>.</div>',
   '{}', null, null),
  (6, 20, 'Tags and colour classes', 'static', 6, 'standard', '{}',
   '<p><span class="tag">tag</span> <span class="tag tag-info">tag-info</span> <span class="tag tag-warning">tag-warning</span> <span class="tag tag-error">tag-error</span></p><p><span class="tc-badge tc-badge-success">success</span> <span class="tc-badge tc-badge-info">info</span> <span class="tc-badge tc-badge-warning">warning</span> <span class="tc-badge tc-badge-danger">danger</span> <span class="tc-badge tc-badge-neutral">neutral</span></p><p><span class="u-color-1-subtle">u-color-1-subtle</span> <span class="u-color-4-subtle">u-color-4-subtle</span> <span class="u-color-7-subtle">u-color-7-subtle</span> <span class="u-color-success-subtle">u-color-success-subtle</span> <span class="u-color-warning-subtle">u-color-warning-subtle</span></p>',
   '{}', null, null),
  (6, 30, 'Text', 'static', 12, 'standard', '{}',
   '<p class="lead">A lead paragraph (<code>lead</code>) introduces a page.</p><p>Body text, with <strong>bold</strong>, <em>emphasis</em>, <code>code</code> and a <a href="#">link</a>.</p><p class="muted">Muted text (<code>muted</code>) for things of less importance.</p>',
   '{}', null, null),
  (6, 40, 'List as links', 'list', 4, 'standard', '{}', null, '{"list": "UX_SHORTCUTS", "template": "links"}', null, null),
  (6, 50, 'List as badges', 'list', 8, 'standard', '{}', null, '{"list": "UX_SHORTCUTS", "template": "badges"}', null, null),
  (6, 60, 'List as tabs', 'list', 12, 'standard', '{}', null, '{"list": "UX_SHORTCUTS", "template": "tabs"}', null, null),
  (6, 70, 'Media list (ut_media_list)', 'template_component', 6, 'standard', '{}',
   E'select name as title, role || '' · '' || status as description, upper(left(name, 1) || substr(name, strpos(name, '' '') + 1, 1)) as initials,\n       status as badge, case status when ''Active'' then ''success'' when ''Away'' then ''warning'' else ''neutral'' end as state\n  from ux_patterns.person order by name',
   '{"component": "ut_media_list", "display": "multiple"}', null, null),
  (6, 80, 'Timeline (ut_timeline)', 'template_component', 6, 'standard', '{}',
   E'select name || '' joined as '' || lower(role) as title, to_char(joined, ''YYYY-MM-DD'') as "when", status as who, note as body,\n       case status when ''Active'' then ''success'' when ''Away'' then ''warning'' else ''neutral'' end as state\n  from ux_patterns.person order by joined desc',
   '{"component": "ut_timeline", "display": "multiple"}', null, null),
  (6, 90, 'Comments (ut_comments)', 'template_component', 6, 'standard', '{}',
   E'select name as "user", upper(left(name, 1) || substr(name, strpos(name, '' '') + 1, 1)) as initials, to_char(joined, ''YYYY-MM-DD'') as date, note as comment, role as actions\n  from ux_patterns.person where status <> ''Left'' order by joined desc',
   '{"component": "ut_comments", "display": "multiple"}', null, null),
  (6, 100, 'Avatars (ut_avatar)', 'template_component', 6, 'standard', '{}',
   E'select name, upper(left(name, 1) || substr(name, strpos(name, '' '') + 1, 1)) as initials from ux_patterns.person order by name',
   '{"component": "ut_avatar", "display": "multiple", "attributes": {"SIZE": "large"}}', null, null),
  (6, 110, 'Metric cards (ut_metric_card)', 'template_component', 12, 'standard', '{}',
   E'select ''People'' as label, count(*)::text as value, null as unit, count(*) filter (where joined > current_date - 365) || '' joined this year'' as change, ''up'' as trend, ''up'' as good from ux_patterns.person\nunion all\nselect ''Away'', count(*) filter (where status = ''Away'')::text, ''people'', null, ''flat'', ''down'' from ux_patterns.person\nunion all\nselect ''Left'', count(*) filter (where status = ''Left'')::text, ''people'', ''one more than last year'', ''up'', ''down'' from ux_patterns.person',
   '{"component": "ut_metric_card", "display": "multiple"}', null, null),
  (6, 120, 'KPI tiles (cards, style metric)', 'cards', 12, 'plain', '{}',
   E'select status as title, count(*)::text as badge, case status when ''Active'' then ''check-circle'' when ''Away'' then ''clock'' else ''logout'' end as icon\n  from ux_patterns.person group by status order by status',
   '{"style": "metric"}', null, null),
  (6, 130, 'Empty state of a report', 'report', 6, 'standard', '{}',
   E'select name, role from ux_patterns.person where false', '{"searchable": false, "empty": "Nobody here yet: a report with no rows shows its empty text."}', null, null),
  (6, 140, 'Empty state of cards', 'cards', 6, 'standard', '{}',
   E'select name as title from ux_patterns.person where false', '{"empty": "No cards to show: a cards region with no rows shows its empty text."}', null, null),

  -- 7 Page patterns
  (7, 5, 'About this page', 'static', 12, 'plain', '{}',
   '<p class="lead">A page''s <strong>mode</strong> and <strong>dialog position</strong> make it a modal dialog or a drawer; its <strong>page template</strong> can add a side column. The buttons open examples of each.</p>',
   '{}', null, null),
  (7, 10, 'Dialogs, drawers and columns', 'static', 12, 'buttons_container', '{}', null, '{}', 'p-buttons', null),
  (8, 10, 'A modal dialog', 'static', 12, 'plain', '{}',
   '<p>This page has the mode <em>Modal dialog</em> with the size <em>small</em>. It opens over the page that linked to it; on a phone it fills the screen. Opened directly, it is an ordinary page.</p>',
   '{}', null, null),
  (9, 10, 'A drawer', 'static', 12, 'plain', '{}',
   '<p>This page is a modal dialog with the position <em>right</em>: a drawer that slides in from the right edge. Top, bottom and left drawers work the same way.</p>',
   '{}', null, null),
  (10, 10, 'The side column', 'static', 12, 'standard', '{}',
   '<p>This region has the position <code>left</code>. On a page with the template <em>Left side column</em> it shows beside the body; on a narrow screen above it.</p>',
   '{}', null, 'left'),
  (10, 20, 'The body', 'static', 12, 'standard', '{}',
   '<p>The regions of the body use the 12-column grid as usual. A faceted search beside its report is the typical use of a side column.</p>',
   '{}', null, null)
  ) as r (page, seq, title, type, cols, template, topts, source, config, sid, pos);

-- buttons
insert into meta.button (page_id, region_id, seq, name, label, action, hot, target_page, template_options, menu, badge)
select pg_temp.page_id('ux-patterns', b.page), pg_temp.region_id('ux-patterns', b.page, b.region), b.seq, b.name, b.label, b.action, b.hot, b.target,
       b.topts::text[], b.menu::jsonb, b.badge
  from (values
  (2, 'title-bar', 10, 'TB_EDIT', 'Edit', 'da', false, null, '{}', null, null),
  (2, 'title-bar', 20, 'TB_ADD', 'Add', 'da', true, null, '{}', null, null),
  (2, 'buttons', 10, 'OPEN_DIALOG', 'Open the inline dialog', 'da', false, null, '{}', null, null),
  (2, 'buttons', 20, 'OPEN_DRAWER', 'Open the inline drawer', 'da', false, null, '{}', null, null),
  (4, 'b-kind', 10, 'NORMAL', 'Normal', 'da', false, null, '{}', null, null),
  (4, 'b-kind', 20, 'HOT', 'Hot', 'da', true, null, '{}', null, null),
  (4, 'b-size', 10, 'SMALL', 'Small (to-small)', 'da', false, null, '{to-small}', null, null),
  (4, 'b-size', 20, 'MEDIUM', 'Normal', 'da', false, null, '{}', null, null),
  (4, 'b-size', 30, 'LARGE', 'Large (to-large)', 'da', false, null, '{to-large}', null, null),
  (4, 'b-shape', 10, 'PILL', 'Pill (to-pill)', 'da', false, null, '{to-pill}', null, null),
  (4, 'b-shape', 20, 'OUTLINE', 'Outline (to-outline)', 'da', false, null, '{to-outline}', null, null),
  (4, 'b-shape', 30, 'LINK', 'Link (to-link)', 'da', false, null, '{to-link}', null, null),
  (4, 'b-colour', 10, 'SUCCESS', 'Success (to-success)', 'da', false, null, '{to-success}', null, null),
  (4, 'b-colour', 20, 'DANGER', 'Danger (to-danger)', 'da', false, null, '{to-danger}', null, null),
  (4, 'b-colour', 30, 'HOT_PILL', 'Hot pill', 'da', true, null, '{to-pill}', null, null),
  (4, 'b-block', 10, 'BLOCK', 'A full-width button', 'da', true, null, '{to-block}', null, null),
  (4, 'b-menu', 10, 'MENU', 'Go to', 'menu', false, null, '{}',
   '[{"label": "Region templates", "page": 2, "icon": "layers"}, {"label": "Items and forms", "page": 5, "icon": "edit"}, {"label": "Content patterns", "page": 6, "icon": "grid"}]', null),
  (4, 'b-menu', 20, 'INBOX', 'Inbox', 'da', false, null, '{}', null, '3'),
  (7, 'p-buttons', 10, 'MODAL', 'Open a modal dialog', 'redirect', true, 8, '{}', null, null),
  (7, 'p-buttons', 20, 'DRAWER', 'Open a drawer', 'redirect', false, 9, '{}', null, null),
  (7, 'p-buttons', 30, 'SIDE', 'A page with a side column', 'redirect', false, 10, '{}', null, null)
  ) as b (page, region, seq, name, label, action, hot, target, topts, menu, badge);

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select pg_temp.page_id('ux-patterns', 2), d.seq, d.name, 'click', d.button, 'open_region', pg_temp.region_id('ux-patterns', 2, d.region)
  from (values (10, 'Open the inline dialog', 'OPEN_DIALOG', 'dialog'), (20, 'Open the inline drawer', 'OPEN_DRAWER', 'drawer')) as d (seq, name, button, region);

-- items
insert into meta.item (page_id, region_id, seq, name, label, type, lov, default_value, required, help, config, template_options)
select pg_temp.page_id('ux-patterns', 5), pg_temp.region_id('ux-patterns', 5, i.region), i.seq, i.name, i.label, i.type, i.lov, i.def, i.req, i.help,
       i.config::jsonb, i.topts::text[]
  from (values
  ('f-text', 10, 'P5_NAME', 'Name (text, required)', 'text', null, null, true, 'Required items are marked with a *.', '{}', '{}'),
  ('f-text', 20, 'P5_EMAIL', 'E-mail (email)', 'email', null, null, false, null, '{}', '{}'),
  ('f-text', 30, 'P5_AMOUNT', 'Amount (number)', 'number', null, '1250.5', false, 'With the format mask 999G990D00.', '{"format_mask": "999G990D00"}', '{}'),
  ('f-text', 40, 'P5_PASSWORD', 'Password (password)', 'password', null, null, false, null, '{"reveal": true}', '{}'),
  ('f-text', 50, 'P5_NOTES', 'Notes (textarea)', 'textarea', null, null, false, 'A textarea always takes the whole row.', '{"rows": 3}', '{}'),
  ('f-choice', 10, 'P5_STATUS', 'Status (select)', 'select', 'STATIC:Active,Away,Left', 'Active', false, null, '{}', '{}'),
  ('f-choice', 20, 'P5_SIZE', 'Size (radio)', 'radio', 'STATIC:Small;S,Medium;M,Large;L', 'M', false, null, '{}', '{}'),
  ('f-choice', 30, 'P5_DAYS', 'Days (checkbox group)', 'checkbox_group', 'STATIC:Mon,Tue,Wed,Thu,Fri', 'Mon:Wed', false, 'Several values, colon separated.', '{}', '{}'),
  ('f-choice', 40, 'P5_ACTIVE', 'Active (switch)', 'switch', null, 'true', false, null, '{}', '{}'),
  ('f-choice', 50, 'P5_AGREE', 'I agree (checkbox)', 'checkbox', null, null, false, null, '{}', '{}'),
  ('f-choice', 60, 'P5_RATING', 'Rating (rating)', 'rating', null, '4', false, null, '{}', '{}'),
  ('f-date', 10, 'P5_DAY', 'Day (date)', 'date', null, null, false, 'With the date picker.', '{}', '{}'),
  ('f-date', 20, 'P5_PERIOD', 'Period (date range)', 'daterange', null, null, false, null, '{}', '{}'),
  ('f-date', 30, 'P5_COLOUR', 'Colour (color)', 'color', null, '#2f6fde', false, null, '{}', '{}'),
  ('f-date', 40, 'P5_TAGS', 'Tags (combobox)', 'combobox', 'STATIC:Urgent,Customer,Internal', null, false, 'Free text with suggestions; several values become tags.', '{}', '{}'),
  ('f-date', 50, 'P5_SHOWN', 'Display only (display)', 'display', null, 'A value that cannot be changed', false, null, '{}', '{}'),
  ('f-options', 10, 'P5_STRETCH', 'Stretch (to-stretch)', 'text', null, null, false, 'Takes the whole row of the form grid.', '{}', '{to-stretch}'),
  ('f-options', 20, 'P5_LARGE', 'Large field (to-large)', 'text', null, null, false, null, '{}', '{to-large}'),
  ('f-options', 30, 'P5_QUIET', 'Quiet (to-quiet)', 'text', null, null, false, 'No border until the field has the focus.', '{}', '{to-quiet}'),
  ('f-options', 40, 'P5_BOLD', 'Bold value (to-bold)', 'display', null, 'A bold value', false, null, '{}', '{to-bold}'),
  ('f-options', 50, 'P5_HIDDEN_LABEL', 'Hidden label (to-hide-label)', 'text', null, 'The label is only for screen readers', false, null, '{}', '{to-hide-label}')
  ) as i (region, seq, name, label, type, lov, def, req, help, config, topts);
