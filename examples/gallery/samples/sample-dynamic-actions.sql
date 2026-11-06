-- =====================================================================
-- Sample app "Sample Dynamic Actions" (App Gallery → Sample Apps)
--
-- Behaviour in the browser without JavaScript of your own:
--   page 2  show, hide, enable and disable items on a condition;
--   page 3  values from the server (set value, execute SQL) and a report
--           refreshed when an item changes;
--   page 4  messages, confirmations, a wait popup, classes, item errors,
--           an inline dialog and actions on page load and key release;
--   page 5  keyboard and mouse: key down / key press (with Cancel Event),
--           focus, blur, select, double click, mouse enter / leave and
--           Set Style with greater / less conditions;
--   page 6  a form with rules: Before Submit, Submit, Refresh Item, Disable,
--           Hide, list and empty conditions, Page Unload, a dialog page
--           (page 10) closed or cancelled by a dynamic action;
--   page 7  regions and the window: before / after refresh, resize, scroll,
--           Close Region, Print, Share, Download, Push Subscribe;
--   page 8  a tree: Selection Change, Expand Tree, Collapse Tree;
--   page 9  faceted search: Facets Change and the report's dialogs;
--   page 11 Show AI Assistant (asking needs an AI service set up by an
--           administrator; the page works without one).
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-dynamic-actions.sql
-- then open /a/sample-dynamic-actions and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;
create or replace function pg_temp.region_id(p_alias text, p_page int, p_static text) returns int language sql stable as
  $$ select r.id from meta.region r where r.page_id = pg_temp.page_id(p_alias, p_page) and r.static_id = p_static $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_da;

create table sample_da.city (
  country text not null,
  name    text not null,
  primary key (country, name)
);

insert into sample_da.city (country, name) values
  ('NL', 'Amsterdam'), ('NL', 'Rotterdam'), ('NL', 'Utrecht'), ('BE', 'Antwerp'), ('BE', 'Brussels'), ('BE', 'Ghent'),
  ('DE', 'Berlin'), ('DE', 'Hamburg'), ('DE', 'Munich'), ('FR', 'Lyon'), ('FR', 'Paris'), ('FR', 'Toulouse'),
  ('US', 'Boston'), ('US', 'Chicago'), ('US', 'Seattle'), ('JP', 'Osaka'), ('JP', 'Sapporo'), ('JP', 'Tokyo');

create table sample_da.product (
  id       int generated always as identity primary key,
  name     text not null unique,
  category text not null,
  price    numeric(10, 2) not null
);

insert into sample_da.product (name, category, price) values
  ('Notebook', 'Paper', 3.50), ('Sticky notes', 'Paper', 2.25), ('Printer paper', 'Paper', 6.95),
  ('Ballpoint', 'Pens', 1.20), ('Fountain pen', 'Pens', 24.00), ('Marker set', 'Pens', 8.40),
  ('Stapler', 'Desk', 12.50), ('Desk organiser', 'Desk', 18.00), ('Scissors', 'Desk', 6.75);

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_da') then create role app_sample_da nologin; end if;
end $$;
grant app_sample_da to pgkiln_runtime;
grant usage on schema sample_da to app_sample_da;
grant select on all tables in schema sample_da to app_sample_da;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-dynamic-actions', 'Sample Dynamic Actions', 1, 'app_users', 'app_sample_da');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-dynamic-actions';

-- push notifications on, for the dynamic action push_subscribe (page 7)
update meta.app set pwa = true, pwa_push = true where alias = 'sample-dynamic-actions';

insert into meta.page (app_id, page_no, name, title, parent_page, mode)
select a.id, p.no, p.name, p.name, p.parent, p.mode
  from meta.app a, (values
  (1, 'Sample Dynamic Actions', null, 'normal'), (2, 'Show, hide, enable', 1, 'normal'), (3, 'Values from the server', 1, 'normal'),
  (4, 'Messages and effects', 1, 'normal'), (5, 'Keyboard and mouse', 1, 'normal'), (6, 'A form with rules', 1, 'normal'),
  (7, 'Regions and the window', 1, 'normal'), (8, 'A tree', 1, 'normal'), (9, 'Faceted search', 1, 'normal'),
  (10, 'A dialog page', 6, 'modal'), (11, 'AI assistant', 1, 'normal')
  ) as p (no, name, parent, mode)
 where a.alias = 'sample-dynamic-actions';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Show, hide, enable', 'eye', 2), (30, 'Values from the server', 'refresh', 3), (40, 'Messages and effects', 'bell', 4),
  (50, 'Keyboard and mouse', 'keyboard', 5), (60, 'A form with rules', 'clipboard', 6), (70, 'Regions and the window', 'layers', 7),
  (80, 'A tree', 'folder', 8), (90, 'Faceted search', 'filter', 9), (100, 'AI assistant', 'chat', 11)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-dynamic-actions';

