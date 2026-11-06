-- =====================================================================
-- Sample app "Sample Processes" (App Gallery → Sample Apps)
--
-- Page processing on the back office of a small pottery supplies shop:
--   page 1  application processes, application computations and
--           shortcuts fill in the home page;
--   page 2  the orders: page computations, Clear Session State and
--           User Preferences behind two buttons;
--   page 3  the order form in a modal dialog: Form – Initialization,
--           the row process and Close Dialog handing values back;
--   page 4  shipping: Server Side Geocoding, Send E-Mail and Send Push
--           Notification, Print Report, branches to a URL and to a page
--           of an application;
--   page 5  the outbox: what shipping queued;
--   page 6  report queries in six formats;
--   page 7  Ajax callbacks: a page process and an application process;
--   page 8  tracking an order from a link without a checksum
--           (page protection unrestricted);
--   page 9  an editable grid whose Save runs Reset Pagination.
-- Sign-in is custom authentication: a PL/pgSQL function checks the shop's
-- own staff table (account demo / demo); any user it accepts may use the
-- application (access control "any user").
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-processes.sql
-- then open /a/sample-processes and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;
create or replace function pg_temp.region_id(p_alias text, p_page int, p_static text) returns int language sql stable as
  $$ select r.id from meta.region r where r.page_id = pg_temp.page_id(p_alias, p_page) and r.static_id = p_static $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_processes;

-- the shop's staff: the custom authentication checks this table, not pgkiln's accounts
create table sample_processes.staff (
  username      text primary key check (username = lower(username)),
  display_name  text not null,
  email         text not null,
  password_hash text not null,
  active        boolean not null default true,
  last_login_at timestamptz
);

create table sample_processes.product (
  id    int generated always as identity primary key,
  name  text not null unique,
  price numeric(10, 2) not null check (price > 0),
  stock int not null default 0 check (stock >= 0)
);

create table sample_processes.orders (
  id         int generated always as identity primary key,
  customer   text not null,
  email      text not null,
  address    text not null,
  product_id int not null references sample_processes.product,
  qty        int not null default 1 check (qty > 0),
  status     text not null default 'NEW' check (status in ('NEW', 'SHIPPED')),
  location   text,
  ordered_at timestamptz not null default now(),
  shipped_at timestamptz,
  shipped_by text
);

-- what shipping queued: the mail and push queues are pgkiln's, out of the application's reach
create table sample_processes.outbox (
  id        int generated always as identity primary key,
  at        timestamptz not null default now(),
  order_id  int not null references sample_processes.orders on delete cascade,
  channel   text not null,
  recipient text not null,
  outcome   text not null
);

insert into sample_processes.staff (username, display_name, email, password_hash)
values ('demo', 'Dana Demo', 'demo@example.com', meta.hash_password('demo'));

insert into sample_processes.product (name, price, stock) values
  ('Stoneware clay 10 kg', 18.50, 40), ('Porcelain clay 10 kg', 32.00, 12), ('Celadon glaze 1 l', 24.95, 8),
  ('Tenmoku glaze 1 l', 22.50, 0), ('Pottery wheel bats (5)', 29.00, 15), ('Trimming tool set', 14.75, 25);

insert into sample_processes.orders (customer, email, address, product_id, qty, status, location, ordered_at, shipped_at, shipped_by)
select o.customer, o.email, o.address, p.id, o.qty, o.status, o.location, now() - o.age, case when o.status = 'SHIPPED' then now() - o.age + interval '1 day' end,
       case when o.status = 'SHIPPED' then 'Dana Demo' end
  from (values
  ('Studio Aarde', 'orders@studio-aarde.example', 'Oudegracht 120, Utrecht', 'Stoneware clay 10 kg', 4, 'SHIPPED', '52.090100,5.119900', interval '9 days'),
  ('Mira Jansen', 'mira@example.com', 'Dam 1, Amsterdam', 'Celadon glaze 1 l', 2, 'SHIPPED', '52.373100,4.893200', interval '7 days'),
  ('De Draaischijf', 'info@draaischijf.example', 'Grote Markt 1, Groningen', 'Pottery wheel bats (5)', 1, 'NEW', null, interval '3 days'),
  ('Tom de Vries', 'tom@example.com', 'Coolsingel 40, Rotterdam', 'Porcelain clay 10 kg', 2, 'NEW', null, interval '2 days'),
  ('Keramiekhuis Zuid', 'zuid@keramiekhuis.example', 'Vrijthof 1, Maastricht', 'Trimming tool set', 3, 'NEW', null, interval '1 day'),
  ('Lotte Bakker', 'lotte@example.com', 'Markt 1, Delft', 'Stoneware clay 10 kg', 1, 'NEW', null, interval '5 hours')
  ) as o (customer, email, address, product, qty, status, location, age)
  join sample_processes.product p on p.name = o.product
 order by o.age desc;

