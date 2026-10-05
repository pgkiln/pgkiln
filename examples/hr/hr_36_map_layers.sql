-- =====================================================================
-- HR example, part 36: a map with several layers, marker clustering and
-- a report filtered by the distance from the map's centre
-- (docs/guide/04-pages-and-regions.md, map region)
--
-- Page 33 "Field visits": one map with four layers, each with its own
-- query, switched on and off in the map's legend:
--   - "Visits": customer visits by the sales staff (hr.field_visit),
--     clustered markers (a round marker with the count; click to zoom in);
--   - "Offices": the department offices, linked to the department;
--   - "Sales areas": an area around each office and the delivery routes
--     between them (GeoJSON built in SQL; with PostGIS a geometry column
--     would do);
--   - "Visit density": the same visits as a heat map, off at first.
-- The map filters the "Visits" report below it to the places within a
-- distance of the map's centre ("Show places within … km of the centre"),
-- on the server: with PostGIS installed on a geometry column, here on the
-- lat/lng columns.
-- =====================================================================

create table hr.field_visit (
  id         int primary key,
  deptno     int not null references hr.dept,
  customer   text not null,
  visited_on date not null,
  lat        numeric(9, 5) not null,
  lng        numeric(9, 5) not null
);
grant select on hr.field_visit to hr_app;

-- twenty visits around each office, spread over a few hundred kilometres (deterministic)
insert into hr.field_visit (id, deptno, customer, visited_on, lat, lng)
select d.deptno * 100 + n,
       d.deptno,
       (array['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Stark', 'Wayne', 'Wonka', 'Tyrell'])[1 + (n * 7 + d.deptno) % 10]
         || ' ' || (array['Foods', 'Logistics', 'Systems', 'Retail', 'Labs'])[1 + (n + d.deptno / 10) % 5],
       current_date - (n * 5 + d.deptno / 10),
       round((d.lat + (0.15 + (n % 5) * 0.45) * sin(n * 1.7 + d.deptno))::numeric, 5),
       round((d.lng + (0.2 + (n % 4) * 0.6) * cos(n * 1.3 + d.deptno))::numeric, 5)
  from hr.dept d, generate_series(1, 20) n
 where d.lat is not null;

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 33, 'Field visits', 'Field visits', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, 10, 'Field visits', 'map', 12, 'standard',
$q$select v.lat, v.lng, v.customer as title,
       to_char(v.visited_on, 'DD Mon YYYY') || ' · ' || initcap(d.loc) as body
  from hr.field_visit v join hr.dept d using (deptno)$q$,
jsonb_build_object(
  'name', 'Visits',
  'height', 'large',
  'cluster', true,
  'filter', 'distance',
  'layers', jsonb_build_array(
    jsonb_build_object(
      'name', 'Offices',
      'source', $q$select d.lat, d.lng, d.dname as title, initcap(d.loc) as body, d.deptno
  from hr.dept d
 where d.lat is not null$q$,
      'link', jsonb_build_object('page', 5, 'items', jsonb_build_object('P5_DEPTNO', '#deptno#'))),
    jsonb_build_object(
      'name', 'Sales areas',
      'source', $q$-- an area of about 2 by 3 degrees around each office
select d.dname || ' area' as title,
       json_build_object('type', 'Polygon', 'coordinates', json_build_array(json_build_array(
         json_build_array(d.lng - 1.5, d.lat - 1), json_build_array(d.lng + 1.5, d.lat - 1),
         json_build_array(d.lng + 1.5, d.lat + 1), json_build_array(d.lng - 1.5, d.lat + 1),
         json_build_array(d.lng - 1.5, d.lat - 1))))::text as geojson
  from hr.dept d
 where d.lat is not null
union all
-- the delivery routes between the offices, from New York
select 'Route to ' || initcap(d.loc),
       json_build_object('type', 'LineString', 'coordinates', json_build_array(
         json_build_array(ny.lng, ny.lat), json_build_array(d.lng, d.lat)))::text
  from hr.dept d, hr.dept ny
 where ny.deptno = 10 and d.deptno <> 10 and d.lat is not null$q$),
    jsonb_build_object(
      'name', 'Visit density',
      'layer', 'heat',
      'hidden', true,
      'source', 'select lat, lng from hr.field_visit')
  ))
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 33;

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, 20, 'Visits', 'report', 12, 'standard',
$q$select v.visited_on, v.customer, initcap(d.loc) as office, v.lat, v.lng
  from hr.field_visit v join hr.dept d using (deptno)
 order by v.visited_on desc$q$,
'{"page_size": 10, "headings": {"visited_on": "Visited on", "customer": "Customer", "office": "Office", "lat": "Latitude", "lng": "Longitude"}}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 33;

-- the map filters the report on the same page
update meta.region m
   set config = m.config || jsonb_build_object('report', r.id)
  from meta.region r
 where m.page_id = r.page_id and m.type = 'map' and r.type = 'report'
   and r.page_id = (select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 33);

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 26, 'Field visits', 'map', 33
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Employees' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Field visits', 'Klantbezoeken'),
  ('Visits', 'Bezoeken'),
  ('Visited on', 'Bezocht op'),
  ('Customer', 'Klant'),
  ('Sales areas', 'Verkoopgebieden'),
  ('Visit density', 'Bezoekdichtheid')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
