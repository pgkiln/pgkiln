import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { ICONS } from '../icons.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

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
const KINDS = new Set(WIZARD_KINDS.map((k) => k[0]));
const CHART_KINDS = ['bar', 'column', 'line', 'area', 'donut', 'pie', 'funnel'];
const FUNCTIONS: [string, string][] = [['count', 'Count'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Minimum'], ['max', 'Maximum']];

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
      o.function = FUNCTIONS.some(([f]) => f === str('function')) ? str('function') : 'count';
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
    const rel = KINDS.has(kind) && table
      ? await owner.one<{ t: string; relkind: string }>(
          `select meta.wizard_qname(c.oid) as t, c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.oid = to_regclass($1) and c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')`,
          [table],
        )
      : null;
    if (!rel) {
      flash(s, KINDS.has(kind) ? 'Choose a table or view.' : 'Choose a page type.', 'error');
      return back(reply, s, `${BASE}/apps/${a.id}`);
    }
    const [cols, defaults] = await Promise.all([
      owner.query<Col>('select * from meta.wizard_catalog($1::regclass)', [rel.t]).then((r) => r.rows),
      owner.one<{ d: Record<string, any> }>('select meta.wizard_defaults($1, $2::regclass) as d', [kind, rel.t]).then((r) => r?.d ?? {}),
    ]);
    const nextPage = await freePage(a.id, Math.max(0, ...(await owner.query('select page_no from meta.page where app_id = $1', [a.id])).rows.map((p) => p.page_no)) + 1);
    const pk = cols.find((c) => c.is_pk)?.column_name ?? null;
    const role = a.db_role as string | null;
    const access = role
      ? await owner.one<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
          `select has_table_privilege($1, $2::regclass, 'select') as s, has_table_privilege($1, $2::regclass, 'insert') as i,
                  has_table_privilege($1, $2::regclass, 'update') as u, has_table_privilege($1, $2::regclass, 'delete') as d
            where exists (select 1 from pg_roles where rolname = $1)`,
          [role, rel.t],
        )
      : null;

    const none: [string, string] = ['', '- none -'];
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
    const formPage = (help: string) => input('form_page', 'Form page', '', { type: 'number', placeholder: `e.g. ${nextPage + 1} (empty: no form)`, help });
    const needsPk = ['report_form', 'grid', 'form', 'master_detail'].includes(kind);

    let fields: Raw | string = '';
    switch (kind) {
      case 'report_form':
        fields = input('form_page', 'Form page', nextPage + 1, { type: 'number', required: true, help: 'The modal form page opened from the report.' });
        break;
      case 'form':
        fields = html`<div class="form-grid">
            ${select('mode', 'Page mode', defaults.mode, [['normal', 'Normal page'], ['modal', 'Modal dialog']])}
            ${input('return_page', 'After saving or cancelling, go to page', defaults.return_page ?? '', { type: 'number', placeholder: a.home_page ? `empty: the home page (${a.home_page})` : 'empty: this page', help: 'Cancel, Create, Apply Changes and Delete return there.' })}
          </div>
          ${colChecks('columns', 'Columns', defaults.columns ?? [], (c) => !c.is_pk && !c.generated && c.kind !== 'binary', (c) => (c.not_null && !c.has_default ? ', required: always included' : c.fk_table ? `, a select list of ${c.fk_table}` : ''))}`;
        break;
      case 'cards':
        fields = html`<div class="form-grid">
            ${select('title', 'Title', defaults.title, colOpts(notBinary, false))}
            ${select('subtitle', 'Subtitle', defaults.subtitle ?? '', colOpts(notBinary))}
            ${select('body', 'Body', defaults.body ?? '', colOpts(notBinary))}
            ${select('badge', 'Badge', defaults.badge ?? '', colOpts(notBinary))}
            ${pk ? formPage('A modal form page for a card (a link on each card and a Create button).') : ''}
          </div>`;
        break;
      case 'calendar':
        fields = html`<div class="form-grid">
            ${select('start', 'Start date', defaults.start ?? '', colOpts((c) => c.kind === 'date' || c.kind === 'timestamp', false))}
            ${select('end', 'End date', defaults.end ?? '', colOpts((c) => c.kind === 'date' || c.kind === 'timestamp'))}
            ${select('title', 'Event title', defaults.title ?? '', colOpts(notBinary))}
            ${pk ? formPage('A modal form page: each event links to it, and a + on every day creates an event there.') : ''}
          </div>
          ${pk ? check('drag', 'Drag and drop', !!defaults.drag, 'Users who see the calendar can move events to another day or hour (an UPDATE of the start and end columns as the app\'s role; row level security applies). Set an authorization in the region\'s "move_authz" to limit it.') : ''}`;
        break;
      case 'chart':
        fields = html`<div class="form-grid">
            ${select('chart', 'Chart type', defaults.chart, CHART_KINDS)}
            ${select('label_column', 'Label (one bar, slice or point per value)', defaults.label_column ?? '', colOpts(notBinary, false))}
            ${select('function', 'Value', defaults.function, FUNCTIONS)}
            ${select('value_column', 'Of column', defaults.value_column ?? '', colOpts((c) => c.kind === 'number'), 'Count: empty counts the rows. Sum, average, minimum and maximum need a number column.')}
          </div>`;
        break;
      case 'map':
        fields = html`<div class="form-grid">
            ${select('location', 'Position', defaults.location ?? '', colOpts((c) => c.kind === 'geometry' || c.kind === 'point' || c.kind === 'text'), 'A PostGIS geometry, a point, or text "latitude,longitude" (a location item). Empty: the latitude and longitude columns.')}
            ${select('lat', 'Latitude', defaults.lat ?? '', colOpts((c) => c.kind === 'number'))}
            ${select('lng', 'Longitude', defaults.lng ?? '', colOpts((c) => c.kind === 'number'))}
            ${select('title', 'Popup title', defaults.title ?? '', colOpts(notBinary))}
            ${select('body', 'Popup text', defaults.body ?? '', colOpts(notBinary))}
            ${pk ? formPage('A modal form page, linked from the popups and the list.') : ''}
          </div>
          ${check('report', 'A list below the map', defaults.report !== false, 'An interactive report of the same rows; moving the map offers "Show this area in the list".')}`;
        break;
      case 'facets':
        fields = html`
          ${colChecks('columns', 'Report columns', defaults.columns ?? [], notBinary, (c) => (c.is_pk ? ', key: always included' : c.fk_table && c.fk_display ? `, with ${c.fk_table}.${c.fk_display}` : ''))}
          ${colChecks('facets', 'Facets', defaults.facets ?? [], (c) => notBinary(c) && c.kind !== 'point' && c.kind !== 'other', (c) => (c.fk_table ? `: values of ${c.fk_table}.${c.fk_display ?? c.column_name}` : ['number', 'date', 'timestamp'].includes(c.kind) ? ': a range (from / to)' : ': values with counts'))}
          ${check('search', 'A search field above the facets', defaults.search !== false)}
          ${pk ? html`<div class="form-grid">${formPage('A modal form page, linked from each row, and a Create button.')}</div>` : ''}`;
        break;
      case 'master_detail': {
        const details = (
          await owner.query<{ t: string; col: string }>(
            `select meta.wizard_qname(con.conrelid) as t, a.attname::text as col
               from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
              where con.confrelid = $1::regclass and con.contype = 'f' and con.conrelid <> con.confrelid and array_length(con.conkey, 1) = 1
              order by 1, 2`,
            [rel.t],
          )
        ).rows;
        fields = details.length
          ? select('detail', 'Detail table', defaults.detail ? `${defaults.detail}|${defaults.detail_column}` : '', details.map((d): [string, string] => [`${d.t}|${d.col}`, `${d.t} (${d.col} → ${rel.t})`]), 'Tables with a foreign key to this table. Selecting a master row shows its details; new detail rows get the master\'s key.')
          : html`<p class="alert alert-error" role="status">No table has a foreign key to ${rel.t}: a master-detail page needs one.</p>`;
        break;
      }
    }

    const kindName = WIZARD_KINDS.find((k) => k[0] === kind)![1];
    const main = html`${appHeader(a, 'pages')}
      ${region(`${kindName} on ${rel.t}`, html`
        <p class="muted u-mt0">${WIZARD_KINDS.find((k) => k[0] === kind)![2]} The proposals come from the table's columns, key and foreign keys; change them below. <a href="${BASE}/apps/${a.id}">Back to choose another type or table</a>.</p>
        ${needsPk && !pk ? html`<p class="alert alert-error" role="status">${rel.t} has no single-column primary key, which this page type needs.</p>` : ''}
        ${role && access && !(access.s && (!needsPk || (access.i && access.u && access.d)))
          ? html`<p class="alert alert-error" role="status">The application's database role <code>${role}</code> ${access.s ? 'can read but not change' : 'has no access to'} ${rel.t}: grant it the privileges the page needs (${needsPk ? 'select, insert, update, delete' : 'select'}).</p>`
          : ''}
        <form method="post" action="${BASE}/apps/${a.id}/wizard">${csrf(s)}
          <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="table" value="${rel.t}">
          <div class="form-grid">
            ${input('report_page', 'Page number', nextPage, { type: 'number', required: true })}
            ${input('label', 'Name', defaults.label ?? '', { help: 'The page title and the navigation entry.' })}
            ${select('icon', 'Menu icon', defaults.icon ?? 'table', [...ICONS])}
          </div>
          ${['report_form', 'grid'].includes(kind) ? '' : check('nav', 'Add a navigation entry', !!defaults.nav)}
          ${fields}
          <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}">Cancel</a><button class="btn btn-hot">Create page</button></div>
        </form>`)}`;
    return send(reply, s, shell(s, `Create page · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], [`Create ${kindName.toLowerCase()} page`]], main));
  });

  app.post(`${BASE}/apps/:id/wizard`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = KINDS.has(String(b.kind)) ? String(b.kind) : 'report_form';
    const table = String(b.table ?? '');
    const retry = `${BASE}/apps/${req.params.id}/wizard?kind=${encodeURIComponent(kind)}&table=${encodeURIComponent(table)}`;
    try {
      const page = pageNo(b.report_page);
      if (page === null) throw new Error('Enter a page number.');
      const options = wizardOptions(kind, b);
      const id = await owner.tx(async (c) => {
        const a = await c.query('select alias from meta.app where id = $1', [req.params.id]);
        if (!a.rowCount) throw new Error('This application does not exist.');
        // report and form and grid keep their own icons and need no step 2 (older forms post here directly)
        if (kind === 'report_form' && options.form_page === null) throw new Error('Enter the form page number.');
        if (['report_form', 'grid'].includes(kind) && !options.icon) options.icon = kind === 'grid' ? 'grid' : 'table';
        return (await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb) as id', [a.rows[0].alias, kind, table, page, JSON.stringify(options)])).rows[0].id as number;
      });
      const pages = (await owner.query('select page_no from meta.page where app_id = $1 and id >= $2 order by page_no', [req.params.id, id])).rows.map((r) => r.page_no);
      flash(s, `${pages.length > 1 ? `Pages ${pages.join(' and ')}` : `Page ${page}`} created for ${table}. Make sure the app's database role has privileges on it.`);
      return back(reply, s, `${BASE}/pages/${id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, KINDS.has(String(b.kind)) && table ? retry : `${BASE}/apps/${req.params.id}`);
    }
  });
}
