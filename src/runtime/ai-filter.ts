import type { FastifyInstance } from 'fastify';
import { generate, type CallInfo } from '../ai/service.ts';
import { AiError } from '../ai/types.ts';
import { applyBinds } from '../binds.ts';
import { appTx, owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { logActivity, saveState } from '../session.ts';
import { checkPageAccess, computeVisibility, Forbidden } from './authz.ts';
import { bindValues, dbg, publicError, stripSemicolon, type PageContext } from './context.ts';
import { fieldsOf, headingOf, isNumeric, opLabel, OPERATORS, visibleColumns } from './report.ts';
import { resolveRestRegion } from './rest-sources.ts';
import { loadContext, simplePage, txContext, type Req } from './routes.ts';

// Natural-language filters on an interactive report (APEX: NL2IR). With
//   "ai_filter": {"service": "HR_ASSISTANT", "placeholder": "…", "public": false}
// in a report region's config, an "Ask in your own words" box sits above the
// report. The question goes to the AI service with the report's columns
// (names, headings, kinds) and the report's operators; the answer is a
// structured output (filters, a search text, a sort) that is checked
// against those columns and operators and becomes the report's ordinary
// URL parameters (r<id>_f, r<id>_q, r<id>_s, r<id>_d). So the model can only
// produce what the user could set by hand in the Actions menu: the report's
// own code builds the SQL (values as escaped literals) and runs it as the
// application's role.

export interface AiFilterConfig {
  service?: string;
  placeholder?: string;
  public?: boolean;
}

export const MAX_QUESTION_CHARS = 500;
const MAX_FILTERS = 5;
const SERVICE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

export function aiFilterOf(r: Region): AiFilterConfig | null {
  const c = r.config?.ai_filter;
  if (r.type !== 'report' || r.config?.interactive === false || r.config?.searchable === false) return null;
  return c && typeof c === 'object' && !Array.isArray(c) && typeof c.service === 'string' && SERVICE.test(c.service) ? (c as AiFilterConfig) : null;
}

/** Problems with a report region's ai_filter setting (builder). */
export function aiFilterProblems(c: unknown): string[] {
  if (c === undefined || c === null) return [];
  if (typeof c !== 'object' || Array.isArray(c)) return ['"ai_filter" is an object: {"service": "NAME"}.'];
  const x = c as Record<string, unknown>;
  const out: string[] = [];
  if (typeof x.service !== 'string' || !SERVICE.test(x.service)) out.push('"ai_filter.service": the name of an AI service.');
  if (x.placeholder !== undefined && typeof x.placeholder !== 'string') out.push('"ai_filter.placeholder" is text.');
  if (x.public !== undefined && typeof x.public !== 'boolean') out.push('"ai_filter.public" is true or false.');
  return out;
}

const mayUse = (ctx: PageContext, c: AiFilterConfig) => ctx.user !== 'nobody' || ctx.app.authentication === 'none' || c.public === true;

/** May the application use the service (enabled and allowed)? */
async function available(appId: number, service: string) {
  return !!(await owner.one(
    `select 1 from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1 where s.name = $2 and s.enabled`,
    [appId, service.toUpperCase()],
  ));
}

/** The "Ask in your own words" box above a report ('' when the report has none). */
export async function renderAiFilter(ctx: PageContext, r: Region): Promise<Raw | ''> {
  const c = aiFilterOf(r);
  if (!c || !mayUse(ctx, c) || !(await available(ctx.app.id, c.service!))) return '';
  const t = ctx.locale.t;
  const form = `aif${r.id}`;
  // the user's last question is in the box: never share a cached copy of the region between users
  ctx.userBound = true;
  ctx.detached.push(html`<form id="${form}" method="post" action="${ctx.base}/${ctx.page.page_no}/report/${r.id}/ask">
    <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="params" value="${ctx.params.toString().slice(0, 4000)}"></form>`);
  return html`<div class="ai-filter">
    <label class="label" for="${form}_q">${t('ai_filter.label')}</label>
    <div class="ai-filter-row">
      <input id="${form}_q" name="question" form="${form}" maxlength="${MAX_QUESTION_CHARS}" required value="${ctx.session.state[`__AIQ${r.id}`] ?? ''}" placeholder="${c.placeholder ? ctx.locale.tr(c.placeholder) : t('ai_filter.placeholder')}">
      <button class="btn" form="${form}" data-busy="${t('assistant.thinking')}">${t('ai_filter.ask')}</button>
    </div>
  </div>`;
}

type Kind = 'number' | 'date' | 'text' | 'boolean';
const DATE_OIDS = new Set([1082, 1114, 1184]);
const kindOf = (oid: number): Kind => (isNumeric(oid) ? 'number' : DATE_OIDS.has(oid) ? 'date' : oid === 16 ? 'boolean' : 'text');

interface Column {
  name: string;
  label: string;
  kind: Kind;
  /** position in the report's query (ORDER BY n) */
  pos: number;
}

/** The structured output asked for: filters, search and sort over the given columns. */
export function filterSchema(columns: Column[]) {
  const names = columns.map((c) => c.name);
  return {
    type: 'object',
    properties: {
      filters: {
        type: 'array',
        description: `At most ${MAX_FILTERS} conditions; all must hold.`,
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', enum: names },
            operator: { type: 'string', enum: Object.keys(OPERATORS) },
            value: { type: 'string', description: 'The value to compare with (a date as YYYY-MM-DD, a number without thousands separators); empty for null and not_null.' },
          },
          required: ['column', 'operator', 'value'],
          additionalProperties: false,
        },
      },
      search: { type: 'string', description: 'Words to look for in every column, only when no column filter fits; otherwise empty.' },
      sort_column: { type: 'string', enum: ['', ...names], description: 'The column to sort by, or empty.' },
      sort_descending: { type: 'boolean' },
    },
    required: ['filters', 'search', 'sort_column', 'sort_descending'],
    additionalProperties: false,
  };
}

