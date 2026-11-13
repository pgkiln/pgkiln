-- =====================================================================
-- 164: remote catalogues for the App Gallery (sprint 181, WS-8 leftover)
--
-- The App Gallery lists the apps shipped with pgkiln (examples/gallery/
-- gallery.json). APEX can also show a gallery from a remote URL. Here an
-- administrator adds the URL of a catalogue: a JSON document in the format
-- of gallery.json with starter and utility apps, each naming the URL of its
-- blueprint. pgkiln fetches the catalogue when it is added and on Refresh,
-- through the server's guarded web client (PGKILN_REST_ALLOWED_HOSTS), and
-- keeps the checked entries here; the gallery lists them next to the
-- shipped apps with the source's name.
--
-- Only blueprints: a remote catalogue can't list sample apps, which run
-- SQL as pgkiln's owner. A blueprint is fetched when a developer chooses
-- Install and opens in the blueprint review, where nothing is created
-- before the developer confirms (as with a blueprint pasted by hand).
--
-- Installation data: not exported with an application.
-- =====================================================================

create table meta.gallery_source (
  id          int generated always as identity primary key,
  name        text not null check (length(name) between 1 and 60),
  url         text not null unique check (length(url) between 9 and 2000 and url ~ '^https?://'),
  enabled     boolean not null default true,
  -- the checked entries of the last fetch that worked: {"starters": [...], "utilities": [...]}
  catalogue   jsonb not null default '{}'::jsonb check (jsonb_typeof(catalogue) = 'object'),
  fetched_at  timestamptz,
  -- why the last fetch failed (null: it worked); the previous entries stay listed
  error       text check (length(error) <= 2000),
  created_by  text,
  created_at  timestamptz not null default now()
);
revoke all on meta.gallery_source from public;
comment on table meta.gallery_source is
  'The App Gallery''s remote catalogues (164): starter and utility apps listed from a URL; installation data, not exported';
