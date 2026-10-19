import type { FastifyInstance } from 'fastify';
import { generate } from '../ai/service.ts';
import { AiError } from '../ai/types.ts';
import { applyBinds } from '../binds.ts';
import { appTx, owner, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { logActivity, saveState } from '../session.ts';
import { checkPageAccess, computeVisibility, Forbidden } from './authz.ts';
import { REPORT_CHART_KINDS } from './charts.ts';
import { bindValues, dbg, publicError, stripSemicolon, type PageContext } from './context.ts';
import { applyPlan, checkPlan, chipsOf, ChipRefused, editChip, planIsEmpty, removeChip, type Chip, type Column, type Kind, type Plan } from './ir-plan.ts';
import { parseQuestion, type Lookup } from './ir-phrases.ts';
import { AGGREGATES, fieldsOf, headingOf, HIGHLIGHT_COLORS, isNumeric, opLabel, OPERATORS, q, reportState, visibleColumns, withComputations } from './report.ts';
import { resolveRestRegion } from './rest-sources.ts';
import { loadContext, simplePage, txContext, type Req } from './routes.ts';

// "Ask in your own words" on an interactive report (APEX: AI interactive
// reports, 26.1/26.2). With
//   "ai_filter": {"service": "HR_ASSISTANT", "placeholder": "…", "public": false}
// in a report region's config (or "ai_filter": {} for the built-in phrases
// only), a question box sits above the report. The question becomes the
// report's own settings: filters, highlights, a search, a sort, a control
// break, aggregates, group by, a pivot, a chart and computed columns.
//
// With an AI service the question goes to it with the report's shown columns
// (names, headings, kinds) and the allowed operators and functions; the
// answer is a structured output. Without one (or when the application may
// not use it) a rule-based parser reads common phrases (ir-phrases.ts).
// Either answer is checked against the report's shown columns and whitelists
// (ir-plan.ts) and becomes the report's ordinary URL parameters, so the model
// or the parser can only set what the user could set by hand in the Actions
// menu: the report's own code builds the SQL (values as escaped literals) and
// runs it as the application's role.
//
// The settings in force are listed under the box as chips, each with Edit (a
// small form) and Remove; Undo returns to the settings before the last
// change. All are buttons of one POST form (CSRF-checked), so they work
// without JavaScript; the undo history is kept in the session.

export { type Column } from './ir-plan.ts';

export interface AiFilterConfig {
  service?: string;
  placeholder?: string;
  public?: boolean;
}

export const MAX_QUESTION_CHARS = 500;
const SERVICE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const MAX_PARAMS = 4000;
const MAX_UNDO = 5;
const MAX_CANDIDATES = 30;
const MAX_LOOKUP_COLUMNS = 12;

export function aiFilterOf(r: Region): AiFilterConfig | null {
  const c = r.config?.ai_filter;
  if (r.type !== 'report' || r.config?.interactive === false || r.config?.searchable === false) return null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (c.service !== undefined && c.service !== null && (typeof c.service !== 'string' || !SERVICE.test(c.service))) return null;
  return c as AiFilterConfig;
}

/** Problems with a report region's ai_filter setting (builder). */
export function aiFilterProblems(c: unknown): string[] {
  if (c === undefined || c === null) return [];
  if (typeof c !== 'object' || Array.isArray(c)) return ['"ai_filter" is an object: {} (built-in phrases) or {"service": "NAME"}.'];
  const x = c as Record<string, unknown>;
  const out: string[] = [];
  if (x.service !== undefined && x.service !== null && (typeof x.service !== 'string' || !SERVICE.test(x.service))) out.push('"ai_filter.service": the name of an AI service (or leave it out for the built-in phrases).');
  if (x.placeholder !== undefined && typeof x.placeholder !== 'string') out.push('"ai_filter.placeholder" is text.');
  if (x.public !== undefined && typeof x.public !== 'boolean') out.push('"ai_filter.public" is true or false.');
  return out;
}

const mayUse = (ctx: PageContext, c: AiFilterConfig) => ctx.user !== 'nobody' || ctx.app.authentication === 'none' || c.public === true;

/** May the application use the service (enabled and allowed)? */
async function available(appId: number, service: string | undefined) {
  if (!service) return false;
  return !!(await owner.one(
    `select 1 from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1 where s.name = $2 and s.enabled`,
    [appId, service.toUpperCase()],
  ));
}

const DATE_OIDS = new Set([1082, 1114, 1184]);
const kindOf = (oid: number): Kind => (isNumeric(oid) ? 'number' : DATE_OIDS.has(oid) ? 'date' : oid === 16 ? 'boolean' : 'text');

/**
 * The columns a question may use: the report's shown columns (not "hidden")
 * and its computed columns, from the query with the given URL parameters.
 * Needs ctx.client.
 */
async function askColumns(ctx: PageContext, r: Region, params: URLSearchParams) {
  await resolveRestRegion(ctx, r);
  const st = reportState({ ...ctx, params } as PageContext, r);
  const base = stripSemicolon(applyBinds(r.source ?? 'select 1', bindValues(ctx)));
  const { src } = await withComputations(ctx, r, base, st);
  const fields = await fieldsOf(ctx, src);
  const computed = new Set(st.computations.map((c) => c.name.toLowerCase()));
  const baseCount = src === base ? fields.length : (await fieldsOf(ctx, base)).length;
  const columns = visibleColumns(r, fields).map(({ f, i }): Column => ({
    name: f.name, label: headingOf(r, f.name, ctx.locale.tr), kind: kindOf(f.dataTypeID), pos: i + 1,
    ...(i >= baseCount && computed.has(f.name.toLowerCase()) ? { computed: true } : {}),
  }));
  return { columns, fieldCount: fields.length, src };
}

/** Stored values of the report's text columns matching the candidates (a query parameter): for "only clerks". */
function valueLookup(ctx: PageContext, columns: Column[], src: string): Lookup {
  return async (column, candidates) => {
    const cols = columns.filter((c) => c.kind === 'text' && !c.computed && (column === null || c.name === column)).slice(0, MAX_LOOKUP_COLUMNS);
    const cands = [...new Set(candidates.map((x) => x.slice(0, 200).replace(/\0/g, '')).filter(Boolean))].slice(0, MAX_CANDIDATES);
    if (!cols.length || !cands.length) return null;
    const c = ctx.client!;
    const res = await savepoint(c, () =>
      c.query({
        text: `select x.i, x.v from (\n${src}\n) "__q" cross join lateral (values ${cols.map((col, i) => `(${i}, ${q(col.name)}::text)`).join(', ')}) as x(i, v)
                where lower(x.v) = any($1::text[]) order by length(x.v) desc limit 1`,
        values: [cands],
      }),
    );
    const row = res.rows[0] as { i: number; v: string } | undefined;
    return row ? { column: cols[row.i].name, value: row.v, candidate: row.v.toLowerCase() } : null;
  };
}

// ------------------------------------------------------------------ the AI service's answer

/** The structured output asked for: every setting the report has, over the given columns. */
export function planSchema(columns: Column[]) {
  const names = columns.map((c) => c.name);
  const ops = Object.keys(OPERATORS);
  const fns = Object.keys(AGGREGATES);
  const agg = { type: 'object', properties: { function: { type: 'string', enum: fns }, column: { type: 'string', enum: names } }, required: ['function', 'column'], additionalProperties: false };
  return {
    type: 'object',
    properties: {
      reset: { type: 'boolean', description: 'True to clear the current settings first ("start over"); otherwise false.' },
      filters: {
        type: 'array',
        description: 'At most 5 conditions; all must hold. A filter on a column replaces that column\'s current filters.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', enum: names },
            operator: { type: 'string', enum: ops },
            value: { type: 'string', description: 'The value to compare with (a date as YYYY-MM-DD, a number without thousands separators); empty for null and not_null.' },
          },
          required: ['column', 'operator', 'value'],
          additionalProperties: false,
        },
      },
      highlights: {
        type: 'array',
        description: 'Rows to color (not to filter), at most 5.',
        items: {
          type: 'object',
          properties: { column: { type: 'string', enum: names }, operator: { type: 'string', enum: ops }, value: { type: 'string' }, color: { type: 'string', enum: HIGHLIGHT_COLORS } },
          required: ['column', 'operator', 'value', 'color'],
          additionalProperties: false,
        },
      },
      search: { type: 'string', description: 'Words to look for in every column, only when no column filter fits; otherwise empty.' },
      sort_column: { type: 'string', enum: ['', ...names], description: 'The column to sort by, or empty.' },
      sort_descending: { type: 'boolean' },
      control_break: { type: 'string', enum: ['', ...names], description: 'A column to group the rows under headings by, or empty.' },
      aggregates: { type: 'array', description: 'Totals under the report (sum and avg only on number columns).', items: agg },
      group_by: { type: 'array', description: 'Up to 3 columns for a Group By view (with group_functions); empty for none.', items: { type: 'string', enum: names } },
      group_functions: { type: 'array', description: 'The functions per group (with group_by).', items: agg },
      pivot: {
        type: ['object', 'null'],
        description: 'A pivot view: rows by one column, columns by another, a function of a value column; null for none.',
        properties: { row: { type: 'string', enum: names }, column: { type: 'string', enum: names }, function: { type: 'string', enum: fns }, value: { type: 'string', enum: names } },
        required: ['row', 'column', 'function', 'value'],
        additionalProperties: false,
      },
      chart: {
        type: ['object', 'null'],
        description: 'A chart view: a label column and a function of a value column; null for none.',
        properties: { type: { type: 'string', enum: REPORT_CHART_KINDS }, label: { type: 'string', enum: names }, function: { type: 'string', enum: fns }, value: { type: 'string', enum: names } },
        required: ['type', 'label', 'function', 'value'],
        additionalProperties: false,
      },
      computed_columns: {
        type: 'array',
        description: 'New columns computed from the others, at most 5.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A short name (letters, digits, spaces).' },
            expression: { type: 'string', description: 'An expression over the columns by name: numbers, \'text\', + - * / ||, parentheses and abs ceil floor round trunc mod power upper lower initcap length trim substr left right replace concat coalesce nullif greatest least. Not SQL.' },
          },
          required: ['name', 'expression'],
          additionalProperties: false,
        },
      },
    },
    required: ['reset', 'filters', 'highlights', 'search', 'sort_column', 'sort_descending', 'control_break', 'aggregates', 'group_by', 'group_functions', 'pivot', 'chart', 'computed_columns'],
    additionalProperties: false,
  };
}

