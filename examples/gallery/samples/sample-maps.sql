-- =====================================================================
-- Sample app "Sample Maps" (App Gallery → Sample Apps)
--
-- Map regions on Dutch museums, without PostGIS: markers with popups and
-- clustering; several layers (markers, a route and an area as GeoJSON, a
-- heat map that starts hidden); a map that filters the report beside it by
-- distance; and a form with a location item ("Use my location") whose
-- places show on a map.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-maps.sql
-- then open /a/sample-maps and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;
create or replace function pg_temp.region_id(p_alias text, p_page int, p_static text) returns int language sql stable as
  $$ select r.id from meta.region r where r.page_id = pg_temp.page_id(p_alias, p_page) and r.static_id = p_static $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_maps;

create table sample_maps.museum (
  id       int generated always as identity primary key,
  name     text not null unique,
  city     text not null,
  kind     text not null check (kind in ('Art', 'History', 'Science', 'Maritime', 'Nature')),
  visitors int not null,
  lat      numeric(8, 5) not null,
  lng      numeric(8, 5) not null
);

insert into sample_maps.museum (name, city, kind, visitors, lat, lng) values
  ('Rijksmuseum', 'Amsterdam', 'Art', 2500000, 52.36000, 4.88520),
  ('Van Gogh Museum', 'Amsterdam', 'Art', 2100000, 52.35840, 4.88110),
  ('Stedelijk Museum', 'Amsterdam', 'Art', 700000, 52.35800, 4.87970),
  ('Anne Frank House', 'Amsterdam', 'History', 1300000, 52.37520, 4.88400),
  ('NEMO Science Museum', 'Amsterdam', 'Science', 650000, 52.37380, 4.91230),
  ('National Maritime Museum', 'Amsterdam', 'Maritime', 400000, 52.37140, 4.91490),
  ('Mauritshuis', 'The Hague', 'Art', 450000, 52.08040, 4.31430),
  ('Kunstmuseum Den Haag', 'The Hague', 'Art', 400000, 52.08970, 4.28060),
  ('Kunsthal', 'Rotterdam', 'Art', 280000, 51.91070, 4.47330),
  ('Maritime Museum Rotterdam', 'Rotterdam', 'Maritime', 300000, 51.91740, 4.48230),
  ('Centraal Museum', 'Utrecht', 'Art', 200000, 52.08360, 5.12590),
  ('Rijksmuseum van Oudheden', 'Leiden', 'History', 230000, 52.15840, 4.48590),
  ('Naturalis', 'Leiden', 'Nature', 400000, 52.16520, 4.47370),
  ('Frans Hals Museum', 'Haarlem', 'Art', 200000, 52.37720, 4.63660),
  ('Teylers Museum', 'Haarlem', 'Science', 150000, 52.38010, 4.64030),
  ('Kröller-Müller Museum', 'Otterlo', 'Art', 350000, 52.09550, 5.81700),
  ('Van Abbemuseum', 'Eindhoven', 'Art', 120000, 51.43420, 5.48180),
  ('Groninger Museum', 'Groningen', 'Art', 250000, 53.21240, 6.56600),
  ('Bonnefanten', 'Maastricht', 'Art', 120000, 50.84220, 5.70200),
  ('Zuiderzeemuseum', 'Enkhuizen', 'History', 250000, 52.70360, 5.29410);

-- lines and areas as GeoJSON text (with PostGIS a geometry column works the same way)
create table sample_maps.shape (
  id      int generated always as identity primary key,
  name    text not null,
  geojson text not null
);

insert into sample_maps.shape (name, geojson) values
  ('Museum walk: Anne Frank House to the Rijksmuseum',
   '{"type": "LineString", "coordinates": [[4.8840, 52.3752], [4.8851, 52.3700], [4.8868, 52.3650], [4.8852, 52.3600], [4.8811, 52.3584]]}'),
  ('Museumplein',
   '{"type": "Polygon", "coordinates": [[[4.8790, 52.3590], [4.8850, 52.3590], [4.8855, 52.3565], [4.8795, 52.3560], [4.8790, 52.3590]]]}');

create table sample_maps.place (
  id       int generated always as identity primary key,
  name     text not null,
  note     text,
  location text check (location ~ '^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$')
);

insert into sample_maps.place (name, note, location) values
  ('Amsterdam Centraal', 'Trains every few minutes', '52.37890,4.90040'),
  ('Vondelpark', 'Lunch in the park', '52.35800,4.86860');

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_maps') then create role app_sample_maps nologin; end if;
end $$;
grant app_sample_maps to pgkiln_runtime;
grant usage on schema sample_maps to app_sample_maps;
grant select on sample_maps.museum, sample_maps.shape to app_sample_maps;
grant select, insert, update, delete on sample_maps.place to app_sample_maps;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-maps', 'Sample Maps', 1, 'app_users', 'app_sample_maps');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-maps';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values (1, 'Sample Maps', null), (2, 'Museums', 1), (3, 'Layers', 1), (4, 'Map and list', 1)) as p (no, name, parent)
 where a.alias = 'sample-maps';

