import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { generate } from '../ai/service.ts';
import { AiError } from '../ai/types.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { formatAnswer } from '../runtime/assistant.ts';
import type { Session } from '../session.ts';
import { appOr404 } from './forms.ts';
import { isAdmin } from './locks.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, select, send, shell, workshopTabs, type Req } from './ui.ts';
import { WIZARD_KINDS, wizardTables } from './wizards.ts';

// App Builder AI (migration 062), with the AI service an administrator
// chooses for the builder (meta.builder_ai):
// - SQL Workshop → AI: SQL from a question (shown, never run: the developer
//   may run it in SQL Commands), and an explanation of a query or an error;
// - SQL Workshop → AI → Describe tables: descriptions of tables and columns
//   for the model (meta.ai_table_note, optionally also COMMENT ON), typed or
//   drafted by AI from the names and types (never from the data) and
//   reviewed before they are saved;
// - an application's Pages → Create pages with AI: a description becomes
//   proposed pages (page type, table, page number, label: what the create
//   page wizards take); the developer reviews and creates the ones they tick
//   with meta.generate_page.
// The model sees table and column names, types, keys and the descriptions
// (never rows). Its answers are escaped when shown.

export const RESERVED = /^(pg_.*|information_schema|meta)$/i;
const MAX_TABLES = 80;
const MAX_SCHEMA_CHARS = 60_000;
const MAX_PROPOSALS = 10;

/** The App Builder's AI service (enabled), or null. */
export async function builderService() {
  return (await owner.one<{ name: string; provider: string; model: string }>(
    `select s.name, s.provider, s.model from meta.builder_ai b join meta.ai_service s on s.id = b.service_id where s.enabled`)) ?? null;
}

async function ask(s: Session, req: Parameters<typeof generate>[1]) {
  const svc = await builderService();
  if (!svc) throw new AiError('config', 'The App Builder has no AI service yet (an administrator chooses one under SQL Workshop → AI).');
  return generate(svc.name, req, { appId: null, user: s.username, source: 'builder' });
}

/** Schemas a developer may describe or ask about (not pgkiln's, not the system's). */
async function schemas() {
  return (await owner.query<{ n: string }>(
    `select nspname as n from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema', 'meta') order by 1`)).rows.map((r) => r.n);
}

interface TableInfo {
  schema: string;
  table: string;
  kind: string;
  note: string | null;
  columns: { name: string; type: string; not_null: boolean; pk: boolean; fk: string | null; note: string | null }[];
}

/** Tables and views (by schema, or by "schema.table" names) with columns, keys and descriptions (notes, else comments). */
export async function tableInfo(where: { schema?: string; table?: string; tables?: string[] }): Promise<TableInfo[]> {
  const rows = (await owner.query<TableInfo>(
    `select n.nspname as schema, c.relname as table, case c.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end as kind,
            coalesce((select note from meta.ai_table_note x where x.schema_name = n.nspname and x.table_name = c.relname and x.column_name = ''), obj_description(c.oid, 'pg_class')) as note,
            coalesce((select json_agg(json_build_object(
                'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
                'pk', exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p' and a.attnum = any (k.conkey)),
                'fk', (select format('%s.%s', k.confrelid::regclass, (select attname from pg_attribute where attrelid = k.confrelid and attnum = k.confkey[1]))
                         from pg_constraint k where k.conrelid = c.oid and k.contype = 'f' and k.conkey = array[a.attnum] limit 1),
                'note', coalesce((select note from meta.ai_table_note x where x.schema_name = n.nspname and x.table_name = c.relname and x.column_name = a.attname),
                                 col_description(c.oid, a.attnum))) order by a.attnum)
               from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]') as columns
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'meta')
        and ($1::text is null or n.nspname = $1) and ($3::text is null or c.relname = $3)
        and ($2::text[] is null or format('%I.%I', n.nspname, c.relname) = any ($2))
      order by 1, 2 limit ${MAX_TABLES}`,
    [where.schema ?? null, where.tables ?? null, where.table ?? null],
  )).rows;
  return rows;
}

const ident = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : pg.escapeIdentifier(n));

