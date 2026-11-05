-- Sprint 156 (CD-3, part 1; APEX: Dynamic Action events, client-side conditions and actions).
--
-- Events (besides change, click, load, …):
--   double_click     items, buttons or regions (trigger: their names / region ids or static ids)
--   key_down, key_press   a key goes down in an item / a key that types a character (trigger: item names)
--   mouse_enter, mouse_leave   the pointer enters / leaves an item, a button or a region
--   select           text is selected in an item
--   resize, scroll   the window (no trigger)
--   page_unload      the page is left (pagehide; only quick, local actions finish)
--   before_refresh   a region is about to be refreshed (trigger: region ids or static ids)
--   facets_change    a faceted search or smart filters region's facets changed (trigger: that region)
-- Client-side conditions (besides equals, not_equals, in_list, is_null, is_not_null):
--   greater, greater_equal, less, less_equal   numbers compared as numbers, ISO dates as dates, else text
--   not_in_list      not one of the comma-separated values
-- Actions (besides the 32 of 001–124):
--   cancel_event     stops the actions after it, and the event's own effect (a button's submit or link)
--   set_style        config {"styles": {"color": "#b42318", "font-weight": "bold"}} on the affected items / region
--                    (a fixed list of properties; values without url() or expressions: checked in the builder and
--                    again before they reach the page)
--   collapse_tree, expand_tree   every node of the affected tree region
--   show_ai_assistant            opens the affected AI assistant region (or its inline dialog) and focuses its input
--   trigger_geocoding            the affected geocoded address item looks its text up (its Check address button)
--   open_report_dialog           code: the dialog of the affected interactive report to open (filter, columns,
--                                sort, highlight, compute, aggregate, chart, group, pivot, break, rows, saved)

alter table meta.dynamic_action drop constraint dynamic_action_event_check;
alter table meta.dynamic_action add constraint dynamic_action_event_check check (event in (
  'change', 'click', 'load', 'dialog_closed', 'after_refresh', 'selection_change', 'focus', 'blur', 'key_release', 'before_submit', 'custom', 'menu_entry',
  'double_click', 'key_down', 'key_press', 'mouse_enter', 'mouse_leave', 'select', 'resize', 'scroll', 'page_unload', 'before_refresh', 'facets_change'));

alter table meta.dynamic_action drop constraint dynamic_action_condition_type_check;
alter table meta.dynamic_action add constraint dynamic_action_condition_type_check check (condition_type in (
  'equals', 'not_equals', 'in_list', 'is_null', 'is_not_null', 'greater', 'greater_equal', 'less', 'less_equal', 'not_in_list'));

alter table meta.dynamic_action drop constraint dynamic_action_action_check;
alter table meta.dynamic_action add constraint dynamic_action_action_check check (action in (
  'show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit', 'set_focus', 'add_class',
  'remove_class', 'show_success', 'show_error', 'clear_errors', 'ai_generate', 'execute_javascript', 'plugin', 'push_subscribe', 'confirm',
  'close_dialog', 'cancel_dialog', 'clear', 'open_region', 'close_region', 'download', 'print', 'current_position', 'share', 'wait_popup',
  'remove_wait_popup',
  'cancel_event', 'set_style', 'collapse_tree', 'expand_tree', 'show_ai_assistant', 'trigger_geocoding', 'open_report_dialog'));

alter table meta.dynamic_action add constraint dynamic_action_report_dialog_check check (
  action <> 'open_report_dialog'
  or coalesce(trim(code), '') in ('filter', 'columns', 'sort', 'highlight', 'compute', 'aggregate', 'chart', 'group', 'pivot', 'break', 'rows', 'saved'));
