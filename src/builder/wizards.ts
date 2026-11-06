import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { ICONS } from '../icons.ts';
import { appOr404 } from './forms.ts';
import { addDashboard } from './appsheets.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Create page wizards (APEX: Create Page). Step 1, on the app's Pages tab,
// picks the page type and a table or view (a GET form); step 2 (GET
// /builder/apps/:id/wizard?kind=…&table=…) shows the options with defaults
// from the catalog (meta.wizard_defaults, migration 047); its POST creates
// the pages with meta.generate_page. Everything is a plain form: no
// JavaScript needed.

export const WIZARD_KINDS: [string, string, string][] = [
  ['report_form', 'Report and form', 'An interactive report and a modal form with create, update and delete.'],
  ['grid', 'Interactive grid', 'One editable grid page.'],
  ['form', 'Form', 'A form for one row: create, update and delete, back to a page of your choice.'],
  ['cards', 'Cards', 'A card per row with a title, subtitle, body and badge, optionally linked to a form.'],
  ['calendar', 'Calendar', 'Rows with a date as events in month, week, day and list views.'],
  ['chart', 'Chart', 'The number of rows, or a sum, average, minimum or maximum, per label.'],
  ['map', 'Map', 'Rows with a position as markers on a map, with a list filtered by the map area.'],
  ['facets', 'Faceted search', 'A report with a filter panel: values with counts, ranges and a search field.'],
  ['master_detail', 'Master detail', 'A grid of the table and, below it, an editable grid of the selected row\'s details.'],
];
/**
 * (sprint 137, AP-3) The page types that reuse other regions (APEX: Create a Page → Component), made by the same
 * meta.generate_page (migration 137), and the dashboard (addDashboard). WIZARD_KINDS above stay the types the
 * AI path and blueprints propose.
 */
export const MORE_KINDS: [string, string, string][] = [
  ['report', 'Interactive report', 'An interactive report of the table on its own page, optionally with a modal form page.'],
  ['smart_filters', 'Smart filters', 'An interactive report with one search field above it that suggests filters (chips) from the columns.'],
  ['search', 'Search page', 'A search region over the application\'s search configurations, or a new one on a table.'],
  ['data_load', 'Data loading', 'A data load definition for the table and a page where users upload a CSV, Excel, JSON or XML file into it.'],
  ['tree', 'Tree', 'The rows as a tree: an id, a parent (from a foreign key to the table itself) and a label.'],
  ['timeline', 'Timeline', 'Rows as events on a vertical line: when, who, a title and a text (template component Timeline).'],
  ['media_list', 'Media list', 'Rows with initials, a title, a description and a badge (template component Media list).'],
  ['content_row', 'Content row', 'Rows with initials, a title and a description, and a secondary text and a badge on the right (template component Content row).'],
  ['comments', 'Comments', 'Rows as a conversation: who wrote what and when (template component Comments).'],
  ['dashboard', 'Dashboard', 'Charts of the application\'s tables, chosen from the data like a new application\'s dashboard.'],
  ['wizard', 'Wizard', 'A form over several steps, one page per step with a progress list, Previous and Next; Finish adds the row.'],
  ['tasks', 'Unified task list', 'The approval and action tasks of the signed-in user (a task list region).'],
  ['workflows', 'Workflow console', 'The workflows the user started or administers, with their state and history.'],
];
/** All the page types step 2 knows: [key, label, description]. */
export const PAGE_KINDS: [string, string, string][] = [...WIZARD_KINDS, ...MORE_KINDS];
/** A page type's label and description in the builder language (the lists above stay English for the AI path). */
export const kindLabel = (k: string, fallback: string) => tx.dyn(`wiz.kind.${k}`, fallback);
export const kindHelp = (k: string, fallback: string) => tx.dyn(`wiz.kind_help.${k}`, fallback);
const KINDS = new Set(PAGE_KINDS.map((k) => k[0]));
/** Page types that need no table (search takes one optionally, for a new search configuration). */
export const NO_TABLE = new Set(['search', 'tasks', 'workflows', 'dashboard']);
const TASK_CONTEXTS = (): [string, string][] => [['my', tx('wiz.my_tasks_to_act_on')], ['initiated', tx('wiz.tasks_i_requested')], ['admin', tx('wiz.tasks_i_administer')]];
const CHART_KINDS = ['bar', 'column', 'line', 'area', 'donut', 'pie', 'funnel'];
const FUNCTIONS = (): [string, string][] => [['count', tx('wiz.count')], ['sum', tx('wiz.sum')], ['avg', tx('wiz.average')], ['min', tx('wiz.minimum')], ['max', tx('wiz.maximum')]];

