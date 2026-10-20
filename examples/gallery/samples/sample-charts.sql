-- =====================================================================
-- Sample app "Sample Charts" (App Gallery → Sample Apps)
--
-- Every chart type of the chart region, a page per kind of question
-- (comparing categories, change over time, parts of a whole, relations and
-- spread, plans) and a drill-down from a chart to a report. Each page starts
-- with a text that says how the query shapes the chart.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-charts.sql
-- then open /a/sample-charts and sign in as demo / demo.
-- =====================================================================

-- helpers of this script (temporary: they go with the session)
create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_charts;

create table sample_charts.sale (
  id      int generated always as identity primary key,
  sold_on date not null,
  region  text not null,
  product text not null,
  channel text not null,
  units   int not null,
  amount  numeric(12, 2) not null
);

-- twelve months of sales: four regions, three products, three channels
insert into sample_charts.sale (sold_on, region, product, channel, units, amount)
select (date_trunc('month', current_date) - make_interval(months => m))::date + ((r * 7 + p * 3) % 27)::int,
       g.region, q.product, (array['Web', 'Store', 'Partner'])[1 + (m + r + p) % 3],
       x.units, x.units * (array[640, 290, 95])[p]
  from generate_series(0, 11) m,
       unnest(array['North', 'South', 'East', 'West']) with ordinality as g (region, r),
       unnest(array['Standing desk', 'Office chair', 'Monitor arm']) with ordinality as q (product, p),
       lateral (select (5 + (m * 7 + r * 11 + p * 13) % 23)::int as units) x;

create table sample_charts.share_price (
  day   date primary key,
  open  numeric(8, 2) not null,
  high  numeric(8, 2) not null,
  low   numeric(8, 2) not null,
  close numeric(8, 2) not null
);

insert into sample_charts.share_price (day, open, high, low, close)
select current_date - 30 + d, o, greatest(o, c) + 1.5, least(o, c) - 1.2, c
  from generate_series(1, 30) d,
       lateral (select round((100 + 8 * sin((d - 1) / 4.0) + (d - 1) * 0.3)::numeric, 2) as o,
                       round((100 + 8 * sin(d / 4.0) + d * 0.3)::numeric, 2) as c) v;

create table sample_charts.pipeline (
  seq   int primary key,
  stage text not null,
  deals int not null
);

insert into sample_charts.pipeline values (1, 'Leads', 240), (2, 'Qualified', 130), (3, 'Proposal', 64), (4, 'Negotiation', 31), (5, 'Won', 18);

create table sample_charts.budget (
  node_id   int primary key,
  parent_id int references sample_charts.budget,
  label     text not null,
  amount    numeric(10, 2) not null default 0
);

insert into sample_charts.budget values
  (1, null, 'Operations', 0), (2, null, 'Marketing', 0), (3, null, 'Engineering', 0),
  (11, 1, 'Rent', 40), (12, 1, 'Utilities', 12),
  (21, 2, 'Events', 18), (22, 2, 'Online ads', 25), (23, 2, 'Print', 6),
  (31, 3, 'Salaries', 120), (32, 3, 'Cloud', 30), (33, 3, 'Tools', 14);

create table sample_charts.project_task (
  id         int primary key,
  name       text not null,
  team       text not null,
  starts     date not null,
  ends       date,
  progress   int not null default 0,
  depends_on int[] not null default '{}'
);

insert into sample_charts.project_task values
  (1, 'Kick-off', 'Product', current_date - 20, null, 100, '{}'),
  (2, 'Requirements', 'Product', current_date - 19, current_date - 8, 100, '{1}'),
  (3, 'Design', 'Product', current_date - 9, current_date + 3, 70, '{2}'),
  (4, 'Build', 'Engineering', current_date + 1, current_date + 25, 10, '{3}'),
  (5, 'Test', 'Quality', current_date + 18, current_date + 32, 0, '{4}'),
  (6, 'Launch', 'Product', current_date + 33, null, 0, '{5}');

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_charts') then create role app_sample_charts nologin; end if;
end $$;
grant app_sample_charts to pgkiln_runtime;
grant usage on schema sample_charts to app_sample_charts;
grant select on all tables in schema sample_charts to app_sample_charts;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-charts', 'Sample Charts', 1, 'app_users', 'app_sample_charts');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-charts';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values
  (1, 'Sample Charts', null), (2, 'Comparing categories', 1), (3, 'Change over time', 1), (4, 'Parts of a whole', 1),
  (5, 'Relations and spread', 1), (6, 'Plans and timelines', 1), (7, 'Drill-down', 1), (8, 'Sales by region', 7)
  ) as p (no, name, parent)
 where a.alias = 'sample-charts';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Comparing categories', 'chart', 2), (30, 'Change over time', 'line-chart', 3),
  (40, 'Parts of a whole', 'pie-chart', 4), (50, 'Relations and spread', 'activity', 5), (60, 'Plans and timelines', 'calendar', 6),
  (70, 'Drill-down', 'filter', 7)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-charts';