/** The tables as text for a model: one block per table, a line per column. */
export function describeTables(tables: TableInfo[]) {
  let out = '';
  for (const t of tables) {
    const block = [`${t.kind} ${ident(t.schema)}.${ident(t.table)}${t.note ? ` -- ${t.note.replace(/\s+/g, ' ')}` : ''}`,
      ...t.columns.map((c) => `  ${ident(c.name)} ${c.type}${c.pk ? ' primary key' : ''}${c.not_null && !c.pk ? ' not null' : ''}${c.fk ? ` references ${c.fk}` : ''}${c.note ? ` -- ${c.note.replace(/\s+/g, ' ')}` : ''}`),
    ].join('\n');
    if (out.length + block.length > MAX_SCHEMA_CHARS) {
      out += '\n(more tables are left out)';
      break;
    }
    out += `${out ? '\n\n' : ''}${block}`;
  }
  return out;
}

const opt = (value: string, label: string, current: unknown) => html`<option value="${value}"${String(current ?? '') === value ? raw(' selected') : ''}>${label}</option>`;

async function serviceBox(s: Session) {
  const svc = await builderService();
  const admin = await isAdmin(s.username);
  if (!admin)
    return svc
      ? html`<p class="muted">AI service: <b>${svc.name}</b> (${svc.provider === 'anthropic' ? 'Claude' : 'OpenAI'}, ${svc.model}). Table and column names, types and descriptions, and what you type, are sent to it.</p>`
      : html`<div class="alert alert-info">The App Builder has no AI service yet: ask an administrator to choose one here.</div>`;
  const all = (await owner.query<{ name: string; provider: string; model: string }>('select name, provider, model from meta.ai_service where enabled order by name')).rows;
  return html`<form method="post" action="${BASE}/sql/ai/service" class="component-form">${csrf(s)}
    <div class="form-grid"><div class="field"><label class="label" for="f_ai_builder_service">AI service of the App Builder (administrators)</label>
      <select id="f_ai_builder_service" name="service">${opt('', '- none: no AI in the App Builder -', svc?.name ?? '')}${all.map((x) => opt(x.name, `${x.name} (${x.provider === 'anthropic' ? 'Claude' : 'OpenAI'}, ${x.model})`, svc?.name ?? ''))}</select>
      <small class="help">Table and column names, types and descriptions (never rows), and what developers type, are sent to it. Its calls are logged without an application.</small></div></div>
    <div class="buttons"><button class="btn">Save</button></div></form>`;
}

const errorBox = (e: unknown) => html`<div class="alert alert-error" role="alert">${e instanceof AiError || e instanceof Error ? e.message : 'The AI request failed.'}</div>`;

// ---------------------------------------------------------------- SQL Workshop → AI

const SQL_SCHEMA = {
  type: 'object',
  properties: {
    sql: { type: 'string', description: 'One PostgreSQL statement, without a trailing semicolon.' },
    explanation: { type: 'string', description: 'What the statement does, in one to three sentences.' },
  },
  required: ['sql', 'explanation'],
  additionalProperties: false,
};