interface Col {
  column_name: string;
  kind: string;
  type_sql: string;
  not_null: boolean;
  has_default: boolean;
  generated: boolean;
  is_pk: boolean;
  fk_table: string | null;
  fk_display: string | null;
}

/** Tables and views a wizard can use (not pgkiln's or the system's), with whether the app's role can read them. */
export async function wizardTables(dbRole: string | null) {
  return (
    await owner.query<{ t: string; access: boolean }>(
      `select format('%I.%I', n.nspname, c.relname) as t,
              $1::text is null or not exists (select 1 from pg_roles where rolname = $1)
                or has_table_privilege($1, c.oid, 'select') as access
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
        order by 1`,
      [dbRole],
    )
  ).rows;
}

/** The first free page number from `from` on. */
async function freePage(appId: number, from: number) {
  const used = new Set((await owner.query('select page_no from meta.page where app_id = $1', [appId])).rows.map((r) => r.page_no as number));
  let n = from;
  while (used.has(n)) n++;
  return n;
}

const list = (v: unknown): string[] => ([] as string[]).concat((v as string | string[] | undefined) ?? []).filter((x) => typeof x === 'string' && x !== '');
const pageNo = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (!/^\d{1,6}$/.test(s) || Number(s) < 1) throw new Error(`"${s}" is not a page number.`);
  return Number(s);
};

/** The options of a kind from the step 2 form, as meta.generate_page takes them. */
export function wizardOptions(kind: string, b: Record<string, unknown>) {
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  const o: Record<string, unknown> = { label: str('label') || null, icon: ICONS.includes(str('icon') as never) ? str('icon') : null, nav: b.nav === 'true' };
  const formPage = () => pageNo(b.form_page);
  switch (kind) {
    case 'report_form':
      o.form_page = formPage();
      break;
    case 'form':
      o.mode = b.mode === 'modal' ? 'modal' : 'normal';
      o.return_page = pageNo(b.return_page);
      o.columns = list(b.columns);
      break;
    case 'cards':
      for (const k of ['title', 'subtitle', 'body', 'badge']) o[k] = str(k) || null;
      o.form_page = formPage();
      break;
    case 'calendar':
      for (const k of ['start', 'end', 'title']) o[k] = str(k) || null;
      o.drag = b.drag === 'true';
      o.form_page = formPage();
      break;
    case 'chart':
      o.chart = CHART_KINDS.includes(str('chart')) ? str('chart') : 'bar';
      o.function = FUNCTIONS().some(([f]) => f === str('function')) ? str('function') : 'count';
      o.label_column = str('label_column') || null;
      o.value_column = str('value_column') || null;
      break;
    case 'map':
      for (const k of ['lat', 'lng', 'location', 'title', 'body']) o[k] = str(k) || null;
      o.report = b.report === 'true';
      o.form_page = formPage();
      break;
    case 'facets':
      o.columns = list(b.columns);
      o.facets = list(b.facets);
      o.search = b.search === 'true';
      o.form_page = formPage();
      break;
    // (137) the page types of migration 137
    case 'report':
      o.form_page = formPage();
      break;
    case 'smart_filters':
      o.facets = list(b.facets);
      o.form_page = formPage();
      break;
    case 'tree':
      for (const k of ['id_column', 'parent_column', 'label_column']) o[k] = str(k) || null;
      o.expanded = /^\d{1,2}$/.test(str('expanded')) ? Number(str('expanded')) : 1;
      o.form_page = formPage();
      break;
    case 'timeline':
      for (const k of ['title', 'when', 'who', 'body']) o[k] = str(k) || null;
      o.form_page = formPage();
      break;
    case 'media_list':
    case 'content_row':
      for (const k of ['title', 'description', 'badge', ...(kind === 'content_row' ? ['misc'] : [])]) o[k] = str(k) || null;
      o.form_page = formPage();
      break;
    case 'comments':
      for (const k of ['user', 'date', 'comment']) o[k] = str(k) || null;
      break;
    case 'data_load':
      o.definition = str('definition').toUpperCase() || null;
      o.mode = ['append', 'merge', 'replace'].includes(str('mode')) ? str('mode') : 'append';
      o.skip_errors = b.skip_errors === 'true';
      break;
    case 'wizard':
      o.columns = list(b.columns);
      o.steps = /^\d{1,2}$/.test(str('steps')) ? Number(str('steps')) : 2;
      o.return_page = pageNo(b.return_page);
      break;
    case 'search':
      o.configs = list(b.configs).map((c) => c.toUpperCase());
      o.form_page = formPage();
      break;
    case 'tasks':
      o.context = TASK_CONTEXTS().some(([c]) => c === str('context')) ? str('context') : 'my';
      o.completed = b.completed === 'true';
      break;
    case 'workflows':
      o.context = str('context') === 'admin' ? 'admin' : 'initiator';
      break;
    case 'dashboard':
      o.tables = list(b.tables);
      break;
    case 'master_detail': {
      const d = str('detail');
      const at = d.lastIndexOf('|');
      o.detail = at > 0 ? d.slice(0, at) : null;
      o.detail_column = at > 0 ? d.slice(at + 1) : null;
      break;
    }
  }
  return o;
}

