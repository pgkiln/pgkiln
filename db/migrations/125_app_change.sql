-- =====================================================================
-- 125: who changed an application last (sprint 116, WS-12)
--
-- APEX's Applications report shows Updated By next to Updated. The builder
-- records the developer and the time of the last successful change to an
-- application (any builder POST under /builder/apps/:id or /pages/:pid,
-- except locks, comments and other actions that change nothing; and the
-- application a Create or Import made) in meta.app_change: one row per
-- application. The App Builder list shows it, with the number of working
-- copies (meta.working_copy) and the application lock (meta.builder_lock).
--
-- Builder state of this installation, like meta.builder_lock: written by the
-- builder as the owner, never read by the runtime; not part of an
-- application's export (kept by pgkiln import --replace). Not a column of
-- meta.app on purpose: export_app exports meta.app's columns.
-- =====================================================================

create table meta.app_change (
  app_id     int primary key references meta.app on delete cascade,
  updated_by text not null check (length(updated_by) between 1 and 200),
  updated_at timestamptz not null default now()
);
comment on table meta.app_change is 'builder: the developer who changed an application last, and when (App Builder list: Updated by)';
