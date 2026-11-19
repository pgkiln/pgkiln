// (sprint 202, AX-3) The names of component types in the Page Designer, in the builder's language: the tree, the
// layout, tooltips and the property editor's Type lists say Interactive Report, Select List, Popup LOV, Submit Page,
// Set Value … instead of report, select, popup_lov, submit, set_value. Region, item and button types use the App
// Gallery's names (REGION_LABELS, ITEM_LABELS, BUTTON_LABELS and their gallery.* keys, as the Pages report does);
// the other lists have their English names here and a key per value in src/builder/i18n/*.
import { BUTTON_LABELS, ITEM_LABELS, POSITION_LABELS, REGION_LABELS, SLOT_LABELS } from './arrange.ts';
import { scopedTx } from './i18n.ts';
import { COMPONENT_TYPE_LABELS } from './component-regions.ts';

/** Dynamic action actions (APEX's names where APEX has the action). */
export const DA_ACTION_LABELS: Record<string, string> = {
  show: 'Show', hide: 'Hide', enable: 'Enable', disable: 'Disable', set_value: 'Set Value', execute_sql: 'Execute Server-side Code',
  refresh_region: 'Refresh Region', refresh_item: 'Refresh Item', alert: 'Alert', submit: 'Submit Page', set_focus: 'Set Focus',
  add_class: 'Add Class', remove_class: 'Remove Class', show_success: 'Show Success Message', show_error: 'Show Error', clear_errors: 'Clear Errors',
  ai_generate: 'Generate Text with AI', execute_javascript: 'Execute JavaScript Code', plugin: 'Plug-in', push_subscribe: 'Subscribe to Push Notifications',
  confirm: 'Confirm', close_dialog: 'Close Dialog', cancel_dialog: 'Cancel Dialog', clear: 'Clear', open_region: 'Open Region', close_region: 'Close Region',
  download: 'Download', print: 'Print', current_position: 'Get Current Position', share: 'Share', wait_popup: 'Show Wait Popup',
  remove_wait_popup: 'Remove Wait Popup', cancel_event: 'Cancel Event', set_style: 'Set Style', collapse_tree: 'Collapse Tree', expand_tree: 'Expand Tree',
  show_ai_assistant: 'Show AI Assistant', trigger_geocoding: 'Trigger Geocoding', open_report_dialog: 'Open Report Dialog',
};

/** Dynamic action events. */
export const DA_EVENT_LABELS: Record<string, string> = {
  change: 'Change', click: 'Click', load: 'Page Load', dialog_closed: 'Dialog Closed', focus: 'Get Focus', blur: 'Lose Focus',
  key_release: 'Key Release', after_refresh: 'After Refresh', selection_change: 'Selection Change', before_submit: 'Before Page Submit',
  custom: 'Custom', menu_entry: 'Menu Entry Chosen', double_click: 'Double Click', key_down: 'Key Down', key_press: 'Key Press',
  mouse_enter: 'Mouse Enter', mouse_leave: 'Mouse Leave', select: 'Select', resize: 'Resize', scroll: 'Scroll', page_unload: 'Page Unload',
  before_refresh: 'Before Refresh', facets_change: 'Facets Change', grid_row_init: 'Row Initialization (Interactive Grid)', grid_save: 'Save (Interactive Grid)',
  calendar_date_select: 'Date Select (Calendar)', calendar_view_change: 'View Change (Calendar)', map_object_click: 'Map Object Clicked',
  map_change: 'Map Changed', tree_selection_change: 'Selection Change (Tree)', timer: 'Timer',
};

/** Process types. */
export const PROCESS_TYPE_LABELS: Record<string, string> = {
  sql: 'Execute Code', form_dml: 'Form - Automatic Row Processing (DML)', grid_dml: 'Interactive Grid - Automatic Row Processing (DML)',
  data_load: 'Data Loading', invoke_api: 'Invoke API', download: 'Download', chain: 'Execution Chain', workflow: 'Workflow',
  ai_generate: 'Generate Text with AI', plugin: 'Plug-in', send_push: 'Send Push Notification', send_email: 'Send E-Mail',
  send_notification: 'Send Notification', close_dialog: 'Close Dialog', clear_session_state: 'Clear Session State', reset_pagination: 'Reset Pagination',
  user_preferences: 'User Preferences', server_geocoding: 'Geocoding', print_report: 'Print Report', human_task_create: 'Human Task - Create',
  human_task_manage: 'Human Task - Manage', form_init: 'Form - Initialization',
};

