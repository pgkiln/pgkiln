-- =====================================================================
-- Sample app "Sample Reporting" (App Gallery → Sample Apps)
--
-- Reports and the ways to search them: an interactive report with its form,
-- a faceted search, smart filters, and a classic report with column
-- display options, a column template and a link.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-reporting.sql
-- then open /a/sample-reporting and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;
create or replace function pg_temp.region_id(p_alias text, p_page int, p_static text) returns int language sql stable as
  $$ select r.id from meta.region r where r.page_id = pg_temp.page_id(p_alias, p_page) and r.static_id = p_static $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_reporting;

create table sample_reporting.book (
  id        int generated always as identity primary key,
  title     text not null,
  author    text not null,
  genre     text not null check (genre in ('Novel', 'Crime', 'Science fiction', 'History', 'Science', 'Poetry')),
  language  text not null default 'English',
  published int not null check (published between 1500 and 2100),
  pages     int,
  rating    int check (rating between 1 and 5),
  price     numeric(8, 2),
  in_stock  boolean not null default true
);

insert into sample_reporting.book (title, author, genre, language, published, pages, rating, price, in_stock) values
  ('Pride and Prejudice', 'Jane Austen', 'Novel', 'English', 1813, 432, 5, 9.99, true),
  ('Middlemarch', 'George Eliot', 'Novel', 'English', 1871, 880, 4, 12.50, true),
  ('Max Havelaar', 'Multatuli', 'Novel', 'Dutch', 1860, 352, 4, 11.00, false),
  ('The Hound of the Baskervilles', 'Arthur Conan Doyle', 'Crime', 'English', 1902, 256, 4, 7.95, true),
  ('Murder on the Orient Express', 'Agatha Christie', 'Crime', 'English', 1934, 274, 5, 8.99, true),
  ('Maigret and the Yellow Dog', 'Georges Simenon', 'Crime', 'French', 1931, 160, 3, 9.50, true),
  ('The Time Machine', 'H. G. Wells', 'Science fiction', 'English', 1895, 118, 4, 6.50, true),
  ('Foundation', 'Isaac Asimov', 'Science fiction', 'English', 1951, 255, 5, 10.99, false),
  ('Solaris', 'Stanisław Lem', 'Science fiction', 'Polish', 1961, 204, 4, 11.95, true),
  ('The Guns of August', 'Barbara Tuchman', 'History', 'English', 1962, 640, 5, 15.00, true),
  ('Homo Ludens', 'Johan Huizinga', 'History', 'Dutch', 1938, 288, 3, 13.50, true),
  ('The Waning of the Middle Ages', 'Johan Huizinga', 'History', 'Dutch', 1919, 400, 4, 14.00, false),
  ('On the Origin of Species', 'Charles Darwin', 'Science', 'English', 1859, 502, 5, 10.00, true),
  ('A Brief History of Time', 'Stephen Hawking', 'Science', 'English', 1988, 212, 4, 12.99, true),
  ('The Double Helix', 'James Watson', 'Science', 'English', 1968, 226, 3, 11.50, true),
  ('Leaves of Grass', 'Walt Whitman', 'Poetry', 'English', 1855, 384, 4, 9.00, true),
  ('Les Fleurs du mal', 'Charles Baudelaire', 'Poetry', 'French', 1857, 300, 5, 8.50, false),
  ('Verzamelde gedichten', 'Lucebert', 'Poetry', 'Dutch', 1974, 620, 3, 29.95, true);

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_reporting') then create role app_sample_reporting nologin; end if;
end $$;
grant app_sample_reporting to pgkiln_runtime;
grant usage on schema sample_reporting to app_sample_reporting;
grant select, insert, update, delete on all tables in schema sample_reporting to app_sample_reporting;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-reporting', 'Sample Reporting', 1, 'app_users', 'app_sample_reporting');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-reporting';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values (1, 'Sample Reporting', null), (5, 'Smart filters', 1), (6, 'Classic report', 1)) as p (no, name, parent)
 where a.alias = 'sample-reporting';

-- page 2 and its form, page 3: the Report and form wizard; page 4: the Faceted search wizard
select meta.generate_page('sample-reporting', 'report_form', 'sample_reporting.book', 2, '{"label": "Books", "form_page": 3, "nav": false}');
select meta.generate_page('sample-reporting', 'facets', 'sample_reporting.book', 4,
  '{"label": "Faceted search", "nav": false, "facets": ["genre", "language", "rating", "in_stock", "published"]}');
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-reporting') and page_no in (2, 4);
update meta.item set type = 'select', lov = 'STATIC:Novel,Crime,Science fiction,History,Science,Poetry'
 where page_id = pg_temp.page_id('sample-reporting', 3) and name = 'P3_GENRE';
