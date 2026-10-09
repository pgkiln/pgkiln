-- =====================================================================
-- 073: a static id for regions (APEX: Static ID)
--
-- Optional, unique on the page: lower case letters, digits, _ and -,
-- starting with a letter. It names the region in the directory export
-- (pages/…/regions/<seq>-<static id>.json|yaml) instead of a key derived
-- from the title, so renaming a region keeps its file, the references to it
-- and, with `pgkiln import --replace`, the users' saved reports. The page
-- renders it as data-static-id on the region, for CSS and JavaScript.
-- =====================================================================

alter table meta.region add column static_id text check (static_id ~ '^[a-z][a-z0-9_-]{0,49}$');
alter table meta.region add constraint region_static_id_unique unique (page_id, static_id);