export async function wizardRoutes(app: FastifyInstance) {
  // step 2: the options of a page type for a table, with the proposed defaults
  app.get(`${BASE}/apps/:id/wizard`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const kind = String(req.query.kind ?? '');
    const table = String(req.query.table ?? '');
    const rel = KINDS.has(kind) && table && kind !== 'dashboard'
      ? await owner.one<{ t: string; relkind: string }>(
          `select meta.wizard_qname(c.oid) as t, c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.oid = to_regclass($1) and c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')`,
          [table],
        )
      : null;
    if (!rel && !(NO_TABLE.has(kind) && !table)) {
      flash(s, KINDS.has(kind) ? tx('wiz.choose_a_table_or_view') : tx('wiz.choose_a_page_type'), 'error');
      // (137) back to the type's table step on the Create page grid
      return back(reply, s, KINDS.has(kind) ? `${BASE}/apps/${a.id}/create-page?type=${encodeURIComponent(kind)}` : `${BASE}/apps/${a.id}/create-page`);
    }
    const [cols, defaults] = await Promise.all([
      rel ? owner.query<Col>('select * from meta.wizard_catalog($1::regclass)', [rel.t]).then((r) => r.rows) : Promise.resolve([] as Col[]),
      owner.one<{ d: Record<string, any> }>('select meta.wizard_defaults($1, $2::regclass) as d', [kind, rel?.t ?? null]).then((r) => r?.d ?? {}),
    ]);
    const nextPage = await freePage(a.id, Math.max(0, ...(await owner.query('select page_no from meta.page where app_id = $1', [a.id])).rows.map((p) => p.page_no)) + 1);
    const pk = cols.find((c) => c.is_pk)?.column_name ?? null;
    const role = a.db_role as string | null;
    const access = role && rel
      ? await owner.one<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
          `select has_table_privilege($1, $2::regclass, 'select') as s, has_table_privilege($1, $2::regclass, 'insert') as i,
                  has_table_privilege($1, $2::regclass, 'update') as u, has_table_privilege($1, $2::regclass, 'delete') as d
            where exists (select 1 from pg_roles where rolname = $1)`,
          [role, rel!.t],
        )
      : null;

    const none: [string, string] = ['', tx('wiz.none')];
    const colOpts = (pred: (c: Col) => boolean, withNone = true): [string, string][] => [
      ...(withNone ? [none] : []),
      ...cols.filter(pred).map((c): [string, string] => [c.column_name, `${c.column_name} (${c.type_sql}${c.fk_table ? `, shows ${c.fk_table}.${c.fk_display ?? '?'}` : ''})`]),
    ];
    const notBinary = (c: Col) => c.kind !== 'binary' && c.kind !== 'geometry';
    const check = (name: string, label: string, on: boolean, help = '') =>
      html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="true"${on ? raw(' checked') : ''}> ${label}</label>${help ? html`<small class="help">${help}</small>` : ''}</div>`;
    const colChecks = (name: string, legend: string, chosen: string[], pred: (c: Col) => boolean, note: (c: Col) => string = () => '') =>
      html`<fieldset class="prop-group"><legend>${legend}</legend><div class="qb-pick">${cols.filter(pred).map(
        (c) => html`<label class="check"><input type="checkbox" name="${name}" value="${c.column_name}"${chosen.includes(c.column_name) ? raw(' checked') : ''}> ${c.column_name} <span class="muted small">${c.type_sql}${note(c)}</span></label>`,
      )}</div></fieldset>`;
    const formPage = (help: string) => input('form_page', tx('wiz.form_page'), '', { type: 'number', placeholder: tx('wiz.form_page_ph', { n: nextPage + 1 }), help });
    const needsPk = ['report_form', 'grid', 'form', 'master_detail'].includes(kind);
    const allCols = (c: Col) => c.kind !== 'binary';
    const dates = (c: Col) => c.kind === 'date' || c.kind === 'timestamp';

    let fields: Raw | string = '';
    switch (kind) {
      case 'report_form':
        fields = input('form_page', tx('wiz.form_page'), nextPage + 1, { type: 'number', required: true, help: tx('wiz.the_modal_form_page_opened') });
        break;
      case 'form':
        fields = html`<div class="form-grid">
            ${select('mode', tx('wiz.page_mode'), defaults.mode, [['normal', tx('wiz.normal_page')], ['modal', tx('wiz.modal_dialog')]])}
            ${input('return_page', tx('wiz.after_saving_or_cancelling_go'), defaults.return_page ?? '', { type: 'number', placeholder: a.home_page ? tx('wiz.return_home', { n: a.home_page }) : tx('wiz.return_this'), help: tx('wiz.cancel_create_apply_changes_and') })}
          </div>
          ${colChecks('columns', tx('wiz.col_columns'), defaults.columns ?? [], (c) => !c.is_pk && !c.generated && c.kind !== 'binary', (c) => (c.not_null && !c.has_default ? tx('wiz.note_required') : c.fk_table ? tx('wiz.note_select_list', { table: c.fk_table }) : ''))}`;
        break;
      case 'cards':
        fields = html`<div class="form-grid">
            ${select('title', tx('wiz.title'), defaults.title, colOpts(notBinary, false))}
            ${select('subtitle', tx('wiz.subtitle'), defaults.subtitle ?? '', colOpts(notBinary))}
            ${select('body', tx('wiz.body'), defaults.body ?? '', colOpts(notBinary))}
            ${select('badge', tx('wiz.badge'), defaults.badge ?? '', colOpts(notBinary))}
            ${pk ? formPage('A modal form page for a card (a link on each card and a Create button).') : ''}
          </div>`;
        break;
      case 'calendar':
        fields = html`<div class="form-grid">
            ${select('start', tx('wiz.start_date'), defaults.start ?? '', colOpts((c) => c.kind === 'date' || c.kind === 'timestamp', false))}
            ${select('end', tx('wiz.end_date'), defaults.end ?? '', colOpts((c) => c.kind === 'date' || c.kind === 'timestamp'))}
            ${select('title', tx('wiz.event_title'), defaults.title ?? '', colOpts(notBinary))}
            ${pk ? formPage('A modal form page: each event links to it, and a + on every day creates an event there.') : ''}
          </div>
          ${pk ? check('drag', tx('wiz.drag_and_drop'), !!defaults.drag, tx('wiz.users_who_see_the_calendar')) : ''}`;
        break;
      case 'chart':
        fields = html`<div class="form-grid">
            ${select('chart', tx('wiz.chart_type'), defaults.chart, CHART_KINDS)}
            ${select('label_column', tx('wiz.label_one_bar_slice_or'), defaults.label_column ?? '', colOpts(notBinary, false))}
            ${select('function', tx('wiz.value'), defaults.function, FUNCTIONS())}
            ${select('value_column', tx('wiz.of_column'), defaults.value_column ?? '', colOpts((c) => c.kind === 'number'), tx('wiz.count_empty_counts_the_rows'))}
          </div>`;
        break;
      case 'map':
        fields = html`<div class="form-grid">
            ${select('location', tx('wiz.position'), defaults.location ?? '', colOpts((c) => c.kind === 'geometry' || c.kind === 'point' || c.kind === 'text'), 'A PostGIS geometry, a point, or text "latitude,longitude" (a location item). Empty: the latitude and longitude columns.')}
            ${select('lat', tx('wiz.latitude'), defaults.lat ?? '', colOpts((c) => c.kind === 'number'))}
            ${select('lng', tx('wiz.longitude'), defaults.lng ?? '', colOpts((c) => c.kind === 'number'))}
            ${select('title', tx('wiz.popup_title'), defaults.title ?? '', colOpts(notBinary))}
            ${select('body', tx('wiz.popup_text'), defaults.body ?? '', colOpts(notBinary))}
            ${pk ? formPage(tx('wiz.form_map')) : ''}
          </div>
          ${check('report', tx('wiz.a_list_below_the_map'), defaults.report !== false, tx('wiz.an_interactive_report_of_the'))}`;
        break;
      case 'facets':
        fields = html`
          ${colChecks('columns', tx('wiz.col_report_columns'), defaults.columns ?? [], notBinary, (c) => (c.is_pk ? tx('wiz.note_key') : c.fk_table && c.fk_display ? tx('wiz.note_with', { col: `${c.fk_table}.${c.fk_display}` }) : ''))}
          ${colChecks('facets', tx('wiz.col_facets'), defaults.facets ?? [], (c) => notBinary(c) && c.kind !== 'point' && c.kind !== 'other', (c) => (c.fk_table ? tx('wiz.note_values_of', { col: `${c.fk_table}.${c.fk_display ?? c.column_name}` }) : ['number', 'date', 'timestamp'].includes(c.kind) ? tx('wiz.note_range') : tx('wiz.note_counts')))}
          ${check('search', tx('wiz.a_search_field_above_the'), defaults.search !== false)}
          ${pk ? html`<div class="form-grid">${formPage(tx('wiz.form_rows'))}</div>` : ''}`;
        break;
      // (137) the page types of migration 137
      case 'report':
        fields = pk ? html`<div class="form-grid">${formPage(tx('wiz.form_rows'))}</div>` : '';
        break;
      case 'smart_filters':
        fields = html`
          ${colChecks('facets', tx('wiz.col_filters'), defaults.facets ?? [], (c) => notBinary(c) && c.kind !== 'point' && c.kind !== 'other', (c) => (c.fk_table ? tx('wiz.note_values_of', { col: `${c.fk_table}.${c.fk_display ?? c.column_name}` }) : ['number', 'date', 'timestamp'].includes(c.kind) ? tx('wiz.note_ranges') : tx('wiz.note_values')))}
          ${pk ? html`<div class="form-grid">${formPage(tx('wiz.form_rows'))}</div>` : ''}`;
        break;
      case 'tree':
        fields = html`<div class="form-grid">
            ${select('id_column', tx('wiz.node_id'), defaults.id_column ?? '', colOpts(allCols, false), tx('wiz.what_identifies_a_node_usually'))}
            ${select('parent_column', tx('wiz.parent'), defaults.parent_column ?? '', colOpts(allCols), tx('wiz.the_column_with_the_parent'))}
            ${select('label_column', tx('wiz.label'), defaults.label_column ?? '', colOpts(notBinary, false))}
            ${input('expanded', tx('wiz.levels_open_at_first'), defaults.expanded ?? 1, { type: 'number' })}
            ${pk ? formPage('A modal form page, opened by clicking a node.') : ''}
          </div>`;
        break;
      case 'timeline':
        fields = html`<div class="form-grid">
            ${select('title', tx('wiz.title'), defaults.title ?? '', colOpts(notBinary, false))}
            ${select('when', tx('wiz.when'), defaults.when ?? '', colOpts(dates), tx('wiz.the_events_come_newest_first'))}
            ${select('who', tx('wiz.who'), defaults.who ?? '', colOpts(notBinary))}
            ${select('body', tx('wiz.text'), defaults.body ?? '', colOpts(notBinary))}
            ${pk ? formPage('A modal form page, linked from each title.') : ''}
          </div>`;
        break;
      case 'media_list':
      case 'content_row':
        fields = html`<div class="form-grid">
            ${select('title', tx('wiz.title'), defaults.title ?? '', colOpts(notBinary, false), tx('wiz.its_first_two_letters_are'))}
            ${select('description', tx('wiz.description'), defaults.description ?? '', colOpts(notBinary))}
            ${kind === 'content_row' ? select('misc', tx('wiz.secondary_text_on_the_right'), defaults.misc ?? '', colOpts(notBinary)) : ''}
            ${select('badge', tx('wiz.badge'), defaults.badge ?? '', colOpts(notBinary))}
            ${pk ? formPage('A modal form page, linked from each title.') : ''}
          </div>`;
        break;
      case 'comments':
        fields = html`<div class="form-grid">
            ${select('user', tx('wiz.who_wrote_it'), defaults.user ?? '', colOpts(notBinary))}
            ${select('date', tx('wiz.when'), defaults.date ?? '', colOpts(dates), tx('wiz.the_newest_first'))}
            ${select('comment', tx('wiz.comment'), defaults.comment ?? '', colOpts(notBinary, false))}
          </div>`;
        break;
      case 'data_load': {
        const defs = (await owner.query<{ name: string; table_name: string }>('select name, table_name from meta.data_load_def where app_id = $1 order by name', [a.id])).rows;
        fields = html`<div class="form-grid">
            ${input('definition', tx('wiz.data_load_definition'), defaults.definition ?? '', { required: true, help: defs.length ? tx('wiz.def_help_has', { table: rel?.t ?? tx('wiz.the_table'), list: defs.map((d) => d.name).join(', ') }) : tx('wiz.def_help', { table: rel?.t ?? tx('wiz.the_table') }) })}
            ${select('mode', tx('wiz.mode'), defaults.mode ?? 'append', [['append', tx('wiz.append_add_the_rows')], ['merge', tx('wiz.merge_update_rows_with_the')], ['replace', tx('wiz.replace_delete_all_rows_first')]])}
          </div>
          ${check('skip_errors', tx('wiz.skip_rows_with_errors'), !!defaults.skip_errors, tx('wiz.load_the_good_rows_and'))}`;
        break;
      }
      case 'wizard':
        fields = html`<div class="form-grid">
            ${input('steps', tx('wiz.steps'), defaults.steps ?? 2, { type: 'number', help: tx('wiz.one_page_per_step_numbered') })}
            ${input('return_page', tx('wiz.after_finish_or_cancel_go'), defaults.return_page ?? '', { type: 'number', placeholder: a.home_page ? tx('wiz.return_home', { n: a.home_page }) : tx('wiz.return_this') })}
          </div>
          ${colChecks('columns', tx('wiz.col_columns'), defaults.columns ?? [], (c) => !c.is_pk && !c.generated && c.kind !== 'binary' && c.kind !== 'geometry', (c) => (c.not_null && !c.has_default ? tx('wiz.note_required') : c.fk_table ? tx('wiz.note_select_list', { table: c.fk_table }) : ''))}`;
        break;
      case 'search': {
        const configs = (await owner.query<{ name: string; label: string; source: string }>('select name, label, source from meta.search_config where app_id = $1 order by seq, name', [a.id])).rows;
        const tables = await wizardTables(role);
        fields = html`
          ${configs.length
            ? html`<fieldset class="prop-group"><legend>${tx('wiz.search_configurations')}</legend><div class="qb-pick">${configs.map((c) => html`<label class="check"><input type="checkbox" name="configs" value="${c.name}" checked> ${c.label} <span class="muted small">${c.name}, ${c.source.slice(0, 60)}</span></label>`)}</div></fieldset>`
            : html`<p class="muted">${tx.rich('wiz.no_search_configs', { link: html`<a href="${BASE}/apps/${a.id}/shared?type=search_config">${tx('wiz.shared_components_search_configurations')}</a>` })}</p>`}
          <div class="form-grid">
            ${select('table', tx('wiz.and_a_new_configuration_on'), rel?.t ?? '', [['', tx('wiz.none')], ...tables.filter((t) => t.access).map((t): [string, string] => [t.t, t.t])], tx('wiz.searches_the_table_s_text'))}
            ${formPage(tx('wiz.form_search'))}
          </div>`;
        break;
      }
      case 'tasks':
        fields = html`<div class="form-grid">${select('context', tx('wiz.show'), defaults.context ?? 'my', TASK_CONTEXTS())}</div>
          ${check('completed', tx('wiz.also_completed_tasks'), !!defaults.completed)}
          <p class="muted small">${tx('wiz.tasks_come_from_task_definitions')}</p>`;
        break;
      case 'workflows':
        fields = html`<div class="form-grid">${select('context', tx('wiz.show'), defaults.context ?? 'initiator', [['initiator', tx('wiz.the_workflows_the_user_started')], ['admin', tx('wiz.the_workflows_the_user_administers')]])}</div>`;
        break;
      case 'dashboard': {
        const tables = (await wizardTables(role)).filter((t) => t.access);
        fields = tables.length
          ? html`<fieldset class="prop-group"><legend>${tx('wiz.tables')}</legend><div class="qb-pick">${tables.map((t, n) => html`<label class="check"><input type="checkbox" name="tables" value="${t.t}"${n < 12 ? raw(' checked') : ''}> ${t.t}</label>`)}</div></fieldset>
              <p class="muted small">${tx('wiz.a_chart_per_table_at')}</p>`
          : html`<p class="alert alert-error" role="status">${tx('wiz.the_application_s_database_role')}</p>`;
        break;
      }
      case 'master_detail': {
        const t = rel!.t;
        const details = (
          await owner.query<{ t: string; col: string }>(
            `select meta.wizard_qname(con.conrelid) as t, a.attname::text as col
               from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
              where con.confrelid = $1::regclass and con.contype = 'f' and con.conrelid <> con.confrelid and array_length(con.conkey, 1) = 1
              order by 1, 2`,
            [t],
          )
        ).rows;
        fields = details.length
          ? select('detail', tx('wiz.detail_table'), defaults.detail ? `${defaults.detail}|${defaults.detail_column}` : '', details.map((d): [string, string] => [`${d.t}|${d.col}`, `${d.t} (${d.col} → ${t})`]), tx('wiz.tables_with_a_foreign_key'))
          : html`<p class="alert alert-error" role="status">${tx('wiz.no_fk', { table: t })}</p>`;
        break;
      }
    }

    const kindDef = PAGE_KINDS.find((k) => k[0] === kind)!;
    const kindName = kindLabel(kindDef[0], kindDef[1]);
    const main = html`${appHeader(a, 'pages', s)}
      ${region(rel && kind !== 'search' ? tx('wiz.kind_on', { kind: kindName, table: rel.t }) : kindName, html`
        <p class="muted u-mt0">${kindHelp(kindDef[0], kindDef[2])} ${rel ? tx('wiz.the_proposals_come_from_the') : ''} <a href="${BASE}/apps/${a.id}/create-page">${rel ? tx('wiz.back_choose_table') : tx('wiz.back_choose')}</a>.</p>
        ${rel && needsPk && !pk ? html`<p class="alert alert-error" role="status">${tx('wiz.no_pk', { table: rel.t })}</p>` : ''}
        ${rel && role && access && !(access.s && (!(needsPk || kind === 'wizard' || kind === 'data_load') || (access.i && (kind === 'wizard' || (access.u && access.d)))))
          ? html`<p class="alert alert-error" role="status">${tx.rich(access.s ? 'wiz.role_read_only' : 'wiz.role_no_access', { role: html`<code>${role}</code>`, table: rel.t, privs: needsPk ? 'select, insert, update, delete' : kind === 'wizard' ? 'select, insert' : kind === 'data_load' ? tx('wiz.privs_merge') : 'select' })}</p>`
          : ''}
        <form method="post" action="${BASE}/apps/${a.id}/wizard">${csrf(s)}
          <input type="hidden" name="kind" value="${kind}">${rel && kind !== 'search' ? html`<input type="hidden" name="table" value="${rel.t}">` : ''}
          <div class="form-grid">
            ${input('report_page', tx('wiz.page_number'), nextPage, { type: 'number', required: true })}
            ${input('label', tx('wiz.name'), defaults.label ?? '', { help: tx('wiz.the_page_title_and_the') })}
            ${select('icon', tx('wiz.menu_icon'), defaults.icon ?? 'table', [...ICONS])}
          </div>
          ${['report_form', 'grid', 'dashboard'].includes(kind) ? '' : check('nav', tx('wiz.add_a_navigation_entry'), !!defaults.nav)}
          ${fields}
          <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}">${tx('wiz.cancel')}</a><button class="btn btn-hot">${tx('wiz.create_page')}</button></div>
        </form>`)}`;
    return send(reply, s, shell(s, tx('wiz.page_title', { app: a.name }), [[tx('wiz.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('wiz.create_page'), `${BASE}/apps/${a.id}/create-page`], [kindName]], main));
  });

  app.post(`${BASE}/apps/:id/wizard`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = KINDS.has(String(b.kind)) ? String(b.kind) : 'report_form';
    const table = kind === 'dashboard' || kind === 'tasks' || kind === 'workflows' ? '' : String(b.table ?? '');
    const retry = `${BASE}/apps/${req.params.id}/wizard?kind=${encodeURIComponent(kind)}${table && kind !== 'search' ? `&table=${encodeURIComponent(table)}` : ''}`;
    try {
      const page = pageNo(b.report_page);
      if (page === null) throw new Error(tx('wiz.enter_a_page_number'));
      const options = wizardOptions(kind, b);
      if (!table && !NO_TABLE.has(kind)) throw new Error(tx('wiz.choose_a_table_or_view'));
      const id = await owner.tx(async (c) => {
        const a = await c.query('select alias, db_role from meta.app where id = $1', [req.params.id]);
        if (!a.rowCount) throw new Error(tx('wiz.this_application_does_not_exist'));
        // report and form and grid keep their own icons and need no step 2 (older forms post here directly)
        if (kind === 'report_form' && options.form_page === null) throw new Error(tx('wiz.enter_the_form_page_number'));
        if (['report_form', 'grid'].includes(kind) && !options.icon) options.icon = kind === 'grid' ? 'grid' : 'table';
        if (kind === 'dashboard') {
          // (137) only tables the application's role can read
          const readable = new Set((await wizardTables(a.rows[0].db_role)).filter((t) => t.access).map((t) => t.t));
          const tables = (options.tables as string[]).filter((t) => readable.has(t));
          if (!tables.length) throw new Error(tx('wiz.choose_at_least_one_table'));
          const made = await addDashboard(c, a.rows[0].alias, tables, page);
          if (!made) throw new Error(tx('wiz.none_of_these_tables_has'));
          const pid = (await c.query('select id from meta.page where app_id = $1 and page_no = $2', [req.params.id, page])).rows[0].id as number;
          if (options.label) {
            await c.query('update meta.page set name = $2, title = $2 where id = $1', [pid, options.label]);
            await c.query('update meta.nav_entry set label = $3 where app_id = $1 and target_page = $2', [req.params.id, page, options.label]);
          }
          if (options.icon) await c.query('update meta.nav_entry set icon = $3 where app_id = $1 and target_page = $2', [req.params.id, page, options.icon]);
          return pid;
        }
        return (await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb) as id', [a.rows[0].alias, kind, table || null, page, JSON.stringify(options)])).rows[0].id as number;
      });
      const pages = (await owner.query('select page_no from meta.page where app_id = $1 and id >= $2 order by page_no', [req.params.id, id])).rows.map((r) => r.page_no);
      flash(s, table
        ? (pages.length > 1 ? tx('wiz.created_pages_for', { list: pages.join(', '), table }) : tx('wiz.created_page_for', { n: page, table }))
        : (pages.length > 1 ? tx('wiz.created_pages', { list: pages.join(', ') }) : tx('wiz.created_page', { n: page })));
      return back(reply, s, `${BASE}/pages/${id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, KINDS.has(String(b.kind)) && (table || NO_TABLE.has(kind)) ? retry : `${BASE}/apps/${req.params.id}`);
    }
  });
}