/** (sprint 36 name) the structured output's schema */
export const filterSchema = planSchema;

const OPERATOR_TEXT: Record<string, string> = {
  eq: 'equals', ne: 'differs from', contains: 'contains the text (case-insensitive)', not_contains: 'does not contain the text',
  gt: 'is greater than (later than, for dates)', ge: 'is at least', lt: 'is less than (earlier than, for dates)', le: 'is at most',
  null: 'is empty', not_null: 'is not empty',
};

export function planSystem(columns: Column[], today: string, current: string) {
  return [
    'You turn a request about a report into the report\'s settings: filters, highlights, a search, a sort, a control break, totals, a group by, a pivot, a chart and computed columns. Answer only with the requested JSON; leave out what wasn\'t asked for (empty lists, empty strings, null).',
    'Use only these columns (name: heading, kind):',
    ...columns.map((c) => `- ${c.name}: ${c.label.replace(/\s+/g, ' ')}, ${c.kind}${c.computed ? ' (computed)' : ''}`),
    'Operators:',
    ...Object.keys(OPERATORS).map((op) => `- ${op}: ${OPERATOR_TEXT[op] ?? op}`),
    `Functions: ${Object.keys(AGGREGATES).join(', ')} (sum and avg need a number column).`,
    `Today is ${today}. For "this year", "last month" and the like, use date bounds with ge and le.`,
    'Text values are compared as they are stored: if unsure of the exact spelling, prefer contains. When the request asks for something the columns can\'t express, leave it out.',
    current ? `The report's current settings (the request may refine them): ${current}` : 'The report has no settings yet.',
  ].join('\n');
}

