-- =====================================================================
-- HR example, part 43: a drawer (docs/guide/04-pages-and-regions.md,
-- "Dialogs and drawers")
--
-- Page 7 "Leave request" (a modal page, opened by "Request leave" on
-- page 6) slides in from the right edge instead of opening as a centred
-- dialog. On phones it fills the screen like any dialog.
-- =====================================================================

update meta.page set dialog_position = 'right', dialog_size = 'medium'
 where page_no = 7 and app_id = (select id from meta.app where alias = 'hr');
