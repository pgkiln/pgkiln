-- =====================================================================
-- 054: importing an export made before 051
--
-- meta.import_app() builds the app row with jsonb_populate_record, so a key
-- missing from an older export (debug_level, debug_retention_days: added in
-- 051) becomes an explicit NULL and the column default does not apply. As
-- 053 does for template_options, a trigger turns NULL into the default (no
-- need to redefine import_app).
-- =====================================================================

create function meta.app_debug_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.debug_level := coalesce(new.debug_level, 0);
  new.debug_retention_days := coalesce(new.debug_retention_days, 7);
  return new;
end $$;
create trigger app_debug_default before insert or update on meta.app
  for each row execute function meta.app_debug_default();