-- the home page's list of topics
insert into meta.list (app_id, name, type, description)
select id, 'CHART_TOPICS', 'static', 'The pages of Sample Charts (cards on the home page)' from meta.app where alias = 'sample-charts';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'CHART_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Comparing categories', 'chart', 2, 'Bar, column, stacked and combination charts.'),
  (20, 'Change over time', 'line-chart', 3, 'Line, area, range and stock charts.'),
  (30, 'Parts of a whole', 'pie-chart', 4, 'Pie, donut, funnel, pyramid, treemap and sunburst charts.'),
  (40, 'Relations and spread', 'activity', 5, 'Scatter, bubble, box plot, radar, polar and gauge charts.'),
  (50, 'Plans and timelines', 'calendar', 6, 'Gantt and timeline charts.'),
  (60, 'Drill-down', 'filter', 7, 'A chart whose columns open a report of their rows.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-charts';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select pg_temp.page_id('sample-charts', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb
  from (values
  -- 1 Home
  (1, 10, 'Sample Charts', 'static', 12, 'hero',
   '<p>A chart region draws a SELECT: the first column is the label, every further number column a series, named by its alias. The attribute <code>kind</code> chooses one of 22 chart types. Every chart has tooltips, a legend for several series and a <em>Data table</em> toggle, the accessible alternative to the picture.</p>',
   '{"icon": "chart"}'),
  (1, 20, 'Topics', 'list', 12, 'plain', null, '{"list": "CHART_TOPICS", "template": "cards"}'),
  (1, 30, 'The data', 'static', 12, 'standard',
   '<p>The schema <code>sample_charts</code> holds a year of sales (<code>sale</code>: region, product, channel, units, amount), a month of share prices, a sales pipeline, a budget in two levels and a small project plan. The queries of the charts are in the Page Designer: open a region and look at its Source and its attributes.</p>',
   '{}'),

  -- 2 Comparing categories
  (2, 5, 'About these charts', 'static', 12, 'plain',
   '<p class="lead">Compare categories with bars and columns. <strong>bar</strong> draws horizontal bars, good for long labels; <strong>column</strong> vertical columns; <strong>stacked</strong> stacks the series of a label on top of each other; <strong>combo</strong> draws the first series as columns and the others as lines over them.</p>',
   '{}'),
  (2, 10, 'Units sold per product and channel (bar)', 'chart', 6, 'standard',
   E'select product || '' via '' || lower(channel) as product, sum(units) as "Units"\n  from sample_charts.sale group by product, channel order by 2 desc',
   '{"kind": "bar"}'),
  (2, 20, 'Sales per region (column)', 'chart', 6, 'standard',
   E'select region, sum(amount) as "Sales"\n  from sample_charts.sale group by region order by region',
   '{"kind": "column", "format_mask": "999G999G990"}'),
  (2, 30, 'Sales per region and product (stacked)', 'chart', 6, 'standard',
   E'select region,\n       sum(amount) filter (where product = ''Standing desk'') as "Standing desk",\n       sum(amount) filter (where product = ''Office chair'') as "Office chair",\n       sum(amount) filter (where product = ''Monitor arm'') as "Monitor arm"\n  from sample_charts.sale group by region order by region',
   '{"kind": "stacked", "format_mask": "999G999G990"}'),
  (2, 40, 'Sales against the target (combo)', 'chart', 6, 'standard',
   E'select region, sum(amount) as "Sales", 200000 as "Target"\n  from sample_charts.sale group by region order by region',
   '{"kind": "combo", "format_mask": "999G999G990"}'),

  -- 3 Change over time
  (3, 5, 'About these charts', 'static', 12, 'plain',
   '<p class="lead">Show change over time with the label column in order (months, days). <strong>line</strong> and <strong>area</strong> draw one line per series; <strong>range</strong> a floating column from a low to a high column; <strong>stock</strong> a candle per row from the open, high, low and close columns.</p>',
   '{}'),
  (3, 10, 'Monthly sales per region (line)', 'chart', 12, 'standard',
   E'select to_char(date_trunc(''month'', sold_on), ''YYYY-MM'') as month,\n       sum(amount) filter (where region = ''North'') as "North",\n       sum(amount) filter (where region = ''South'') as "South",\n       sum(amount) filter (where region = ''East'') as "East",\n       sum(amount) filter (where region = ''West'') as "West"\n  from sample_charts.sale group by 1 order by 1',
   '{"kind": "line", "format_mask": "999G999G990"}'),
  (3, 20, 'Sales so far this year (area)', 'chart', 6, 'standard',
   E'select month, sum(total) over (order by month) as "Cumulative sales"\n  from (select to_char(date_trunc(''month'', sold_on), ''YYYY-MM'') as month, sum(amount) as total\n          from sample_charts.sale group by 1) m\n order by month',
   '{"kind": "area", "format_mask": "999G999G990"}'),
  (3, 30, 'Smallest and largest sale per region (range)', 'chart', 6, 'standard',
   E'select region, min(amount) as "Smallest", max(amount) as "Largest"\n  from sample_charts.sale group by region order by region',
   '{"kind": "range", "format_mask": "999G999G990"}'),
  (3, 40, 'Share price over the last month (stock)', 'chart', 12, 'standard',
   E'select to_char(day, ''DD Mon'') as day, open as "Open", high as "High", low as "Low", close as "Close"\n  from sample_charts.share_price order by sample_charts.share_price.day',
   '{"kind": "stock"}'),

  -- 4 Parts of a whole
  (4, 5, 'About these charts', 'static', 12, 'plain',
   '<p class="lead">Show how a total divides. <strong>pie</strong> and <strong>donut</strong> use the first series (up to six slices, the rest folds into Other); <strong>funnel</strong> shows the stages of a process in the order of the query; <strong>pyramid</strong> with two series compares two groups back to back; <strong>treemap</strong> and <strong>sunburst</strong> show a hierarchy from the columns <code>node_id</code> and <code>parent_id</code>.</p>',
   '{}'),
  (4, 10, 'Sales per channel (pie)', 'chart', 6, 'standard',
   E'select channel, sum(amount) as "Sales"\n  from sample_charts.sale group by channel order by 2 desc',
   '{"kind": "pie", "format_mask": "999G999G990"}'),
  (4, 20, 'Units per product (donut)', 'chart', 6, 'standard',
   E'select product, sum(units) as "Units"\n  from sample_charts.sale group by product order by 2 desc',
   '{"kind": "donut"}'),
  (4, 30, 'Sales pipeline (funnel)', 'chart', 6, 'standard',
   E'select stage, deals as "Deals" from sample_charts.pipeline order by seq',
   '{"kind": "funnel"}'),
  (4, 40, 'Units per product, North against South (pyramid)', 'chart', 6, 'standard',
   E'select product,\n       sum(units) filter (where region = ''North'') as "North",\n       sum(units) filter (where region = ''South'') as "South"\n  from sample_charts.sale group by product order by product',
   '{"kind": "pyramid"}'),
  (4, 50, 'Budget (treemap)', 'chart', 6, 'standard',
   E'select label, amount as "Budget", node_id, parent_id from sample_charts.budget order by node_id',
   '{"kind": "treemap"}'),
  (4, 60, 'Budget (sunburst)', 'chart', 6, 'standard',
   E'select label, amount as "Budget", node_id, parent_id from sample_charts.budget order by node_id',
   '{"kind": "sunburst"}'),

  -- 5 Relations and spread
  (5, 5, 'About these charts', 'static', 12, 'plain',
   '<p class="lead">Look at numbers against each other. <strong>scatter</strong> takes a number as its first column (the x axis); <strong>bubble</strong> a label, then x, y and size; <strong>boxplot</strong> one row per observation and computes the quartiles per label; <strong>radar</strong> an axis per row; <strong>polar</strong> a sector per row; <strong>gauge</strong> a dial per row with thresholds in its attributes.</p>',
   '{}'),
  (5, 10, 'Units against amount per sale (scatter)', 'chart', 6, 'standard',
   E'select units as "Units", amount as "Amount" from sample_charts.sale order by units',
   '{"kind": "scatter"}'),
  (5, 20, 'Products per region: units, average sale and number of sales (bubble)', 'chart', 6, 'standard',
   E'select region || '' '' || lower(product) as product, sum(units) as "Units", round(avg(amount)) as "Average sale", count(*) as "Sales"\n  from sample_charts.sale group by region, product order by 1',
   '{"kind": "bubble"}'),
  (5, 30, 'Spread of the sales per region (box plot)', 'chart', 6, 'standard',
   E'select region, amount as "Sale" from sample_charts.sale order by region',
   '{"kind": "boxplot"}'),
  (5, 40, 'Units per region and product (radar)', 'chart', 6, 'standard',
   E'select region,\n       sum(units) filter (where product = ''Standing desk'') as "Standing desk",\n       sum(units) filter (where product = ''Office chair'') as "Office chair",\n       sum(units) filter (where product = ''Monitor arm'') as "Monitor arm"\n  from sample_charts.sale group by region order by region',
   '{"kind": "radar"}'),
  (5, 50, 'Sales per month (polar)', 'chart', 6, 'standard',
   E'select to_char(date_trunc(''month'', sold_on), ''Mon'') as month, sum(amount) as "Sales"\n  from sample_charts.sale group by date_trunc(''month'', sold_on) order by date_trunc(''month'', sold_on)',
   '{"kind": "polar", "format_mask": "999G999G990"}'),
  (5, 60, 'Target reached per region, % (gauge)', 'chart', 6, 'standard',
   E'select region, round(100.0 * sum(amount) / 200000) as "Target reached"\n  from sample_charts.sale group by region order by region',
   '{"kind": "gauge", "gauge": {"min": 0, "max": 120, "warning": 90, "critical": 75}}'),

  -- 6 Plans and timelines
  (6, 5, 'About these charts', 'static', 12, 'plain',
   '<p class="lead">Show plans. <strong>gantt</strong> takes a label, a start and an end (no end: a milestone), and optional columns <code>progress</code>, <code>task_id</code> and <code>depends_on</code>; <strong>timeline</strong> a label, a start and an end, with a lane per value of the column <code>series</code>.</p>',
   '{}'),
  (6, 10, 'Project plan (Gantt)', 'chart', 12, 'standard',
   E'select name as "Task", starts as "Starts", ends as "Ends", progress, id as task_id,\n       array_to_string(depends_on, '','') as depends_on\n  from sample_charts.project_task order by starts, id',
   '{"kind": "gantt"}'),
  (6, 20, 'Who works when (timeline)', 'chart', 12, 'standard',
   E'select name as "Task", starts as "Starts", ends as "Ends", team as series\n  from sample_charts.project_task order by starts, id',
   '{"kind": "timeline"}'),

  -- 7 Drill-down
  (7, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">With the attribute <code>link</code> every column of the chart is a link: <code>#region#</code> is replaced by the value of the clicked row. The link carries a checksum, like every link pgkiln makes. Columns that only the link uses are not drawn. From the keyboard, the data table has the same links.</p>',
   '{}'),
  (7, 10, 'Sales per region: click a column', 'chart', 12, 'standard',
   E'select region, sum(amount) as "Sales"\n  from sample_charts.sale group by region order by region',
   '{"kind": "column", "format_mask": "999G999G990", "link": {"page": 8, "items": {"P8_REGION": "#region#"}}}'),

  -- 8 Sales by region (the drill-down's target)
  (8, 10, 'Sales', 'report', 12, 'standard',
   E'select sold_on, region, product, channel, units, amount\n  from sample_charts.sale\n where :P8_REGION is null or region = :P8_REGION\n order by sold_on desc, id',
   '{"headings": {"sold_on": "Sold on"}, "formats": {"amount": "999G999G990D00"}}'),
  (8, 20, 'Per product', 'chart', 12, 'standard',
   E'select product, sum(amount) as "Sales"\n  from sample_charts.sale where :P8_REGION is null or region = :P8_REGION\n group by product order by 2 desc',
   '{"kind": "bar", "format_mask": "999G999G990"}')
  ) as r (page, seq, title, type, cols, template, source, config);

insert into meta.item (page_id, region_id, seq, name, label, type, lov, config)
select pg_temp.page_id('sample-charts', 8), null, 10, 'P8_REGION', 'Region', 'select',
       'select distinct region as d, region as r from sample_charts.sale order by 1',
       '{"submit_on_change": true, "null_label": "All regions"}';
