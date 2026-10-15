// The builder's own metadata: which columns of each meta table are editable
// and how. The page designer and the shared components pages are generated
// from this spec, and SQL column names only ever come from here (never from
// the request).

import { ALL_REGION_CONFIG_HELP, regionConfigHelp } from './region-help.ts';
import { searchConfigProblems } from '../runtime/search.ts';
import { objectStoreProblem } from '../objectstore.ts';
import { formatSettingsProblem } from '../runtime/format.ts';
import { scheduleProblem } from '../automations.ts';
import { ICONS, isIcon } from '../icons.ts';
import { templateProblem } from '../runtime/document.ts';
import { stepProblems } from '../workflow.ts';
import { workflowBeforeSave } from './workflows.ts';
import { handlerProblems } from '../runtime/rest.ts';
import { TEMPLATE_COMPONENT_SPEC } from './template-spec.ts';
import { REST_SOURCE_SPEC, WEB_CREDENTIAL_SPEC } from './websources.ts';
import { invokeProblems } from '../runtime/rest-sources.ts';
import { aiProblems } from '../runtime/ai.ts';
import { DATA_LOAD_DEF_SPEC } from './dataload.ts';
import { processProblems } from '../runtime/processes.ts';
import { BUTTON_OPTIONS, ITEM_OPTIONS, REGION_OPTIONS } from '../runtime/template-options.ts';
import { checkGroupMembers } from '../subscriptions.ts';

export type FieldKind =
  | 'text' | 'int' | 'bool' | 'code' | 'json' | 'select' | 'upper'
  | 'textarea' // plain multi-line text
  | 'color'    // #rrggbb
  | 'list'     // comma-separated values into a text[] column
  | 'region'   // region of the current page
  | 'authz'    // authorization scheme of the app
  | 'page'     // page of the app
  | 'nav'      // navigation entry of the app (parent)
  | 'list_name'   // list of the app (by name)
  | 'list_parent' // entry of the app's lists (parent of a list entry)
  | 'automation_name' // automation of the app (by name)
  | 'build_option' // build option of the app (NAME or !NAME)
  | 'rest_source' // REST data source of the app (by name)
  | 'secret'   // write-only: never shown; empty keeps the stored value
  | 'options'  // checkboxes from `choices` into a text[] column (unknown values dropped)
  | 'icon';

export interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  /** kind 'options': value and label of each checkbox */
  choices?: readonly { cls: string; label: string }[];
  help?: string;
  wide?: boolean;
  group?: string;
  /** shown, not editable (the form still posts it) */
  readonly?: boolean;
  /** (sprint 77) shown with the property editor's "Common" toggle on (a spec without any shows every field) */
  common?: boolean;
  /** (sprint 51) help that depends on the component being edited (wins over `help` when it gives some) */
  helpBy?: (row: any) => { text: string; url: string | null } | null;
}

export interface ComponentSpec {
  table: string;
  scope: 'page' | 'app';
  label: string;
  plural: string;
  icon: string;
  fields: Field[];
  summary: (row: any) => string;
  defaults?: Record<string, unknown>;
  /** checks the parsed values before saving; returns a message when they're not valid */
  validate?: (values: Record<string, any>) => string | null;
  /** adjusts the parsed values before they are saved (cid: the row being edited; parentId: its page or application); throws when they can't be */
  beforeSave?: (values: Record<string, unknown>, cid: string | undefined, parentId: string) => Promise<void>;
}

const AUTHZ_HELP = 'Authorization scheme; prefix with ! to negate. MUST_NOT_BE_PUBLIC_USER is built in.';
const BUILD_HELP = 'Build option (Shared Components): the component exists only while the option is included; "Not" only while it is excluded.';
const buildOption = (group?: string): Field => ({ name: 'build_option', label: 'Build option', kind: 'build_option', help: BUILD_HELP, ...(group ? { group } : {}) });

const CONDITION_TYPES = ['', 'sql', 'exists', 'not_exists', 'item_null', 'item_not_null', 'item_equals', 'item_not_equals', 'request_in'];
const CONDITION_HELP = 'sql: a boolean expression · exists / not_exists: a query · item_*: the item\'s name below · request_in: the button(s) pressed, in Value.';
const conditionFields = (group: string): Field[] => [
  { name: 'condition_type', label: 'Condition', kind: 'select', options: CONDITION_TYPES, group, help: CONDITION_HELP },
  { name: 'condition_expr', label: 'Expression / item', kind: 'code', group, help: 'e.g. :P3_STATUS = \'OPEN\' (sql) · select 1 from sales.orders where id = :P3_ID (exists) · P3_ID (item_*)' },
  { name: 'condition_value', label: 'Value', kind: 'text', group, help: 'item_equals / item_not_equals: the value · request_in: e.g. SAVE,CREATE' },
];

/** JSON "menu" field: empty means no menu (null), not {}. */
const menuBeforeSave = async (v: Record<string, unknown>) => {
  if (v.menu === '{}' || v.menu === '[]') v.menu = null;
  if (typeof v.menu === 'string' && !Array.isArray(JSON.parse(v.menu))) throw new Error('Menu entries: a JSON array, e.g. [{"label": "Details", "page": 3, "items": {"P3_ID": "&P2_ID."}}, {"label": "Archive", "request": "ARCHIVE"}]');
};
const CLASS_LIST = /^[a-z][a-z0-9_-]{0,39}( [a-z][a-z0-9_-]{0,39}){0,4}$/;

