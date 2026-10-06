-- =====================================================================
-- HR example, part 48: a map of a large data set, as vector tiles and
-- by the visible area (docs/guide/04-pages-and-regions.md, map region)
--
-- Page 41 "Weather stations": 20 000 stations (hr.weather_station,
-- generated, deterministic) on one map:
--   - "Stations": the region's own query, served as Mapbox Vector Tiles
--     (config "tiles": true): the browser fetches the tiles it shows,
--     each with the stations in its area; nothing comes with the page;
--   - "High stations" (above 2 000 m): loaded for the visible area only
--     (config "visible_area": true), again whenever the map moves; when
--     more than 2 000 are in view the map says to zoom in.
-- =====================================================================

create table hr.weather_station (
  id        int primary key,
  name      text not null,
  elevation int not null,
  lat       numeric(9, 5) not null,
  lng       numeric(9, 5) not null
);
grant select on hr.weather_station to hr_app;

-- spread evenly over Europe (a low-discrepancy sequence: the same places every install)
insert into hr.weather_station (id, name, elevation, lat, lng)
select g, 'Station ' || g, (g * 37) % 2500,
       round((36 + ((g * 0.6180339887) % 1) * 34)::numeric, 5),
       round((-10 + ((g * 0.7548776662) % 1) * 40)::numeric, 5)
  from generate_series(1, 20000) g;

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 41, 'Weather stations', 'Weather stations', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, 10, 'Weather stations', 'map', 12, 'standard',
$q$select lat, lng, name as title, elevation || ' m' as body from hr.weather_station$q$,
jsonb_build_object(
  'name', 'Stations',
  'height', 'large',
  'tiles', true,
  'layers', jsonb_build_array(
    jsonb_build_object(
      'name', 'High stations',
      'visible_area', true,
      'cluster', true,
      'source', $q$select lat, lng, name as title, elevation || ' m' as body
  from hr.weather_station
 where elevation > 2000$q$)))
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 41;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 33, 'Weather stations', 'map', 41 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Weather stations', 'Weerstations'),
  ('Stations', 'Stations'),
  ('High stations', 'Hooggelegen stations')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