insert into sample_processes.outbox (at, order_id, channel, recipient, outcome)
select o.shipped_at, o.id, 'e-mail', o.email, 'queued (seed data)' from sample_processes.orders o where o.status = 'SHIPPED';

-- the custom authentication: does the user name and password match an active member of the staff?
-- security definer, so the application's role never reads the password hashes; crypt() comes from
-- pgcrypto: created with the installer's search path (the body is checked then), then pinned below to
-- pgcrypto's own schema, wherever the installation put it
create function sample_processes.check_login(p_username text, p_password text) returns boolean
  language sql stable security definer set search_path from current as $$
  select coalesce((select s.active and s.password_hash = crypt(p_password, s.password_hash)
                     from sample_processes.staff s where s.username = lower(p_username)), false)
$$;
revoke execute on function sample_processes.check_login(text, text) from public;
do $$ begin
  execute format('alter function sample_processes.check_login(text, text) set search_path = %I, pg_catalog',
                 (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'));
end $$;

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_processes') then create role app_sample_processes nologin; end if;
end $$;
grant app_sample_processes to pgkiln_runtime;
grant usage on schema sample_processes to app_sample_processes;
grant select (username, display_name, email, active, last_login_at), update (last_login_at) on sample_processes.staff to app_sample_processes;
grant select, insert, update, delete on sample_processes.product to app_sample_processes;
grant select, insert, update, delete on sample_processes.orders to app_sample_processes;
grant select, insert on sample_processes.outbox to app_sample_processes;
grant execute on function sample_processes.check_login(text, text) to app_sample_processes;

-- 3. The application ----------------------------------------------------------
-- custom authentication with the staff table; any user it signs in may use the application;
-- always in the primary language; push notifications on, so Send Push Notification can queue
insert into meta.app (alias, name, home_page, authentication, custom_auth_function, custom_auth_post_code,
                      access_control, language, language_from, db_role, pwa, pwa_push, pwa_short_name)
values ('sample-processes', 'Sample Processes', 1, 'custom', 'sample_processes.check_login',
        'update sample_processes.staff set last_login_at = now() where username = lower(p_username);',
        'any_user', 'en', 'primary', 'app_sample_processes', true, true, 'Processes');

insert into meta.page (app_id, page_no, name, title, parent_page, mode, protection)
select a.id, p.no, p.name, p.name, p.parent, p.mode, p.protection
  from meta.app a, (values
  (1, 'Sample Processes', null, 'normal', 'checksum'), (4, 'Ship an order', 1, 'normal', 'checksum'),
  (5, 'Outbox', 1, 'normal', 'checksum'), (6, 'Downloads', 1, 'normal', 'checksum'),
  (7, 'Ajax callbacks', 1, 'normal', 'checksum'), (8, 'Track an order', 1, 'normal', 'unrestricted')
  ) as p (no, name, parent, mode, protection)
 where a.alias = 'sample-processes';

-- page 2 and its form, page 3 (a modal dialog): the Report and form wizard on the orders
select meta.generate_page('sample-processes', 'report_form', 'sample_processes.orders', 2, '{"label": "Orders", "form_page": 3, "nav": false}');
-- page 9: an editable grid on the products (the Interactive grid wizard)
select meta.generate_page('sample-processes', 'grid', 'sample_processes.product', 9, '{"label": "Stock", "nav": false}');
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-processes') and page_no in (2, 9);

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Orders', 'list', 2), (30, 'Ship an order', 'truck', 4), (40, 'Outbox', 'send', 5),
  (50, 'Downloads', 'download', 6), (60, 'Ajax callbacks', 'bolt', 7), (70, 'Track an order', 'search', 8), (80, 'Stock', 'grid', 9)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-processes';

-- shared components: application items, computations, processes, shortcuts, report queries
insert into meta.app_item (app_id, name, description)
select a.id, i.name, i.description
  from meta.app a, (values
  ('AI_DISPLAY_NAME', 'The staff member''s name, looked up once at sign-in'),
  ('AI_DEFAULT_STATUS', 'The status the order list shows when you have no saved filter'),
  ('AI_TODAY', 'Today, written out'),
  ('AI_GREETING', 'Good morning, afternoon or evening'),
  ('AI_SIGNED_IN_AS', 'A copy of APP_USER'),
  ('AI_OPEN_ORDERS', 'The number of orders to ship, counted before every page')
  ) as i (name, description)
 where a.alias = 'sample-processes';

insert into meta.app_computation (app_id, seq, item_name, point, type, expression, comments)
select a.id, c.seq, c.item, c.point, c.type, c.expr, c.comments
  from meta.app a, (values
  (10, 'AI_DISPLAY_NAME', 'after_authentication', 'sql_query',
   'select display_name from sample_processes.staff where username = lower(:APP_USER)', 'Once, at sign-in: the first column of the first row'),
  (20, 'AI_DEFAULT_STATUS', 'after_authentication', 'static', 'NEW', 'Once, at sign-in: a fixed value'),
  (30, 'AI_TODAY', 'before_header', 'sql_expression', 'to_char(current_date, ''FMDay FMDD FMMonth YYYY'')', 'Every page: a SQL expression'),
  (40, 'AI_GREETING', 'before_header', 'function_body',
   E'begin\n  return case when localtime < time ''12:00'' then ''Good morning''\n              when localtime < time ''18:00'' then ''Good afternoon''\n              else ''Good evening'' end;\nend',
   'Every page: a PL/pgSQL function body'),
  (50, 'AI_SIGNED_IN_AS', 'before_header', 'item', 'APP_USER', 'Every page: the value of another item')
  ) as c (seq, item, point, type, expr, comments)
 where a.alias = 'sample-processes';

insert into meta.app_process (app_id, seq, name, point, code)
select a.id, p.seq, p.name, p.point, p.code
  from meta.app a, (values
  -- before every page view and every submit: a column named like an application item sets it
  (10, 'Count the open orders', 'before_page',
   'select count(*) as ai_open_orders from sample_processes.orders where status = ''NEW'''),
  -- an Ajax callback every page can call by name (pgkiln.server.process('SERVER_CLOCK'))
  (20, 'SERVER_CLOCK', 'ajax',
   'select to_char(clock_timestamp(), ''HH24:MI:SS'') as now, :AI_GREETING || '', '' || coalesce(:AI_DISPLAY_NAME, :APP_USER) as greeting, :AI_OPEN_ORDERS as open_orders')
  ) as p (seq, name, point, code)
 where a.alias = 'sample-processes';

insert into meta.shortcut (app_id, name, type, value, comments)
select a.id, s.name, s.type, s.value, s.comments
  from meta.app a, (values
  ('SHOP_NAME', 'text', 'Kiln & Clay Supplies', 'Text: HTML-escaped where it is used'),
  ('SUPPORT_CONTACT', 'html', 'Questions? Mail <a href="mailto:support@example.com">support@example.com</a>.', 'HTML, used as it is'),
  ('OPEN_ORDERS_LINE', 'function_body',
   'return format(''%s of %s orders are waiting to be shipped.'', count(*) filter (where status = ''NEW''), count(*)) from sample_processes.orders;',
   'Computed by PL/pgSQL once per request'),
  ('DELETE_ORDER', 'text', 'Delete this order? The customer gets nothing.', 'The Delete button''s confirmation')
  ) as s (name, type, value, comments)
 where a.alias = 'sample-processes';

insert into meta.report_query (app_id, name, description, query, format, file_name, title)
select a.id, q.name, q.description, q.query, q.format, q.file_name, q.title
  from meta.app a, (values
  ('ORDERS_CSV', 'The orders as CSV', 'select o.id, o.customer, o.email, p.name as product, o.qty, o.status, o.ordered_at from sample_processes.orders o join sample_processes.product p on p.id = o.product_id order by o.id', 'csv', 'orders', null),
  ('ORDERS_XLSX', 'The orders with their totals, for Excel', 'select o.id, o.customer, p.name as product, o.qty, p.price, o.qty * p.price as total, o.status, o.ordered_at from sample_processes.orders o join sample_processes.product p on p.id = o.product_id order by o.id', 'xlsx', 'orders', null),
  ('ORDERS_JSON', 'The orders as JSON', 'select o.id, o.customer, p.name as product, o.qty, o.status from sample_processes.orders o join sample_processes.product p on p.id = o.product_id order by o.id', 'json', 'orders', null),
  ('ORDERS_XML', 'The orders as XML', 'select o.id, o.customer, p.name as product, o.qty, o.status from sample_processes.orders o join sample_processes.product p on p.id = o.product_id order by o.id', 'xml', 'orders', null),
  ('OPEN_ORDERS_HTML', 'What is left to ship, as a web page', 'select o.id, o.customer, o.address, p.name as product, o.qty from sample_processes.orders o join sample_processes.product p on p.id = o.product_id where o.status = ''NEW'' order by o.id', 'html', 'open-orders', 'Orders to ship'),
  ('PRICE_LIST', 'The price list', 'select name as product, price, stock from sample_processes.product order by name', 'pdf', 'price-list', 'Price list, &AI_TODAY.'),
  ('PACKING_SLIP', 'The packing slip of the order chosen on page 4', 'select o.id as "Order", o.customer, o.address, p.name as product, o.qty from sample_processes.orders o join sample_processes.product p on p.id = o.product_id where o.id = nullif(:P4_ORDER, '''')::int', 'pdf', 'packing-slip-&P4_ORDER.', 'Packing slip')
  ) as q (name, description, query, format, file_name, title)
 where a.alias = 'sample-processes';

-- the Ajax callbacks of page 7 are called from this file, loaded by every page
insert into meta.static_file (app_id, name, mime, content)
select a.id, 'sample-processes.js', 'text/javascript', convert_to($js$// Sample Processes: functions for "Execute JavaScript" dynamic actions (page 7).
// pgkiln.server.process runs an Ajax callback by name and sets the items it returns.
pgkiln.actions.register('sp.checkStock', async () => {
  const r = await pgkiln.server.process('CHECK_STOCK', { items: ['P7_PRODUCT'] });
  if (r.data) pgkiln.showSuccess(r.data.message);
  else pgkiln.showError('Choose a product first.', 'P7_PRODUCT');
});
pgkiln.actions.register('sp.serverClock', async () => {
  const r = await pgkiln.server.process('SERVER_CLOCK');
  pgkiln.showSuccess(`${r.data.greeting}: the server's clock says ${r.data.now}, and ${r.data.open_orders} orders wait to be shipped.`);
});
$js$, 'utf8')
  from meta.app a where a.alias = 'sample-processes';
update meta.app set static_includes = '{sample-processes.js}' where alias = 'sample-processes';

-- 4. Pages ---------------------------------------------------------------------
-- the wizard's report: product and total instead of the product's id
update meta.region set source = 'select o.id, o.customer, p.name as product, o.qty, o.qty * p.price as total, o.status, o.ordered_at, o.shipped_by
  from sample_processes.orders o join sample_processes.product p on p.id = o.product_id
 where (:P2_STATUS = ''ALL'' or o.status = :P2_STATUS)
   and (:P2_SEARCH is null or o.customer ilike ''%'' || :P2_SEARCH || ''%'')
 order by o.id desc',
       config = config || '{"formats": {"total": "999G990D00"}}'
 where page_id = pg_temp.page_id('sample-processes', 2) and type = 'report';
update meta.region set static_id = 'orders' where page_id = pg_temp.page_id('sample-processes', 2) and type = 'report';

-- the form: what happened to the order is shown, not edited
update meta.item set type = 'display'
 where page_id = pg_temp.page_id('sample-processes', 3) and name in ('P3_STATUS', 'P3_LOCATION', 'P3_ORDERED_AT', 'P3_SHIPPED_AT', 'P3_SHIPPED_BY');
update meta.item set type = 'select', lov = 'select name, id from sample_processes.product order by name'
 where page_id = pg_temp.page_id('sample-processes', 3) and name = 'P3_PRODUCT_ID';
update meta.button set confirm = '"DELETE_ORDER"'
 where page_id = pg_temp.page_id('sample-processes', 3) and name = 'DELETE';

insert into meta.list (app_id, name, type, description)
select id, 'PROCESS_TOPICS', 'static', 'The pages of Sample Processes' from meta.app where alias = 'sample-processes';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'PROCESS_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Orders', 'list', 2, 'Computations fill in the filter; buttons reset the pagination, clear the filter and remember it for you.'),
  (20, 'Ship an order', 'truck', 4, 'Geocode the address, mail the customer, push to your devices, print a packing slip, then branch on.'),
  (30, 'Outbox', 'send', 5, 'What shipping queued, by e-mail and by push notification.'),
  (40, 'Downloads', 'download', 6, 'Report queries: the same rows as CSV, Excel, JSON, XML, HTML and PDF.'),
  (50, 'Ajax callbacks', 'bolt', 7, 'JavaScript asks a page process and an application process by name.'),
  (60, 'Track an order', 'search', 8, 'A page that takes its order number from any link: protection Unrestricted.'),
  (70, 'Stock', 'grid', 9, 'An editable grid whose Save starts it on its first page again: Reset Pagination.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-processes';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id)
select pg_temp.page_id('sample-processes', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb, r.sid
  from (values
  -- 1 Home
  (1, 10, 'Sample Processes', 'static', 12, 'hero',
   '<p>What happens on the server when a page is shown or submitted, without code in the browser: <strong>processes</strong> (SQL, and declarative types such as Send E-Mail or Print Report), <strong>computations</strong> that set items, <strong>branches</strong> that decide where to go next, and the same for the whole application. The shop is "SHOP_NAME"; "OPEN_ORDERS_LINE"</p>',
   '{"icon": "settings"}', null),
  (1, 20, 'Topics', 'list', 12, 'plain', null, '{"list": "PROCESS_TOPICS", "template": "cards"}', null),
  (1, 30, 'Made by the application', 'static', 6, 'standard',
   '<p>&AI_GREETING., <strong>&AI_DISPLAY_NAME.</strong>. Today is &AI_TODAY.; you are signed in as <code>&AI_SIGNED_IN_AS.</code>, and &AI_OPEN_ORDERS. orders wait to be shipped.</p><ul><li><em>&AI_DISPLAY_NAME.</em> and the order list''s default status (&AI_DEFAULT_STATUS.): application computations run once at sign-in (<code>sql_query</code>, <code>static</code>)</li><li><em>&AI_TODAY.</em>, the greeting and the user name: application computations before every page (<code>sql_expression</code>, <code>function_body</code>, <code>item</code>)</li><li>the number of open orders: an application process before every page (<code>before_page</code>)</li></ul>',
   '{}', 'made'),
  (1, 40, 'Shortcuts and sign-in', 'static', 6, 'standard',
   '<p>The quoted names in this page''s texts are <strong>shortcuts</strong>: "SHOP_NAME" is text, the next line is HTML and the open orders above come from a PL/pgSQL function body.</p><p>"SUPPORT_CONTACT"</p><p>You signed in through <strong>custom authentication</strong>: the function <code>sample_processes.check_login</code> checks the shop''s own staff table, and the post-authentication code records the time (<code>last_login_at</code>). Access control is <em>any user</em>: everyone the function accepts may use the application. Track <a href="8?P8_ID=3">order 3</a> or <a href="8?P8_ID=1">order 1</a>: plain links, no checksum.</p>',
   '{}', 'shortcuts'),

  -- 2 Orders
  (2, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Before the page is shown, <strong>computations</strong> fill in the status: your saved filter (a <code>sql_query</code> on <code>meta.get_preference</code>), else the application item <code>AI_DEFAULT_STATUS</code> (type <code>item</code>), and the line under it (<code>static</code>). <strong>Filter</strong> runs <em>User Preferences</em>: the status is remembered for you, also in your next session; <strong>Clear</strong> runs <em>Clear Session State</em> and forgets the preference. Editing an order opens a modal dialog whose <em>Close Dialog</em> process hands the order number back to this page.</p>',
   '{}', null),
  (2, 7, 'Filter', 'static', 12, 'standard', null, '{}', 'filter'),

  -- 4 Ship an order
  (4, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Choose an order: <code>sql_query</code> computations fill in its address and e-mail, an <code>item</code> computation your name, and after a submit a <code>static</code> one the note when it is empty. <strong>Locate</strong> runs <em>Server Side Geocoding</em> (the installation''s geocoder, <code>GEOCODER_URL</code>; without one it says so). <strong>Ship</strong> updates the order, queues a mail to the customer (<em>Send E-Mail</em>, with the condition <code>meta.mail_available()</code>: only when the application has a mail service) and a notification to your devices (<em>Send Push Notification</em>), clears the page and branches to the outbox (a branch to a page of an application). <strong>Packing slip</strong> answers with the report query <code>PACKING_SLIP</code> as a PDF (<em>Print Report</em>). When nothing is left to ship, a branch before the page is shown goes to the order list (a URL).</p>',
   '{}', null),
  (4, 10, 'Order to ship', 'static', 12, 'standard', null, '{}', 'ship'),

  -- 5 Outbox
  (5, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Send E-Mail and Send Push Notification <strong>queue</strong> a message in the submit''s transaction; the server sends it after the commit. The queues are pgkiln''s (an administrator sees them under Administration and the application''s Activity), so after each one the Ship button records here what it queued: a mail only when the application has a mail service, a push message for every device of yours that turned notifications on (none: nothing arrives, and nothing fails).</p>',
   '{}', null),
  (5, 10, 'Outbox', 'report', 12, 'standard',
   'select b.at, b.order_id as "Order", o.customer, b.channel, b.recipient, b.outcome
  from sample_processes.outbox b join sample_processes.orders o on o.id = b.order_id
 order by b.id desc', '{"empty": "Nothing queued yet: ship an order."}', 'outbox'),

  -- 6 Downloads
  (6, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead"><strong>Report queries</strong> (Shared Components) are named queries printed without a template: each button below has the action <em>Download document</em> and names one. The same file is at <code>?doc=NAME</code> on any page, e.g. <a href="6?doc=ORDERS_CSV">6?doc=ORDERS_CSV</a>. The packing slip on <em>Ship an order</em> is a report query too, sent by a <em>Print Report</em> process.</p>',
   '{}', null),
  (6, 10, 'Download', 'static', 12, 'buttons_container', null, '{}', 'downloads'),

  -- 7 Ajax callbacks
  (7, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">A process with point <strong>ajax</strong> runs only when JavaScript calls it by name, <code>pgkiln.server.process(''CHECK_STOCK'', {items: [''P7_PRODUCT'']})</code>, and answers JSON; the columns named like items set them. <em>Check stock</em> calls this page''s process; <em>Ask the server</em> calls an application process with point ajax, which every page can call. The calls live in the static application file <code>sample-processes.js</code>, run by <em>Execute JavaScript</em> dynamic actions.</p>',
   '{}', null),
  (7, 10, 'Stock', 'static', 6, 'standard', null, '{}', 'stock'),
  (7, 20, 'The server', 'static', 6, 'standard',
   '<p>An application process answers with the server''s clock, your greeting and the number of open orders.</p>', '{}', 'clock'),

  -- 9 Stock (the wizard's grid follows at seq 10)
  (9, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The Interactive grid wizard made this grid and its <code>grid_dml</code> process. A grid''s Save normally comes back to the page of rows you were on; here a <em>Reset Pagination</em> process runs on Save too, so the grid starts on its first page again. Go to the second page, change a stock and press <strong>Save</strong>.</p>',
   '{}', null),

  -- 8 Track an order
  (8, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">This page''s protection is <strong>Unrestricted</strong>: a link may set <code>P8_ID</code> without a checksum, e.g. <a href="8?P8_ID=2">8?P8_ID=2</a>, as a link in a mail would. Other pages have the default, <em>Arguments must have checksum</em>: their links come from pgkiln, signed.</p>',
   '{}', null),
  (8, 10, 'Which order?', 'static', 12, 'standard', null, '{}', 'which'),
  (8, 20, 'The order', 'report', 12, 'standard',
   'select o.id as "Order", o.customer, p.name as product, o.qty, o.status, o.ordered_at, o.shipped_at, o.location
  from sample_processes.orders o join sample_processes.product p on p.id = o.product_id
 where o.id::text = :P8_ID', '{"empty": "There is no order with that number."}', 'order')
  ) as r (page, seq, title, type, cols, template, source, config, sid);

update meta.region set condition = ':P8_ID is not null' where id = pg_temp.region_id('sample-processes', 8, 'order');

insert into meta.item (page_id, region_id, seq, name, label, type, lov, default_value, help, config)
select pg_temp.page_id('sample-processes', i.page), pg_temp.region_id('sample-processes', i.page, i.region),
       i.seq, i.name, i.label, i.type, i.lov, i.def, i.help, i.config::jsonb
  from (values
  (2, 'filter', 10, 'P2_STATUS', 'Status', 'select', 'STATIC:All orders;ALL,To ship;NEW,Shipped;SHIPPED', null, null, '{"null_label": false}'),
  (2, 'filter', 20, 'P2_SEARCH', 'Customer', 'text', null, null, null, '{}'),
  (2, 'filter', 30, 'P2_SHOWING', 'Showing', 'display', null, null, null, '{}'),
  (2, 'filter', 40, 'P3_ID', 'Last order in the dialog', 'display', null, null, 'Handed back by the dialog''s Close Dialog process.', '{}'),
  (4, 'ship', 10, 'P4_ORDER', 'Order', 'select',
   'select format(''%s: %s, %s × %s'', o.id, o.customer, o.qty, p.name), o.id from sample_processes.orders o join sample_processes.product p on p.id = o.product_id where o.status = ''NEW'' order by o.id',
   null, null, '{"submit_on_change": true, "null_label": "- Choose an order -"}'),
  (4, 'ship', 20, 'P4_ADDRESS', 'Address', 'display', null, null, null, '{}'),
  (4, 'ship', 30, 'P4_EMAIL', 'E-mail', 'display', null, null, null, '{}'),
  (4, 'ship', 40, 'P4_LOCATION', 'Coordinates', 'text', null, null, 'Filled in by Locate (lat,lng).', '{}'),
  (4, 'ship', 50, 'P4_SHIPPED_BY', 'Shipped by', 'text', null, null, null, '{}'),
  (4, 'ship', 60, 'P4_NOTE', 'Note for the customer', 'textarea', null, null, 'Empty: a computation after the submit fills in a standard note.', '{"rows": 2}'),
  (7, 'stock', 10, 'P7_PRODUCT', 'Product', 'select', 'select name, id from sample_processes.product order by name', null, null, '{"warn_unsaved": false}'),
  (7, 'stock', 20, 'P7_STOCK', 'In stock', 'text', null, null, 'Set by the Ajax callback.', '{"warn_unsaved": false}'),
  (8, 'which', 10, 'P8_ID', 'Order number', 'text', null, null, null, '{}')
  ) as i (page, region, seq, name, label, type, lov, def, help, config);

insert into meta.button (page_id, region_id, seq, name, label, action, hot, document, condition)
select pg_temp.page_id('sample-processes', b.page), pg_temp.region_id('sample-processes', b.page, b.region),
       b.seq, b.name, b.label, b.action, b.hot, b.doc, b.cond
  from (values
  (2, 'filter', 10, 'FILTER', 'Filter', 'submit', true, null, null),
  (2, 'filter', 20, 'CLEAR', 'Clear', 'submit', false, null, null),
  (4, 'ship', 10, 'SHIP', 'Ship', 'submit', true, null, ':P4_ORDER is not null'),
  (4, 'ship', 20, 'LOCATE', 'Locate', 'submit', false, null, ':P4_ORDER is not null'),
  (4, 'ship', 30, 'PACKING_SLIP', 'Packing slip', 'submit', false, null, ':P4_ORDER is not null'),
  (6, 'downloads', 10, 'CSV', 'Orders (CSV)', 'document', false, 'ORDERS_CSV', null),
  (6, 'downloads', 20, 'XLSX', 'Orders (Excel)', 'document', false, 'ORDERS_XLSX', null),
  (6, 'downloads', 30, 'JSON', 'Orders (JSON)', 'document', false, 'ORDERS_JSON', null),
  (6, 'downloads', 40, 'XML', 'Orders (XML)', 'document', false, 'ORDERS_XML', null),
  (6, 'downloads', 50, 'HTML', 'To ship (HTML)', 'document', false, 'OPEN_ORDERS_HTML', null),
  (6, 'downloads', 60, 'PDF', 'Price list (PDF)', 'document', true, 'PRICE_LIST', null),
  (7, 'stock', 10, 'CHECK', 'Check stock', 'da', true, null, null),
  (7, 'clock', 10, 'CLOCK', 'Ask the server', 'da', false, null, null),
  (8, 'which', 10, 'TRACK', 'Track', 'submit', true, null, null)
  ) as b (page, region, seq, name, label, action, hot, doc, cond);

-- page computations
insert into meta.computation (page_id, seq, item_name, point, type, expression, condition_type, condition_expr)
select pg_temp.page_id('sample-processes', c.page), c.seq, c.item, c.point, c.type, c.expr, c.ctype, c.cexpr
  from (values
  (2, 10, 'P2_STATUS', 'before_header', 'sql_query', 'select meta.get_preference(''ORDERS_STATUS'')', 'item_null', 'P2_STATUS'),
  (2, 20, 'P2_STATUS', 'before_header', 'item', 'AI_DEFAULT_STATUS', 'item_null', 'P2_STATUS'),
  (2, 30, 'P2_SHOWING', 'before_header', 'static', 'Status &P2_STATUS., newest first; your saved filter is used when you come back.', null, null),
  (4, 10, 'P4_ADDRESS', 'before_header', 'sql_query', 'select address from sample_processes.orders where id = :P4_ORDER::int', 'item_not_null', 'P4_ORDER'),
  (4, 20, 'P4_EMAIL', 'before_header', 'sql_query', 'select email from sample_processes.orders where id = :P4_ORDER::int', 'item_not_null', 'P4_ORDER'),
  (4, 30, 'P4_LOCATION', 'before_header', 'sql_query', 'select location from sample_processes.orders where id = :P4_ORDER::int', 'item_not_null', 'P4_ORDER'),
  (4, 40, 'P4_SHIPPED_BY', 'before_header', 'item', 'AI_DISPLAY_NAME', 'item_null', 'P4_SHIPPED_BY'),
  (4, 50, 'P4_NOTE', 'after_submit', 'static', 'Thank you for your order!', 'item_null', 'P4_NOTE')
  ) as c (page, seq, item, point, type, expr, ctype, cexpr);

-- page processes
insert into meta.process (page_id, seq, name, type, point, when_button, code, config, success_message, condition_type, condition_expr)
select pg_temp.page_id('sample-processes', p.page), p.seq, p.name, p.type, p.point, p.button, p.code, p.config::jsonb, p.message, p.ctype, p.cexpr
  from (values
  -- 2 Orders
  (2, 10, 'Remember the status', 'user_preferences', 'submit', 'FILTER', null,
   '{"action": "set", "preference": "ORDERS_STATUS", "item": "P2_STATUS"}', 'Filter saved: you see these orders when you come back.', null, null),
  (2, 30, 'Clear the filter', 'clear_session_state', 'submit', 'CLEAR', null, '{"items": ["P2_STATUS", "P2_SEARCH"]}', null, null, null),
  (2, 40, 'Forget the status', 'user_preferences', 'submit', 'CLEAR', null,
   '{"action": "reset", "preference": "ORDERS_STATUS"}', 'Filter cleared: back to the default status.', null, null),
  -- 3 Order (the dialog): the wizard made the row process
  (3, 1, 'Initialize form', 'form_init', 'load', null, null, '{}', null, null, null),
  (3, 90, 'Close the dialog', 'close_dialog', 'submit', null, null, '{"items": ["P3_ID"]}', null, null, null),
  -- 4 Ship an order
  (4, 10, 'Locate the address', 'server_geocoding', 'submit', 'LOCATE', null,
   '{"address_item": "P4_ADDRESS", "coordinates_item": "P4_LOCATION", "country": "nl"}', null, null, null),
  (4, 20, 'Store the location', 'sql', 'submit', 'LOCATE',
   'update sample_processes.orders set location = :P4_LOCATION where id = :P4_ORDER::int', '{}', 'Address located: &P4_LOCATION..', 'item_not_null', 'P4_LOCATION'),
  (4, 30, 'Ship the order', 'sql', 'submit', 'SHIP',
   E'update sample_processes.orders set status = ''SHIPPED'', shipped_at = now(), shipped_by = :P4_SHIPPED_BY\n where id = :P4_ORDER::int and status = ''NEW''',
   '{}', 'The order is shipped.', null, null),
  (4, 40, 'Mail the customer', 'send_email', 'submit', 'SHIP', null,
   '{"to": "&P4_EMAIL.", "subject": "Your order &P4_ORDER. is on its way", "body": "&P4_NOTE.\n\nYour order &P4_ORDER. left our workshop today.\n\n&P4_SHIPPED_BY., Kiln & Clay Supplies", "body_html": "<p>&P4_NOTE.</p><p>Your order <b>&P4_ORDER.</b> left our workshop today.</p><p>&P4_SHIPPED_BY., Kiln &amp; Clay Supplies</p>"}',
   null, 'sql', 'meta.mail_available()'),
  (4, 50, 'Note the mail', 'sql', 'submit', 'SHIP',
   E'insert into sample_processes.outbox (order_id, channel, recipient, outcome)\nvalues (:P4_ORDER::int, ''e-mail'', :P4_EMAIL, case when meta.mail_available() then ''queued'' else ''not sent: the application has no mail service'' end)',
   '{}', null, null, null),
  (4, 60, 'Tell my devices', 'send_push', 'submit', 'SHIP', null,
   '{"to": "&APP_USER.", "title": "Order &P4_ORDER. shipped", "body": "&P4_ADDRESS.", "page": 8, "items": {"P8_ID": "&P4_ORDER."}, "tag": "order-&P4_ORDER.", "urgency": "low"}',
   null, null, null),
  (4, 70, 'Note the push message', 'sql', 'submit', 'SHIP',
   E'insert into sample_processes.outbox (order_id, channel, recipient, outcome)\nvalues (:P4_ORDER::int, ''push'', :APP_USER, case when meta.has_push_subscription() then ''queued for your devices'' else ''queued: you have no device with notifications on'' end)',
   '{}', null, null, null),
  (4, 80, 'Start afresh', 'clear_session_state', 'submit', 'SHIP', null, '{"pages": [4]}', null, null, null),
  (4, 90, 'Print the packing slip', 'print_report', 'submit', 'PACKING_SLIP', null, '{"document": "PACKING_SLIP"}', null, null, null),
  -- 7 Ajax callbacks: an Ajax callback of this page
  (7, 10, 'CHECK_STOCK', 'sql', 'ajax', null,
   E'select stock as p7_stock, format(''%s: %s in stock'', name, stock) as message\n  from sample_processes.product where id = nullif(:P7_PRODUCT, '''')::int',
   '{}', null, null, null)
  ) as p (page, seq, name, type, point, button, code, config, message, ctype, cexpr);

-- 9 Stock: Reset Pagination on the grid's Save (its request is GRID_SAVE_<region id>)
insert into meta.process (page_id, seq, name, type, when_button, success_message)
select r.page_id, 20, 'Back to the first page', 'reset_pagination', 'GRID_SAVE_' || r.id, 'Saved: the grid starts on its first page again.'
  from meta.region r where r.page_id = pg_temp.page_id('sample-processes', 9) and r.type = 'grid';
update meta.region set config = config || '{"page_size": 3}'
 where page_id = pg_temp.page_id('sample-processes', 9) and type = 'grid';

-- branches
insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_url, target_app, target_page, condition_type, condition_expr)
select pg_temp.page_id('sample-processes', b.page), b.seq, b.name, b.point, b.button, b.ttype, b.url, b.app, b.target, b.ctype, b.cexpr
  from (values
  -- nothing left to ship: the order list instead of this page (a URL inside the application)
  (4, 10, 'Nothing to ship', 'before_header', null, 'url', '2', null, null,
   'not_exists', 'select 1 from sample_processes.orders where status = ''NEW'''),
  -- after shipping: the outbox, as a page of an application (here this one, by its alias)
  (4, 20, 'To the outbox', 'after_processing', 'SHIP', 'app', null, 'sample-processes', 5, null, null)
  ) as b (page, seq, name, point, button, ttype, url, app, target, ctype, cexpr);

-- page 2 runs these when the dialog closes: the report is refreshed (the dialog's P3_ID is set by then)
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select pg_temp.page_id('sample-processes', 2), 10, 'Refresh after the dialog', 'dialog_closed', '3', 'refresh_region',
       pg_temp.region_id('sample-processes', 2, 'orders');

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, code)
select pg_temp.page_id('sample-processes', 7), d.seq, d.name, 'click', d.button, 'execute_javascript', d.fn
  from (values (10, 'Check the stock', 'CHECK', 'sp.checkStock'), (20, 'Ask the server', 'CLOCK', 'sp.serverClock')) as d (seq, name, button, fn);
