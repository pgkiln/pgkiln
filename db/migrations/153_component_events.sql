-- Sprint 161 (CD-3, part 2; APEX: component events of Interactive Grid, Calendar, Map and Tree).
--
-- Events (trigger: the component's region id or static id):
--   grid_row_init         a row was added to an editable grid (Add row, Duplicate) (APEX: Row Initialization)
--   grid_save             a grid's changes were saved; runs on the page that comes back (APEX: Save)
--   calendar_date_select  an empty day or hour of a calendar was chosen; the condition sees the date
--                         (YYYY-MM-DD or YYYY-MM-DDTHH:MM); a cancel_event keeps the Create link closed
--                         (APEX: Date Select)
--   calendar_view_change  a calendar showed another view or period; the condition sees the view
--                         (month, week, day, list) (APEX: View Change)
--   map_object_click      a marker or shape of a map was clicked; the condition sees its id column (else its
--                         title) (APEX: Map Object Clicked)
--   map_change            a map was moved or zoomed; the condition sees the zoom level (APEX: Map Changed)
--   tree_selection_change a node of a tree was chosen; the condition sees its id; a cancel_event keeps its link
--                         closed (APEX: Selection Change [Tree])

alter table meta.dynamic_action drop constraint dynamic_action_event_check;
alter table meta.dynamic_action add constraint dynamic_action_event_check check (event in (
  'change', 'click', 'load', 'dialog_closed', 'after_refresh', 'selection_change', 'focus', 'blur', 'key_release', 'before_submit', 'custom', 'menu_entry',
  'double_click', 'key_down', 'key_press', 'mouse_enter', 'mouse_leave', 'select', 'resize', 'scroll', 'page_unload', 'before_refresh', 'facets_change',
  'grid_row_init', 'grid_save', 'calendar_date_select', 'calendar_view_change', 'map_object_click', 'map_change', 'tree_selection_change'));