async function workshopPage(s: Session, reply: FastifyReply, out: { question?: string; schema?: string; sql?: string; error?: string; result?: Raw }) {
  const list = await schemas();
  const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('ai')}
    ${await serviceBox(s)}
    <p><a href="${BASE}/sql/ai/describe">Describe tables for AI ▸</a> <span class="muted">(better answers: say what tables and columns mean)</span></p>
    ${out.result ?? ''}
    <div class="columns">
      ${region('SQL from a question', html`
        <p class="muted u-mt0">The answer is shown, never run: check it, then run it in SQL Commands if you want.</p>
        <form method="post" action="${BASE}/sql/ai/sql">${csrf(s)}
          <div class="form-grid">${select('schema', 'Schema', out.schema ?? list[0] ?? '', list)}</div>
          <div class="field"><label class="label" for="f_question">Question</label>
            <textarea id="f_question" name="question" rows="4" maxlength="4000" required placeholder="e.g. employees per department with their average salary">${out.question ?? ''}</textarea></div>
          <div class="buttons"><button class="btn btn-hot" data-busy="Thinking…">Write the SQL</button></div>
        </form>`)}
      ${region('Explain a query or an error', html`
        <form method="post" action="${BASE}/sql/ai/explain">${csrf(s)}
          <div class="form-grid">${select('schema', 'Schema (optional)', out.schema ?? '', [['', '- none -'], ...list.map((x): [string, string] => [x, x])])}</div>
          <div class="field"><label class="label" for="f_sql">SQL</label>
            <textarea id="f_sql" name="sql" class="code" rows="6" maxlength="20000" spellcheck="false">${out.sql ?? ''}</textarea></div>
          <div class="field"><label class="label" for="f_error">Error message (optional)</label>
            <textarea id="f_error" name="error" rows="2" maxlength="4000">${out.error ?? ''}</textarea></div>
          <div class="buttons"><button class="btn btn-hot" data-busy="Thinking…">Explain</button></div>
        </form>`)}
    </div>`;
  return send(reply, s, shell(s, 'SQL Workshop', [['SQL Workshop', `${BASE}/sql`], ['AI']], main, 'sql'));
}

// ---------------------------------------------------------------- describe tables

const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 63;

async function describePage(s: Session, reply: FastifyReply, schema: string, table: string, draft: { table?: string; columns?: Record<string, string> } | null, message?: Raw) {
  const list = await schemas();
  const tables = schema && list.includes(schema) ? await tableInfo({ schema }) : [];
  const t = table ? tables.find((x) => x.table === table) : undefined;
  const noted = new Set((await owner.query<{ t: string }>(`select distinct table_name as t from meta.ai_table_note where schema_name = $1`, [schema])).rows.map((r) => r.t));
  const value = (col: string, current: string | null) => (draft ? (col === '' ? draft.table : draft.columns?.[col]) ?? current ?? '' : current ?? '');
  const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('ai')}
    <p><a href="${BASE}/sql/ai">◂ SQL Workshop AI</a></p>
    ${message ?? ''}
    ${region('Describe tables for AI', html`
      <p class="muted u-mt0">Say what tables and columns mean: the descriptions go with the table list when the App Builder asks a model for SQL or pages. Without one, the database comment is used.</p>
      <form method="get" action="${BASE}/sql/ai/describe"><div class="form-grid">
        ${select('schema', 'Schema', schema, [['', '- choose -'], ...list.map((x): [string, string] => [x, x])])}
      </div><div class="buttons"><button class="btn">Show tables</button></div></form>
      ${tables.length ? html`<ul class="ai-tables">${tables.map((x) => html`<li><a href="${BASE}/sql/ai/describe?schema=${encodeURIComponent(schema)}&amp;table=${encodeURIComponent(x.table)}"${x.table === table ? raw(' aria-current="true"') : ''}>${x.table}</a> <span class="muted">${x.kind}${noted.has(x.table) ? ', described' : ''}</span></li>`)}</ul>` : ''}`)}
    ${t ? region(`${t.schema}.${t.table}`, html`
      ${draft ? html`<div class="alert alert-info">Drafted by AI from the names and types: check and change the descriptions, then save.</div>` : ''}
      <form method="post" action="${BASE}/sql/ai/describe">${csrf(s)}
        <input type="hidden" name="schema" value="${t.schema}"><input type="hidden" name="table" value="${t.table}">
        <div class="field"><label class="label" for="f_note_">The ${t.kind}</label>
          <textarea id="f_note_" name="note:" rows="2" maxlength="2000">${value('', t.note)}</textarea></div>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">Column</th><th scope="col">Description</th></tr></thead><tbody>
          ${t.columns.map((c) => html`<tr><td data-label="Column"><code>${c.name}</code> <span class="muted">${c.type}${c.pk ? ', key' : ''}${c.fk ? `, → ${c.fk}` : ''}</span></td>
            <td data-label="Description"><input name="note:${c.name}" maxlength="2000" value="${value(c.name, c.note)}" aria-label="Description of ${c.name}"></td></tr>`)}
        </tbody></table></div>
        <div class="field"><label class="check"><input type="checkbox" name="comments" value="true"> Also save them as database comments (COMMENT ON)</label></div>
        <div class="buttons"><button class="btn btn-hot">Save the descriptions</button>
          <button class="btn" formaction="${BASE}/sql/ai/describe/draft" data-busy="Thinking…">Draft with AI</button></div>
      </form>`) : ''}`;
  return send(reply, s, shell(s, 'SQL Workshop', [['SQL Workshop', `${BASE}/sql`], ['AI', `${BASE}/sql/ai`], ['Describe tables']], main, 'sql'));
}

// ---------------------------------------------------------------- pages from a description

