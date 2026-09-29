// The builder's own metadata: which columns of each meta table are editable
// and how. The page designer and the shared components pages are generated
// from this spec, and SQL column names only ever come from here (never from
// the request).

import { ICONS } from '../icons.ts';

export type FieldKind =
  | 'text' | 'int' | 'bool' | 'code' | 'json' | 'select' | 'upper'
  | 'region'   // region of the current page
  | 'authz'    // authorization scheme of the app
  | 'page'     // page of the app
  | 'nav'      // navigation entry of the app (parent)
  | 'icon';

export interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  help?: string;
  wide?: boolean;
  group?: string;
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
}

const AUTHZ_HELP = 'Authorization scheme; prefix with ! to negate. MUST_NOT_BE_PUBLIC_USER is built in.';

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
    fields: [
      { name: 'title', label: 'Title', kind: 'text', group: 'Identification' },
      { name: 'type', label: 'Type', kind: 'select', options: ['report', 'grid', 'form', 'chart', 'cards', 'calendar', 'facets', 'static', 'dynamic'], group: 'Identification' },
      { name: 'source', label: 'Source', kind: 'code', wide: true, group: 'Source',
        help: 'report/grid: a SELECT (use :ITEM binds) · chart: label column + one numeric column per series · cards: title, subtitle, body, badge, icon · calendar: start_date, end_date, title · dynamic: a SELECT returning HTML (escape with meta.html_escape) · static: HTML with &ITEM. substitutions.' },
      { name: 'table_name', label: 'Table (form, grid)', kind: 'text', help: 'e.g. hr.emp', group: 'Source' },
      { name: 'pk_column', label: 'Primary key column (form, grid)', kind: 'text', group: 'Source' },
      { name: 'pk_item', label: 'Primary key item (form)', kind: 'upper', group: 'Source' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Layout' },
      { name: 'columns', label: 'Column span (1-12)', kind: 'int', group: 'Layout' },
      { name: 'template', label: 'Template', kind: 'select', options: ['standard', 'plain', 'collapsible'], group: 'Layout' },
      { name: 'condition', label: 'Server-side condition (SQL)', kind: 'code', group: 'Security', help: 'Boolean expression; the region renders only when true.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      { name: 'config', label: 'Attributes (JSON)', kind: 'json', wide: true, group: 'Attributes',
        help: 'report: {"page_size":15,"searchable":true,"sortable":true,"interactive":true,"mobile":"reflow"|"scroll","hidden":["col"],"headings":{"col":"Label"},"link":{"column":"id","page":3,"items":{"P3_ID":"#id#"}},"empty":"No rows"} · chart: {"kind":"bar"|"column"|"line"|"area"|"donut"} · cards: {"style":"metric","link":{...}} · grid: {"page_size":25,"allow":{"insert":true,"update":true,"delete":true},"readonly":["col"],"columns":{"deptno":{"lov":"LOV:DEPARTMENTS","required":true}}} · calendar: {"link":{...}} · facets: {"report":<region id>,"facets":[{"column":"job","label":"Job"}]}' },
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
    fields: [
      { name: 'name', label: 'Name', kind: 'upper', help: 'Referenced in SQL as :NAME, e.g. P3_ENAME', group: 'Identification' },
      { name: 'type', label: 'Type', kind: 'select', options: ['text', 'textarea', 'number', 'date', 'datetime', 'select', 'popup_lov', 'radio', 'checkbox', 'switch', 'checkbox_group', 'multiselect', 'email', 'tel', 'url', 'color', 'hidden', 'display', 'password'], group: 'Identification' },
      { name: 'label', label: 'Label', kind: 'text', group: 'Identification' },
      { name: 'region_id', label: 'Region', kind: 'region', group: 'Layout' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Layout' },
      { name: 'source_column', label: 'Source column (form)', kind: 'text', group: 'Source' },
      { name: 'default_value', label: 'Default value', kind: 'text', group: 'Source' },
      { name: 'lov', label: 'List of values', kind: 'code', wide: true, group: 'List of values', help: 'select display, return from … · STATIC:Yes;Y,No;N · LOV:NAME (shared) · checkbox_group/multiselect store values colon-separated: string_to_array(:P1_X, \':\')' },
      { name: 'required', label: 'Value required', kind: 'bool', group: 'Validation' },
      { name: 'help', label: 'Help text', kind: 'text', group: 'Validation' },
      { name: 'readonly_condition', label: 'Read-only condition (SQL)', kind: 'code', group: 'Security', help: 'When true the item is shown read-only and ignored on submit.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      { name: 'config', label: 'Attributes (JSON)', kind: 'json', group: 'Attributes', help: '{"submit_on_change":true,"null_label":"- All -","cascade_parents":"P3_DEPTNO","wide":true}' },
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
    fields: [
      { name: 'name', label: 'Name (request)', kind: 'upper', group: 'Identification' },
      { name: 'label', label: 'Label', kind: 'text', group: 'Identification' },
      { name: 'action', label: 'Action', kind: 'select', options: ['submit', 'redirect', 'da'], group: 'Behaviour', help: 'da = "Defined by dynamic action"' },
      { name: 'target_page', label: 'Target / branch page', kind: 'page', group: 'Behaviour' },
      { name: 'target_items', label: 'Set items (JSON)', kind: 'json', group: 'Behaviour', help: '{"P3_ID": "&P2_ID."}' },
      { name: 'confirm', label: 'Confirm message', kind: 'text', group: 'Behaviour' },
      { name: 'hot', label: 'Primary (hot) button', kind: 'bool', group: 'Appearance' },
      { name: 'region_id', label: 'Region', kind: 'region', group: 'Layout' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Layout' },
      { name: 'condition', label: 'Server-side condition (SQL)', kind: 'code', group: 'Security', help: 'e.g. :P3_ID is not null — also re-checked when the button is pressed.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
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
    fields: [
      { name: 'name', label: 'Name', kind: 'text', group: 'When' },
      { name: 'event', label: 'Event', kind: 'select', options: ['change', 'click', 'load'], group: 'When' },
      { name: 'trigger_element', label: 'Item(s) / button', kind: 'upper', group: 'When', help: 'Comma separated item names, or a button name for click.' },
      { name: 'condition_type', label: 'Client-side condition', kind: 'select', options: ['', 'equals', 'not_equals', 'in_list', 'is_null', 'is_not_null'], group: 'When' },
      { name: 'condition_value', label: 'Condition value', kind: 'text', group: 'When' },
      { name: 'action', label: 'Action', kind: 'select', options: ['show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit'], group: 'Action',
        help: 'show/hide/enable/disable reverse automatically when the condition is false.' },
      { name: 'affected_items', label: 'Affected items', kind: 'upper', group: 'Action' },
      { name: 'affected_region_id', label: 'Affected region', kind: 'region', group: 'Action' },
      { name: 'code', label: 'SQL', kind: 'code', wide: true, group: 'Action', help: 'set_value: a SELECT whose columns set the affected items · execute_sql: any SQL; returned columns named like items set them.' },
      { name: 'items_to_submit', label: 'Items to submit', kind: 'upper', group: 'Action' },
      { name: 'message', label: 'Message (alert)', kind: 'text', group: 'Action' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Security' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
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
    fields: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'type', label: 'Type', kind: 'select', options: ['sql', 'form_dml', 'grid_dml', 'send_email'] },
      { name: 'point', label: 'Point', kind: 'select', options: ['submit', 'load'] },
      { name: 'code', label: 'Code (SQL / PL/pgSQL call)', kind: 'code', wide: true,
        help: 'e.g. select hr.give_raise(:P3_EMPNO::int, 10) as p3_sal — returned columns named like items set them. RAISE EXCEPTION messages are shown to the user; USING COLUMN = \'sal\' puts it on that field.' },
      { name: 'region_id', label: 'Form / grid region (form_dml, grid_dml)', kind: 'region' },
      { name: 'when_button', label: 'When button pressed', kind: 'upper' },
      { name: 'success_message', label: 'Success message', kind: 'text' },
      { name: 'config', label: 'E-mail (send_email, JSON)', kind: 'json', wide: true,
        help: '{"to":"&P5_EMAIL.","cc":"","bcc":"","reply_to":"","from":"","subject":"Leave &P5_ID.","body":"text with &ITEM. substitutions","body_html":"optional HTML"} · or a template: {"to":"&P5_EMAIL.","template":"LEAVE_DECIDED","placeholders":{"NAME":"&P5_ENAME."}}' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      { name: 'authz', label: 'Authorization', kind: 'authz', help: AUTHZ_HELP },
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
      { name: 'query', label: 'Query', kind: 'code', wide: true, help: 'select display_value, return_value from … (STATIC: lists work too)' },
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
      { name: 'name', label: 'Name', kind: 'upper', help: 'e.g. AI_EMPNO; only server-side code can set it.' },
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
      { name: 'point', label: 'Point', kind: 'select', options: ['after_login', 'before_page'] },
      { name: 'code', label: 'Code (SQL)', kind: 'code', wide: true, help: 'Returned columns named like application items set them, e.g. select empno as ai_empno from …' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      { name: 'authz', label: 'Authorization', kind: 'authz', help: AUTHZ_HELP },
    ],
  },
  email_template: {
    table: 'meta.email_template',
    scope: 'app',
    label: 'E-mail template',
    plural: 'E-mail templates',
    icon: 'inbox',
    summary: (t) => `${t.name} (${t.static_id})`,
    fields: [
      { name: 'static_id', label: 'Static ID', kind: 'upper', help: "Used in meta.send_mail_template('LEAVE_DECIDED', …) and the Send e-mail process." },
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'subject', label: 'Subject', kind: 'text', wide: true, help: 'Placeholders: #NAME# (from the placeholders you pass)' },
      { name: 'body_html', label: 'HTML body', kind: 'code', wide: true, help: '#NAME# is HTML-escaped; #NAME!RAW# is inserted as-is.' },
      { name: 'body_text', label: 'Plain text body', kind: 'code', wide: true },
    ],
  },
};

export const ICON_OPTIONS = ['', ...ICONS];

/** Convert a submitted form into typed column values; throws on bad input. */
export function parseFields(spec: ComponentSpec, body: Record<string, string | undefined>) {
  const values: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const raw = body[f.name];
    const v = raw === undefined || raw.trim() === '' ? '' : raw;
    switch (f.kind) {
      case 'bool':
        values[f.name] = raw === 'true';
        break;
      case 'int':
      case 'region':
      case 'page':
      case 'nav':
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
      case 'upper':
      case 'authz':
        values[f.name] = v === '' ? null : v.trim().toUpperCase();
        break;
      default:
        values[f.name] = v === '' ? null : v;
    }
  }
  return values;
}