export const filterSystem = (columns: Column[], today: string) => planSystem(columns, today, '');

/** (sprint 36 name) the answer checked: only known columns, operators and functions */
export const checkAnswer = (json: unknown, columns: Column[]) => checkPlan(json, columns);

// ------------------------------------------------------------------ texts

type T = PageContext['locale']['t'];

function describePlan(p: Plan, t: T, label: (n: string) => string) {
  return [
    ...(p.reset ? [t('report.reset')] : []),
    ...p.filters.map((f) => `${label(f.column)} ${opLabel(t, f.operator)}${f.value ? ` ${f.value}` : ''}`),
    ...(p.search ? [`"${p.search}"`] : []),
    ...(p.sort ? [t('ai_filter.sort', { column: `${p.sort.label}${p.desc ? ' ↓' : ''}` })] : []),
    ...p.highlights.map((h) => `${t('report.highlight')}: ${label(h.column)} ${opLabel(t, h.operator)}${h.value ? ` ${h.value}` : ''}`),
    ...(p.breakCol ? [`${t('report.break')}: ${label(p.breakCol)}`] : []),
    ...p.aggregates.map((a) => `${t(`agg.${a.fn}`)}: ${label(a.column)}`),
    ...(p.groupBy.length ? [`${t('report.group_by')}: ${p.groupBy.map(label).join(', ')}`] : []),
    ...p.groupFunctions.map((a) => `${t(`agg.${a.fn}`)}: ${label(a.column)}`),
    ...(p.pivot ? [`${t('report.pivot')}: ${label(p.pivot.row)} × ${label(p.pivot.column)}`] : []),
    ...(p.chart ? [`${t('report.chart')}: ${t(`chart.${p.chart.kind}`)}, ${label(p.chart.label)}`] : []),
    ...p.computed.map((c) => `${c.name} = ${c.expr}`),
  ].join('; ');
}

