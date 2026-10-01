// The builder's own metadata: which columns of each meta table are editable
// and how. The page designer and the shared components pages are generated
// from this spec, and SQL column names only ever come from here (never from
// the request).

import { scheduleProblem } from '../automations.ts';
import { ICONS } from '../icons.ts';
import { templateProblem } from '../runtime/document.ts';
import { stepProblems } from '../workflow.ts';
import { workflowBeforeSave } from './workflows.ts';
import { handlerProblems } from '../runtime/rest.ts';
import { TEMPLATE_COMPONENT_SPEC } from './template-spec.ts';

export type FieldKind =
  | 'text' | 'int' | 'bool' | 'code' | 'json' | 'select' | 'upper'
  | 'textarea' // plain multi-line text
  | 'color'    // #rrggbb
  | 'list'     // comma-separated values into a text[] column
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
  /** shown, not editable (the form still posts it) */
  readonly?: boolean;
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
  /** adjusts the parsed values before they are saved (cid: the row being edited); throws when they can't be */
  beforeSave?: (values: Record<string, unknown>, cid: string | undefined) => Promise<void>;
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
      { name: 'type', label: 'Type', kind: 'select', options: ['report', 'grid', 'form', 'chart', 'cards', 'calendar', 'facets', 'tasks', 'workflows', 'map', 'tree', 'template_component', 'static', 'dynamic'], group: 'Identification' },
      { name: 'source', label: 'Source', kind: 'code', wide: true, group: 'Source',
        help: 'report/grid: a SELECT (use :ITEM binds) · chart: label column + one numeric column per series · cards: title, subtitle, body, badge, icon · calendar: start_date, end_date, title · map: lat and lng (or location "lat,lng"), title, body, geojson · tree: id, parent_id, label, icon · template_component: any SELECT (its columns are #COLUMN# in the template), or empty for one instance · dynamic: a SELECT returning HTML (escape with meta.html_escape) · static: HTML with &ITEM. substitutions.' },
      { name: 'table_name', label: 'Table (form, grid)', kind: 'text', help: 'e.g. sales.orders', group: 'Source' },
      { name: 'pk_column', label: 'Primary key column (form, grid)', kind: 'text', group: 'Source' },
      { name: 'pk_item', label: 'Primary key item (form)', kind: 'upper', group: 'Source' },
      { name: 'seq', label: 'Sequence', kind: 'int', group: 'Layout' },
      { name: 'columns', label: 'Column span (1-12)', kind: 'int', group: 'Layout' },
      { name: 'template', label: 'Template', kind: 'select', options: ['standard', 'plain', 'collapsible'], group: 'Layout' },
      { name: 'condition', label: 'Server-side condition (SQL)', kind: 'code', group: 'Security', help: 'Boolean expression; the region renders only when true.' },
      { name: 'authz', label: 'Authorization', kind: 'authz', group: 'Security', help: AUTHZ_HELP },
      { name: 'config', label: 'Attributes (JSON)', kind: 'json', wide: true, group: 'Attributes',
        help: 'report: {"page_size":15,"searchable":true,"sortable":true,"interactive":true,"mobile":"reflow"|"scroll","hidden":["col"],"headings":{"col":"Label"},"link":{"column":"id","page":3,"items":{"P3_ID":"#id#"}},"empty":"No rows","pdf":{"layout":"NAME","columns":["col"],"widths":{"col":40},"align":{"col":"right"}}} (pdf widths in mm; layouts under Shared Components → Report layouts) · chart: {"kind":"bar"|"column"|"line"|"area"|"donut"} · cards: {"style":"metric","link":{...}} · grid: {"page_size":25,"allow":{"insert":true,"update":true,"delete":true},"readonly":["col"],"columns":{"deptno":{"lov":"LOV:DEPARTMENTS","required":true}}} · calendar: {"link":{...}} · facets: {"report":<region id>,"facets":[{"column":"job","label":"Job"}]}' },
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
      { name: 'name', label: 'Name', kind: 'upper', help: 'Referenced in SQL as :NAME, e.g. P3_NAME', group: 'Identification' },
      { name: 'type', label: 'Type', kind: 'select', options: ['text', 'textarea', 'number', 'date', 'datetime', 'select', 'popup_lov', 'radio', 'checkbox', 'switch', 'checkbox_group', 'multiselect', 'email', 'tel', 'url', 'color', 'file', 'location', 'hidden', 'display', 'password'], group: 'Identification' },
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
      { name: 'config', label: 'Attributes (JSON)', kind: 'json', group: 'Attributes', help: '{"submit_on_change":true,"null_label":"- All -","cascade_parents":"P3_DEPTNO","wide":true}. File items: {"filename_column":"photo_name","mime_column":"photo_mime","accept":"image/*,.pdf","max_mb":2,"capture":"environment","max_px":1600} (capture opens the camera on phones; max_px makes photos smaller before upload). Several files: {"multiple":true,"max_files":5,"table":"doc.attachment","parent_column":"ticket_id","key_column":"id"} with the content column as source (one row per file). Text items: {"scan":true} adds a barcode/QR scan button where the browser can read codes. Location items hold "lat,lng" with a "Use my location" button.' },
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
      { name: 'action', label: 'Action', kind: 'select', options: ['submit', 'redirect', 'da', 'document'], group: 'Behaviour', help: 'da = "Defined by dynamic action"; document = download a document template (filled with the page\'s values as last loaded or saved)' },
      { name: 'document', label: 'Document template (action document)', kind: 'upper', group: 'Behaviour', help: 'The name of a document template (Shared Components → Document templates).' },
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
      { name: 'type', label: 'Type', kind: 'select', options: ['sql', 'form_dml', 'grid_dml', 'data_load'] },
      { name: 'point', label: 'Point', kind: 'select', options: ['submit', 'load'] },
      { name: 'code', label: 'Code (SQL / PL/pgSQL call)', kind: 'code', wide: true,
        help: 'e.g. select sales.ship_order(:P3_ID::int) as p3_status — returned columns named like items set them. RAISE EXCEPTION messages are shown to the user; USING COLUMN = \'sal\' puts it on that field.' },
      { name: 'region_id', label: 'Form / grid region (form_dml, grid_dml)', kind: 'region' },
      { name: 'config', label: 'Data load (data_load)', kind: 'json', wide: true,
        help: '{"file_item":"P5_FILE","table":"sales.orders","mode":"append | merge | replace","skip_errors":false,"headers":true,"columns":{"Heading in file":"column"}} — runs as the app\'s database role; columns match by name unless mapped.' },
      { name: 'when_button', label: 'When button pressed', kind: 'upper' },
      { name: 'success_message', label: 'Success message', kind: 'text' },
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
      { name: 'point', label: 'Point', kind: 'select', options: ['after_login', 'before_page'] },
      { name: 'code', label: 'Code (SQL)', kind: 'code', wide: true, help: 'Returned columns named like application items set them, e.g. select id as ai_customer_id from sales.customer where lower(username) = lower(:APP_USER)' },
      { name: 'seq', label: 'Sequence', kind: 'int' },
      { name: 'authz', label: 'Authorization', kind: 'authz', help: AUTHZ_HELP },
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
        help: '[{"name": "CHECK", "type": "switch", "cases": [{"when": ":AMOUNT::numeric > 1000", "next": "DIRECTOR"}], "otherwise": "MANAGER"}, {"name": "MANAGER", "type": "task", "task": "EXPENSE_APPROVAL", "owners": "select manager from staff where id = :DETAIL_PK::int", "next": {"approved": "PAY", "rejected": "END"}}, {"name": "PAY", "type": "sql", "code": "select expenses.pay(:DETAIL_PK::int) as paid_on"}, {"name": "PAUSE", "type": "wait", "for": "2 days"}, {"name": "END", "type": "end"}] · "next" is optional (the following step). Parallel branches: {"name": "SPLIT", "type": "parallel", "branches": ["BOOK", "NOTIFY"], "join": "BOTH"} runs the branches side by side until each reaches the join {"name": "BOTH", "type": "join", "wait_for": "all"} ("any": the first one, the others are cancelled). Binds: the variables, :DETAIL_PK, :WORKFLOW_ID, :INITIATOR, and after a task :TASK_OUTCOME and :TASK_APPROVER. Columns that sql steps return become variables.' },
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
      { name: 'details_page', label: 'Details page', kind: 'page', group: 'Details', help: 'The subject links here, setting the item below to the task\'s record key.' },
      { name: 'details_item', label: 'Details item', kind: 'upper', group: 'Details', help: 'e.g. P7_ID' },
      { name: 'action_code', label: 'On completion (SQL)', kind: 'code', wide: true, group: 'Action',
        help: 'Runs as the application\'s role when the task is approved, rejected or completed, in the same transaction (an error undoes the decision). Binds: :TASK_ID, :DETAIL_PK, :OUTCOME (APPROVED, REJECTED, COMPLETED), :COMMENT, :APPROVER, :INITIATOR and the task parameters, e.g. select expenses.decide(:DETAIL_PK::int, :OUTCOME, :COMMENT)' },
    ],
  },
  template_component: TEMPLATE_COMPONENT_SPEC,
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
    defaults: { enabled: true, schedule: '0 7 * * 1-5', time_zone: 'UTC', timeout_s: 300 },
    validate: (v) => (v.schedule ? scheduleProblem(String(v.schedule), String(v.time_zone ?? 'UTC')) : 'Enter a schedule.') ?? (v.code ? null : 'Enter the code to run.'),
    fields: [
      { name: 'name', label: 'Name', kind: 'text', group: 'Identification' },
      { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
      { name: 'enabled', label: 'Enabled (runs on its schedule)', kind: 'bool', group: 'Identification' },
      { name: 'schedule', label: 'Schedule (cron)', kind: 'text', group: 'Schedule',
        help: 'minute hour day-of-month month day-of-week, e.g. 0 7 * * 1-5 (07:00 on weekdays), */15 * * * * (every 15 minutes), 0 2 1 * * (02:00 on the 1st); or @hourly, @daily, @weekly, @monthly' },
      { name: 'time_zone', label: 'Time zone', kind: 'text', group: 'Schedule', help: 'IANA name, e.g. Europe/Amsterdam or UTC' },
      { name: 'query', label: 'For each row of (optional)', kind: 'code', wide: true, group: 'Action',
        help: 'A SELECT; the code then runs once per row with its columns as binds, e.g. select id, owner from sales.orders where status = \'OPEN\' → :ID, :OWNER' },
      { name: 'code', label: 'Code (SQL or PL/pgSQL)', kind: 'code', wide: true, group: 'Action',
        help: 'Runs as the application\'s database role, in one transaction. Binds: :APP_ID, :APP_ALIAS, :APP_USER (automation:<name>), :AUTOMATION_NAME, and the row\'s columns (not inside $$ … $$ blocks: pass them to a function instead).' },
      { name: 'roles', label: 'Roles', kind: 'list', group: 'Action', help: 'Comma separated; what meta.has_role() returns true for while it runs.' },
      { name: 'timeout_s', label: 'Timeout (seconds)', kind: 'int', group: 'Action' },
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
      case 'list':
        values[f.name] = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
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