insert into meta.list (app_id, name, type, description)
select id, 'DA_TOPICS', 'static', 'The pages of Sample Dynamic Actions' from meta.app where alias = 'sample-dynamic-actions';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'DA_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Show, hide, enable', 'eye', 2, 'Items that appear, disappear or switch on depending on another item.'),
  (20, 'Values from the server', 'refresh', 3, 'SQL fills in items and refreshes a report, without reloading the page.'),
  (30, 'Messages and effects', 'bell', 4, 'Alerts, confirmations, a wait popup, classes, item errors and an inline dialog.'),
  (40, 'Keyboard and mouse', 'keyboard', 5, 'Keys counted or refused, focus, selected text, double clicks, hovering and Set Style.'),
  (50, 'A form with rules', 'clipboard', 6, 'Before submit, submit, a list refreshed by another item, disable and hide, a dialog page.'),
  (60, 'Regions and the window', 'layers', 7, 'Before and after a refresh, resize and scroll, print, share, download, notifications.'),
  (70, 'A tree', 'folder', 8, 'A node chosen in a tree shows its products; expand and collapse every node.'),
  (80, 'Faceted search', 'filter', 9, 'Facets that changed, and the interactive report''s dialogs opened by buttons.'),
  (90, 'AI assistant', 'chat', 11, 'A button that opens an AI assistant and puts the cursor in its question.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-dynamic-actions';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id)