-- page 5 and its form, page 6: the Report and form wizard on the places
select meta.generate_page('sample-maps', 'report_form', 'sample_maps.place', 5, '{"label": "My places", "form_page": 6, "nav": false}');
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-maps') and page_no = 5;
update meta.item set type = 'location', help = 'Latitude,longitude; Use my location fills it in from the device.'
 where page_id = pg_temp.page_id('sample-maps', 6) and name = 'P6_LOCATION';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Museums', 'map', 2), (30, 'Layers', 'layers', 3),
  (40, 'Map and list', 'list', 4), (50, 'My places', 'map', 5)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-maps';

insert into meta.list (app_id, name, type, description)
select id, 'MAP_TOPICS', 'static', 'The pages of Sample Maps' from meta.app where alias = 'sample-maps';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'MAP_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Museums', 'map', 2, 'Markers from latitude and longitude columns, popups, and clusters that open as you zoom in.'),
  (20, 'Layers', 'layers', 3, 'Several queries on one map: markers, a route and an area as GeoJSON, a heat map you switch on.'),
  (30, 'Map and list', 'list', 4, 'Move the map, then show only the museums within that distance in the list beside it.'),
  (40, 'My places', 'map', 5, 'A form with a location item: Use my location stores latitude,longitude, the map shows them.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-maps';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id)
select pg_temp.page_id('sample-maps', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb, r.sid
  from (values
  -- 1 Home
  (1, 10, 'Sample Maps', 'static', 12, 'hero',
   '<p>A map region draws the rows of a SELECT: a place per row from <code>lat</code> and <code>lng</code> columns (or a <code>location</code> column holding <code>latitude,longitude</code>), lines and areas from a <code>geojson</code> column. No GIS extension is needed; with PostGIS a <code>geometry</code> column works too, and filtering by area runs on the server.</p>',
   '{"icon": "map"}', null),
  (1, 20, 'Topics', 'list', 12, 'plain', null, '{"list": "MAP_TOPICS", "template": "cards"}', null),

  -- 2 Museums
  (2, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">One query, one marker per museum: <code>title</code> and <code>body</code> fill the popup. With <code>"cluster": true</code> markers that are close together become one round marker with their number; click it, or zoom in, and they come apart. Below the map the same places are listed, which is also what you get without JavaScript.</p>',
   '{}', null),
  (2, 10, 'Museums in the Netherlands', 'map', 12, 'standard',
   E'select name as title, city || '' · '' || kind || '' · '' || to_char(visitors, ''FM9G999G999'') || '' visitors a year'' as body, lat, lng\n  from sample_maps.museum order by name',
   '{"cluster": true, "height": "large", "name": "Museums"}', 'museums'),

  -- 3 Layers
  (3, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The region''s query is the first layer; <code>layers</code> adds more, each with its own query and settings. The walk and Museumplein come from a <code>geojson</code> column; the visitor heat map (<code>"layer": "heat"</code>, weighted by a <code>weight</code> column) starts hidden: switch it on in the <strong>Layers</strong> legend.</p>',
   '{}', null),
  (3, 10, 'Amsterdam', 'map', 12, 'standard',
   E'select name as title, kind as body, lat, lng from sample_maps.museum where city = ''Amsterdam''',
   '{"name": "Museums", "height": "large",
     "layers": [{"name": "Walk and square", "source": "select name as title, geojson from sample_maps.shape"},
                {"name": "Visitors", "layer": "heat", "hidden": true,
                 "source": "select lat, lng, visitors / 100000 as weight from sample_maps.museum"}]}', 'layers'),

  -- 4 Map and list
  (4, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The map has <code>"report"</code>: the id of the report beside it, and <code>"filter": "distance"</code>. Move or zoom the map and press <strong>Show places within … km of the centre</strong>: the report keeps only the museums within that distance (a removable chip), filtered in its SQL on the server. The report needs position columns like the map''s.</p>',
   '{}', null),
  (4, 10, 'Map', 'map', 6, 'standard',
   'select name as title, city as body, lat, lng from sample_maps.museum', '{"filter": "distance", "zoom": 8}', 'filter-map'),
  (4, 20, 'Museums', 'report', 6, 'standard',
   'select name, city, kind, visitors, lat, lng from sample_maps.museum order by visitors desc',
   '{"hidden": ["lat", "lng"], "page_size": 20, "formats": {"visitors": "999G999G999"}}', 'filter-list'),

  -- 5 My places (the wizard's report follows at seq 10)
  (5, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The form''s <strong>Location</strong> is a location item: <em>Use my location</em> asks the browser for the device''s position and stores it as <code>latitude,longitude</code> text, which a check constraint on the column keeps in shape. The map reads the same column.</p>',
   '{}', null),
  (5, 20, 'On the map', 'map', 12, 'standard',
   'select id, name as title, note as body, location from sample_maps.place where location is not null',
   '{"link": {"page": 6, "items": {"P6_ID": "#id#"}}, "empty": "No place has a location yet."}', null)
  ) as r (page, seq, title, type, cols, template, source, config, sid);

update meta.region set config = config || jsonb_build_object('report', pg_temp.region_id('sample-maps', 4, 'filter-list'))
 where id = pg_temp.region_id('sample-maps', 4, 'filter-map');
