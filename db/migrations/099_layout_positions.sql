-- =====================================================================
-- 099: display positions, button positions and side-column page templates
-- (sprint 77; APEX: a region's Layout → Position, a button's Layout →
-- Button Position, the Left / Right Side Column page templates)
--
-- meta.region.position: where the region shows on the page: banner (above
-- everything), breadcrumb (the bar under the title), left or right (the side
-- column of a side-column page template; on other pages in the body, in
-- sequence), body (the default) or footer (after the body). Null is body.
-- meta.button.slot: where a region's button shows: create, edit, change,
-- copy, help or up (the region's top bar), previous, close or delete (the
-- bottom bar, on the left), next (the bottom bar, on the right) or region
-- (with the region's other buttons, as before). Null is region.
-- meta.page.page_template: left_side_column and right_side_column too.
--
-- The columns are nullable (older exports and imports leave them null) and
-- travel with an application's export like its other columns.
-- =====================================================================
alter table meta.region add column position text
  check (position in ('banner', 'breadcrumb', 'left', 'body', 'right', 'footer'));
comment on column meta.region.position is 'Where the region shows (099): banner, breadcrumb, left, body (null), right or footer.';

alter table meta.button add column slot text
  check (slot in ('create', 'edit', 'change', 'copy', 'help', 'up', 'previous', 'close', 'delete', 'next', 'region'));
comment on column meta.button.slot is 'Where a region''s button shows (099): the top bar (create, edit, change, copy, help, up), the bottom bar (previous, close, delete; next on the right) or with the other buttons (region, null).';

alter table meta.page drop constraint page_page_template_check;
alter table meta.page add constraint page_page_template_check
  check (page_template in ('standard', 'minimal', 'left_side_column', 'right_side_column'));
