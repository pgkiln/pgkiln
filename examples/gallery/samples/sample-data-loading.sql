-- =====================================================================
-- Sample app "Sample Data Loading" (App Gallery → Sample Apps)
--
-- Loading CSV, Excel, JSON and XML files into a table from a page: a load
-- that matches columns by name and merges by the primary key; a load
-- through a data load definition that maps other headings, cleans values
-- and reads a date format; and a load that skips rows with errors and lists
-- them. The example files are static files of the application.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-data-loading.sql
-- then open /a/sample-data-loading and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_loading;

create table sample_loading.product (
  code     text primary key check (code ~ '^[A-Z]{2}-\d{3}$'),
  name     text not null,
  category text not null check (category in ('TOOLS', 'GARDEN', 'KITCHEN', 'OFFICE')),
  price    numeric(8, 2) not null check (price > 0),
  stock    int not null default 0 check (stock >= 0),
  added    date not null default current_date
);

insert into sample_loading.product (code, name, category, price, stock, added) values
  ('TL-001', 'Hammer', 'TOOLS', 14.95, 40, '2026-01-12'),
  ('TL-002', 'Screwdriver set', 'TOOLS', 19.50, 25, '2026-01-12'),
  ('GD-001', 'Garden hose 20 m', 'GARDEN', 24.99, 12, '2026-03-02'),
  ('KT-001', 'Chef''s knife', 'KITCHEN', 39.00, 8, '2026-04-20');

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_loading') then create role app_sample_loading nologin; end if;
end $$;
grant app_sample_loading to pgkiln_runtime;
grant usage on schema sample_loading to app_sample_loading;
grant select, insert, update, delete on sample_loading.product to app_sample_loading;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-data-loading', 'Sample Data Loading', 1, 'app_users', 'app_sample_loading');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-data-loading';

-- the example files, served at /a/sample-data-loading/static/<name>
insert into meta.static_file (app_id, name, mime, content)
select a.id, f.name, f.mime, convert_to(f.body, 'utf8')
  from meta.app a, (values
  ('products.csv', 'text/csv',
   E'code,name,category,price,stock\nTL-002,Screwdriver set,TOOLS,17.95,30\nTL-003,Spirit level,TOOLS,12.50,15\nOF-001,Stapler,OFFICE,8.95,60\nOF-002,Desk lamp,OFFICE,29.00,10\n'),
  ('products.json', 'application/json',
   E'[{"code": "KT-002", "name": "Cutting board", "category": "KITCHEN", "price": 15.5, "stock": 20},\n {"code": "GD-002", "name": "Pruning shears", "category": "GARDEN", "price": 21.95, "stock": 9}]\n'),
  ('supplier-list.csv', 'text/csv',
   E'Article no.,Description,Group,Unit price,In stock,Since\ngd-003,  watering   can ,garden,9.99,35,02.05.2026\nkt-003,kitchen   scale,Kitchen,18.75,14,15.06.2026\n'),
  ('with-errors.csv', 'text/csv',
   E'code,name,category,price,stock\nOF-003,Notebook,OFFICE,3.50,100\nOF-004,Paper clips,OFFICE,-1,500\nXX,Mystery box,TOYS,10,1\nOF-005,Pencil case,OFFICE,6.25,40\n')
  ) as f (name, mime, body)
 where a.alias = 'sample-data-loading';

-- other headings, messy values, a date format: a data load definition (Shared Components → Data load definitions)
insert into meta.data_load_def (app_id, name, description, table_name, format, mode, columns)
select a.id, 'SUPPLIER_LIST', 'A supplier''s product list: other headings, codes and groups in lower case, dates as DD.MM.YYYY.',
       'sample_loading.product', 'csv', 'merge',
       '[{"source": "Article no.", "column": "code", "transform": ["trim", "upper"]},
         {"source": "Description", "column": "name", "transform": ["collapse_spaces", "initcap"]},
         {"source": "Group", "column": "category", "transform": ["trim", "upper"]},
         {"source": "Unit price", "column": "price", "format": "99990.99"},
         {"source": "In stock", "column": "stock", "default": "0"},
         {"source": "Since", "column": "added", "format": "DD.MM.YYYY"}]'
  from meta.app a where a.alias = 'sample-data-loading';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values (1, 'Sample Data Loading', null), (2, 'Products', 1), (3, 'Load a file', 1), (4, 'Load with a definition', 1), (5, 'Skip rows with errors', 1)) as p (no, name, parent)
 where a.alias = 'sample-data-loading';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Products', 'table', 2), (30, 'Load a file', 'upload', 3),
  (40, 'Load with a definition', 'upload', 4), (50, 'Skip rows with errors', 'upload', 5)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-data-loading';

