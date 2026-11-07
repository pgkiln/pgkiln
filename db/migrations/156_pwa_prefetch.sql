-- Sprint 168: the whole application offline from the first visit.
--
--   pwa_prefetch_hours   with "Keep visited pages on the device" on: after a sign-in (or on the first page
--                        opened on a device) the service worker fetches every page of the navigation menu and
--                        navigation bar the user may open, and keeps them for offline use; again when the kept
--                        copies are older than this many hours. Null: only the pages the user opens.
--                        Prefetched pages run read-only on the server (routes.ts: X-Pgkiln-Prefetch).

alter table meta.app add column pwa_prefetch_hours integer
  check (pwa_prefetch_hours between 1 and 168);

comment on column meta.app.pwa_prefetch_hours is
  'PWA: fetch every navigation page for offline use after sign-in, and again after this many hours (null: off)';