export const COMPONENTS: Record<string, ComponentSpec> = {
  // ------------------------------------------------------------ page level
  region: {
    table: 'meta.region',
    scope: 'page',
    label: 'Region',
    plural: 'Regions',
    icon: 'layers',
    summary: (r) => r.title ?? `(${r.type})`,
    defaults: { type: 'report', columns: 12, template: 'standard' },
    validate: (v) => formatSettingsProblem(v.config) ?? (v.type === 'file' ? objectStoreProblem((v.config as Record<string, unknown> | null)?.object_store) : null),
    fields: [
      { name: 'title', common: true, label: 'Title', kind: 'text', group: 'Identification' },
      { name: 'static_id', label: 'Static ID', kind: 'text', group: 'Identification',
        help: 'Optional, unique on the page: lower case letters, digits, _ and -, starting with a letter. Names the region in exported files (so renaming it keeps them) and is data-static-id on the page, for CSS and JavaScript.' },
      { name: 'type', common: true, label: 'Type', kind: 'select', options: ['report', 'grid', 'form', 'login', 'chart', 'cards', 'calendar', 'facets', 'smart_filters', 'display_selector', 'tasks', 'workflows', 'map', 'tree', 'template_component', 'list', 'static', 'dynamic', 'data_reporter', 'ai_assistant', 'plugin', 'url', 'search'], group: 'Identification' },
      { name: 'source', common: true, label: 'Source', kind: 'code', wide: true, group: 'Source',
        help: 'report/grid: a SELECT (use :ITEM binds) · chart: label column + one numeric column per series · cards: title, subtitle, body, badge, icon · calendar: start_date, end_date, title · map: lat and lng (or location "lat,lng"), title, body, geojson · tree: id, parent_id, label, icon · template_component: any SELECT (its columns are #COLUMN# in the template), or empty for one instance · dynamic: a SELECT returning HTML (escape with meta.html_escape) · static: HTML with &ITEM. substitutions · url: the page to show, https://host/path?q=&P1_ITEM. (the host is written out; items are URL-encoded) or a path on this server (/a/other/1).' },
      { name: 'rest_source', label: 'REST data source', kind: 'rest_source', group: 'Source',
        help: 'Read the rows of a REST data source (Shared Components) instead of a table: the source above is then optional SQL over them, e.g. select * from rest where price > 10. Parameters: {"rest_params": {"city": "&P1_CITY."}} in the attributes.' },
      { name: 'table_name', common: true, label: 'Table (form, grid)', kind: 'text', help: 'e.g. sales.orders', group: 'Source' },
      { name: 'pk_column', label: 'Primary key column (form, grid)', kind: 'text', group: 'Source' },
      { name: 'pk_item', label: 'Primary key item (form)', kind: 'upper', group: 'Source' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Layout' },
      { name: 'columns', common: true, label: 'Column span (1-12)', kind: 'int', group: 'Layout' },
      { name: 'template', common: true, label: 'Template', kind: 'select', options: ['standard', 'plain', 'collapsible', 'hero', 'title_bar', 'buttons_container', 'inline_dialog', 'inline_drawer', 'wizard'], group: 'Layout', help: 'hero: a large banner (title, text, {"icon":"…"} in the attributes, buttons). title_bar: title and buttons on one line. buttons_container: the buttons only. inline_dialog, inline_drawer: hidden until a dynamic action Open region (or a link to #R<id>) opens it over the page. wizard: a narrow card for one step (a list region with template wizard_progress shows the steps).' },
      { name: 'position', common: true, label: 'Position', kind: 'select', options: ['', 'banner', 'breadcrumb', 'left', 'body', 'right', 'footer'], group: 'Layout',
        help: 'Where the region shows (APEX: Layout → Position). banner: above everything else in the page; breadcrumb: in the bar under the title; left / right: in the side column of a page with template Left or Right side column (on other pages in the body); footer: after the body. Empty is body.' },
      { name: 'template_options', label: 'Template options', kind: 'options', choices: REGION_OPTIONS, group: 'Appearance',
        help: 'CSS classes from a fixed list, added to the region (APEX: Template Options). "Hide the header" applies to the standard template.' },
      { name: 'condition', common: true, label: 'Server-side condition (SQL)', kind: 'code', group: 'Security', help: 'Boolean expression; the region renders only when true.' },
      { name: 'authz', common: true, label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
      { name: 'config', label: 'Attributes (JSON)', kind: 'json', wide: true, group: 'Attributes',
        help: ALL_REGION_CONFIG_HELP, helpBy: (row: any) => regionConfigHelp(row?.type) },
    ],
  },
  item: {
    table: 'meta.item',
    scope: 'page',
    label: 'Item',
    plural: 'Items',
    icon: 'edit',
    summary: (i) => i.name,
    defaults: { type: 'text' },
    validate: (v) => formatSettingsProblem(v.config),
    fields: [
      { name: 'name', common: true, label: 'Name', kind: 'upper', help: 'Referenced in SQL as :NAME, e.g. P3_NAME', group: 'Identification' },
      { name: 'type', common: true, label: 'Type', kind: 'select', options: ['text', 'textarea', 'number', 'date', 'datetime', 'select', 'popup_lov', 'radio', 'checkbox', 'switch', 'checkbox_group', 'multiselect', 'email', 'tel', 'url', 'color', 'file', 'location', 'richtext', 'markdown', 'rating', 'combobox', 'daterange', 'qrcode', 'image', 'address', 'hidden', 'display', 'password', 'plugin'], group: 'Identification' },
      { name: 'label', common: true, label: 'Label', kind: 'text', group: 'Identification' },
      { name: 'region_id', common: true, label: 'Region', kind: 'region', group: 'Layout' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Layout' },
      { name: 'source_column', common: true, label: 'Source column (form)', kind: 'text', group: 'Source' },
      { name: 'default_value', common: true, label: 'Default value', kind: 'text', group: 'Source' },
      { name: 'lov', common: true, label: 'List of values', kind: 'code', wide: true, group: 'List of values', help: 'select display, return from … · STATIC:Yes;Y,No;N · LOV:NAME (shared) · checkbox_group/multiselect store values colon-separated: string_to_array(:P1_X, \':\')' },
      { name: 'template_options', label: 'Template options', kind: 'options', choices: ITEM_OPTIONS, group: 'Appearance',
        help: 'CSS classes from a fixed list, added to the item (APEX: Template Options).' },
      { name: 'required', common: true, label: 'Value required', kind: 'bool', group: 'Validation' },
      { name: 'help', label: 'Help text', kind: 'text', group: 'Validation' },
      { name: 'readonly_condition', label: 'Read-only condition (SQL)', kind: 'code', group: 'Security', help: 'When true the item is shown read-only and ignored on submit.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
      { name: 'config', label: 'Attributes (JSON)', kind: 'json', group: 'Attributes', help: '{"submit_on_change":true,"null_label":"- All -","cascade_parents":"P3_DEPTNO","wide":true}. {"warn_unsaved":false}: a change of this item doesn\'t count for the page\'s "Warn on unsaved changes". Lists of values read at most {"max_rows":5000} rows. File items: {"filename_column":"photo_name","mime_column":"photo_mime","size_column":"photo_size","updated_column":"photo_updated","accept":"image/*,.pdf","max_mb":2,"capture":"environment","max_px":1600} (capture opens the camera on phones; max_px makes photos smaller before upload). {"crop":"1:1"} lets the user crop a picture before upload (free, 1:1, 4:3, 3:4, 16:9, 3:2, 2:3). Several files: {"multiple":true,"max_files":5,"table":"doc.attachment","parent_column":"ticket_id","key_column":"id"} with the content column as source (one row per file). Text items: {"scan":true} adds a barcode/QR scan button where the browser can read codes. Location items hold "lat,lng" with a "Use my location" button. Rich text: sanitised HTML; markdown: Markdown text ({"rows":10}). Rating: {"max":5} stars, stored as 1..max. Combobox: free text with list-of-values suggestions, values colon-separated ({"multiple":false} for one value). Date range: "from:to" (ISO dates; split_part(:P1_X, \':\', 1)). QR code: shows the value as a QR code ({"ecc":"M","size":200,"show_value":true}). Password: {"reveal":true} adds a show/hide button. Image (display image): the value is an https URL, a path or a data:image URL; or {"sql":"select photo, photo_mime from hr.emp where id = :P3_ID"} shows the first column of the first row (a BLOB); {"alt":"Photo of &P3_NAME.","width":160,"height":160}. Address: {"coordinates_item":"P3_LOCATION","country":"nl"} (a "Check address" button where the installation has a geocoder, GEOCODER_URL; the chosen address\'s position goes into the item as "lat,lng"). Any item: {"persist":"user"} keeps its value per user across sessions (a user preference named like the item). Number and display items: {"format_mask":"999G999G990D00"} shows the number in the language\'s notation (FML999G990D00 adds the currency) and reads it back on submit. · plugin: {"plugin":"name","attributes":{"NAME":"value"}} (an item plug-in: a text field its JavaScript enhances)' },
    ],
  },
  button: {
    table: 'meta.button',
    scope: 'page',
    label: 'Button',
    plural: 'Buttons',
    icon: 'play',
    summary: (b) => b.name,
    defaults: { action: 'submit' },
    beforeSave: menuBeforeSave,
    fields: [
      { name: 'name', common: true, label: 'Name (request)', kind: 'upper', group: 'Identification' },
      { name: 'label', common: true, label: 'Label', kind: 'text', group: 'Identification' },
      { name: 'action', common: true, label: 'Action', kind: 'select', options: ['submit', 'redirect', 'da', 'document', 'menu'], group: 'Behaviour', help: 'menu = a menu of links and submit requests (Menu entries) · da = "Defined by dynamic action"; document = download a document template (filled with the page\'s values as last loaded or saved)' },
      { name: 'document', label: 'Document template (action document)', kind: 'upper', group: 'Behaviour', help: 'The name of a document template or a report query (Shared Components → Document templates, Report queries).' },
      { name: 'target_page', common: true, label: 'Target / branch page', kind: 'page', group: 'Behaviour' },
      { name: 'target_items', label: 'Set items (JSON)', kind: 'json', group: 'Behaviour', help: '{"P3_ID": "&P2_ID."}' },
      { name: 'confirm', label: 'Confirm message', kind: 'text', group: 'Behaviour' },
      { name: 'menu', label: 'Menu entries (action menu, JSON)', kind: 'json', wide: true, group: 'Behaviour',
        help: '[{"label": "Details", "page": 3, "items": {"P3_ID": "&P2_ID."}}, {"label": "Archive", "request": "ARCHIVE", "confirm": "Archive it?", "authz": "ADMIN", "icon": "inbox"}] — a link to a page, or a submit with that request (processes and branches see it as the button pressed). At most 20.' },
      { name: 'hot', common: true, label: 'Primary (hot) button', kind: 'bool', group: 'Appearance' },
      { name: 'template_options', label: 'Template options', kind: 'options', choices: BUTTON_OPTIONS, group: 'Appearance',
        help: 'CSS classes from a fixed list, added to the button (APEX: Template Options).' },
      { name: 'badge', label: 'Badge', kind: 'text', group: 'Appearance', help: 'A short value shown on the button, e.g. &P2_OPEN_COUNT. (empty value: no badge).' },
      { name: 'badge_query', label: 'Badge (SQL)', kind: 'code', group: 'Appearance', help: 'Instead: a SELECT whose first value is the badge, e.g. select count(*) from sales.orders where status = \'OPEN\'. Runs as the application\'s role.' },
      { name: 'region_id', common: true, label: 'Region', kind: 'region', group: 'Layout' },
      { name: 'slot', common: true, label: 'Button position', kind: 'select', options: ['', 'region', 'create', 'edit', 'change', 'copy', 'help', 'up', 'previous', 'close', 'delete', 'next'], group: 'Layout',
        help: 'A region button\'s place (APEX: Button Position): create, edit, change, copy, help and up in the region\'s header; previous, close and delete at the left of its bottom bar, next at the right. Empty or region: with its other buttons (the header of reports and charts, the bottom of forms and static content).' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Layout' },
      { name: 'condition', label: 'Server-side condition (SQL)', kind: 'code', group: 'Security', help: 'e.g. :P3_ID is not null — also re-checked when the button is pressed.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
    ],
  },
  dynamic_action: {
    table: 'meta.dynamic_action',
    scope: 'page',
    label: 'Dynamic action',
    plural: 'Dynamic actions',
    icon: 'bolt',
    summary: (d) => d.name,
    defaults: { event: 'change', action: 'show' },
    validate: (v) =>
      v.css_classes && !CLASS_LIST.test(String(v.css_classes))
        ? 'CSS classes: up to five names of lower case letters, digits, - and _, separated by spaces.'
        : v.action === 'execute_javascript' && !/^[A-Za-z_$][\w$.-]{0,99}$/.test(String(v.code ?? '').trim())
          ? 'Execute JavaScript: Code is the name of a function a static file registers with pgkiln.actions.register(name, fn), e.g. highlightLate.'
          : null,
    fields: [
      { name: 'name', label: 'Name', kind: 'text', group: 'When' },
      { name: 'event', label: 'Event', kind: 'select', options: ['change', 'click', 'load', 'dialog_closed', 'focus', 'blur', 'key_release', 'after_refresh', 'selection_change', 'before_submit', 'custom'], group: 'When',
        help: 'dialog_closed: a modal dialog opened from this page was submitted and closed (instead of reloading the page), e.g. refresh a region. focus / blur / key_release: an item gets or loses the focus, a key is released in it. after_refresh: a region was refreshed or loaded. selection_change: rows were selected in a report (row selection) or a grid\'s master row. before_submit: the page is about to be submitted (a declined confirm keeps it). custom: JavaScript raised it with pgkiln.trigger(\'NAME\', value). The actions of one event and trigger run in sequence order; a declined confirm stops the ones after it.' },
      { name: 'trigger_element', label: 'Item(s) / button / region / page / event', kind: 'upper', group: 'When', help: 'Comma separated: item names (change, focus, blur, key_release), a button name (click), region ids or static ids (after_refresh, selection_change), dialog page numbers (dialog_closed; empty: any dialog), event names (custom). Empty for load and before_submit.' },
      { name: 'condition_type', label: 'Client-side condition', kind: 'select', options: ['', 'equals', 'not_equals', 'in_list', 'is_null', 'is_not_null'], group: 'When' },
      { name: 'condition_value', label: 'Condition value', kind: 'text', group: 'When' },
      { name: 'action', label: 'Action', kind: 'select', options: ['show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit', 'set_focus', 'add_class', 'remove_class', 'show_success', 'show_error', 'clear_errors', 'ai_generate', 'execute_javascript', 'plugin', 'push_subscribe', 'confirm', 'close_dialog', 'cancel_dialog', 'clear', 'open_region', 'close_region', 'download', 'print', 'current_position', 'share'], group: 'Action',
        help: 'show/hide/enable/disable reverse automatically when the condition is false. set_focus: the first affected item (or the region). show_error: on the affected items, or at the top. clear_errors: of the affected items, or all. ai_generate: runs the "Generate text with AI" process named in Code through AJAX, without submitting the page (on a submit button, the button submits instead when JavaScript is off). execute_javascript: calls the function named in Code, registered by a static application file (Shared Components → Static Application Files). push_subscribe: turns on push notifications on the user\'s device (use it on click: browsers ask only after one; the app needs push notifications on in Settings → Progressive Web App); Message is shown when it worked. confirm: asks Message; No stops the actions after it. close_dialog / cancel_dialog: close the modal page this runs on (close_dialog refreshes the page below and runs its dialog_closed actions). clear: empties the affected items. open_region / close_region: a collapsible region opens or closes (another region shows or hides). download: the file of the download process named in Code (Items to submit are sent first). print: the browser\'s print dialog. current_position: the device\'s position as latitude,longitude into the first affected item. share: the device\'s share sheet for this page (Message as the text), or the link copied.' },
      { name: 'affected_items', label: 'Affected items', kind: 'upper', group: 'Action' },
      { name: 'affected_region_id', label: 'Affected region', kind: 'region', group: 'Action' },
      { name: 'code', label: 'SQL', kind: 'code', wide: true, group: 'Action', help: 'set_value: a SELECT whose columns set the affected items · execute_sql: any SQL; returned columns named like items set them · ai_generate: the name of an ai_generate process on this page (its output items are updated; items to submit default to the items its prompts use) · execute_javascript: the name of a function registered with pgkiln.actions.register(name, fn) in a static file the page loads.' },
      { name: 'items_to_submit', label: 'Items to submit', kind: 'upper', group: 'Action' },
      { name: 'message', label: 'Message (alert, show_success, show_error)', kind: 'text', group: 'Action' },
      { name: 'config', label: 'Plug-in attributes (JSON)', kind: 'json', group: 'Action', help: 'plugin: {"attributes": {"NAME": "value or &ITEM."}} (Shared Components → Plug-ins lists each plug-in\'s attributes).' },
      { name: 'css_classes', label: 'CSS classes (add_class, remove_class)', kind: 'text', group: 'Action', help: 'Up to five class names, e.g. is-highlight is-muted (lower case letters, digits, - and _).' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Security' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
    ],
  },
  validation: {
    table: 'meta.validation',
    scope: 'page',
    label: 'Validation',
    plural: 'Validations',
    icon: 'check',
    summary: (v) => v.name,
    defaults: { type: 'sql' },
    fields: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'type', label: 'Type', kind: 'select', options: ['sql', 'not_null', 'regex'] },
      { name: 'item_name', label: 'Associated item', kind: 'upper' },
      { name: 'expression', label: 'Expression', kind: 'code', wide: true, help: 'sql: boolean expression that must be true · regex: POSIX pattern' },
      { name: 'message', label: 'Error message', kind: 'text' },
      { name: 'when_button', label: 'When button pressed', kind: 'upper' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      buildOption(),
    ],
  },
  process: {
    table: 'meta.process',
    scope: 'page',
    label: 'Process',
    plural: 'Processes',
    icon: 'code',
    summary: (p) => p.name,
    defaults: { type: 'sql', point: 'submit' },
    validate: (v) => {
      const conf = typeof v.config === 'string' ? JSON.parse(v.config || '{}') : v.config;
      const problems = v.type === 'invoke_api' ? invokeProblems(conf) : v.type === 'ai_generate' ? aiProblems(conf) : processProblems(String(v.type), conf);
      if (v.type === 'download' && !String(v.code ?? '').trim()) problems.push('A download process needs a query in Code.');
      return problems.length ? problems.join(' ') : null;
    },
    fields: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'type', label: 'Type', kind: 'select', options: ['sql', 'form_dml', 'grid_dml', 'data_load', 'invoke_api', 'download', 'chain', 'workflow', 'ai_generate', 'plugin', 'send_push', 'send_email'],
        help: 'download: a file from the query in Code · chain: runs the processes that name it as their chain, in sequence (optionally in the background) · workflow: start, terminate or retry a workflow · ai_generate: Generate text with AI (an AI service the application may use) · send_push: a push notification to a user\'s devices (Settings → Progressive Web App → push notifications)' },
      { name: 'point', label: 'Point', kind: 'select', options: ['submit', 'load', 'ajax'], help: 'A chain\'s processes run when the chain does (their own point is not used). ajax: an Ajax callback (APEX: On Demand) that JavaScript calls by name with pgkiln.server.process(\'NAME\', {items: [\'P1_X\'], x01: …}); SQL processes only; the last statement\'s rows come back as JSON, and the items it sets are set on the page.' },
      { name: 'parent_process', label: 'Chain (parent process)', kind: 'text', help: 'The name of a chain process on this page: this process then runs only inside that chain, in its sequence.' },
      { name: 'code', label: 'Code (SQL / PL/pgSQL call)', kind: 'code', wide: true,
        help: 'e.g. select sales.ship_order(:P3_ID::int) as p3_status — returned columns named like items set them. RAISE EXCEPTION messages are shown to the user; USING COLUMN = \'sal\' puts it on that field. · download: a query returning the file\'s content (bytea or text), file name and MIME type, e.g. select content, filename, mime_type from docs.file where id = :P5_ID::int — several rows are sent as one zip file.' },
      { name: 'region_id', label: 'Form / grid region (form_dml, grid_dml)', kind: 'region' },
      { name: 'config', label: 'Configuration (data_load, invoke_api, download, chain, workflow, ai_generate, plugin, send_push, send_email)', kind: 'json', wide: true,
        help: 'data_load: {"file_item":"P5_FILE","definition":"ORDERS_LOAD"} (a data load definition: table, format, mapping, transformations) or {"file_item":"P5_FILE","table":"sales.orders","mode":"append | merge | replace","skip_errors":false,"headers":true,"format":"auto | csv | xlsx | json | xml","row_tag":"order","columns":{"Heading in file":"column"}} — runs as the app\'s database role; columns match by name unless mapped. · invoke_api: {"source":"WEATHER","params":{"city":"&P5_CITY."},"items":{"P5_TEMP":"current.temp"},"status_item":"P5_STATUS"} or {"url":"https://api.example.com/orders/&P5_ID.","method":"POST","credential":"SHOP_API","body":"{\\"note\\": &P5_NOTE.}","items":{…}} — without "items", the first row\'s columns set the items named like them. · download: {"content_column":"content","filename_column":"filename","mime_column":"mime_type","zip_name":"files-&P5_ID..zip","disposition":"attachment | inline"} (all optional; default: the first three columns). Or {"export":"csv | json | xml | html | xlsx | pdf","file_name":"orders-&P5_ID.","title":"Orders","layout":"A4_LANDSCAPE","separator":";"}: the query\'s rows as one file (APEX_DATA_EXPORT; meta.data_export does csv, json, xml and html from SQL). · chain: {"background": true, "status_item": "P5_JOB_ID"} runs it after the submit, on the server (status in meta.process_jobs). · workflow: {"action":"start","definition":"APPROVAL","version":"2","detail_pk":"&P5_ID.","variables":{"AMOUNT":"&P5_AMOUNT."},"id_item":"P5_WORKFLOW_ID"} or {"action":"terminate | retry","instance":"&P5_WORKFLOW_ID.","comment":"…"} · send_push: {"to":"&P5_OWNER.","title":"Order &P5_ID. needs approval","body":"…","page":5,"items":{"P5_ID":"&P5_ID."},"tag":"order-&P5_ID.","urgency":"normal | high | low | very-low"} — to the user\'s devices that turned notifications on; the link is signed for that user · ai_generate: {"service":"CLAUDE","system":"You write short, friendly summaries.","prompt":"Summarise: &P5_NOTES.","output_item":"P5_SUMMARY"} (text), {"service":…,"prompt":"Extract the contact from: &P5_TEXT.","output_items":["P5_NAME","P5_EMAIL"]} (structured: a JSON schema built from the items, their labels describe the fields) or {"service":…,"prompt":…,"schema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"items":{"P5_NAME":"name"}} (your schema; items map to properties or paths); optional "max_tokens", "error_message". &ITEM. values are sent as delimited data, never as instructions. · plugin: {"plugin":"name","attributes":{"NAME":"value or &ITEM."}} (a process plug-in: its function returns the message) · send_email: {"to":"&P5_EMAIL.","cc":"…","bcc":"…","from":"…","reply_to":"…","subject":"Order &P5_ID.","body":"plain text","body_html":"<p>HTML (item values escaped)</p>"} or {"to":"&P5_EMAIL.","template":"ORDER_SHIPPED","placeholders":{"NAME":"&P5_NAME."}}; "attachments":"select content, filename, mime from sales.invoice where order_id = :P5_ID" — queued in the page\'s transaction, sent after the commit through the application\'s mail service' },
      { name: 'when_button', label: 'When button pressed', kind: 'upper' },
      ...conditionFields('Condition'),
      { name: 'success_message', label: 'Success message', kind: 'text' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      { name: 'authz', label: 'Authorization', kind: 'authz', help: AUTHZ_HELP },
      buildOption(),
    ],
  },
  computation: {
    table: 'meta.computation',
    scope: 'page',
    label: 'Computation',
    plural: 'Computations',
    icon: 'activity',
    summary: (c) => `${c.item_name} (${c.type})`,
    defaults: { point: 'before_header', type: 'static' },
    fields: [
      { name: 'item_name', label: 'Item', kind: 'upper', group: 'Identification', help: 'A page item or an application item, e.g. P3_TOTAL' },
      { name: 'point', label: 'Point', kind: 'select', options: ['before_header', 'after_submit'], group: 'Identification', help: 'before_header: when the page is shown (after the form fetch) · after_submit: after a submit, before the validations' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Identification' },
      { name: 'type', label: 'Type', kind: 'select', options: ['static', 'item', 'sql_query', 'sql_expression', 'function_body'], group: 'Computation' },
      { name: 'expression', label: 'Expression', kind: 'code', wide: true, group: 'Computation',
        help: 'static: a value, &ITEM. allowed · item: an item name · sql_query: a SELECT (first column of the first row) · sql_expression: e.g. :P3_PRICE::numeric * :P3_QTY::int · function_body: PL/pgSQL, e.g. begin return upper(:P3_NAME); end. Runs as the application\'s role.' },
      ...conditionFields('Condition'),
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
    ],
  },
  branch: {
    table: 'meta.branch',
    scope: 'page',
    label: 'Branch',
    plural: 'Branches',
    icon: 'chevron',
    summary: (b) => b.name,
    defaults: { point: 'after_processing', target_type: 'page' },
    fields: [
      { name: 'name', label: 'Name', kind: 'text', group: 'Identification' },
      { name: 'point', label: 'Point', kind: 'select', options: ['after_processing', 'before_header'], group: 'Identification', help: 'after_processing: after a submit\'s processes · before_header: before the page is shown (a branch to the page itself is ignored)' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Identification', help: 'The first branch whose button and condition match is taken; without one, the button\'s target page.' },
      { name: 'when_button', label: 'When button pressed', kind: 'upper', group: 'Identification', help: 'after_processing only; empty = any button' },
      { name: 'target_type', label: 'Target', kind: 'select', options: ['page', 'url', 'function', 'app'], group: 'Target',
        help: 'page: a page of this application · url: a path inside it · function: a PL/pgSQL body returning such a path · app: a page of another application of this installation' },
      { name: 'target_app', label: 'Application (app)', kind: 'text', group: 'Target', help: 'The alias of another application; its own sign-in and authorization apply. The page is the target page there.' },
      { name: 'target_page', label: 'Page', kind: 'int', group: 'Target', help: 'Empty: this page. For app: the page number in that application.' },
      { name: 'target_items', label: 'Set items (JSON)', kind: 'json', group: 'Target', help: '{"P3_ID": "&P2_ID."} — sent with a checksum.' },
      { name: 'target_url', label: 'URL (inside the application)', kind: 'text', group: 'Target', help: 'A path after /a/<alias>/, e.g. 10?tab=open or account; &ITEM. values are URL-encoded. No other sites.' },
      { name: 'target_function', label: 'Function returning a URL (function)', kind: 'code', wide: true, group: 'Target',
        help: 'PL/pgSQL, run as the application\'s role, e.g. begin if :P3_TOTAL::numeric > 1000 then return \'20?P20_ID=\' || :P3_ID; end if; return \'10\'; end — a path inside the application as for URL (checked the same way); null: the next branch.' },
      ...conditionFields('Condition'),
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
    ],
  },

  // ------------------------------------------------------------ shared components (app level)
  nav_entry: {
    table: 'meta.nav_entry',
    scope: 'app',
    label: 'Navigation entry',
    plural: 'Navigation menu',
    icon: 'list',
    summary: (n) => n.label,
    fields: [
      { name: 'label', label: 'Label', kind: 'text' },
      { name: 'icon', label: 'Icon', kind: 'icon' },
      { name: 'target_page', label: 'Target page', kind: 'page', help: 'Leave empty for a parent entry with children.' },
      { name: 'parent_id', label: 'Parent entry', kind: 'nav' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      { name: 'authz', label: 'Authorization', kind: 'authz', help: AUTHZ_HELP },
      buildOption(),
    ],
  },
  list: {
    table: 'meta.list',
    scope: 'app',
    label: 'List',
    plural: 'Lists',
    icon: 'list',
    summary: (l) => l.name,
    defaults: { type: 'static' },
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', help: 'Show it with a list region ({"list": "NAME"}), or as the navigation menu or bar (Settings).' },
      { name: 'type', label: 'Type', kind: 'select', options: ['static', 'sql'], help: 'static: the list entries below · sql: the rows of the query.' },
      { name: 'query', label: 'Query (sql)', kind: 'code', wide: true,
        help: 'select label, page, items, url, icon, badge, description, id, parent_id from … (only label is required). page: a page of this app; items: a JSON object of item values (sent with a checksum); url: a path inside the app or an http(s) address; parent_id nests a row under the row with that id. Runs as the application\'s role with :ITEM binds.' },
      { name: 'description', label: 'Description', kind: 'textarea' },
    ],
    validate: (v) => (v.type === 'sql' && !v.query ? 'A sql list needs a query.' : null),
  },
  list_entry: {
    table: 'meta.list_entry',
    scope: 'app',
    label: 'List entry',
    plural: 'List entries',
    icon: 'chevron',
    summary: (e) => `${e.list_name}: ${e.label}`,
    fields: [
      { name: 'list_name', label: 'List', kind: 'list_name', group: 'Entry' },
      { name: 'label', label: 'Label', kind: 'text', group: 'Entry', help: '&ITEM. allowed.' },
      { name: 'icon', label: 'Icon', kind: 'icon', group: 'Entry' },
      { name: 'parent_id', label: 'Parent entry', kind: 'list_parent', group: 'Entry', help: 'An entry of the same list: this entry is shown below it (a sub menu).' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Entry' },
      { name: 'badge', label: 'Badge', kind: 'text', group: 'Entry', help: 'A short text or number, &ITEM. allowed (e.g. &P1_OPEN_COUNT.).' },
      { name: 'description', label: 'Description', kind: 'textarea', group: 'Entry', help: 'Shown by the cards template.' },
      { name: 'target_page', label: 'Page', kind: 'page', group: 'Target', help: 'Empty with no URL: a heading for its child entries.' },
      { name: 'target_items', label: 'Set items (JSON)', kind: 'json', group: 'Target', help: '{"P3_ID": "&P1_ID."} — sent with a checksum.' },
      { name: 'target_url', label: 'Or URL', kind: 'text', group: 'Target', help: 'A path after /a/<alias>/ (e.g. 10?tab=open), or an http(s) address of another site. &ITEM. values are URL-encoded.' },
      { name: 'condition', label: 'Server-side condition (SQL)', kind: 'code', group: 'Security', help: 'Boolean expression; the entry shows only when true.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
    ],
    validate: (v) => (v.target_page && v.target_url ? 'Choose a page or a URL, not both.' : null),
  },
  supporting_script: {
    table: 'meta.supporting_script',
    scope: 'app',
    label: 'Supporting script',
    plural: 'Supporting objects',
    icon: 'code',
    summary: (s) => s.name,
    defaults: { kind: 'install' },
    fields: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'kind', label: 'Kind', kind: 'select', options: ['install', 'upgrade', 'deinstall'], help: 'Scripts of a kind run together, by sequence, when a developer chooses to (Supporting objects page). Never on import.' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      { name: 'script', label: 'Script', kind: 'code', wide: true, help: 'SQL statements separated by semicolons (DDL, inserts, DO blocks). They run as the application\'s database role, in one transaction: an error undoes the whole run.' },
    ],
  },
  authz_scheme: {
    table: 'meta.authz_scheme',
    scope: 'app',
    label: 'Authorization scheme',
    plural: 'Authorization schemes',
    icon: 'shield',
    summary: (a) => a.name,
    defaults: { type: 'role' },
    fields: [
      { name: 'name', label: 'Name', kind: 'upper' },
      { name: 'type', label: 'Type', kind: 'select', options: ['role', 'sql'] },
      { name: 'value', label: 'Role name / SQL expression', kind: 'code', wide: true, help: "role: e.g. admin · sql: e.g. meta.has_role('manager') or :APP_USER = 'boss'" },
      { name: 'error_message', label: 'Error message', kind: 'text', wide: true },
    ],
  },
  lov: {
    table: 'meta.lov',
    scope: 'app',
    label: 'List of values',
    plural: 'Lists of values',
    icon: 'list',
    summary: (l) => l.name,
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', help: 'Use it in items and grid columns as LOV:NAME' },
      { name: 'query', label: 'Query', kind: 'code', wide: true, help: 'select display_value, return_value from … (STATIC: lists work too). With a REST data source: select name, code from rest' },
      { name: 'rest_source', label: 'REST data source', kind: 'rest_source', help: 'The query reads the source\'s rows from "rest".' },
    ],
  },
  app_item: {
    table: 'meta.app_item',
    scope: 'app',
    label: 'Application item',
    plural: 'Application items',
    icon: 'key',
    summary: (i) => i.name,
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', help: 'e.g. AI_CUSTOMER_ID; only server-side code can set it.' },
      { name: 'description', label: 'Description', kind: 'text', wide: true },
    ],
  },
  app_process: {
    table: 'meta.app_process',
    scope: 'app',
    label: 'Application process',
    plural: 'Application processes',
    icon: 'code',
    summary: (p) => p.name,
    defaults: { point: 'after_login' },
    fields: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'point', label: 'Point', kind: 'select', options: ['after_login', 'before_page', 'ajax'], help: 'ajax: an Ajax callback every page can call with pgkiln.server.process(\'NAME\') (a page\'s own ajax process of that name wins).' },
      { name: 'code', label: 'Code (SQL)', kind: 'code', wide: true, help: 'Returned columns named like application items set them, e.g. select id as ai_customer_id from sales.customer where lower(username) = lower(:APP_USER)' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      { name: 'authz', label: 'Authorization', kind: 'authz', help: AUTHZ_HELP },
      buildOption(),
    ],
  },
  // (102) application computations (APEX: Shared Components → Application Computations)
  app_computation: {
    table: 'meta.app_computation',
    scope: 'app',
    label: 'Application computation',
    plural: 'Application computations',
    icon: 'activity',
    summary: (c) => `${c.item_name} (${c.point}, ${c.type})`,
    defaults: { point: 'before_header', type: 'static' },
    fields: [
      { name: 'item_name', label: 'Item', kind: 'upper', group: 'Identification', help: 'An application item, e.g. AI_REGION (a page item is computed on its own page only)' },
      { name: 'point', label: 'Point', kind: 'select', options: ['after_authentication', 'before_header', 'after_submit'], group: 'Identification',
        help: 'after_authentication: once, when a user signs in · before_header: every page shown, before the page\'s own computations · after_submit: every page submitted, before the page\'s own computations' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Identification' },
      { name: 'type', label: 'Type', kind: 'select', options: ['static', 'item', 'sql_query', 'sql_expression', 'function_body'], group: 'Computation' },
      { name: 'expression', label: 'Expression', kind: 'code', wide: true, group: 'Computation',
        help: 'static: a value, &ITEM. allowed · item: an item name · sql_query: a SELECT (first column of the first row), e.g. select region from sales.rep where lower(username) = lower(:APP_USER) · sql_expression · function_body: PL/pgSQL. Runs as the application\'s role.' },
      ...conditionFields('Condition'),
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      buildOption('Security'),
      { name: 'comments', label: 'Comments', kind: 'textarea', wide: true, group: 'Comments' },
    ],
  },
  // (105) component groups (APEX: Shared Components → Component Groups)
  component_group: {
    table: 'meta.component_group',
    scope: 'app',
    label: 'Component group',
    plural: 'Component groups',
    icon: 'layers',
    summary: (g) => `${g.name} (${(g.members ?? []).length})`,
    defaults: {},
    beforeSave: async (v, _cid, appId) => {
      const { members, problems } = await checkGroupMembers(Number(appId), (v.members as string[] | null) ?? []);
      if (problems.length) throw new Error(problems.join(' '));
      v.members = members;
    },
    fields: [
      { name: 'name', label: 'Name', kind: 'text', help: 'e.g. Sales lookups. Other applications subscribe to all of its components at once (Subscriptions), when this is a library or theme application.' },
      { name: 'description', label: 'Description', kind: 'text', wide: true },
      { name: 'members', label: 'Components', kind: 'list', wide: true,
        help: 'Comma separated kind:name, e.g. lov:JOBS, authz_scheme:MANAGER, build_option:FEATURE_EXPORT, template_component:status_badge, list:SHORTCUTS.' },
    ],
  },
  // (103) shortcuts (APEX: Shared Components → Shortcuts)
  shortcut: {
    table: 'meta.shortcut',
    scope: 'app',
    label: 'Shortcut',
    plural: 'Shortcuts',
    icon: 'link',
    summary: (s) => `"${s.name}" (${s.type})`,
    defaults: { type: 'text' },
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', help: 'e.g. DELETE_CONFIRM_MSG: "DELETE_CONFIRM_MSG" (in double quotes) in a static region\'s content, an item\'s help text or a button\'s confirm message is replaced by the shortcut.' },
      { name: 'type', label: 'Type', kind: 'select', options: ['text', 'html', 'function_body'], help: 'text: the value (escaped in HTML) · html: the value as HTML · function_body: PL/pgSQL that returns the text, e.g. begin return \'Signed in as \' || :APP_USER; end. Runs as the application\'s role, once per request.' },
      { name: 'value', label: 'Value', kind: 'code', wide: true },
      { name: 'comments', label: 'Comments', kind: 'textarea', wide: true },
    ],
  },
  page_group: {
    table: 'meta.page_group',
    scope: 'app',
    label: 'Page group',
    plural: 'Page groups',
    icon: 'layers',
    summary: (o) => o.name,
    defaults: {},
    fields: [
      { name: 'name', label: 'Name', kind: 'text', help: 'e.g. Administration. Pages join it in their Page group property; renaming the group renames it on its pages.' },
      { name: 'description', label: 'Description', kind: 'text', wide: true },
    ],
  },
  build_option: {
    table: 'meta.build_option',
    scope: 'app',
    label: 'Build option',
    plural: 'Build options',
    icon: 'settings',
    summary: (o) => `${o.name} (${o.status})`,
    defaults: { status: 'include' },
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', help: 'e.g. FEATURE_EXPORT; components name it in their Build option property.' },
      { name: 'status', label: 'Status', kind: 'select', options: ['include', 'exclude'], help: 'exclude: every component with this option is left out of the running application (and those with "Not" are included).' },
      { name: 'description', label: 'Description', kind: 'text', wide: true },
    ],
  },
  rest_module: {
    table: 'meta.rest_module',
    scope: 'app',
    label: 'REST module',
    plural: 'REST modules',
    icon: 'code',
    summary: (d) => d.name,
    defaults: {
      enabled: true,
      handlers: [
        { method: 'GET', path: 'items', type: 'collection', source: 'select 1 as id, current_user as db_role' },
        { method: 'GET', path: 'items/:id', type: 'item', source: 'select :ID as id' },
      ],
    },
    validate: (v) => {
      // parseFields gives the JSON as text
      const problems = handlerProblems(typeof v.handlers === 'string' ? JSON.parse(v.handlers) : v.handlers);
      return problems.length ? problems.join(' ') : null;
    },
    fields: [
      { name: 'name', label: 'Name (in the URL)', kind: 'text', group: 'Identification', help: 'lowercase; served under /a/<alias>/rest/<name>/' },
      { name: 'title', label: 'Title', kind: 'text', group: 'Identification', help: 'The title of the OpenAPI description.' },
      { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
      { name: 'enabled', label: 'Enabled', kind: 'bool', group: 'Identification' },
      { name: 'handlers', label: 'Handlers (JSON)', kind: 'json', wide: true, group: 'Handlers',
        help: '[{"method": "GET", "path": "orders", "type": "collection", "source": "select id, customer, total from sales.orders order by id"}, {"method": "GET", "path": "orders/:id", "type": "item", "source": "select * from sales.orders where id = :ID::int"}, {"method": "POST", "path": "orders", "type": "sql", "source": "select sales.create_order(:CUSTOMER, :TOTAL::numeric) as id", "roles": ["sales"]}] · type: collection (paged: ?limit, ?offset), item (404 when no row), sql (the first row of the last statement). Binds: path parameters, query parameters and JSON body fields, upper case; :BODY is the whole body. "auth": "public" for endpoints without a token. The SQL runs as the application\'s role, with meta.app_user() the caller.' },
    ],
  },
  workflow_definition: {
    table: 'meta.workflow_definition',
    scope: 'app',
    label: 'Workflow',
    plural: 'Workflows',
    icon: 'layers',
    summary: (d) => d.name,
    defaults: {
      title: 'Request &DETAIL_PK.',
      steps: [
        { name: 'APPROVE', type: 'task', task: 'MY_APPROVAL', next: { approved: 'DONE', rejected: 'END' } },
        { name: 'DONE', type: 'sql', code: 'select 1' },
        { name: 'END', type: 'end' },
      ],
    },
    validate: (v) => {
      // parseFields gives the JSON as text
      const problems = stepProblems(typeof v.steps === 'string' ? JSON.parse(v.steps) : v.steps);
      return problems.length ? problems.join(' ') : null;
    },
    beforeSave: workflowBeforeSave,
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: "Application SQL starts it with meta.start_workflow('NAME', :P1_ID, '{\"AMOUNT\": 100}')." },
      { name: 'title', label: 'Title', kind: 'text', wide: true, group: 'Identification', help: '&VAR. is replaced by a variable given at the start (and &DETAIL_PK.), e.g. Onboarding of &NAME.' },
      { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
      { name: 'admin_role', label: 'Administrator (role)', kind: 'text', group: 'Identification', help: 'Sees every instance, terminates them and retries a failed step.' },
      { name: 'steps', label: 'Steps (JSON)', kind: 'json', wide: true, group: 'Steps',
        help: '[{"name": "CHECK", "type": "switch", "cases": [{"when": ":AMOUNT::numeric > 1000", "next": "DIRECTOR"}], "otherwise": "MANAGER"}, {"name": "MANAGER", "type": "task", "task": "EXPENSE_APPROVAL", "owners": "select manager from staff where id = :DETAIL_PK::int", "next": {"approved": "PAY", "rejected": "END"}}, {"name": "PAY", "type": "sql", "code": "select expenses.pay(:DETAIL_PK::int) as paid_on"}, {"name": "PAUSE", "type": "wait", "for": "2 days"}, {"name": "END", "type": "end"}] · "next" is optional (the following step). Invoke API: {"name": "RATE", "type": "invoke_api", "source": "EXCHANGE", "params": {"currency": "&CURRENCY."}, "variables": {"RATE": "rates.EUR"}, "status_variable": "HTTP_STATUS", "timeout": 20} calls a REST data source (with its web credential), or {"url": "https://api.example.com/orders/&ORDER_ID.", "method": "POST", "credential": "SHOP_API", "body": "{\\"note\\": &NOTE.}", "response_variable": "ORDER"}; &VAR. is a variable; "variables" maps variables to JSON paths in the response (without it, the first row\'s columns of the source); with "status_variable" an error status doesn\'t fail the step. Parallel branches: {"name": "SPLIT", "type": "parallel", "branches": ["BOOK", "NOTIFY"], "join": "BOTH"} runs the branches side by side until each reaches the join {"name": "BOTH", "type": "join", "wait_for": "all"} ("any": the first one, the others are cancelled). Binds: the variables, :DETAIL_PK, :WORKFLOW_ID, :INITIATOR, and after a task :TASK_OUTCOME and :TASK_APPROVER. Columns that sql steps return become variables.' },
    ],
  },
  task_definition: {
    table: 'meta.task_definition',
    scope: 'app',
    label: 'Task definition',
    plural: 'Task definitions',
    icon: 'check',
    summary: (d) => d.name,
    defaults: { type: 'approval', priority: 3, subject: 'Request &DETAIL_PK.' },
    validate: (v) => {
      if (v.due_in && !/^\s*\d+\s*(minute|hour|day|week|month)s?\s*$/i.test(String(v.due_in))) return 'Due in: a number and a unit, e.g. 2 days or 4 hours.';
      if (v.priority !== null && v.priority !== undefined && (Number(v.priority) < 1 || Number(v.priority) > 5)) return 'Priority: 1 (urgent) to 5 (low).';
      if (v.expiration && !v.due_in) return 'When overdue: set "Due in" first (a task without a due date is never overdue).';
      if (v.expiration === 'renew' && v.max_renewals !== null && v.max_renewals !== undefined && v.max_renewals !== '' && (Number(v.max_renewals) < 1 || Number(v.max_renewals) > 100)) return 'Maximum renewals: 1 to 100.';
      if (v.expiration === 'escalate' && !String(v.escalate_role ?? '').trim()) return 'Escalation role: the role that takes the task over.';
      return null;
    },
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: "Application SQL creates tasks with meta.create_task('NAME', :P1_ID, params, owners)." },
      { name: 'type', label: 'Type', kind: 'select', options: ['approval', 'action'], group: 'Identification', help: 'approval: Approve / Reject · action: Complete' },
      { name: 'subject', label: 'Subject', kind: 'text', wide: true, group: 'Identification', help: '&KEY. is replaced by the task parameter KEY (and &DETAIL_PK.), e.g. Expense claim of &NAME.: &AMOUNT.' },
      { name: 'owner_roles', label: 'Potential owners (roles)', kind: 'list', group: 'Participants', help: 'Users with one of these roles may act on the task, as may the users given to create_task.' },
      { name: 'admin_role', label: 'Business administrator (role)', kind: 'text', group: 'Participants', help: 'Sees all these tasks, delegates and cancels them.' },
      { name: 'initiator_can_complete', label: 'The person who requested it may complete it', kind: 'bool', group: 'Participants' },
      { name: 'priority', label: 'Priority (1 urgent – 5 low)', kind: 'int', group: 'Deadline' },
      { name: 'due_in', label: 'Due in', kind: 'text', group: 'Deadline', help: 'e.g. 2 days; overdue tasks are marked in the task list.' },
      { name: 'expiration', label: 'When overdue', kind: 'select', options: ['', 'expire', 'renew', 'escalate'], group: 'Deadline',
        help: 'Empty: the task stays open. expire: it ends as expired. renew: the due date moves on by "Due in" (up to the maximum renewals), then it expires. escalate: once, the escalation role becomes an owner, the priority 1 and the task unassigned with a new due date; overdue again, it expires. A workflow waiting for the task goes on with the outcome "expired".' },
      { name: 'max_renewals', label: 'Maximum renewals', kind: 'int', group: 'Deadline', help: 'For renew: 1 to 100 (default 3).' },
      { name: 'escalate_role', label: 'Escalation role', kind: 'text', group: 'Deadline', help: 'For escalate: the role (e.g. a manager role) whose members may then act on the task.' },
      { name: 'details_page', label: 'Details page', kind: 'page', group: 'Details', help: 'The subject links here, setting the item below to the task\'s record key.' },
      { name: 'details_item', label: 'Details item', kind: 'upper', group: 'Details', help: 'e.g. P7_ID' },
      { name: 'action_code', label: 'On completion (SQL)', kind: 'code', wide: true, group: 'Action',
        help: 'Runs as the application\'s role when the task is approved, rejected or completed, in the same transaction (an error undoes the decision). Binds: :TASK_ID, :DETAIL_PK, :OUTCOME (APPROVED, REJECTED, COMPLETED), :COMMENT, :APPROVER, :INITIATOR and the task parameters, e.g. select expenses.decide(:DETAIL_PK::int, :OUTCOME, :COMMENT)' },
    ],
  },
  template_component: TEMPLATE_COMPONENT_SPEC,
  web_credential: WEB_CREDENTIAL_SPEC,
  rest_source: REST_SOURCE_SPEC,
  data_load_def: DATA_LOAD_DEF_SPEC,
  // (104) report queries (APEX: Shared Components → Report Queries)
  report_query: {
    table: 'meta.report_query',
    scope: 'app',
    label: 'Report query',
    plural: 'Report queries',
    icon: 'file',
    summary: (q) => `${q.name} (${q.format})`,
    defaults: { format: 'pdf', query: 'select empno, ename, job from sales.staff order by ename' },
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'Pages download it with ?doc=NAME (a document template of that name wins); buttons with action "document" name it.' },
      { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
      { name: 'query', label: 'Query (SQL)', kind: 'code', wide: true, group: 'Source', help: 'A SELECT with :ITEM binds (the page\'s session state), run as the application\'s role. Its columns\' names are the headings.' },
      { name: 'format', label: 'Output format', kind: 'select', options: ['pdf', 'xlsx', 'csv', 'json', 'xml', 'html'], group: 'Output' },
      { name: 'layout', label: 'Report layout', kind: 'upper', group: 'Output', help: 'PDF: paper, margins, font size, colours, logo and footer (Shared Components → Report layouts). Empty: the default layout.' },
      { name: 'file_name', label: 'File name', kind: 'text', group: 'Output', help: 'Without extension, e.g. staff-&P3_DEPTNO. Empty: the name in lower case.' },
      { name: 'title', label: 'Title', kind: 'text', group: 'Output', help: 'Of a PDF or HTML file (&ITEM. allowed). Empty: the description or the name.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      { name: 'comments', label: 'Comments', kind: 'textarea', wide: true, group: 'Comments' },
    ],
  },
  document_template: {
    table: 'meta.document_template',
    scope: 'app',
    label: 'Document template',
    plural: 'Document templates',
    icon: 'file',
    summary: (d) => d.name,
    defaults: {
      query: "select current_date as today, 'Example' as title",
      template: '<h1>{{title}}</h1>\n<p>Prepared for {{APP_USER}} on {{today|date}}.</p>\n<table>\n  <tr><th width="40%">Item</th><td align="right">{{@index}}</td></tr>\n</table>',
    },
    validate: (v) => templateProblem(String(v.template ?? '')),
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'Pages download it with ?doc=NAME; buttons with action "document".' },
      { name: 'description', label: 'Title', kind: 'text', wide: true, group: 'Identification', help: 'The PDF title (and &REPORT_TITLE. in the layout footer).' },
      { name: 'query', label: 'Data (SQL)', kind: 'code', wide: true, group: 'Data',
        help: 'A SELECT with :ITEM binds. The first row\'s columns are {{column}}; all rows are {{#rows}}…{{/rows}}; json columns (json_agg(…)) are lists for {{#name}}…{{/name}}. Built in: APP_USER, APP_NAME, TODAY, NOW.' },
      { name: 'template', label: 'Template (HTML)', kind: 'code', wide: true, group: 'Template',
        help: 'h1–h4, p, b, i, u, small, br, ul/ol/li, hr, table/tr/th/td (width="30%", align, colspan, class="plain"), img src="logo", class="page-break", align="right|center", class="muted". Tags: {{name}}, {{amount|number:2}}, {{date|date}}, {{#list}}…{{/list}}, {{^list}}none{{/list}}, {{@index}}. Values are always escaped.' },
      { name: 'layout', label: 'Report layout', kind: 'upper', group: 'Output', help: 'Paper, margins, font size, colours, logo and footer (Shared Components → Report layouts). Empty: the default layout.' },
      { name: 'filename', label: 'File name', kind: 'text', group: 'Output', help: 'e.g. invoice-&P5_ID. (".pdf" is added). Empty: the name.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
    ],
  },
  // (080) search configurations: what a search region searches
  search_config: {
    table: 'meta.search_config',
    scope: 'app',
    label: 'Search configuration',
    plural: 'Search configurations',
    icon: 'search',
    summary: (c) => `${c.name} (${c.source_type})`,
    defaults: { source_type: 'table', seq: 10, max_results: 10, searchable_columns: [] },
    validate: (v) => searchConfigProblems(v as never).join(' ') || null,
    fields: [
      { name: 'name', label: 'Name (static ID)', kind: 'upper', group: 'Identification', help: 'e.g. CUSTOMERS; a search region names it in {"configs": ["CUSTOMERS"]}.' },
      { name: 'label', label: 'Label', kind: 'text', group: 'Identification', help: 'The heading of its results, e.g. Customers.' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Identification', help: 'The order of the groups of results.' },
      { name: 'source_type', label: 'Source type', kind: 'select', options: ['table', 'sql', 'list'], group: 'Source',
        help: 'table: a table or view · sql: a SELECT (:ITEM binds allowed) · list: the entries of a list (Shared Components → Lists) the user may see.' },
      { name: 'source', label: 'Source', kind: 'code', wide: true, group: 'Source', help: 'table: sales.customers · sql: select id, name, city from sales.customers where active · list: the list\'s name.' },
      { name: 'searchable_columns', label: 'Searchable columns', kind: 'list', group: 'Source',
        help: 'Comma-separated columns the search text is looked for in (each word must be found in one of them). Empty: the title, subtitle and description columns.' },
      { name: 'title_column', label: 'Title column', kind: 'text', group: 'Result', help: 'Required (table, sql); results are ordered by it.' },
      { name: 'subtitle_column', label: 'Subtitle column', kind: 'text', group: 'Result' },
      { name: 'description_column', label: 'Description column', kind: 'text', group: 'Result' },
      { name: 'badge_column', label: 'Badge column', kind: 'text', group: 'Result' },
      { name: 'icon', label: 'Icon', kind: 'text', group: 'Result', help: 'An icon name (e.g. user), or #COLUMN# for a column that holds icon names.' },
      { name: 'link', label: 'Link', kind: 'json', wide: true, group: 'Result', help: 'Where a result goes: {"page": 3, "items": {"P3_ID": "#ID#"}} (#COLUMN# is the row\'s value). Empty: no link.' },
      { name: 'max_results', label: 'Maximum results', kind: 'int', group: 'Result', help: '1–100 (default 10).' },
      buildOption('Result'),
    ],
  },
  // (081) e-mail templates: meta.send_mail_template and the send_email process fill them
  email_template: {
    table: 'meta.email_template',
    scope: 'app',
    label: 'E-mail template',
    plural: 'E-mail templates',
    icon: 'send',
    summary: (t) => t.name,
    defaults: { subject: 'Order #ORDER_ID# shipped', html_body: '<p>Dear #NAME#,</p>\n<p>Your order #ORDER_ID# is on its way.</p>', text_body: 'Dear #NAME#,\n\nYour order #ORDER_ID# is on its way.' },
    validate: (v) => (typeof v.subject !== 'string' || !v.subject.trim() || /[\r\n]/.test(v.subject) ? 'The subject is required, on one line.' : !v.html_body && !v.text_body ? 'Write an HTML or a plain text body (or both).' : null),
    fields: [
      { name: 'name', label: 'Name (static ID)', kind: 'upper', help: 'e.g. ORDER_SHIPPED: meta.send_mail_template(\'ORDER_SHIPPED\', …) and the Send e-mail process name it.' },
      { name: 'subject', label: 'Subject', kind: 'text', wide: true, help: 'One line; #PLACEHOLDERS# are filled in.' },
      { name: 'html_body', label: 'HTML body', kind: 'code', wide: true,
        help: '#NAME# is the value, HTML-escaped; #NAME!RAW# the value as it is (trusted HTML only). Mail clients ignore most CSS: keep it simple (tables, inline formatting).' },
      { name: 'text_body', label: 'Plain text body', kind: 'textarea', wide: true, help: 'For mail clients that show no HTML. #NAME# is the value as it is.' },
    ],
  },
  // (086) application settings: meta.get_app_setting / meta.set_app_setting
  app_setting: {
    table: 'meta.app_setting',
    scope: 'app',
    label: 'Application setting',
    plural: 'Application settings',
    icon: 'settings',
    summary: (x) => x.name,
    defaults: { keep_on_upgrade: true },
    // no valid values: any value (null, not an empty list)
    beforeSave: async (v) => {
      if (Array.isArray(v.valid_values) && !v.valid_values.length) v.valid_values = null;
    },
    validate: (v) =>
      v.required && !String(v.value ?? '').trim()
        ? 'A required setting needs a value.'
        : v.value && Array.isArray(v.valid_values) && v.valid_values.length && !v.valid_values.includes(v.value)
          ? `The value is one of the valid values: ${v.valid_values.join(', ')}.`
          : null,
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', help: 'e.g. SUPPORT_EMAIL: meta.get_app_setting(\'SUPPORT_EMAIL\') reads it, meta.set_app_setting(\'SUPPORT_EMAIL\', …) changes it.' },
      { name: 'value', label: 'Value', kind: 'text', wide: true },
      { name: 'description', label: 'Description', kind: 'text', wide: true },
      { name: 'valid_values', label: 'Valid values', kind: 'list', help: 'Comma-separated; empty: any value.' },
      { name: 'required', label: 'Value required', kind: 'bool' },
      { name: 'keep_on_upgrade', label: 'Keep the installed value on upgrade', kind: 'bool', help: 'An import over this application keeps the value set here (on), or takes the value from the file (off).' },
    ],
  },
  // (086) dynamic translations: meta.lang(text)
  dynamic_translation: {
    table: 'meta.dynamic_translation',
    scope: 'app',
    label: 'Dynamic translation',
    plural: 'Dynamic translations',
    icon: 'file',
    summary: (x) => `${x.language}: ${x.source}`,
    validate: (v) => (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(String(v.language ?? '')) ? 'Language: a code such as nl, de or pt-BR.' : null),
    fields: [
      { name: 'language', label: 'Language', kind: 'text', help: 'e.g. nl, de, pt-BR' },
      { name: 'source', label: 'Text (as stored)', kind: 'text', wide: true, help: 'The value as the table holds it, e.g. Sales; select meta.lang(dname) from hr.dept shows the translation.' },
      { name: 'target', label: 'Translation', kind: 'text', wide: true },
    ],
  },
  report_layout: {
    table: 'meta.report_layout',
    scope: 'app',
    label: 'Report layout',
    plural: 'Report layouts',
    icon: 'printer',
    summary: (l) => l.name,
    defaults: { paper: 'A4', orientation: 'auto', font_size: 8.5, margin_mm: 13, show_filters: true, heading_color: '#e8ecf2', stripe_color: '#f6f7f9', text_color: '#111111', logo_width_mm: 30 },
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'Reports use it in their settings: {"pdf": {"layout": "NAME"}}' },
      { name: 'is_default', label: 'Default for reports that name no layout', kind: 'bool', group: 'Identification' },
      { name: 'paper', label: 'Paper size', kind: 'select', options: ['A4', 'A3', 'A5', 'LETTER', 'LEGAL'], group: 'Page' },
      { name: 'orientation', label: 'Orientation', kind: 'select', options: ['auto', 'portrait', 'landscape'], group: 'Page', help: 'auto: landscape when the columns do not fit upright' },
      { name: 'font_size', label: 'Font size (pt)', kind: 'text', group: 'Page', help: '5 to 16, e.g. 8.5' },
      { name: 'margin_mm', label: 'Margins (mm)', kind: 'int', group: 'Page' },
      { name: 'full_width', label: 'Stretch the table to the page width', kind: 'bool', group: 'Page' },
      { name: 'title', label: 'Title', kind: 'text', wide: true, group: 'Texts', help: 'Empty: the report title. Substitutions: &REPORT_TITLE. &APP_NAME. &APP_USER. &DATE. &TIMESTAMP. &P1_ITEM. &APP_TEXT$NAME.' },
      { name: 'header', label: 'Header (under the title)', kind: 'textarea', wide: true, group: 'Texts', help: 'Empty: application, time and user. Several lines are allowed.' },
      { name: 'footer', label: 'Footer (bottom left of every page)', kind: 'text', wide: true, group: 'Texts', help: 'Empty: the title. Page numbers are always at the bottom right.' },
      { name: 'show_filters', label: 'Show the filters and search the user applied', kind: 'bool', group: 'Texts' },
      { name: 'heading_color', label: 'Column heading background', kind: 'color', group: 'Colors' },
      { name: 'stripe_color', label: 'Stripe every other row', kind: 'text', group: 'Colors', help: '#rrggbb; empty = no stripes' },
      { name: 'text_color', label: 'Text', kind: 'color', group: 'Colors' },
      { name: 'logo_width_mm', label: 'Logo width (mm)', kind: 'int', group: 'Logo', help: 'Upload the logo (PNG or JPEG) below, after saving.' },
    ],
  },
  automation: {
    table: 'meta.automation',
    scope: 'app',
    label: 'Automation',
    plural: 'Automations',
    icon: 'clock',
    summary: (a) => a.name,
    defaults: { enabled: true, schedule: '0 7 * * 1-5', time_zone: 'UTC', timeout_s: 300, error_handling: 'stop' },
    validate: (v) => (v.schedule ? scheduleProblem(String(v.schedule), String(v.time_zone ?? 'UTC')) : 'Enter a schedule.'),
    fields: [
      { name: 'name', label: 'Name', kind: 'text', group: 'Identification', help: 'Application code runs it with meta.run_automation(\'<name>\').' },
      { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
      { name: 'enabled', label: 'Enabled (runs on its schedule)', kind: 'bool', group: 'Identification' },
      { name: 'schedule', label: 'Schedule (cron)', kind: 'text', group: 'Schedule',
        help: 'minute hour day-of-month month day-of-week, e.g. 0 7 * * 1-5 (07:00 on weekdays), */15 * * * * (every 15 minutes), 0 2 1 * * (02:00 on the 1st); or @hourly, @daily, @weekly, @monthly' },
      { name: 'time_zone', label: 'Time zone', kind: 'text', group: 'Schedule', help: 'IANA name, e.g. Europe/Amsterdam or UTC' },
      { name: 'query', label: 'For each row of (optional)', kind: 'code', wide: true, group: 'Execution',
        help: 'A SELECT; the actions then run once per row with its columns as binds, e.g. select id, owner from sales.orders where status = \'OPEN\' → :ID, :OWNER. Empty: the actions run once.' },
      { name: 'error_handling', label: 'Error handling', kind: 'select', options: ['stop', 'skip', 'disable'], group: 'Execution',
        help: 'stop: an error rolls the whole run back · skip: a failing row is rolled back and recorded in the run history, the other rows go on (needs a query) · disable: like stop, and the automation is switched off.' },
      { name: 'roles', label: 'Roles', kind: 'list', group: 'Execution', help: 'Comma separated; what meta.has_role() returns true for while it runs.' },
      { name: 'timeout_s', label: 'Timeout (seconds)', kind: 'int', group: 'Execution', help: 'Of a scheduled run or Run now (a run from SQL has the caller\'s statement timeout).' },
    ],
  },
  automation_action: {
    table: 'meta.automation_action',
    scope: 'app',
    label: 'Automation action',
    plural: 'Automation actions',
    icon: 'play',
    summary: (a) => `${a.automation_name}: ${a.name}`,
    defaults: { seq: 10 },
    validate: (v) => (!v.automation_name ? 'Choose the automation.' : !v.name ? 'Enter a name.' : !v.code ? 'Enter the code to run.' : null),
    fields: [
      { name: 'automation_name', label: 'Automation', kind: 'automation_name', group: 'Action' },
      { name: 'name', label: 'Name', kind: 'text', group: 'Action' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Action', help: 'Actions run in this order, all in the run\'s transaction.' },
      { name: 'code', label: 'Code (SQL or PL/pgSQL)', kind: 'code', wide: true, group: 'Action',
        help: 'Runs as the application\'s database role. Binds: :APP_ID, :APP_ALIAS, :APP_USER (automation:<name>), :AUTOMATION_NAME, and the row\'s columns (not inside $$ … $$ blocks: pass them to a function instead).' },
      { name: 'condition', label: 'Server-side condition (SQL)', kind: 'code', wide: true, group: 'Condition',
        help: 'Optional boolean expression; the action runs only when it is true, e.g. :DAYS_OPEN::int > 7 (the row\'s columns are binds).' },
    ],
  },
};