select pg_temp.page_id('sample-dynamic-actions', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb, r.sid
  from (values
  -- 1 Home
  (1, 10, 'Sample Dynamic Actions', 'static', 12, 'hero',
   '<p>A dynamic action is an <strong>event</strong> (an item changes, a button is clicked, the page loads), an optional <strong>condition</strong> on the item''s value and an <strong>action</strong>: show or hide, set a value with SQL, refresh a region, show a message. The actions of one event run in sequence. They need JavaScript; without it the pages still work, without these conveniences.</p>',
   '{"icon": "bolt"}', null),
  (1, 20, 'Topics', 'list', 12, 'plain', null, '{"list": "DA_TOPICS", "template": "cards"}', null),

  -- 2 Show, hide, enable
  (2, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead"><strong>Show</strong> with a condition shows the company fields when <em>Customer type</em> equals Company, and hides them otherwise: one dynamic action does both, also when the page loads (already on the server, so nothing flickers). <strong>Enable</strong> works the same way for the e-mail address.</p>',
   '{}', null),
  (2, 10, 'Customer', 'static', 6, 'standard', null, '{}', 'customer'),
  (2, 20, 'Newsletter', 'static', 6, 'standard', null, '{}', 'newsletter'),

  -- 3 Values from the server
  (3, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead"><strong>Set value</strong> runs a SELECT on the server with the items it submits and puts the columns of its first row into the affected items: choosing a product fills in its price, changing the quantity the total. <strong>Refresh region</strong> draws the report again with the chosen category. The SQL never reaches the browser.</p>',
   '{}', null),
  (3, 10, 'Order line', 'static', 6, 'standard', null, '{}', 'order-line'),
  (3, 20, 'Filter', 'static', 6, 'standard', null, '{}', 'filter'),
  (3, 30, 'Products', 'report', 12, 'standard',
   E'select name, category, price from sample_da.product\n where :P3_CATEGORY is null or category = :P3_CATEGORY\n order by category, name',
   '{"formats": {"price": "999G990D00"}}', 'products'),

  -- 4 Messages and effects
  (4, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Each button has the action <em>Defined by dynamic action</em>. <strong>Confirm</strong> stops the actions after it when you answer No; <strong>Wait popup</strong> covers the page while an Ajax call runs; <strong>Add class</strong> and <strong>Remove class</strong> change a region''s look; <strong>Show error</strong> puts a message under an item; <strong>Open region</strong> opens an inline dialog. Typing in the name runs a <em>Key release</em> action, and the page load puts the cursor in it.</p>',
   '{}', null),
  (4, 10, 'Try the actions', 'static', 12, 'buttons_container', null, '{}', 'buttons'),
  (4, 20, 'Greeting', 'static', 6, 'standard', null, '{}', 'greeting'),
  (4, 30, 'A region to highlight', 'static', 6, 'standard',
   '<p>The buttons <em>Highlight</em> and <em>Mute</em> add the theme''s classes <code>is-highlight</code> and <code>is-muted</code> to this region; <em>Reset</em> removes them.</p>',
   '{}', 'target'),
  (4, 40, 'An inline dialog', 'static', 12, 'inline_dialog',
   '<p>This region has the template <em>Inline dialog</em>: hidden until a dynamic action (or a link to its id) opens it. Escape, the close button or a click beside it closes it.</p>',
   '{}', 'dialog'),

  -- 5 Keyboard and mouse
  (5, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Events of the keyboard and the mouse. <strong>Key down</strong> counts every key you press in <em>Type here</em> (a <em>Set value</em> on the server). <strong>Key press</strong> with the condition <em>greater or equal</em> 100 and <strong>Cancel Event</strong> keeps a fourth digit out of <em>Quantity</em>. <strong>Focus</strong> and <strong>Blur</strong> highlight the note''s region while you are in it, <strong>Select</strong> notices selected text, a <strong>Double click</strong> runs <em>Clear</em>. <strong>Mouse enter</strong> and <strong>Mouse leave</strong> highlight a region under the pointer, and <strong>Set Style</strong> marks the score with a coloured bar by conditions <em>greater</em>, <em>greater or equal</em> and <em>less</em>.</p>',
   '{}', null),
  (5, 10, 'Keys', 'static', 6, 'standard', null, '{}', 'keys'),
  (5, 20, 'A note', 'static', 6, 'standard', null, '{}', 'note-box'),
  (5, 30, 'Score', 'static', 6, 'standard', null, '{}', 'score'),
  (5, 40, 'Point at this region', 'static', 6, 'standard',
   '<p>Move the pointer onto this region: <em>Mouse enter</em> adds the class <code>is-highlight</code>, <em>Mouse leave</em> removes it again. Each runs once per visit, not on every movement inside it.</p>',
   '{}', 'hover'),

  -- 6 A form with rules
  (6, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead"><strong>Disable</strong> with the condition <em>is empty</em> keeps the buttons off until you have typed a name and left the field. A city list is drawn again with <strong>Refresh item</strong> when the country changes (its SQL uses the country). <strong>Hide</strong> with <em>not in list</em> hides the VAT number outside the EU, <strong>Show</strong> with <em>in list</em> shows the free delivery note and the customs number; <em>less or equal</em> 0 copies shows an error. Every submit runs <strong>Before submit</strong> first: a confirmation that can stop it. <em>Send</em> is a submit button (its process shows a message); <em>Keep as a draft</em> runs the action <strong>Submit</strong>, a submit without a button: the values are kept in session state and no process runs. Leaving the page (<strong>Page unload</strong>) shows a wait popup until the next page is there. <em>Open the dialog page</em> opens page 10, whose buttons run <strong>Close dialog</strong> and <strong>Cancel dialog</strong>.</p>',
   '{}', null),
  (6, 10, 'Order', 'static', 6, 'standard', null, '{}', 'order'),
  (6, 20, 'Delivery', 'static', 6, 'standard', null, '{}', 'delivery'),
  (6, 30, 'Free delivery', 'static', 6, 'standard',
   '<p>Orders to the Netherlands and Belgium are delivered for free. This region is shown by <em>Show</em> with the condition <em>in list</em> <code>NL,BE</code>.</p>',
   '{}', 'free-delivery'),
  (6, 40, 'Send', 'static', 12, 'buttons_container', null, '{}', 'send'),

  -- 7 Regions and the window
  (7, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead"><em>Shuffle</em> refreshes the report: <strong>Before refresh</strong> dims it, <strong>After refresh</strong> notes the time. Changing the window''s size runs <strong>Resize</strong>; scrolling runs <strong>Scroll</strong>, which closes the collapsible <em>Tips</em> with <strong>Close region</strong>. The other buttons run <strong>Print</strong>, <strong>Share</strong> (the device''s share sheet, else the address is copied), <strong>Download</strong> (the file of a download process of the page) and <strong>Push subscribe</strong> (turns on notifications on this device; the server needs <code>PGKILN_SECRET_KEY</code> for them).</p>',
   '{}', null),
  (7, 10, 'Tips', 'static', 12, 'collapsible',
   '<p>This region is collapsible. Scroll the page and a <em>Scroll</em> dynamic action closes it with <em>Close region</em>; open it again with its heading.</p><p>A dynamic action on <em>Resize</em> or <em>Scroll</em> runs at most once per frame, so it can''t slow the page down.</p>',
   '{}', 'tips'),
  (7, 20, 'Try the actions', 'static', 12, 'buttons_container', null, '{}', 'tools'),
  (7, 30, 'Products in random order', 'report', 12, 'standard',
   'select name, category, price from sample_da.product order by random()',
   '{"formats": {"price": "999G990D00"}, "sortable": false, "page_size": 50}', 'shuffled'),
  (7, 40, 'Pick products', 'report', 12, 'standard',
   'select name, category, price from sample_da.product order by name',
   '{"formats": {"price": "999G990D00"}, "page_size": 10, "selection": {"column": "name", "item": "P7_PICKED"}}', 'picks'),

  -- 8 A tree
  (8, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Clicking a node of the tree runs <strong>Selection change [Tree]</strong>: a <em>Set value</em> without SQL puts the node''s id into an item, and <em>Refresh region</em> draws the report with it. <strong>Expand tree</strong> and <strong>Collapse tree</strong> open or close every node.</p>',
   '{}', null),
  (8, 10, 'Categories and products', 'tree', 5, 'standard',
   E'select ''c-'' || lower(category) as id, null::text as parent_id, category as label from sample_da.product group by category\nunion all\nselect id::text, ''c-'' || lower(category), name from sample_da.product',
   '{"expanded": 1}', 'catalogue-tree'),
  (8, 20, 'Chosen', 'report', 7, 'standard',
   E'select name, category, price from sample_da.product\n where :P8_NODE is not null and (id::text = :P8_NODE or ''c-'' || lower(category) = :P8_NODE)\n order by name',
   '{"formats": {"price": "999G990D00"}, "searchable": false, "empty": "Choose a category or a product in the tree."}', 'chosen'),

  -- 9 Faceted search
  (9, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Choosing a facet runs <strong>Facets change</strong> on the page that comes back with the new filters: here a success message. The buttons of the report run <strong>Open report dialog</strong> with the interactive report''s <em>Filter</em>, <em>Columns</em> and <em>Chart</em> dialogs.</p>',
   '{}', null),
  (9, 10, 'Filters', 'facets', 3, 'collapsible', null, '{}', 'filters'),
  (9, 30, 'Catalogue', 'report', 9, 'standard',
   'select name, category, price from sample_da.product',
   '{"formats": {"price": "999G990D00"}}', 'catalogue'),

  -- 10 A dialog page
  (10, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">This page is a <strong>modal dialog</strong>. <em>Close</em> runs <strong>Close dialog</strong>: the page below runs its <em>Dialog closed</em> actions (a message). <em>Cancel</em> runs <strong>Cancel dialog</strong>: the dialog closes and nothing else happens.</p>',
   '{}', null),
  (10, 10, 'Close or cancel', 'static', 12, 'buttons_container', null, '{}', 'dialog-buttons'),

  -- 11 AI assistant
  (11, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The button runs <strong>Show AI Assistant</strong>: it opens the AI assistant region (here in an inline dialog) and puts the cursor in its question. Answers need an AI service that an administrator set up and allowed for this application; without one the assistant says so.</p>',
   '{}', null),
  (11, 10, 'Ask', 'static', 12, 'buttons_container', null, '{}', 'ask'),
  (11, 20, 'Office supplies assistant', 'ai_assistant', 12, 'inline_dialog', null,
   '{"service": "CLAUDE", "system": "You answer questions about the office supplies in the data, briefly.", "welcome": "Ask me about the office supplies: prices, categories, what is cheapest.", "placeholder": "Which pens are there?", "context": [{"name": "products", "sql": "select name, category, price from sample_da.product order by category, name", "max_rows": 50}], "error_message": "No AI service is set up for this application: an administrator adds one (Administration, AI services) and allows it for the application."}',
   'assistant')
  ) as r (page, seq, title, type, cols, template, source, config, sid);

-- the facets filter the catalogue report (its id)
update meta.region set config = jsonb_build_object(
  'report', pg_temp.region_id('sample-dynamic-actions', 9, 'catalogue'),
  'facets', '[{"column": "category", "label": "Category"},
              {"column": "price", "label": "Price", "type": "range", "ranges": [{"to": 5, "label": "Below 5"}, {"from": 5, "to": 15, "label": "5 to 15"}, {"from": 15, "label": "15 and more"}]}]'::jsonb)
 where id = pg_temp.region_id('sample-dynamic-actions', 9, 'filters');

insert into meta.item (page_id, region_id, seq, name, label, type, lov, default_value, help, config)
select pg_temp.page_id('sample-dynamic-actions', i.page), pg_temp.region_id('sample-dynamic-actions', i.page, i.region),
       i.seq, i.name, i.label, i.type, i.lov, i.def, i.help, i.config::jsonb
  from (values
  (2, 'customer', 10, 'P2_TYPE', 'Customer type', 'radio', 'STATIC:Person;PERSON,Company;COMPANY', 'PERSON', null, '{}'),
  (2, 'customer', 20, 'P2_NAME', 'Name', 'text', null, null, null, '{}'),
  (2, 'customer', 30, 'P2_COMPANY', 'Company name', 'text', null, null, 'Shown only for companies.', '{}'),
  (2, 'customer', 40, 'P2_VAT', 'VAT number', 'text', null, null, 'Shown only for companies.', '{}'),
  (2, 'newsletter', 10, 'P2_NEWSLETTER', 'Send me the newsletter', 'radio', 'STATIC:Yes;YES,No;NO', 'NO', null, '{}'),
  (2, 'newsletter', 20, 'P2_EMAIL', 'E-mail address', 'email', null, null, 'Enabled only when you want the newsletter.', '{}'),
  (3, 'order-line', 10, 'P3_PRODUCT', 'Product', 'select', 'select name, id from sample_da.product order by name', null, null, '{"warn_unsaved": false}'),
  (3, 'order-line', 20, 'P3_PRICE', 'Price', 'number', null, null, 'Set by the server when you choose a product.', '{"warn_unsaved": false}'),
  (3, 'order-line', 30, 'P3_QTY', 'Quantity', 'number', null, '1', null, '{"warn_unsaved": false}'),
  (3, 'order-line', 40, 'P3_TOTAL', 'Total', 'number', null, null, 'Price times quantity, computed by the server.', '{"warn_unsaved": false}'),
  (3, 'filter', 10, 'P3_CATEGORY', 'Category', 'select', 'select distinct category as d, category as r from sample_da.product order by 1', null,
   'The report below is refreshed when this changes.', '{"warn_unsaved": false, "null_label": "All categories"}'),
  (4, 'greeting', 10, 'P4_NAME', 'Your name', 'text', null, null, 'Type: the greeting follows each key you release.', '{"warn_unsaved": false}'),
  (4, 'greeting', 20, 'P4_GREETING', 'Greeting', 'text', null, null, null, '{"warn_unsaved": false}'),
  (5, 'keys', 10, 'P5_TYPE', 'Type here', 'text', null, null, 'Key down: every key counts, also arrows and Backspace.', '{"warn_unsaved": false}'),
  (5, 'keys', 20, 'P5_KEYS', 'Keys pressed', 'display', null, '0', null, '{}'),
  (5, 'keys', 30, 'P5_QTY', 'Quantity (up to 999)', 'text', null, null, 'Key press: a fourth digit is refused.', '{"warn_unsaved": false}'),
  (5, 'note-box', 10, 'P5_NOTE', 'Note', 'textarea', null, 'Select a word of this text, or double-click to empty the note.', 'Focus highlights the region; a double click empties the note.', '{"warn_unsaved": false}'),
  (5, 'score', 10, 'P5_SCORE', 'Score (0 to 100)', 'number', null, null, 'Set Style marks a score above 80 green, below 50 red.', '{"warn_unsaved": false}'),
  (6, 'order', 10, 'P6_NAME', 'Your name', 'text', null, null, 'The buttons stay off while this is empty.', '{}'),
  (6, 'order', 20, 'P6_COPIES', 'Copies', 'number', null, '1', 'Zero or fewer shows an error.', '{}'),
  (6, 'delivery', 10, 'P6_COUNTRY', 'Country', 'select', 'STATIC:Netherlands;NL,Belgium;BE,Germany;DE,France;FR,United States;US,Japan;JP', null, null, '{"null_label": "Choose a country"}'),
  (6, 'delivery', 20, 'P6_CITY', 'City', 'select', 'select name as d, name as r from sample_da.city where country = :P6_COUNTRY order by 1', null, 'Refresh item draws this list again when the country changes.', '{"null_label": "Choose a city"}'),
  (6, 'delivery', 30, 'P6_VAT', 'VAT number', 'text', null, null, 'Only in the EU (hidden with not in list).', '{}'),
  (6, 'delivery', 40, 'P6_CUSTOMS', 'Customs number', 'text', null, null, 'Only outside the EU (shown with in list).', '{}'),
  (7, 'tools', 10, 'P7_REFRESHED', 'Last shuffled', 'display', null, 'not yet', null, '{}'),
  (7, 'tools', 20, 'P7_PICKED', 'Picked', 'text', null, null, 'Selection change: the rows checked in Pick products, colon separated.', '{"warn_unsaved": false}'),
  (8, 'chosen', 10, 'P8_NODE', 'Chosen node', 'text', null, null, 'Set by the tree: a category (c-…) or a product id.', '{"warn_unsaved": false}')
  ) as i (page, region, seq, name, label, type, lov, def, help, config);

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select pg_temp.page_id('sample-dynamic-actions', 4), pg_temp.region_id('sample-dynamic-actions', 4, 'buttons'), b.seq, b.name, b.label, 'da', b.hot
  from (values
  (10, 'ALERT', 'Alert', false), (20, 'CONFIRM', 'Confirm, then a message', true), (30, 'WAIT', 'Wait popup', false),
  (40, 'HIGHLIGHT', 'Highlight', false), (50, 'MUTE', 'Mute', false), (60, 'RESET', 'Reset', false),
  (70, 'ERROR', 'Show an item error', false), (80, 'CLEAR', 'Clear the errors', false), (90, 'DIALOG', 'Open the inline dialog', false)
  ) as b (seq, name, label, hot);

insert into meta.button (page_id, region_id, seq, name, label, action, hot, target_page)
select pg_temp.page_id('sample-dynamic-actions', b.page), pg_temp.region_id('sample-dynamic-actions', b.page, b.region), b.seq, b.name, b.label, b.action, b.hot, b.target
  from (values
  (6, 'send', 10, 'SEND', 'Send', 'submit', true, null::int), (6, 'send', 20, 'DRAFT', 'Keep as a draft', 'da', false, null),
  (6, 'send', 30, 'OPEN_DIALOG', 'Open the dialog page', 'redirect', false, 10),
  (7, 'tools', 10, 'SHUFFLE', 'Shuffle', 'da', true, null), (7, 'tools', 20, 'PRINT', 'Print', 'da', false, null),
  (7, 'tools', 30, 'SHARE', 'Share', 'da', false, null), (7, 'tools', 40, 'DOWNLOAD', 'Download as CSV', 'da', false, null),
  (7, 'tools', 50, 'NOTIFY', 'Turn on notifications', 'da', false, null),
  (8, 'catalogue-tree', 10, 'EXPAND', 'Expand all', 'da', false, null), (8, 'catalogue-tree', 20, 'COLLAPSE', 'Collapse all', 'da', false, null),
  (9, 'catalogue', 10, 'FILTER', 'Filter…', 'da', false, null), (9, 'catalogue', 20, 'COLUMNS', 'Columns…', 'da', false, null),
  (9, 'catalogue', 30, 'CHART', 'Chart…', 'da', false, null),
  (10, 'dialog-buttons', 10, 'CANCEL', 'Cancel', 'da', false, null), (10, 'dialog-buttons', 20, 'CLOSE', 'Close', 'da', true, null),
  (11, 'ask', 10, 'ASK', 'Ask the assistant', 'da', true, null)
  ) as b (page, region, seq, name, label, action, hot, target);

-- page 6: what Send submits to (the sample stores nothing); page 7: the file of the Download button
insert into meta.process (page_id, seq, name, type, code, point, when_button, success_message, config)
select pg_temp.page_id('sample-dynamic-actions', p.page), p.seq, p.name, p.type, p.code, p.point, p.button, p.message, p.config::jsonb
  from (values
  (6, 10, 'Send the order', 'sql', 'select null', 'submit', 'SEND', 'Sent (this sample stores nothing): Before submit asked first.', '{}'),
  (7, 10, 'PRODUCTS_CSV', 'download',
   E'select ''name;category;price'' || E''\\n'' || string_agg(name || '';'' || category || '';'' || price, E''\\n'' order by name) as content,\n       ''products.csv'' as filename, ''text/csv'' as mime_type\n  from sample_da.product',
   'submit', 'DOWNLOAD', null, '{}')
  ) as p (page, seq, name, type, code, point, button, message, config);

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, condition_value,
                                 action, affected_items, affected_region_id, code, items_to_submit, message, css_classes)
