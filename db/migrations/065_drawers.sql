-- =====================================================================
-- 065: drawers and dialog sizes (APEX: the Drawer page template; 26.1:
-- top and bottom drawers)
--
-- A modal page opens as a centred dialog (as before) or as a drawer that
-- slides in from the left, right, top or bottom edge; dialog_size picks its
-- width (or height for top and bottom drawers). Both travel with the export
-- (meta.export_app takes every page column). An export made before 065 has
-- no such keys: meta.import_app() then inserts NULL, which the trigger turns
-- into the defaults (no need to redefine import_app, as in 053 and 054).
-- =====================================================================

alter table meta.page
  add column dialog_position text not null default 'center' check (dialog_position in ('center', 'left', 'right', 'top', 'bottom')),
  add column dialog_size text not null default 'medium' check (dialog_size in ('small', 'medium', 'large'));

create function meta.page_dialog_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.dialog_position := coalesce(new.dialog_position, 'center');
  new.dialog_size := coalesce(new.dialog_size, 'medium');
  return new;
end $$;
create trigger page_dialog_default before insert or update on meta.page
  for each row execute function meta.page_dialog_default();

comment on column meta.page.dialog_position is 'Modal pages: center (a dialog) or left, right, top, bottom (a drawer from that edge)';
comment on column meta.page.dialog_size is 'Modal pages: small, medium or large (width; height for top and bottom drawers)';