insert into meta.list (app_id, name, type, description)
select id, 'LOAD_TOPICS', 'static', 'The pages of Sample Data Loading' from meta.app where alias = 'sample-data-loading';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'LOAD_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Products', 'table', 2, 'The table the pages load into.'),
  (20, 'Load a file', 'upload', 3, 'CSV, Excel or JSON with the table''s column names, merged by the product code.'),
  (30, 'Load with a definition', 'upload', 4, 'Other headings, values in the wrong case and a date format, mapped by a data load definition.'),
  (40, 'Skip rows with errors', 'upload', 5, 'Load the good rows and list the others, instead of loading nothing.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-data-loading';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id)
select pg_temp.page_id('sample-data-loading', r.page), r.seq, r.title, r.type, 12, r.template, r.source, r.config::jsonb, r.sid
  from (values
  (1, 10, 'Sample Data Loading', 'static', 'hero',
   '<p>A page with a file item, a button and a <code>data_load</code> process loads a file into a table. It runs as the application''s database role, so grants, constraints, triggers and row level security apply as they do for a form, and by default a file with one bad row loads nothing at all.</p>',
   '{"icon": "upload"}', null),
  (1, 20, 'Topics', 'list', 'plain', null, '{"list": "LOAD_TOPICS", "template": "cards"}', null),
  (2, 10, 'Products', 'report', 'standard',
   'select code, name, category, price, stock, added from sample_loading.product order by code',
   '{"formats": {"price": "999G990D00"}, "page_size": 50}', null),
  (3, 10, 'Load a file', 'static', 'standard',
   '<p class="lead">The process: <code>{"file_item": "P3_FILE", "table": "sample_loading.product", "mode": "merge"}</code>. Columns are matched by name; a row whose <code>code</code> exists is updated, the others are added. Try <a href="/a/sample-data-loading/static/products.csv" download>products.csv</a> (one update, three new) or <a href="/a/sample-data-loading/static/products.json" download>products.json</a>, then look at <a href="/a/sample-data-loading/2">Products</a>.</p>',
   '{}', 'load'),
  (4, 10, 'Load with a definition', 'static', 'standard',
   '<p class="lead"><a href="/a/sample-data-loading/static/supplier-list.csv" download>supplier-list.csv</a> has other headings (<em>Article no.</em>, <em>Unit price</em>), codes in lower case, extra spaces and dates as 02.05.2026. The data load definition <code>SUPPLIER_LIST</code> maps each heading to a column, trims and upper-cases the code, collapses the spaces in the name and reads the date with <code>DD.MM.YYYY</code>; the process only names it: <code>{"file_item": "P4_FILE", "definition": "SUPPLIER_LIST"}</code>.</p>',
   '{}', 'load'),
  (5, 10, 'Skip rows with errors', 'static', 'standard',
   '<p class="lead"><a href="/a/sample-data-loading/static/with-errors.csv" download>with-errors.csv</a> has a negative price and a code and category the table''s check constraints refuse. With <code>"skip_errors": true</code> the two good rows are loaded and the others are listed with the database''s reason; without it (the other pages) nothing would be loaded.</p>',
   '{}', 'load')
  ) as r (page, seq, title, type, template, source, config, sid);

insert into meta.item (page_id, region_id, seq, name, label, type, required, help, config)
select r.page_id, r.id, 10, 'P' || p.page_no || '_FILE', 'File', 'file', true, 'CSV, Excel (.xlsx) or JSON, at most 2 MB.',
       '{"accept": ".csv,.tsv,.txt,.xlsx,.json", "max_mb": 2, "wide": true}'
  from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
 where a.alias = 'sample-data-loading' and r.static_id = 'load';

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select r.page_id, r.id, 10, 'LOAD', 'Load', 'submit', true
  from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
 where a.alias = 'sample-data-loading' and r.static_id = 'load';

insert into meta.process (page_id, seq, name, type, when_button, success_message, config)
select pg_temp.page_id('sample-data-loading', x.page), 10, x.name, 'data_load', 'LOAD', x.message, x.config::jsonb
  from (values
  (3, 'Load products', '{inserted} products added, {updated} updated.', '{"file_item": "P3_FILE", "table": "sample_loading.product", "mode": "merge"}'),
  (4, 'Load a supplier list', '{inserted} products added, {updated} updated.', '{"file_item": "P4_FILE", "definition": "SUPPLIER_LIST"}'),
  (5, 'Load the good rows', '{inserted} added, {updated} updated, {failed} skipped.', '{"file_item": "P5_FILE", "table": "sample_loading.product", "mode": "merge", "skip_errors": true}')
  ) as x (page, name, message, config);