interface Proposal {
  kind: string;
  table: string;
  page: number;
  form_page?: number | null;
  label: string;
  reason?: string;
}

const KINDS = new Map(WIZARD_KINDS.map(([k, label]) => [k, label]));

async function freePages(appId: number) {
  return new Set((await owner.query('select page_no from meta.page where app_id = $1', [appId])).rows.map((r) => r.page_no as number));
}

async function pagesPage(s: Session, reply: FastifyReply, a: any, description: string, proposals: Proposal[] | null, message?: Raw) {
  const tables = (await wizardTables(a.db_role)).filter((t) => t.access).map((t) => t.t);
  const svc = await builderService();
  const kindOptions = WIZARD_KINDS.map(([k, label]): [string, string] => [k, label]);
  const main = html`${appHeader(a, 'pages')}
    ${message ?? ''}
    ${region('Create pages with AI', html`
      <p class="muted u-mt0">Describe the pages you want. The App Builder's AI service proposes pages of the create page wizards for tables and views the application's role (${a.db_role ?? 'the owner'}) can read; you check the proposals and create the ones you tick. Table and column names, types and <a href="${BASE}/sql/ai/describe">descriptions</a> are sent to the service, never rows.</p>
      ${svc ? '' : html`<div class="alert alert-info">The App Builder has no AI service yet: an administrator chooses one under <a href="${BASE}/sql/ai">SQL Workshop → AI</a>.</div>`}
      <form method="post" action="${BASE}/apps/${a.id}/ai-pages">${csrf(s)}
        <div class="field"><label class="label" for="f_description">Description</label>
          <textarea id="f_description" name="description" rows="4" maxlength="4000" required placeholder="e.g. A page to manage employees, a calendar of leave, and a chart of salaries per department">${description}</textarea></div>
        <div class="buttons"><button class="btn btn-hot" data-busy="Thinking…"${svc ? '' : raw(' disabled')}>Propose pages</button></div>
      </form>`)}
    ${proposals ? region('Proposed pages', proposals.length ? html`
      <form method="post" action="${BASE}/apps/${a.id}/ai-pages/create">${csrf(s)}
        <input type="hidden" name="count" value="${proposals.length}">
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">Create</th><th scope="col">Page type</th><th scope="col">Table or view</th><th scope="col">Page</th><th scope="col">Form page</th><th scope="col">Label</th><th scope="col">Why</th></tr></thead><tbody>
          ${proposals.map((p, i) => html`<tr>
            <td data-label="Create"><input type="checkbox" name="on_${i}" value="true" checked aria-label="Create proposal ${i + 1}"></td>
            <td data-label="Page type"><select name="kind_${i}" aria-label="Page type of proposal ${i + 1}">${kindOptions.map(([k, l]) => opt(k, l, p.kind))}</select></td>
            <td data-label="Table or view"><select name="table_${i}" aria-label="Table of proposal ${i + 1}">${tables.map((t) => opt(t, t, p.table))}</select></td>
            <td data-label="Page"><input name="page_${i}" type="number" min="1" max="99999" value="${p.page}" aria-label="Page number of proposal ${i + 1}"></td>
            <td data-label="Form page"><input name="form_${i}" type="number" min="1" max="99999" value="${p.form_page ?? ''}" aria-label="Form page of proposal ${i + 1} (report and form)"></td>
            <td data-label="Label"><input name="label_${i}" maxlength="80" value="${p.label}" aria-label="Label of proposal ${i + 1}"></td>
            <td data-label="Why" class="muted">${p.reason ?? ''}</td></tr>`)}
        </tbody></table></div>
        <div class="buttons"><button class="btn btn-hot">Create the ticked pages</button></div>
      </form>` : html`<p class="muted">No pages were proposed: describe them differently, or check that the application's role may read the tables.</p>`) : ''}`;
  return send(reply, s, shell(s, a.name, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Create pages with AI']], main));
}

/** The model's proposals checked: known page types and tables, free page numbers (others moved to the next free ones). */
export function checkProposals(json: unknown, tables: string[], used: Set<number>): Proposal[] {
  const list = Array.isArray((json as any)?.pages) ? (json as any).pages : [];
  const taken = new Set(used);
  const next = (from: number) => {
    let n = Math.max(1, Math.min(99999, Math.floor(from) || 1));
    while (taken.has(n)) n++;
    taken.add(n);
    return n;
  };
  const out: Proposal[] = [];
  for (const p of list.slice(0, MAX_PROPOSALS)) {
    if (!p || typeof p !== 'object' || !KINDS.has(p.kind) || !tables.includes(p.table)) continue;
    const page = next(Number(p.page));
    out.push({
      kind: p.kind, table: p.table, page,
      form_page: p.kind === 'report_form' ? next(Number(p.form_page) || page + 1) : null,
      label: typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 80) : p.table.split('.').pop()!,
      reason: typeof p.reason === 'string' ? p.reason.slice(0, 300) : '',
    });
  }
  return out;
}

// ---------------------------------------------------------------- routes

export async function aiBuilderRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/ai`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return workshopPage(s, reply, {});
  });

  app.post(`${BASE}/sql/ai/service`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators choose the App Builder\'s AI service.');
    const name = String(req.body?.service ?? '').toUpperCase();
    const svc = name ? await owner.one<{ id: number }>('select id from meta.ai_service where name = $1', [name]) : null;
    if (name && !svc) {
      flash(s, `There is no AI service ${name}.`, 'error');
      return back(reply, s, `${BASE}/sql/ai`);
    }
    await owner.query('update meta.builder_ai set service_id = $1, updated_by = $2, updated_at = now()', [svc?.id ?? null, s.username]);
    flash(s, svc ? `The App Builder uses AI service ${name}.` : 'The App Builder uses no AI service.');
    return back(reply, s, `${BASE}/sql/ai`);
  });

  app.post(`${BASE}/sql/ai/sql`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const question = String(b.question ?? '').trim().slice(0, 4000);
    const schema = String(b.schema ?? '');
    let result: Raw;
    try {
      if (!question) throw new AiError('config', 'Type a question.');
      if (!(await schemas()).includes(schema)) throw new AiError('config', 'Choose a schema.');
      const res = await ask(s, {
        system: `You write PostgreSQL ${(await owner.one<{ v: number }>(`select current_setting('server_version_num')::int / 10000 as v`))!.v} SQL for a developer, for these tables and views:\n\n${describeTables(await tableInfo({ schema }))}\n\n` +
          'Use only those tables and columns, qualified with their schema. Write a SELECT unless the question clearly asks to change data. The developer reviews the SQL before anything runs.',
        prompt: question,
        schema: SQL_SCHEMA,
      });
      const a = res.json as { sql?: unknown; explanation?: unknown };
      const sql = typeof a.sql === 'string' ? a.sql.trim().replace(/;+\s*$/, '') : '';
      result = region('Proposed SQL', html`
        <p>${typeof a.explanation === 'string' ? a.explanation : ''}</p>
        <form method="post" action="${BASE}/sql">${csrf(s)}
          <div class="field"><label class="label" for="f_ai_sql">SQL (not run)</label>
            <textarea id="f_ai_sql" name="sql" class="code sql-editor" rows="10" spellcheck="false" data-code="plpgsql">${sql}</textarea></div>
          <div class="buttons"><button class="btn">Run in SQL Commands</button></div>
        </form>`);
    } catch (e) {
      result = errorBox(e);
    }
    return workshopPage(s, reply, { question, schema, result });
  });

  app.post(`${BASE}/sql/ai/explain`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const sql = String(b.sql ?? '').slice(0, 20000);
    const error = String(b.error ?? '').slice(0, 4000);
    const schema = String(b.schema ?? '');
    let result: Raw;
    try {
      if (!sql.trim() && !error.trim()) throw new AiError('config', 'Paste a query, an error message or both.');
      const tables = schema && (await schemas()).includes(schema) ? describeTables(await tableInfo({ schema })) : '';
      const res = await ask(s, {
        system: 'You explain PostgreSQL to a developer: what a query does, why an error happens and how to fix it. Be concise; show corrected SQL when it helps.' +
          (tables ? `\n\nThe tables and views of the schema:\n\n${tables}` : ''),
        prompt: [sql.trim() ? `Query:\n${sql.trim()}` : '', error.trim() ? `Error:\n${error.trim()}` : ''].filter(Boolean).join('\n\n'),
      });
      result = region('Explanation', html`<div class="ai-answer">${formatAnswer(res.text)}</div>`);
    } catch (e) {
      result = errorBox(e);
    }
    return workshopPage(s, reply, { sql, error, schema, result });
  });

  app.get(`${BASE}/sql/ai/describe`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = req.query as Record<string, string | undefined>;
    return describePage(s, reply, String(q.schema ?? ''), String(q.table ?? ''), null);
  });

  /** The posted table, checked against the catalog (null: unknown or reserved). */
  const postedTable = async (b: Record<string, any>) => {
    const schema = String(b.schema ?? '');
    const table = String(b.table ?? '');
    if (!isName(schema) || !isName(table) || RESERVED.test(schema)) return null;
    return (await tableInfo({ schema, table }))[0] ?? null;
  };

  app.post(`${BASE}/sql/ai/describe`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, any>;
    const t = await postedTable(b);
    if (!t) return reply.code(404).send('Not found');
    const notes: [string, string][] = [['', String(b['note:'] ?? '')], ...t.columns.map((c): [string, string] => [c.name, String(b[`note:${c.name}`] ?? '')])]
      .map(([k, v]) => [k, v.replace(/\s+/g, ' ').trim().slice(0, 2000)]);
    try {
      await owner.tx(async (c) => {
        for (const [col, note] of notes) {
          if (note) await c.query(
            `insert into meta.ai_table_note (schema_name, table_name, column_name, note, updated_by) values ($1, $2, $3, $4, $5)
             on conflict (schema_name, table_name, column_name) do update set note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
            [t.schema, t.table, col, note, s.username]);
          else await c.query('delete from meta.ai_table_note where schema_name = $1 and table_name = $2 and column_name = $3', [t.schema, t.table, col]);
        }
        if (b.comments === 'true') {
          const rel = `${pg.escapeIdentifier(t.schema)}.${pg.escapeIdentifier(t.table)}`;
          const what = t.kind === 'view' ? 'view' : t.kind === 'materialized view' ? 'materialized view' : 'table';
          for (const [col, note] of notes)
            await c.query(col ? `comment on column ${rel}.${pg.escapeIdentifier(col)} is ${note ? pg.escapeLiteral(note) : 'null'}` : `comment on ${what} ${rel} is ${note ? pg.escapeLiteral(note) : 'null'}`);
        }
      });
      flash(s, `Descriptions of ${t.schema}.${t.table} saved${b.comments === 'true' ? ', also as database comments' : ''}.`);
    } catch (e) {
      flash(s, `Not saved: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, `${BASE}/sql/ai/describe?schema=${encodeURIComponent(t.schema)}&table=${encodeURIComponent(t.table)}`);
  });

  app.post(`${BASE}/sql/ai/describe/draft`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, any>;
    const t = await postedTable(b);
    if (!t) return reply.code(404).send('Not found');
    const names = t.columns.map((c) => c.name);
    try {
      const related = [...new Set(t.columns.map((c) => c.fk?.replace(/\.[^.]+$/, '')).filter((x): x is string => !!x))];
      const res = await ask(s, {
        system: 'You describe database tables and columns for other AI models and developers: one short sentence each, saying what the table holds and what each column means (units, codes, how it relates). ' +
          'Use only the names, types, keys and existing descriptions given; where the meaning is unclear, say what it probably is. Keep existing descriptions unless they are wrong.',
        prompt: describeTables([t, ...(related.length ? await tableInfo({ tables: related }) : []).filter((x) => x.table !== t.table || x.schema !== t.schema)]) +
          `\n\nDescribe ${t.kind} ${t.schema}.${t.table} and its columns.`,
        schema: {
          type: 'object',
          properties: {
            table: { type: 'string' },
            columns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', enum: names }, description: { type: 'string' } }, required: ['name', 'description'], additionalProperties: false } },
          },
          required: ['table', 'columns'],
          additionalProperties: false,
        },
      });
      const a = res.json as { table?: unknown; columns?: unknown };
      const columns: Record<string, string> = {};
      for (const c of Array.isArray(a.columns) ? a.columns : [])
        if (c && names.includes(c.name) && typeof c.description === 'string') columns[c.name] = c.description.replace(/\s+/g, ' ').trim().slice(0, 2000);
      return describePage(s, reply, t.schema, t.table, { table: typeof a.table === 'string' ? a.table.replace(/\s+/g, ' ').trim().slice(0, 2000) : undefined, columns });
    } catch (e) {
      return describePage(s, reply, t.schema, t.table, null, errorBox(e));
    }
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/ai-pages`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    return pagesPage(s, reply, a, '', null);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/ai-pages`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const description = String(req.body?.description ?? '').trim().slice(0, 4000);
    try {
      if (!description) throw new AiError('config', 'Describe the pages you want.');
      const tables = (await wizardTables(a.db_role)).filter((t) => t.access).map((t) => t.t).slice(0, 300);
      if (!tables.length) throw new AiError('config', `The application's role ${a.db_role} can't read any table or view yet.`);
      const used = await freePages(a.id);
      const firstFree = (() => {
        let n = 1;
        while (used.has(n)) n++;
        return n;
      })();
      const res = await ask(s, {
        system: 'You plan pages of a low-code web application. Propose pages for what the developer describes, using only these page types:\n' +
          WIZARD_KINDS.map(([k, label, help]) => `- ${k}: ${label}. ${help}`).join('\n') +
          `\n\nand only these tables and views:\n\n${describeTables(await tableInfo({ tables }))}\n\n` +
          `Page numbers ${[...used].sort((x, y) => x - y).join(', ') || '(none)'} are taken; the first free one is ${firstFree}. A report_form needs a second page number for its form (form_page; null for other types). ` +
          `Give each page a short label for the menu and a reason in one sentence. At most ${MAX_PROPOSALS} pages.`,
        prompt: description,
        schema: {
          type: 'object',
          properties: {
            pages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: [...KINDS.keys()] },
                  table: { type: 'string', enum: tables },
                  page: { type: 'integer' },
                  form_page: { type: ['integer', 'null'] },
                  label: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['kind', 'table', 'page', 'form_page', 'label', 'reason'],
                additionalProperties: false,
              },
            },
          },
          required: ['pages'],
          additionalProperties: false,
        },
      });
      return pagesPage(s, reply, a, description, checkProposals(res.json, tables, used));
    } catch (e) {
      return pagesPage(s, reply, a, description, null, errorBox(e));
    }
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/ai-pages/create`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Record<string, any>;
    const tables = new Set((await wizardTables(a.db_role)).filter((t) => t.access).map((t) => t.t));
    const count = Math.min(MAX_PROPOSALS, Math.max(0, Number(b.count) || 0));
    const chosen: Proposal[] = [];
    const errors: string[] = [];
    const num = (v: unknown) => (/^\d{1,5}$/.test(String(v ?? '')) && Number(v) >= 1 ? Number(v) : null);
    for (let i = 0; i < count; i++) {
      if (b[`on_${i}`] !== 'true') continue;
      const kind = String(b[`kind_${i}`] ?? '');
      const table = String(b[`table_${i}`] ?? '');
      const page = num(b[`page_${i}`]);
      const form = num(b[`form_${i}`]);
      const label = String(b[`label_${i}`] ?? '').trim().slice(0, 80);
      if (!KINDS.has(kind) || !tables.has(table) || page === null || (kind === 'report_form' && form === null)) {
        errors.push(`Proposal ${i + 1}: choose a page type, a table the application can read and free page numbers.`);
        continue;
      }
      chosen.push({ kind, table, page, form_page: kind === 'report_form' ? form : null, label: label || table.split('.').pop()! });
    }
    if (errors.length || !chosen.length) {
      flash(s, errors.length ? errors.join(' ') : 'Tick the pages to create.', 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/ai-pages`);
    }
    try {
      const created = await owner.tx(async (c) => {
        const out: number[] = [];
        for (const p of chosen) {
          const options: Record<string, unknown> = { label: p.label };
          if (p.kind === 'report_form') Object.assign(options, { form_page: p.form_page, icon: 'table' });
          if (p.kind === 'grid') options.icon = 'grid';
          await c.query('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb)', [a.alias, p.kind, p.table, p.page, JSON.stringify(options)]);
          out.push(p.page, ...(p.form_page ? [p.form_page] : []));
        }
        return out;
      });
      flash(s, `Pages ${created.join(', ')} created. Make sure the application's database role has the privileges they need.`);
      return back(reply, s, `${BASE}/apps/${a.id}`);
    } catch (e) {
      flash(s, `No pages were created: ${(e as Error).message}`, 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/ai-pages`);
    }
  });
}
