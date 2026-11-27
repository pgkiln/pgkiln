-- =====================================================================
-- 209: button positions in the region body (sprint 259; APEX: Top of
-- Region, Bottom of Region)
--
-- meta.button.slot gains top_of_region (in the region body, above its
-- content) and bottom_of_region (in the region body, under its content),
-- e.g. a full-width "New order" button (template option to-block) above a
-- report. Older exports import unchanged.
--
-- meta.button.css_classes (APEX: Appearance → CSS Classes): class names of
-- the developer's own on the button, checked as a region's (188).
-- =====================================================================

alter table meta.button drop constraint button_slot_check;
alter table meta.button add constraint button_slot_check
  check (slot in ('create', 'edit', 'change', 'copy', 'help', 'up', 'previous', 'close', 'delete', 'next', 'region',
                  'top_of_region', 'bottom_of_region'));
comment on column meta.button.slot is 'Where a region''s button shows (099): the top bar (create, edit, change, copy, help, up), the bottom bar (previous, close, delete; next on the right), with the other buttons (region, null), or (209) in the body above or under its content (top_of_region, bottom_of_region).';

alter table meta.button add column css_classes text
  check (css_classes ~ '^\s*-?[A-Za-z_][A-Za-z0-9_-]*(\s+-?[A-Za-z_][A-Za-z0-9_-]*)*\s*$' and length(css_classes) <= 500);
comment on column meta.button.css_classes is 'CSS Classes (209): class names of the developer''s own on the button';