select pg_temp.page_id('sample-dynamic-actions', d.page), d.seq, d.name, d.event, d.trig, d.ctype, d.cvalue,
       d.action, d.items, pg_temp.region_id('sample-dynamic-actions', d.page, d.region), d.code, d.submit, d.message, d.classes
  from (values
  -- page 2
  (2, 10, 'Company fields for companies', 'change', 'P2_TYPE', 'equals', 'COMPANY', 'show', 'P2_COMPANY,P2_VAT', null, null, null, null, null),
  (2, 20, 'E-mail only with the newsletter', 'change', 'P2_NEWSLETTER', 'equals', 'YES', 'enable', 'P2_EMAIL', null, null, null, null, null),
  -- page 3
  (3, 10, 'The product''s price', 'change', 'P3_PRODUCT', null, null, 'set_value', 'P3_PRICE,P3_TOTAL', null,
   'select price, price * coalesce(nullif(:P3_QTY, '''')::numeric, 1) from sample_da.product where id = nullif(:P3_PRODUCT, '''')::int',
   'P3_PRODUCT,P3_QTY', null, null),
  (3, 20, 'The total', 'change', 'P3_QTY', null, null, 'set_value', 'P3_TOTAL', null,
   'select round(coalesce(nullif(:P3_PRICE, '''')::numeric, 0) * coalesce(nullif(:P3_QTY, '''')::numeric, 0), 2)',
   'P3_PRICE,P3_QTY', null, null),
  (3, 30, 'Refresh the products', 'change', 'P3_CATEGORY', null, null, 'refresh_region', null, 'products', null, 'P3_CATEGORY', null, null),
  -- page 4
  (4, 10, 'Put the cursor in the name', 'load', null, null, null, 'set_focus', 'P4_NAME', null, null, null, null, null),
  (4, 20, 'Greet while typing', 'key_release', 'P4_NAME', null, null, 'set_value', 'P4_GREETING', null,
   'select case when coalesce(:P4_NAME, '''') = '''' then '''' else ''Hello, '' || :P4_NAME || ''!'' end', 'P4_NAME', null, null),
  (4, 30, 'An alert', 'click', 'ALERT', null, null, 'alert', null, null, null, null, 'This is an alert: the browser waits until you close it.', null),
  (4, 40, 'Ask first', 'click', 'CONFIRM', null, null, 'confirm', null, null, null, null, 'Show a success message?', null),
  (4, 50, 'Then the message', 'click', 'CONFIRM', null, null, 'show_success', null, null, null, null, 'You said yes: this is a success message.', null),
  (4, 60, 'Wait popup', 'click', 'WAIT', null, null, 'wait_popup', null, null, null, null, 'Working on it…', null),
  (4, 70, 'A slow call', 'click', 'WAIT', null, null, 'execute_sql', null, null, 'select pg_sleep(1.5)', null, null, null),
  (4, 80, 'Done waiting', 'click', 'WAIT', null, null, 'remove_wait_popup', null, null, null, null, null, null),
  (4, 90, 'Highlight the region', 'click', 'HIGHLIGHT', null, null, 'add_class', null, 'target', null, null, null, 'is-highlight'),
  (4, 100, 'Mute the region', 'click', 'MUTE', null, null, 'add_class', null, 'target', null, null, null, 'is-muted'),
  (4, 110, 'Reset the region', 'click', 'RESET', null, null, 'remove_class', null, 'target', null, null, null, 'is-highlight is-muted'),
  (4, 120, 'An item error', 'click', 'ERROR', null, null, 'show_error', 'P4_NAME', null, null, null, 'This is how an error under an item looks.', null),
  (4, 130, 'Clear the errors', 'click', 'CLEAR', null, null, 'clear_errors', null, null, null, null, null, null),
  (4, 140, 'Open the dialog', 'click', 'DIALOG', null, null, 'open_region', null, 'dialog', null, null, null, null)
  ) as d (page, seq, name, event, trig, ctype, cvalue, action, items, region, code, submit, message, classes);

-- pages 5 to 11: more events, actions and client-side conditions (a region trigger is its static id)
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, condition_value,
                                 action, affected_items, affected_region_id, code, items_to_submit, message, css_classes, config)
select pg_temp.page_id('sample-dynamic-actions', d.page), d.seq, d.name, d.event, d.trig, d.ctype, d.cvalue,
       d.action, d.items, pg_temp.region_id('sample-dynamic-actions', d.page, d.region), d.code, d.submit, d.message, d.classes, d.config::jsonb
  from (values
  -- page 5 Keyboard and mouse
  (5, 10, 'Count the keys', 'key_down', 'P5_TYPE', null, null, 'set_value', 'P5_KEYS', null,
   'select coalesce(nullif(:P5_KEYS, '''')::int, 0) + 1', null, null, null, null),
  (5, 20, 'Say why a key is refused', 'key_press', 'P5_QTY', 'greater_equal', '100', 'show_error', 'P5_QTY', null, null, null,
   'Three digits at most: that key was refused.', null, null),
  (5, 30, 'Refuse a fourth digit', 'key_press', 'P5_QTY', 'greater_equal', '100', 'cancel_event', null, null, null, null, null, null, null),
  (5, 40, 'No error below 100', 'change', 'P5_QTY', 'less', '100', 'clear_errors', 'P5_QTY', null, null, null, null, null, null),
  (5, 50, 'Highlight the note while in it', 'focus', 'P5_NOTE', null, null, 'add_class', null, 'note-box', null, null, null, 'is-highlight', null),
  (5, 60, 'Stop highlighting the note', 'blur', 'P5_NOTE', null, null, 'remove_class', null, 'note-box', null, null, null, 'is-highlight', null),
  (5, 70, 'Text selected', 'select', 'P5_NOTE', null, null, 'show_success', null, null, null, null,
   'You selected text in the note (Select). Copy it with Ctrl+C.', null, null),
  (5, 80, 'Empty the note', 'double_click', 'P5_NOTE', null, null, 'clear', 'P5_NOTE', null, null, null, null, null, null),
  (5, 90, 'Highlight under the pointer', 'mouse_enter', 'hover', null, null, 'add_class', null, 'hover', null, null, null, 'is-highlight', null),
  (5, 100, 'Pointer gone', 'mouse_leave', 'hover', null, null, 'remove_class', null, 'hover', null, null, null, 'is-highlight', null),
  (5, 110, 'A plain score', 'change', 'P5_SCORE', 'greater_equal', '50', 'set_style', 'P5_SCORE', null, null, null, null, null,
   '{"styles": {"border-width": "0", "padding": "0"}}'),
  (5, 120, 'A high score in green', 'change', 'P5_SCORE', 'greater', '80', 'set_style', 'P5_SCORE', null, null, null, null, null,
   '{"styles": {"border-style": "solid", "border-width": "0 0 0 4px", "border-color": "#067647", "padding": "0 0 0 8px"}}'),
  (5, 130, 'A low score in red', 'change', 'P5_SCORE', 'less', '50', 'set_style', 'P5_SCORE', null, null, null, null, null,
   '{"styles": {"border-style": "solid", "border-width": "0 0 0 4px", "border-color": "#b42318", "padding": "0 0 0 8px"}}'),
  -- page 6 A form with rules
  (6, 10, 'Send only with a name', 'change', 'P6_NAME', 'is_null', null, 'disable', null, 'send', null, null, null, null, null),
  (6, 20, 'Cities of the country', 'change', 'P6_COUNTRY', null, null, 'refresh_item', 'P6_CITY', null, null, 'P6_COUNTRY', null, null, null),
  (6, 30, 'No VAT number outside the EU', 'change', 'P6_COUNTRY', 'not_in_list', 'NL,BE,DE,FR', 'hide', 'P6_VAT', null, null, null, null, null, null),
  (6, 40, 'Customs outside the EU', 'change', 'P6_COUNTRY', 'in_list', 'US,JP', 'show', 'P6_CUSTOMS', null, null, null, null, null, null),
  (6, 50, 'Free delivery in the Benelux', 'change', 'P6_COUNTRY', 'in_list', 'NL,BE', 'show', null, 'free-delivery', null, null, null, null, null),
  (6, 60, 'At least one copy', 'change', 'P6_COPIES', 'less_equal', '0', 'show_error', 'P6_COPIES', null, null, null,
   'At least one copy, please.', null, null),
  (6, 70, 'Copies are fine', 'change', 'P6_COPIES', 'greater', '0', 'clear_errors', 'P6_COPIES', null, null, null, null, null, null),
  (6, 80, 'A draft submits the page', 'click', 'DRAFT', null, null, 'submit', null, null, null, null, null, null, null),
  (6, 90, 'Ask before sending', 'before_submit', null, null, null, 'confirm', null, null, null, null, 'Submit the order form?', null, null),
  (6, 100, 'A popup while leaving', 'page_unload', null, null, null, 'wait_popup', null, null, null, null, 'Loading the next page…', null, null),
  (6, 110, 'The dialog page was closed', 'dialog_closed', '10', null, null, 'show_success', null, null, null, null,
   'The dialog page ran Close dialog: this page ran its Dialog closed action instead of reloading.', null, null),
  -- page 7 Regions and the window
  (7, 10, 'Shuffle the report', 'click', 'SHUFFLE', null, null, 'refresh_region', null, 'shuffled', null, null, null, null, null),
  (7, 20, 'Dim it while it loads', 'before_refresh', 'shuffled', null, null, 'add_class', null, 'shuffled', null, null, null, 'is-muted', null),
  (7, 30, 'Note the time', 'after_refresh', 'shuffled', null, null, 'set_value', 'P7_REFRESHED', null,
   'select to_char(clock_timestamp(), ''HH24:MI:SS'')', null, null, null, null),
  (7, 40, 'The window changed size', 'resize', null, null, null, 'show_success', null, null, null, null,
   'The window changed size (Resize): the regions flowed into the new width.', null, null),
  (7, 50, 'Close the tips when scrolling', 'scroll', null, null, null, 'close_region', null, 'tips', null, null, null, null, null),
  (7, 55, 'Note the picked rows', 'selection_change', 'picks', null, null, 'show_success', null, null, null, null,
   'Selection change: the checked rows go into Picked with the next submit.', null, null),
  (7, 60, 'Print the page', 'click', 'PRINT', null, null, 'print', null, null, null, null, null, null, null),
  (7, 70, 'Share the page', 'click', 'SHARE', null, null, 'share', null, null, null, null, 'Dynamic actions in pgkiln, without JavaScript of your own.', null, null),
  (7, 80, 'Download the products', 'click', 'DOWNLOAD', null, null, 'download', null, null, 'PRODUCTS_CSV', null, null, null, null),
  (7, 90, 'Turn on notifications', 'click', 'NOTIFY', null, null, 'push_subscribe', null, null, null, null,
   'Notifications are on for this device.', null, null),
  -- page 8 A tree
  (8, 10, 'Remember the node', 'tree_selection_change', 'catalogue-tree', null, null, 'set_value', 'P8_NODE', null, null, null, null, null, null),
  (8, 20, 'Show its products', 'tree_selection_change', 'catalogue-tree', null, null, 'refresh_region', null, 'chosen', null, 'P8_NODE', null, null, null),
  (8, 30, 'Open every node', 'click', 'EXPAND', null, null, 'expand_tree', null, 'catalogue-tree', null, null, null, null, null),
  (8, 40, 'Close every node', 'click', 'COLLAPSE', null, null, 'collapse_tree', null, 'catalogue-tree', null, null, null, null, null),
  -- page 9 Faceted search
  (9, 10, 'The facets changed', 'facets_change', 'filters', null, null, 'show_success', null, null, null, null,
   'The facets changed (Facets change): the catalogue shows the matching products.', null, null),
  (9, 20, 'The filter dialog', 'click', 'FILTER', null, null, 'open_report_dialog', null, 'catalogue', 'filter', null, null, null, null),
  (9, 30, 'The columns dialog', 'click', 'COLUMNS', null, null, 'open_report_dialog', null, 'catalogue', 'columns', null, null, null, null),
  (9, 40, 'The chart dialog', 'click', 'CHART', null, null, 'open_report_dialog', null, 'catalogue', 'chart', null, null, null, null),
  -- page 10 A dialog page
  (10, 10, 'Cancel the dialog', 'click', 'CANCEL', null, null, 'cancel_dialog', null, null, null, null, null, null, null),
  (10, 20, 'Close the dialog', 'click', 'CLOSE', null, null, 'close_dialog', null, null, null, null, null, null, null),
  -- page 11 AI assistant
  (11, 10, 'Open the assistant', 'click', 'ASK', null, null, 'show_ai_assistant', null, 'assistant', null, null, null, null, null)
  ) as d (page, seq, name, event, trig, ctype, cvalue, action, items, region, code, submit, message, classes, config);
