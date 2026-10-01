-- Progressive Web Apps (APEX: Progressive Web App) for field work: an
-- application can be installed on a phone, keep working offline, and queue
-- forms submitted without a connection (src/runtime/pwa.ts, public/sw.js).

alter table meta.app
  add column pwa                boolean not null default false,
  -- the name under the icon on a home screen (the app's name when empty)
  add column pwa_short_name     text check (length(pwa_short_name) <= 30),
  -- a square PNG of at least 512 × 512 pixels; NULL: a generated tile with the app's initial
  add column pwa_icon           bytea check (length(pwa_icon) <= 1048576),
  -- keep pages the user visited, to show them offline (personal data on the device: off by default)
  add column pwa_offline_pages  boolean not null default false,
  -- keep forms submitted offline on the device and send them when the connection is back
  add column pwa_offline_submit boolean not null default false;

comment on column meta.app.pwa is 'Installable Progressive Web App (manifest, service worker)';

-- "location": a text item with a button that fills in the device's position ("52.01160,4.35710")
alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in
  ('text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch', 'hidden', 'display',
   'password', 'checkbox_group', 'multiselect', 'popup_lov', 'email', 'tel', 'url', 'color', 'file', 'location'));
