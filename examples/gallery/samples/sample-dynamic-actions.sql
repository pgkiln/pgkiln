-- =====================================================================
-- Sample app "Sample Dynamic Actions" (App Gallery → Sample Apps)
--
-- Behaviour in the browser without JavaScript of your own:
--   page 2  show, hide, enable and disable items on a condition;
--   page 3  values from the server (set value, execute SQL) and a report
--           refreshed when an item changes;
--   page 4  messages, confirmations, a wait popup, classes, item errors,
--           an inline dialog and actions on page load and key release.
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

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values
  (1, 'Sample Dynamic Actions', null), (2, 'Show, hide, enable', 1), (3, 'Values from the server', 1), (4, 'Messages and effects', 1)
  ) as p (no, name, parent)
 where a.alias = 'sample-dynamic-actions';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Show, hide, enable', 'eye', 2), (30, 'Values from the server', 'refresh', 3), (40, 'Messages and effects', 'bell', 4)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-dynamic-actions';

insert into meta.list (app_id, name, type, description)
select id, 'DA_TOPICS', 'static', 'The pages of Sample Dynamic Actions' from meta.app where alias = 'sample-dynamic-actions';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'DA_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Show, hide, enable', 'eye', 2, 'Items that appear, disappear or switch on depending on another item.'),
  (20, 'Values from the server', 'refresh', 3, 'SQL fills in items and refreshes a report, without reloading the page.'),
  (30, 'Messages and effects', 'bell', 4, 'Alerts, confirmations, a wait popup, classes, item errors and an inline dialog.')
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
   '{}', 'dialog')
  ) as r (page, seq, title, type, cols, template, source, config, sid);

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
  (4, 'greeting', 20, 'P4_GREETING', 'Greeting', 'text', null, null, null, '{"warn_unsaved": false}')
  ) as i (page, region, seq, name, label, type, lov, def, help, config);

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select pg_temp.page_id('sample-dynamic-actions', 4), pg_temp.region_id('sample-dynamic-actions', 4, 'buttons'), b.seq, b.name, b.label, 'da', b.hot
  from (values
  (10, 'ALERT', 'Alert', false), (20, 'CONFIRM', 'Confirm, then a message', true), (30, 'WAIT', 'Wait popup', false),
  (40, 'HIGHLIGHT', 'Highlight', false), (50, 'MUTE', 'Mute', false), (60, 'RESET', 'Reset', false),
  (70, 'ERROR', 'Show an item error', false), (80, 'CLEAR', 'Clear the errors', false), (90, 'DIALOG', 'Open the inline dialog', false)
  ) as b (seq, name, label, hot);

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