/** A chip's text (plain: it is escaped where it is used). */
function chipText(chip: Chip, t: T, label: (n: string) => string, byPos: (pos: number) => string) {
  const cond = (column: string, op: string, value: string) => `${label(column)} ${opLabel(t, op)}${OPERATORS[op]?.noValue ? '' : ` ${value}`}`;
  switch (chip.kind) {
    case 'search': return `${t('report.search_chip')}${chip.column ? ` ${label(chip.column)}:` : ''} ${chip.value}`;
    case 'filter': return cond(chip.column, chip.op, chip.value);
    case 'highlight': return `${t('report.highlight')} (${t(`color.${chip.color}`)}): ${cond(chip.column, chip.op, chip.value)}`;
    case 'sort': return t('ai_filter.sort', { column: `${byPos(chip.pos)}${chip.desc ? ' ↓' : ''}` });
    case 'break': return `${t('report.break')}: ${label(chip.column)}`;
    case 'aggregate': return `${t(`agg.${chip.fn}`)}: ${label(chip.column)}`;
    case 'compute': return `${chip.name} = ${chip.expr}`;
    case 'group': return `${t('report.group_by')}: ${label(chip.column)}`;
    case 'groupfn': return t('ai_filter.per_group', { what: `${t(`agg.${chip.fn}`)}: ${label(chip.column)}` });
    case 'pivot': return `${t('report.pivot')}: ${label(chip.row)} × ${label(chip.column)}, ${t(`agg.${chip.fn}`)}: ${label(chip.value)}`;
    case 'chart': return `${t('report.chart')}: ${t(`chart.${chip.type}`)}, ${label(chip.label)}, ${t(`agg.${chip.fn}`)}: ${label(chip.value)}`;
    case 'hide': return `${t('report.hidden_column')}: ${label(chip.column)}`;
    case 'area': case 'near': return t('report.map_area');
  }
}

