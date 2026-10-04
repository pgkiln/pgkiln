-- =====================================================================
-- HR example, part 25: large tables (docs/guide/04-pages-and-regions.md,
-- "Large tables")
--
-- Page 25 "Large tables" reads hr.reading, 200,000 generated sensor
-- readings (generate_series):
--   - a report with "row ranges" pagination: no total is counted, each
--     page reads one row more than it shows to know whether there is a
--     next page;
--   - a report with a total over at most 5,000 rows ("of more than 5000");
--   - a chart of the average per sensor, loaded lazily (the page shows
--     first) and cached for all users for 60 seconds;
--   - cards limited to six rows ("Showing the first 6 rows");
--   - dynamic content cached per user for 30 seconds.
-- CSV and Excel downloads of the reports stream from a cursor.
-- =====================================================================

create table hr.reading (
  id       bigint generated always as identity primary key,
  sensor   text not null,
  taken_at timestamp not null,
  value    numeric(8, 2) not null
);
insert into hr.reading (sensor, taken_at, value)
select 'Sensor ' || chr(65 + g % 8), timestamp '2026-01-01' + g * interval '2 minutes', round((20 + 10 * sin(g / 500.0) + (g % 7))::numeric, 2)
  from generate_series(1, 200000) g;
create index reading_taken_at on hr.reading (taken_at);
analyze hr.reading;
grant select on hr.reading to hr_app;

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 25, 'Large tables', 'Large tables', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, source, config)
select p.id, x.seq, x.title, x.type, x.columns, x.source, x.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id,
  (values
    (10, 'Average per sensor', 'chart', 6,
     'select sensor, round(avg(value), 1) as average from hr.reading group by sensor order by sensor',
     '{"kind": "bar", "lazy": true, "cache": {"scope": "all", "seconds": 60}}'),
    (20, 'Latest readings', 'cards', 6,
     $q$select sensor as title, to_char(taken_at, 'YYYY-MM-DD HH24:MI') as subtitle, value as badge
  from hr.reading order by taken_at desc$q$,
     '{"max_rows": 6}'),
    (30, 'All readings', 'report', 12,
     'select id, sensor, taken_at, value from hr.reading order by id',
     '{"pagination": "range", "page_size": 25, "headings": {"taken_at": "Taken at"}}'),
    (40, 'Readings of sensor A', 'report', 12,
     $q$select id, taken_at, value from hr.reading where sensor = 'Sensor A' order by taken_at desc$q$,
     '{"max_rows": 5000, "page_size": 10, "lazy": true, "headings": {"taken_at": "Taken at"}}'),
    (50, 'Your summary', 'dynamic', 12,
     $q$select '<p>' || meta.html_escape(initcap(:APP_USER)) || ', the newest reading is from '
       || to_char(max(taken_at), 'YYYY-MM-DD HH24:MI') || ' (rendered at ' || to_char(clock_timestamp(), 'HH24:MI:SS') || ').</p>'
  from hr.reading$q$,
     '{"cache": {"scope": "user", "seconds": 30}}')
  ) as x(seq, title, type, columns, source, config)
 where a.alias = 'hr' and p.page_no = 25;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 26, 'Large tables', 'table', 25 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Large tables', 'Grote tabellen'),
  ('Average per sensor', 'Gemiddelde per sensor'),
  ('Latest readings', 'Laatste metingen'),
  ('All readings', 'Alle metingen'),
  ('Readings of sensor A', 'Metingen van sensor A'),
  ('Your summary', 'Uw samenvatting'),
  ('Taken at', 'Gemeten op')
  ) as t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
