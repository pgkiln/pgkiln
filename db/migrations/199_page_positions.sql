-- =====================================================================
-- 199: the Standard page template's other display positions
-- (sprint 234, AX-12; APEX: the page template's Slot list — After Logo,
-- Before Navigation Bar, After Navigation Bar, Top Navigation, Full Width
-- Content and Dialogs, Drawers and Popups)
--
-- meta.region.position gets six more values, next to banner, breadcrumb,
-- left, body, right and footer (099):
--   after_logo             in the header, after the application's name
--   before_navigation_bar  in the header, before the navigation bar list
--   after_navigation_bar   in the header, after the user menu
--   top_navigation         a bar under the header, over the whole width
--   full_width             under the breadcrumb bar, over the content's
--                          whole width (no side column beside it)
--   dialogs                after the footer: inline dialogs, drawers and
--                          popups that open over the page
-- The four header positions belong to the page templates with a header
-- (standard, left_side_column, right_side_column); the minimal template and
-- a modal page leave regions there out (the Advisor warns).
--
-- The column stays nullable (null is body): older exports import as before.
-- =====================================================================
alter table meta.region drop constraint region_position_check;
alter table meta.region add constraint region_position_check
  check (position in ('banner', 'after_logo', 'before_navigation_bar', 'after_navigation_bar', 'top_navigation', 'breadcrumb',
                      'full_width', 'left', 'body', 'right', 'footer', 'dialogs'));
comment on column meta.region.position is 'Where the region shows (099, 199): banner, after_logo, before_navigation_bar, after_navigation_bar, top_navigation, breadcrumb, full_width, left, body (null), right, footer or dialogs.';