// ------------------------------------------------------------------ rendering

/** The "Ask in your own words" box above a report, with the report's settings as chips ('' when the report has none). */
export async function renderAiFilter(ctx: PageContext, r: Region): Promise<Raw | ''> {
  const c = aiFilterOf(r);
  if (!c || !mayUse(ctx, c)) return '';
  const t = ctx.locale.t;
  const form = `aif${r.id}`;
  const chipForm = `aic${r.id}`;
  // the user's last question is in the box: never share a cached copy of the region between users
  ctx.userBound = true;
  const params = ctx.params.toString().slice(0, MAX_PARAMS);
  ctx.detached.push(html`<form id="${form}" method="post" action="${ctx.base}/${ctx.page.page_no}/report/${r.id}/ask">
    <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="params" value="${params}"></form>`);

  // the chips: the report's settings in the URL, each with Edit and Remove
  const chips = chipsOf(ctx.params, r.id);
  let columns: Column[] = [];
  if (chips.length && ctx.client)
    try {
      columns = (await savepoint(ctx.client, () => askColumns(ctx, r, ctx.params))).columns;
    } catch {
      // the report shows its own error; the chips can still be removed
    }
  const label = (n: string) => columns.find((x) => x.name === n)?.label ?? headingOf(r, n, ctx.locale.tr);
  const byPos = (pos: number) => columns.find((x) => x.pos === pos)?.label ?? `#${pos}`;
  const undo = !!ctx.session.state[`__AIU${r.id}`];
  if (chips.length || undo) {
    ctx.askChips ??= new Set();
    ctx.askChips.add(r.id);
    ctx.detached.push(html`<form id="${chipForm}" method="post" action="${ctx.base}/${ctx.page.page_no}/report/${r.id}/chips">
      <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="params" value="${params}">${chips.map((ch, i) => html`<input type="hidden" name="k${i}" value="${ch.key}">`)}</form>`);
  }
  const f = (i: number, n: string) => `e${i}_${n}`;
  const id = (i: number, n: string) => `${chipForm}_${i}_${n}`;
  const field = (i: number, n: string, text: string, control: Raw) => html`<span class="ask-field"><label for="${id(i, n)}">${text}</label>${control}</span>`;
  const colSelect = (i: number, n: string, text: string, selected: string, only: (c: Column) => boolean = () => true) =>
    field(i, n, text, html`<select id="${id(i, n)}" name="${f(i, n)}" form="${chipForm}">${columns.filter(only).map((x) => html`<option value="${x.name}"${x.name === selected ? raw(' selected') : ''}>${x.label}</option>`)}</select>`);
  const listSelect = (i: number, n: string, text: string, selected: string, options: [string, string][]) =>
    field(i, n, text, html`<select id="${id(i, n)}" name="${f(i, n)}" form="${chipForm}">${options.map(([v, l]) => html`<option value="${v}"${v === selected ? raw(' selected') : ''}>${l}</option>`)}</select>`);
  const input = (i: number, n: string, text: string, value: string, max = 200) =>
    field(i, n, text, html`<input id="${id(i, n)}" name="${f(i, n)}" form="${chipForm}" value="${value}" maxlength="${max}">`);
  const ops = (i: number, selected: string) => listSelect(i, 'b', t('report.operator'), selected, Object.keys(OPERATORS).map((o) => [o, opLabel(t, o)]));
  const fns = (i: number, n: string, selected: string) => listSelect(i, n, t('report.function'), selected, Object.keys(AGGREGATES).map((x) => [x, t(`agg.${x}`)]));
  const editor = (ch: Chip, i: number): Raw | '' => {
    if (!columns.length) return '';
    switch (ch.kind) {
      case 'search': return input(i, 'a', t('report.search'), ch.value);
      case 'filter': return html`${colSelect(i, 'a', t('report.column'), ch.column)}${ops(i, ch.op)}${input(i, 'c', t('report.value'), ch.value)}`;
      case 'highlight': return html`${colSelect(i, 'a', t('report.column'), ch.column)}${ops(i, ch.op)}${input(i, 'c', t('report.value'), ch.value)}${listSelect(i, 'd', t('report.color'), ch.color, HIGHLIGHT_COLORS.map((x) => [x, t(`color.${x}`)]))}`;
      case 'sort': return html`${colSelect(i, 'a', t('report.column'), columns.find((x) => x.pos === ch.pos)?.name ?? '', (x) => x.pos > 0)}${listSelect(i, 'b', t('report.sort'), ch.desc ? 'desc' : 'asc', [['asc', t('report.sort_asc')], ['desc', t('report.sort_desc')]])}`;
      case 'break': case 'group': return colSelect(i, 'a', t('report.column'), ch.column);
      case 'aggregate': case 'groupfn': return html`${fns(i, 'a', ch.fn)}${colSelect(i, 'b', t('report.column'), ch.column)}`;
      case 'pivot': return html`${colSelect(i, 'a', t('report.pivot_row'), ch.row)}${colSelect(i, 'b', t('report.pivot_column'), ch.column)}${fns(i, 'c', ch.fn)}${colSelect(i, 'd', t('report.value_column'), ch.value)}`;
      case 'chart': return html`${listSelect(i, 'a', t('report.chart_type'), ch.type, REPORT_CHART_KINDS.map((k) => [k, t(`chart.${k}`)]))}${colSelect(i, 'b', t('report.label_column'), ch.label)}${fns(i, 'c', ch.fn)}${colSelect(i, 'd', t('report.value_column'), ch.value)}`;
      case 'compute': return html`${input(i, 'a', t('report.compute_name'), ch.name, 40)}${input(i, 'b', t('report.compute_expr'), ch.expr, 500)}`;
      default: return '';
    }
  };
  const items = chips.map((ch, i) => {
    const text = chipText(ch, t, label, byPos);
    const edit = editor(ch, i);
    return html`<li class="chip ask-chip"><span class="ask-chip-text">${text}</span>${edit
      ? html`<details class="ask-edit"><summary aria-label="${t('ai_filter.edit')}: ${text}">${t('ai_filter.edit')}</summary><div class="ask-edit-body">${edit}<button class="btn" name="edit" value="${i}" form="${chipForm}">${t('report.apply')}</button></div></details>`
      : ''}<button class="ask-chip-x" name="remove" value="${i}" form="${chipForm}" aria-label="${t('ai_filter.remove', { what: text })}" title="${t('report.remove')}">×</button></li>`;
  });
  return html`<div class="ai-filter">
    <label class="label" for="${form}_q">${t('ai_filter.label')}</label>
    <div class="ai-filter-row">
      <input id="${form}_q" name="question" form="${form}" maxlength="${MAX_QUESTION_CHARS}" required value="${ctx.session.state[`__AIQ${r.id}`] ?? ''}" placeholder="${c.placeholder ? ctx.locale.tr(c.placeholder) : t('ai_filter.placeholder')}">
      <button class="btn" form="${form}" data-busy="${t('assistant.thinking')}">${t('ai_filter.ask')}</button>
      ${undo ? html`<button class="btn" name="undo" value="1" form="${chipForm}">${t('ai_filter.undo')}</button>` : ''}
    </div>
    ${chips.length ? html`<ul class="chips ask-chips" aria-label="${t('ai_filter.chips')}">${items}</ul>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ routes

/** Remember the settings before a change (Undo), at most MAX_UNDO steps. */
function pushUndo(ctx: PageContext, rid: number, before: string) {
  const k = `__AIU${rid}`;
  let stack: unknown;
  try {
    stack = JSON.parse(ctx.session.state[k] ?? '[]');
  } catch {
    stack = [];
  }
  const list = Array.isArray(stack) ? stack.filter((x): x is string => typeof x === 'string') : [];
  list.push(before.slice(0, MAX_PARAMS));
  ctx.session.state[k] = JSON.stringify(list.slice(-MAX_UNDO));
}

function popUndo(ctx: PageContext, rid: number): string | null {
  const k = `__AIU${rid}`;
  let stack: unknown;
  try {
    stack = JSON.parse(ctx.session.state[k] ?? '[]');
  } catch {
    stack = [];
  }
  if (!Array.isArray(stack) || !stack.length) return null;
  const prev = stack.pop();
  ctx.session.state[k] = stack.length ? JSON.stringify(stack) : null;
  return typeof prev === 'string' ? prev : null;
}

export async function aiFilterRoutes(app: FastifyInstance) {
  type Reply = Parameters<typeof loadContext>[1];
  /** The request's context, region and settings, or null when a refusal was sent. */
  const prepare = async (req: Req, reply: Reply, what: string) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return null;
    const t = ctx.locale.t;
    const body = req.body ?? {};
    const refuse = (detail: string) => {
      logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail });
      return simplePage(reply, 403, t('error.access_denied'), t(detail.includes('csrf') ? 'error.session_reload' : 'error.report_unavailable'), `${ctx.base}/${ctx.page.page_no}`, ctx.locale);
    };
    if (typeof body.__csrf !== 'string' || body.__csrf !== ctx.session.csrf_token) return { refused: refuse(`${what}: csrf`) };
    const r = ctx.page.regions.find((x) => x.id === Number(req.params.id) && x.type === 'report');
    const conf = r ? aiFilterOf(r) : null;
    if (!r || !conf) return { refused: refuse(`${what}: region ${req.params.id} on page ${ctx.page.page_no}`) };
    if (!mayUse(ctx, conf)) return { refused: refuse(`${what}: region ${r.id}: not signed in`) };
    const params = new URLSearchParams(typeof body.params === 'string' ? body.params.slice(0, MAX_PARAMS) : '');
    return { ctx, r, conf, body, params, refuse };
  };
  /** Inside the application's transaction, with the page's access and the region's condition checked. */
  const inRegion = <X>(ctx: PageContext, r: Region, fn: () => Promise<X>) =>
    appTx(txContext(ctx), async (c) => {
      ctx.client = c;
      try {
        await checkPageAccess(ctx);
        ctx.vis = await computeVisibility(ctx);
        if (!ctx.vis.regions.has(r.id)) throw new Forbidden('region');
        return await fn();
      } finally {
        ctx.client = undefined;
      }
    });
  const back = (reply: Reply, ctx: PageContext, rid: number, params: URLSearchParams) => {
    const qs = params.toString();
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}${qs ? `?${qs}` : ''}#R${rid}`, 303);
  };

  app.post('/a/:alias/:page/report/:id/ask', async (req: Req, reply) => {
    const p = await prepare(req, reply, 'ai filter');
    if (!p) return;
    if ('refused' in p) return p.refused;
    const { ctx, r, conf, body, params, refuse } = p;
    const t = ctx.locale.t;
    const before = params.toString();
    const question = typeof body.question === 'string' ? body.question.replace(/\s+/g, ' ').trim() : '';
    try {
      if (!question || question.length > MAX_QUESTION_CHARS) throw new AiError('config', t('assistant.too_long', { max: String(MAX_QUESTION_CHARS) }));
      ctx.session.state[`__AIQ${r.id}`] = question;
      const useService = await available(ctx.app.id, conf.service);
      const { columns, fieldCount, parsed } = await inRegion(ctx, r, async () => {
        const { columns, fieldCount, src } = await askColumns(ctx, r, params);
        // without an AI service: the built-in phrases, values looked up in the report's own rows
        const parsed = useService ? null : await parseQuestion(question, columns, ctx.locale.lang, valueLookup(ctx, columns, src));
        return { columns, fieldCount, parsed };
      });
      const label = (name: string) => columns.find((c) => c.name === name)?.label ?? name;
      let plan: Plan;
      if (parsed) {
        plan = checkPlan(parsed.plan, columns, fieldCount);
        dbg(ctx, 6, 'ai', () => `report settings from the phrases: ${JSON.stringify(plan)}; not understood: ${JSON.stringify(parsed.left)}`);
        if (planIsEmpty(plan)) throw new AiError('output', [t('ai_filter.no_match'), ...(parsed.left.length ? [t('ai_filter.not_understood', { what: parsed.left.join('; ') })] : [])].join(' '));
      } else {
        const current = chipsOf(params, r.id).map((ch) => chipText(ch, t, label, (pos) => columns.find((c) => c.pos === pos)?.label ?? `#${pos}`)).join('; ');
        const res = await generate(conf.service!, { system: planSystem(columns, new Date().toISOString().slice(0, 10), current), prompt: question, schema: planSchema(columns), maxTokens: 3000 }, {
          appId: ctx.app.id, pageNo: ctx.page.page_no, user: ctx.user, source: 'nl2ir', debug: (l, x) => dbg(ctx, l, 'ai', x),
        });
        plan = checkPlan(res.json, columns, fieldCount);
        dbg(ctx, 6, 'ai', () => `report settings from the question: ${JSON.stringify(plan)}`);
        if (planIsEmpty(plan)) throw new AiError('output', t('ai_filter.nothing'));
      }
      applyPlan(params, r.id, plan);
      if (params.toString() !== before) pushUndo(ctx, r.id, before);
      ctx.session.state.__FLASH = [t('ai_filter.applied', { what: describePlan(plan, t, label) }), ...(parsed?.left.length ? [t('ai_filter.not_understood', { what: parsed.left.join('; ') })] : [])].join(' ');
    } catch (e) {
      if (e instanceof Forbidden) return refuse(`ai filter: region ${r.id} on page ${ctx.page.page_no}`);
      ctx.session.state.__FLASH_ERROR = e instanceof AiError ? e.message : await publicError(ctx, e, 'AI report filter');
    }
    await saveState(ctx.session);
    return back(reply, ctx, r.id, params);
  });

  // a chip's Edit or Remove, or Undo
  app.post('/a/:alias/:page/report/:id/chips', async (req: Req, reply) => {
    const p = await prepare(req, reply, 'report chips');
    if (!p) return;
    if ('refused' in p) return p.refused;
    const { ctx, r, body, params, refuse } = p;
    const t = ctx.locale.t;
    const before = params.toString();
    if (body.undo !== undefined) {
      const prev = popUndo(ctx, r.id);
      await saveState(ctx.session);
      return back(reply, ctx, r.id, prev === null ? params : new URLSearchParams(prev));
    }
    const chips = chipsOf(params, r.id);
    const which = typeof body.edit === 'string' ? body.edit : typeof body.remove === 'string' ? body.remove : '';
    const i = /^\d{1,3}$/.test(which) ? Number(which) : -1;
    const chip = chips[i];
    // the chip must be the one the form showed (its key), or the form was tampered with
    if (!chip || body[`k${i}`] !== chip.key) return refuse(`report chips: region ${r.id}: chip ${which.slice(0, 10)}`);
    try {
      if (typeof body.edit === 'string') {
        const field = (n: string) => (typeof body[`e${i}_${n}`] === 'string' ? (body[`e${i}_${n}`] as string) : '');
        const { columns } = await inRegion(ctx, r, () => askColumns(ctx, r, params));
        editChip(params, r.id, chip, { a: field('a'), b: field('b'), c: field('c'), d: field('d'), e: field('e') }, columns, (fn) => t('ai_filter.needs_number', { fn: t(`agg.${fn}`) }));
      } else removeChip(params, r.id, chip);
    } catch (e) {
      if (e instanceof Forbidden || (e instanceof ChipRefused && e.tampered)) return refuse(`report chips: region ${r.id}: ${e.message}`);
      ctx.session.state.__FLASH_ERROR = e instanceof ChipRefused ? t('ai_filter.invalid', { why: e.message }) : await publicError(ctx, e, 'report chips');
      await saveState(ctx.session);
      return back(reply, ctx, r.id, new URLSearchParams(before));
    }
    if (params.toString() !== before) pushUndo(ctx, r.id, before);
    await saveState(ctx.session);
    return back(reply, ctx, r.id, params);
  });
}