/** Validation types (APEX's names). */
export const VALIDATION_TYPE_LABELS: Record<string, string> = {
  sql: 'Expression', exists: 'Rows returned', not_exists: 'No Rows returned', function_body: 'Function Body (returning Boolean)',
  function_error: 'Function Body (returning Error Text)', not_null: 'Item is NOT NULL', not_null_or_zero: 'Item is NOT NULL or zero',
  not_zero: 'Item is NOT zero', no_spaces: 'Item contains no spaces', alphanumeric: 'Item is alphanumeric', numeric: 'Item is numeric',
  valid_date: 'Item is a valid date', valid_timestamp: 'Item is a valid timestamp', equals: 'Item = Value', not_equals: 'Item != Value',
  in_list: 'Item is in Value', not_in_list: 'Item is NOT in Value', chars_only: 'Item contains only characters in Value',
  chars_any: 'Item contains at least one of the characters in Value', chars_none: 'Item contains none of the characters in Value',
  regex: 'Item matches Regular Expression',
};

/** Computation types. */
export const COMPUTATION_TYPE_LABELS: Record<string, string> = {
  static: 'Static Value', item: 'Item', sql_query: 'SQL Query (return single value)', sql_expression: 'SQL Expression', function_body: 'Function Body',
};

/** Region templates. */
export const REGION_TEMPLATE_LABELS: Record<string, string> = {
  standard: 'Standard', plain: 'Blank with Attributes', collapsible: 'Collapsible', hero: 'Hero', title_bar: 'Title Bar',
  buttons_container: 'Buttons Container', inline_dialog: 'Inline Dialog', inline_drawer: 'Inline Drawer', wizard: 'Wizard Container',
  tabs_container: 'Tabs Container', flex_container: 'Flexbox Container',
};

const first = (labels: Record<string, [string, string]>) => Object.fromEntries(Object.entries(labels).map(([k, [name]]) => [k, name]));

/** The lists with names: `<component kind>.<field>` → the key prefix and the English names. */
export const TYPE_NAME_LISTS: Record<string, readonly [string, Record<string, string>]> = {
  // (sprint 231, AX-14) and the built-in template components as types of their own (component-regions.ts)
  'region.type': ['gallery.region', first({ ...REGION_LABELS, ...COMPONENT_TYPE_LABELS })],
  'region.template': ['pd.template', REGION_TEMPLATE_LABELS],
  'region.position': ['pos', POSITION_LABELS],
  'item.type': ['gallery.item', first(ITEM_LABELS)],
  'button.action': ['gallery.button', first(BUTTON_LABELS)],
  'button.slot': ['slot', SLOT_LABELS],
  'dynamic_action.event': ['pd.da_event', DA_EVENT_LABELS],
  'dynamic_action.action': ['pd.da_action', DA_ACTION_LABELS],
  'process.type': ['pd.process_type', PROCESS_TYPE_LABELS],
  'validation.type': ['pd.validation_type', VALIDATION_TYPE_LABELS],
  'computation.type': ['pd.computation_type', COMPUTATION_TYPE_LABELS],
};

/**
 * The name of a field's value in the builder's language (the request's translator), or null when the field's values
 * have no names (an empty value has none either). `kind.field` as in TYPE_NAME_LISTS, e.g. ('item', 'type', 'popup_lov').
 */
export function optionName(kind: string, field: string, value: string | null | undefined): string | null {
  const list = TYPE_NAME_LISTS[`${kind}.${field}`];
  if (!list || !value) return null;
  return scopedTx.dyn(`${list[0]}.${value}`, list[1][value] ?? value);
}

/** A region's, item's or button's type by its name (the code itself for an unknown one, e.g. a type a newer version added). */
export const typeName = (kind: 'region' | 'item' | 'button', type: string | null | undefined) =>
  optionName(kind, kind === 'button' ? 'action' : 'type', type) ?? type ?? '';
