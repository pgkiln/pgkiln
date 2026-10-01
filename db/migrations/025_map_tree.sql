-- Map and tree regions (APEX: Map region, Tree region).
--   map   rows with a position (lat/lng columns or a "lat,lng" location), shown as markers on a tiled
--         map, with popups and links; GeoJSON lines and areas (src/runtime/maps.ts, Leaflet)
--   tree  rows with id, parent_id and label as an expandable hierarchy (src/runtime/tree.ts)
alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree'));