const OPERATOR_TEXT: Record<string, string> = {
  eq: 'equals', ne: 'differs from', contains: 'contains the text (case-insensitive)', not_contains: 'does not contain the text',
  gt: 'is greater than (later than, for dates)', ge: 'is at least', lt: 'is less than (earlier than, for dates)', le: 'is at most',
  null: 'is empty', not_null: 'is not empty',
};

export function filterSystem(columns: Column[], today: string) {
  return [
    'You turn a question about a report into the report\'s filters, search and sort. Answer only with the requested JSON.',
    'Use only these columns (name: heading, kind):',
    ...columns.map((c) => `- ${c.name}: ${c.label.replace(/\s+/g, ' ')}, ${c.kind}`),
    'Operators:',
    ...Object.keys(OPERATORS).map((op) => `- ${op}: ${OPERATOR_TEXT[op] ?? op}`),
    `Today is ${today}. For "this year", "last month" and the like, use date bounds with ge and le.`,
    'Text values are compared as they are stored: if unsure of the exact spelling, prefer contains. When the question asks for something the columns can\'t express, leave it out.',
  ].join('\n');
}

interface Answer {
  filters: { column: string; operator: string; value: string }[];
  search: string;
  sort_column: string;
  sort_descending: boolean;
}

/** The model's answer checked: only known columns and operators, short values. */
export function checkAnswer(json: unknown, columns: Column[]) {
  const a = (json ?? {}) as Partial<Answer>;
  const byName = new Map(columns.map((c) => [c.name, c]));
  const filters = (Array.isArray(a.filters) ? a.filters : [])
    .filter((f) => f && typeof f === 'object' && byName.has(f.column) && Object.hasOwn(OPERATORS, f.operator) && typeof f.value === 'string')
    .slice(0, MAX_FILTERS)
    .map((f) => ({ column: f.column, operator: f.operator, value: OPERATORS[f.operator].noValue ? '' : f.value.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) }))
    .filter((f) => OPERATORS[f.operator].noValue || f.value !== '');
  const search = typeof a.search === 'string' ? a.search.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) : '';
  const sort = typeof a.sort_column === 'string' ? byName.get(a.sort_column) ?? null : null;
  return { filters, search, sort, desc: a.sort_descending === true };
}