export const ICON_OPTIONS = ['', ...ICONS];

/** Convert a submitted form into typed column values; throws on bad input. */
export function parseFields(spec: ComponentSpec, body: Record<string, string | undefined>) {
  const values: Record<string, unknown> = {};
  for (const f of spec.fields) {
    // a repeated field (checkboxes) arrives as an array: only 'options' fields read it as one
    const sent = body[f.name] as unknown;
    const raw = Array.isArray(sent) ? (f.kind === 'options' ? undefined : String(sent[0] ?? '')) : (sent as string | undefined);
    const v = raw === undefined || raw.trim() === '' ? '' : raw;
    switch (f.kind) {
      case 'bool':
        values[f.name] = raw === 'true';
        break;
      case 'int':
      case 'region':
      case 'page':
      case 'nav':
      case 'list_parent':
        values[f.name] = v === '' ? null : Number.parseInt(v, 10);
        if (Number.isNaN(values[f.name])) throw new Error(`${f.label} must be a number`);
        break;
      case 'json':
        try {
          values[f.name] = JSON.stringify(v === '' ? {} : JSON.parse(v));
        } catch {
          throw new Error(`${f.label} is not valid JSON`);
        }
        break;
      case 'list':
        values[f.name] = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
        break;
      case 'options': {
        // a repeated form field arrives as an array; only values of the fixed list are kept
        const sent = ([] as unknown[]).concat((body as Record<string, unknown>)[f.name] ?? []);
        values[f.name] = (f.choices ?? []).map((c) => c.cls).filter((c) => sent.includes(c));
        break;
      }
      case 'upper':
      case 'authz':
      case 'build_option':
      case 'rest_source':
      case 'list_name':
        values[f.name] = v === '' ? null : v.trim().toUpperCase();
        break;
      case 'automation_name':
        values[f.name] = v === '' ? null : v.trim();
        break;
      case 'icon': {
        // (0.31) the picker's "any icon" field (a Lucide name, Font APEX name, modifiers) wins over the grid
        const custom = String(body[`${f.name}__custom`] ?? '').trim().replace(/\s+/g, ' ');
        if (custom && !isIcon(custom)) throw new Error(`${f.label}: there is no icon "${custom.split(' ')[0]}" (see the icon picker)`);
        values[f.name] = custom ? custom.slice(0, 100) : v === '' ? null : v;
        break;
      }
      case 'secret':
        // not trimmed: a secret is what was typed
        values[f.name] = raw ? raw : null;
        break;
      default:
        values[f.name] = v === '' ? null : v;
    }
  }
  return values;
}