update meta.item set type = 'rating' where page_id = pg_temp.page_id('sample-reporting', 3) and name = 'P3_RATING';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Interactive report', 'table', 2), (30, 'Faceted search', 'filter', 4),
  (40, 'Smart filters', 'search', 5), (50, 'Classic report', 'list', 6)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-reporting';

insert into meta.list (app_id, name, type, description)
select id, 'REPORT_TOPICS', 'static', 'The pages of Sample Reporting' from meta.app where alias = 'sample-reporting';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'REPORT_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Interactive report', 'table', 2, 'Search, filters, sorting, control breaks, aggregates, highlights, charts, saved reports and downloads.'),
  (20, 'Faceted search', 'filter', 4, 'Filters with counts beside the report, made by the Faceted search wizard.'),
  (30, 'Smart filters', 'search', 5, 'One search field with filter chips and suggestions.'),
  (40, 'Classic report', 'list', 6, 'A report without the search and Actions menu, with column display options and a column template.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-reporting';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id)
select pg_temp.page_id('sample-reporting', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb, r.sid
  from (values
  -- 1 Home
  (1, 10, 'Sample Reporting', 'static', 12, 'hero',
   '<p>A report region shows the rows of any SELECT. As an <em>interactive report</em> the users search, filter, sort, group, chart, save and download it themselves; everything they enter becomes literals, columns are checked against the query, and the state lives in the URL, so a report can be bookmarked.</p>',
   '{"icon": "table"}', null),
  (1, 20, 'Topics', 'list', 12, 'plain', null, '{"list": "REPORT_TOPICS", "template": "cards"}', null),

  -- 2 Interactive report (the wizard's report follows at seq 10)
  (2, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The Report and form wizard made this page: an interactive report with a link to a modal form. Click a column heading for its menu (sort, hide, control break, its values), or open <em>Actions</em> for filters, aggregates, highlights, computed columns, group by, pivot, a chart, saved reports and downloads (CSV, Excel, PDF).</p>',
   '{}', null),

  -- 4 Faceted search (the wizard's regions follow)
  (4, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The Faceted search wizard made this page: a <code>facets</code> region in the left column that filters the report beside it. Each value shows how many rows it would leave, counting the search and the other facets.</p>',
   '{}', null),

  -- 5 Smart filters
  (5, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">A <code>smart_filters</code> region is the compact alternative: one search field above the report, the filters in use as chips and suggestions below it. Type <em>dutch</em> or <em>crime</em> and choose a suggestion. With <code>"ask": true</code> it also reads a phrase: type <em>novels published between 1850 and 1900</em> and choose <strong>Understood as</strong>.</p>',
   '{}', null),
  (5, 10, 'Search', 'smart_filters', 12, 'plain', null, '{}', 'smart'),
  (5, 20, 'Books', 'report', 12, 'standard',
   E'select title, author, genre, language, published, rating, price from sample_reporting.book order by title',
   '{"formats": {"price": "999G990D00"}}', 'smart-report'),

  -- 6 Classic report
  (6, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">With <code>"searchable": false</code> a report is a classic report: no search field and no Actions menu. <code>column_options</code> sets how columns look (bold, muted, monospace, right-aligned), <code>column_templates</code> draws the stock column through the built-in badge component, and <code>link</code> makes the title open the form.</p>',
   '{}', null),
  (6, 10, 'Books per genre', 'report', 12, 'standard',
   E'select id, title, author, genre, published, price,\n       case when in_stock then ''In stock'' else ''Sold out'' end as stock,\n       case when in_stock then ''success'' else ''danger'' end as stock_state\n  from sample_reporting.book order by genre, title',
   '{"searchable": false, "page_size": 50, "hidden": ["id", "stock_state"],
     "link": {"column": "title", "page": 3, "items": {"P3_ID": "#id#"}},
     "formats": {"price": "999G990D00"},
     "column_options": {"title": ["to-col-bold"], "author": ["to-col-muted"], "published": ["to-col-mono"], "price": ["to-col-right"]},
     "column_templates": {"stock": {"component": "ut_badge", "attributes": {"LABEL": "#stock#", "STATE": "#stock_state#"}}}}', null)
  ) as r (page, seq, title, type, cols, template, source, config, sid);

update meta.region set config = jsonb_build_object(
    'report', pg_temp.region_id('sample-reporting', 5, 'smart-report'),
    'placeholder', 'Search, filter, or type e.g. novels published between 1850 and 1900',
    'ask', true,
    'facets', '[{"column": "genre", "label": "Genre"}, {"column": "language", "label": "Language"},
                {"column": "published", "label": "Published", "type": "range", "custom": true,
                 "ranges": [{"to": 1900}, {"from": 1900, "to": 1950}, {"from": 1950}]}]'::jsonb)
 where id = pg_temp.region_id('sample-reporting', 5, 'smart');