export async function aiFilterRoutes(app: FastifyInstance) {
  app.post('/a/:alias/:page/report/:id/ask', async (req: Req, reply) => {
    const ctx = await loadContext(req, reply);
    if (!ctx) return;
    const t = ctx.locale.t;
    const body = req.body ?? {};
    const refuse = (detail: string) => {
      logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail });
      return simplePage(reply, 403, t('error.access_denied'), t(detail.includes('csrf') ? 'error.session_reload' : 'error.report_unavailable'), `${ctx.base}/${ctx.page.page_no}`, ctx.locale);
    };
    if (typeof body.__csrf !== 'string' || body.__csrf !== ctx.session.csrf_token) return refuse('ai filter: csrf');
    const r = ctx.page.regions.find((x) => x.id === Number(req.params.id) && x.type === 'report');
    const conf = r ? aiFilterOf(r) : null;
    if (!r || !conf) return refuse(`ai filter: region ${req.params.id} on page ${ctx.page.page_no}`);
    if (!mayUse(ctx, conf)) return refuse(`ai filter: region ${r.id}: not signed in`);
    const params = new URLSearchParams(typeof body.params === 'string' ? body.params.slice(0, 4000) : '');
    const question = typeof body.question === 'string' ? body.question.replace(/\s+/g, ' ').trim() : '';
    try {
      if (!question || question.length > MAX_QUESTION_CHARS) throw new AiError('config', t('assistant.too_long', { max: String(MAX_QUESTION_CHARS) }));
      ctx.session.state[`__AIQ${r.id}`] = question;
      const columns = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        ctx.vis = await computeVisibility(ctx);
        if (!ctx.vis.regions.has(r.id)) throw new Forbidden('region');
        await resolveRestRegion(ctx, r);
        const fields = await fieldsOf(ctx, stripSemicolon(applyBinds(r.source ?? 'select 1', bindValues(ctx))));
        return visibleColumns(r, fields).map(({ f, i }): Column => ({ name: f.name, label: headingOf(r, f.name, ctx.locale.tr), kind: kindOf(f.dataTypeID), pos: i + 1 }));
      });
      ctx.client = undefined;
      const res = await generate(conf.service!, { system: filterSystem(columns, new Date().toISOString().slice(0, 10)), prompt: question, schema: filterSchema(columns), maxTokens: 2000 }, {
        appId: ctx.app.id, pageNo: ctx.page.page_no, user: ctx.user, source: 'nl2ir' as CallInfo['source'], debug: (l, x) => dbg(ctx, l, 'ai', x),
      });
      const a = checkAnswer(res.json, columns);
      dbg(ctx, 6, 'ai', () => `report filters from the question: ${JSON.stringify(a)}`);
      if (!a.filters.length && !a.search && !a.sort) throw new AiError('output', t('ai_filter.nothing'));
      const key = (k: string) => `r${r.id}_${k}`;
      for (const k of ['f', 'q', 's', 'd', 'p', 'k']) params.delete(key(k));
      for (const f of a.filters) params.append(key('f'), `${f.column}|${f.operator}|${f.value}`);
      if (a.search) params.set(key('q'), a.search);
      if (a.sort) {
        params.set(key('s'), String(a.sort.pos));
        if (a.desc) params.set(key('d'), 'desc');
      }
      const label = (name: string) => columns.find((c) => c.name === name)?.label ?? name;
      const what = [
        ...a.filters.map((f) => `${label(f.column)} ${opLabel(t, f.operator)}${f.value ? ` ${f.value}` : ''}`),
        ...(a.search ? [`"${a.search}"`] : []),
        ...(a.sort ? [t('ai_filter.sort', { column: `${a.sort.label}${a.desc ? ' ↓' : ''}` })] : []),
      ].join('; ');
      ctx.session.state.__FLASH = t('ai_filter.applied', { what });
    } catch (e) {
      if (e instanceof Forbidden) return refuse(`ai filter: region ${r.id} on page ${ctx.page.page_no}`);
      ctx.session.state.__FLASH_ERROR = e instanceof AiError ? e.message : await publicError(ctx, e, 'AI report filter');
    }
    await saveState(ctx.session);
    const q = params.toString();
    return reply.redirect(`${ctx.base}/${ctx.page.page_no}${q ? `?${q}` : ''}#R${r.id}`, 303);
  });
}
