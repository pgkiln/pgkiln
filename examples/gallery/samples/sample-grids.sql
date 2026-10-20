-- =====================================================================
-- Sample app "Sample Interactive Grids" (App Gallery → Sample Apps)
--
-- The interactive grid: an editable grid made by the wizard; a grid with
-- select lists, required columns, totals, a frozen column, a row menu and a
-- default column layout; a master grid with its detail grid; and a
-- read-only grid with its single row, group by and chart views.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-grids.sql
-- then open /a/sample-grids and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_grids;

create table sample_grids.team (
  id       int generated always as identity primary key,
  name     text not null unique,
  location text,
  budget   numeric(12, 2)
);

create table sample_grids.member (
  id      int generated always as identity primary key,
  team_id int not null references sample_grids.team,
  name    text not null,
  role    text not null default 'Developer' check (role in ('Lead', 'Developer', 'Designer', 'Tester', 'Analyst')),
  starts  date not null default current_date,
  hours   int not null default 40 check (hours between 0 and 60),
  rate    numeric(8, 2),
  remote  boolean not null default false
);

insert into sample_grids.team (name, location, budget) values
  ('Platform', 'Amsterdam', 480000), ('Mobile', 'Rotterdam', 310000), ('Data', 'Utrecht', 260000), ('Design', 'Amsterdam', 150000);

insert into sample_grids.member (team_id, name, role, starts, hours, rate, remote) values
  (1, 'Ada', 'Lead', '2019-03-01', 40, 95, false), (1, 'Linus', 'Developer', '2021-06-14', 40, 80, true),
  (1, 'Grace', 'Developer', '2022-01-10', 32, 82, false), (1, 'Ken', 'Tester', '2023-09-01', 24, 65, true),
  (2, 'Margaret', 'Lead', '2020-02-03', 40, 92, false), (2, 'Dennis', 'Developer', '2021-11-22', 36, 78, false),
  (2, 'Barbara', 'Designer', '2024-04-15', 20, 70, true), (3, 'Edgar', 'Analyst', '2018-08-20', 40, 88, false),
  (3, 'Michael', 'Developer', '2022-05-30', 40, 79, true), (3, 'Frances', 'Analyst', '2025-01-06', 28, 72, false),
  (4, 'Susan', 'Designer', '2019-10-01', 40, 85, false), (4, 'Jef', 'Designer', '2023-03-13', 32, 74, true);

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_grids') then create role app_sample_grids nologin; end if;
end $$;
grant app_sample_grids to pgkiln_runtime;
grant usage on schema sample_grids to app_sample_grids;
grant select, insert, update, delete on all tables in schema sample_grids to app_sample_grids;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-grids', 'Sample Interactive Grids', 1, 'app_users', 'app_sample_grids');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-grids';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values (1, 'Sample Interactive Grids', null), (3, 'Grid features', 1), (5, 'Reading and analysing', 1)) as p (no, name, parent)
 where a.alias = 'sample-grids';

-- page 2: an editable grid on the teams, as the Interactive grid wizard makes it
select meta.generate_page('sample-grids', 'grid', 'sample_grids.team', 2, '{"label": "Teams", "nav": false}');
-- page 4: master-detail, teams and their members (the Master-detail wizard)
select meta.generate_page('sample-grids', 'master_detail', 'sample_grids.team', 4, '{"label": "Teams and members", "nav": false}');
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-grids') and page_no in (2, 4);

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Teams', 'grid', 2), (30, 'Grid features', 'sliders', 3),
  (40, 'Teams and members', 'users', 4), (50, 'Reading and analysing', 'chart', 5)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-grids';

insert into meta.list (app_id, name, type, description)
select id, 'GRID_TOPICS', 'static', 'The pages of Sample Interactive Grids' from meta.app where alias = 'sample-grids';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'GRID_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Teams', 'grid', 2, 'An editable grid as the wizard makes it: edit cells, add rows, delete rows, Save.'),
  (20, 'Grid features', 'sliders', 3, 'Select lists, required columns, totals, a frozen column, a row menu and a column layout.'),
  (30, 'Teams and members', 'users', 4, 'Master-detail: choose a team, edit its members below.'),
  (40, 'Reading and analysing', 'chart', 5, 'A read-only grid with the single row, group by and chart views.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-grids';

insert into meta.region (page_id, seq, title, type, columns, template, source, table_name, pk_column, config, static_id)
select pg_temp.page_id('sample-grids', r.page), r.seq, r.title, r.type, 12, r.template, r.source, r.tab, r.pk, r.config::jsonb, r.sid
  from (values
  -- 1 Home
  (1, 10, 'Sample Interactive Grids', 'static', 'hero',
   '<p>An interactive grid edits the rows of one table in place: click a cell (or press Enter or F2) to edit it, the arrow keys move between cells, Ctrl+C and Ctrl+V copy and paste ranges from and to a spreadsheet. Only changed cells are saved, and when one row fails nothing is saved. Without a <code>grid_dml</code> process a grid is read-only.</p>',
   null, null, '{"icon": "grid"}', null),
  (1, 20, 'Topics', 'list', 'plain', null, null, null, '{"list": "GRID_TOPICS", "template": "cards"}', null),

  -- 2 Teams (the wizard's grid follows at seq 10)
  (2, 5, 'About this page', 'static', 'plain',
   '<p class="lead">The wizard made this grid: a region of type <code>grid</code> on <code>sample_grids.team</code> with its key column, and a <code>grid_dml</code> process that saves it. Try <strong>Add row</strong>, change a budget and press <strong>Save</strong>; a duplicate name is refused by the table''s unique constraint, with the row number.</p>',
   null, null, '{}', null),

  -- 3 Grid features
  (3, 5, 'About this page', 'static', 'plain',
   '<p class="lead">The grid''s attributes: <code>columns</code> gives the team column a list of values and makes the name required; <code>aggregates</code> adds totals over every row of the search; <code>frozen</code> keeps the name in view while the grid scrolls sideways; <code>row_actions</code> adds a menu per row (duplicate, delete); <code>layout</code> sets the default order and widths, and every user can rearrange it (Actions → Columns).</p>',
   null, null, '{}', null),
  (3, 10, 'Members', 'grid', 'standard',
   E'select id, name, team_id, role, starts, hours, rate, remote\n  from sample_grids.member order by team_id, name',
   'sample_grids.member', 'id',
   '{"page_size": 10,
     "headings": {"team_id": "Team", "starts": "Started", "hours": "Hours a week", "rate": "Hourly rate"},
     "columns": {"name": {"required": true},
                 "team_id": {"lov": "select name, id from sample_grids.team order by name", "required": true},
                 "role": {"lov": "STATIC:Lead,Developer,Designer,Tester,Analyst", "required": true}},
     "formats": {"rate": "999G990D00"},
     "aggregates": {"hours": ["sum", "avg"], "rate": "avg", "id": "count"},
     "frozen": 1,
     "hidden": ["id"],
     "row_actions": {"duplicate": true, "delete": true},
     "layout": {"order": ["name", "team_id", "role", "hours", "rate", "starts", "remote"], "widths": {"name": 160}}}', 'members'),

  -- 4 Teams and members (the wizard's grids follow at seq 10 and 20)
  (4, 5, 'About this page', 'static', 'plain',
   '<p class="lead">The master-detail wizard made this page. The teams grid has <code>select_row</code>: choosing a row puts its key in the hidden item <code>P4_ID</code>. The members grid has <code>master</code>: its query uses <code>:P4_ID</code>, it refreshes in place when another team is chosen, and its new rows get that team.</p>',
   null, null, '{}', null),

  -- 5 Reading and analysing
  (5, 5, 'About this page', 'static', 'plain',
   '<p class="lead">This grid has no <code>grid_dml</code> process and <code>allow</code> switches off insert, update and delete, so it only reads. Its <strong>views</strong> are still there: open a row in the <em>Single row view</em> (the row menu or Actions), or set up a <em>Group by</em> or a <em>Chart</em> under Actions, for example the hours per team.</p>',
   null, null, '{}', null),
  (5, 10, 'Members per team', 'grid', 'standard',
   E'select m.id, m.name, t.name as team, m.role, m.hours, m.rate, m.remote\n  from sample_grids.member m join sample_grids.team t on t.id = m.team_id\n order by t.name, m.name',
   'sample_grids.member', 'id',
   '{"page_size": 25, "allow": {"insert": false, "update": false, "delete": false}, "views": ["row", "group", "chart"],
     "hidden": ["id"], "aggregates": {"hours": "sum"}, "row_actions": {}}', 'analysis')
  ) as r (page, seq, title, type, template, source, tab, pk, config, sid);

insert into meta.process (page_id, seq, name, type, region_id)
select pg_temp.page_id('sample-grids', 3), 10, 'Save the members', 'grid_dml', r.id
  from meta.region r where r.page_id = pg_temp.page_id('sample-grids', 3) and r.static_id = 'members';

-- the detail grid of page 4: the role as a select list
update meta.region set config = jsonb_set(config, '{columns,role}', '{"lov": "STATIC:Lead,Developer,Designer,Tester,Analyst", "required": true}')
 where page_id = pg_temp.page_id('sample-grids', 4) and seq = 20;
