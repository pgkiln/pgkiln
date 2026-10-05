import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { owner, runtime } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { checkSql, type SqlShape } from './advisor.ts';
import { BASE, developer, type Req } from './ui.ts';
import { appAllowed } from './workspaces.ts';

// The builder's code editor (public/code-editor.js) and its SQL completions.
//
//  - codeAttrs() marks a textarea with data-code="sql|plpgsql|json|html"
//    (plus how to switch language with the component's type, and which
//    Advisor check fits it); the script enhances every such textarea.
//  - GET /builder/code/completions?app=<id> | ?page=<id> lists what the
//    application's database role can use: schemas, tables and views with
//    their columns, functions, and the app's page and application items.
//    An app without its own role runs as the runtime connection's role, so
//    that role is used. Without app or page (SQL Workshop) it lists what the
//    owner connection sees, like the Object Browser. Developer only, no side
//    effects; the catalog part is cached per role for 30 seconds (the SQL
//    Workshop clears it), items are read fresh.
//  - POST /builder/code/check plans one piece of SQL like the Advisor
//    (EXPLAIN as the app's role, binds as NULL, rolled back).

export type CodeLang = 'sql' | 'plpgsql' | 'json' | 'html' | 'text';

/** Fields that hold statements (PL/pgSQL calls, DO blocks) rather than one query. */
const STATEMENTS = new Set(['supporting_script.script', 'process.code', 'app_process.code', 'automation_action.code', 'task_definition.action_code', 'dynamic_action.code']);
/** The Advisor check per field (none: no check). */
const CHECKS: Record<string, SqlShape> = {
  'region.source': 'select', 'region.condition': 'boolean', 'item.lov': 'select', 'item.readonly_condition': 'boolean',
  'button.condition': 'boolean', 'validation.expression': 'boolean', 'process.code': 'statements', 'authz_scheme.value': 'boolean',
  'lov.query': 'select', 'app_process.code': 'statements', 'automation.query': 'select', 'automation_action.code': 'statements', 'automation_action.condition': 'boolean',
  'document_template.query': 'select', 'task_definition.action_code': 'statements', 'dynamic_action.code': 'statements',
  'button.badge_query': 'select', 'list.query': 'select', 'list_entry.condition': 'boolean',
};
/** Fields whose check follows the component's type select, like SWITCH ("none": no check). */
const CHECK_SWITCH: Record<string, string> = {
  'dynamic_action.code': 'action:set_value=select,*=statements',
  'process.code': 'type:sql=statements,*=none',
  'region.source': 'type:static=none,form=none,facets=none,smart_filters=none,display_selector=none,tasks=none,workflows=none,list=none,data_reporter=none,ai_assistant=none,*=select',
  'computation.expression': 'type:sql_query=select,*=none',
  'computation.condition_expr': 'condition_type:sql=boolean,exists=select,not_exists=select,*=none',
  'branch.condition_expr': 'condition_type:sql=boolean,exists=select,not_exists=select,*=none',
};
/** Fields whose language follows the component's type select: "type:value=lang,…" (other values: SQL). */
const SWITCH: Record<string, string> = {
  'region.source': 'type:static=html,form=text',
  'validation.expression': 'type:regex=text,not_null=text',
  'authz_scheme.value': 'type:role=text',
  'dynamic_action.code': 'action:set_value=sql',
  'computation.expression': 'type:static=text,item=text,function_body=plpgsql',
  'computation.condition_expr': 'condition_type:item_null=text,item_not_null=text,item_equals=text,item_not_equals=text',
  'branch.condition_expr': 'condition_type:item_null=text,item_not_null=text,item_equals=text,item_not_equals=text',
};
/** Language when no SWITCH value matches. */
const fallback = (key: string): CodeLang => (STATEMENTS.has(key) ? 'plpgsql' : 'sql');

/** The value of a "col:value=x,…,*=y" switch for a row (undefined: no match and no "*"). */
function pick(sw: string, row: any): string | undefined {
  const [col, list] = sw.split(':');
  const pairs = list.split(',').map((p) => p.split('='));
  return (pairs.find(([val]) => val === row?.[col]) ?? pairs.find(([val]) => val === '*'))?.[1];
}

/** Language of a component field in the property editor, or null for a plain field. */
export function codeLang(kind: string, field: { name: string; kind: string }, row?: any): CodeLang | null {
  if (field.kind === 'json') return 'json';
  if (field.kind !== 'code') return null;
  const key = `${kind}.${field.name}`;
  if (key === 'document_template.template') return 'html';
  return ((SWITCH[key] && pick(SWITCH[key], row)) as CodeLang | undefined) ?? fallback(key);
}

/** The Advisor check of a component field for this row, or null. */
export function codeCheck(kind: string, field: { name: string }, row?: any): SqlShape | null {
  const key = `${kind}.${field.name}`;
  const shape = CHECK_SWITCH[key] ? pick(CHECK_SWITCH[key], row ?? {}) : CHECKS[key];
  return shape && shape !== 'none' ? (shape as SqlShape) : null;
}

/** Attributes for a property editor textarea: ` data-code="…"` (and switch/check hints). */
export function codeAttrs(kind: string, field: { name: string; kind: string }, row?: any): Raw {
  const lang = codeLang(kind, field, row);
  if (!lang) return raw('');
  const key = `${kind}.${field.name}`;
  const check = codeCheck(kind, field, row);
  return html` data-code="${lang}"${SWITCH[key] ? html` data-code-switch="${SWITCH[key]},*=${fallback(key)}"` : ''}${check ? html` data-code-check="${check}"` : ''}${CHECK_SWITCH[key] ? html` data-code-check-switch="${CHECK_SWITCH[key]}"` : ''}`;
}

// ------------------------------------------------------------------ completions

export interface Completions {
  role: string | null;
  schemas: string[];
  relations: { schema: string; name: string; kind: 'table' | 'view'; columns: { name: string; type: string }[] }[];
  functions: { schema: string; name: string; args: string; returns: string }[];
  items: { name: string; page: number | null; label: string | null }[];
}

const CACHE_MS = 30_000;
type Catalog = Pick<Completions, 'schemas' | 'relations' | 'functions'>;
/** The catalog part per database role ("" for the owner), for a short while; items are always read fresh. */
const cache = new Map<string, { at: number; value: Catalog }>();
/** Forget cached completions (tests, and after the SQL Workshop ran something). */
export const clearCompletions = () => cache.clear();

const SYSTEM = `n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname !~ '^pg_(temp|toast_temp)_'`;

/**
 * What the app's role can use (appId null: the owner connection's own view),
 * and the app's items. Objects come from the catalogs, filtered with
 * has_*_privilege for that role, so nothing the role can't reach is listed.
 */
export async function completions(appId: number | null): Promise<Completions> {
  const app = appId === null ? null : await owner.one('select id, db_role from meta.app where id = $1', [appId]);
  // an app without its own role runs as the runtime connection's role
  const role: string | null = app ? (app.db_role ?? (await runtimeRole())) : null;
  const [cat, items] = await Promise.all([catalog(role), app ? appItems(app.id) : Promise.resolve([])]);
  return { role, ...cat, items };
}

async function catalog(role: string | null): Promise<Catalog> {
  const key = role ?? '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  // a role that doesn't exist (yet) can see nothing
  if (role && !(await owner.one('select 1 as ok from pg_roles where rolname = $1', [role]))) return { schemas: [], relations: [], functions: [] };
  const who = role ?? (await owner.one('select current_user as u'))!.u;
  const [schemas, relations, functions] = await Promise.all([
    owner.query(`select n.nspname as name from pg_namespace n where ${SYSTEM} and has_schema_privilege($1, n.oid, 'USAGE') order by 1`, [who]),
    owner.query(
      `select n.nspname as schema, c.relname as name, case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind,
              coalesce((select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                          from pg_attribute a
                         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                           and has_column_privilege($1, c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')), '[]') as columns
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${SYSTEM}
          and has_schema_privilege($1, n.oid, 'USAGE')
          and has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
        order by 1, 2
        limit 3000`,
      [who],
    ),
    owner.query(
      `select n.nspname as schema, p.proname as name, pg_get_function_arguments(p.oid) as args,
              case when p.prokind = 'p' then 'procedure' else pg_get_function_result(p.oid) end as returns
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where ${SYSTEM} and p.prokind in ('f', 'p', 'a', 'w') and p.prorettype <> 'trigger'::regtype
          and has_schema_privilege($1, n.oid, 'USAGE') and has_function_privilege($1, p.oid, 'EXECUTE')
        order by 1, 2
        limit 3000`,
      [who],
    ),
  ]);
  const value: Catalog = { schemas: schemas.rows.map((r) => r.name), relations: relations.rows, functions: functions.rows };
  cache.set(key, { at: Date.now(), value });
  return value;
}

let runtimeUser: string | undefined;
async function runtimeRole(): Promise<string> {
  runtimeUser ??= (await runtime.one('select current_user as u')).u as string;
  return runtimeUser;
}

/** Page items (with their page number) and application items (page null). */
async function appItems(appId: number) {
  return (
    await owner.query(
      `select i.name, p.page_no as page, i.label from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1
       union all
       select name, null, description from meta.app_item where app_id = $1
       order by 2 nulls last, 1`,
      [appId],
    )
  ).rows;
}

/** The app of ?app= or ?page= (undefined: not found; null: neither given, the SQL Workshop). */
async function appOf(q: Record<string, string | undefined>): Promise<{ id: number; page: number | null } | null | undefined> {
  if (q.app !== undefined) {
    if (!/^\d{1,9}$/.test(q.app)) return undefined;
    const a = await owner.one('select id from meta.app where id = $1', [q.app]);
    return a ? { id: a.id, page: null } : undefined;
  }
  if (q.page !== undefined) {
    if (!/^\d{1,9}$/.test(q.page)) return undefined;
    const p = await owner.one('select app_id, page_no from meta.page where id = $1', [q.page]);
    return p ? { id: p.app_id, page: p.page_no } : undefined;
  }
  return null;
}

export async function codeEditorRoutes(app: FastifyInstance) {
  app.get(`${BASE}/code/completions`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const target = await appOf(req.query);
    if (target === undefined || (target && !(await appAllowed(s, target.id)))) return reply.code(404).send({ error: 'Not found' });
    const value = await completions(target?.id ?? null);
    return reply.header('Cache-Control', 'private, no-store').send({ ...value, page: target?.page ?? null, app: target?.id ?? null });
  });

  // One piece of SQL planned like the Advisor does (nothing runs; rolled back).
  app.post(`${BASE}/code/check`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const shape = req.body?.shape as SqlShape;
    const sql = String(req.body?.sql ?? '');
    if (!['select', 'boolean', 'statements'].includes(shape)) return reply.code(400).send({ error: 'Unknown check' });
    const target = await appOf({ app: req.body?.app, page: req.body?.page });
    if (target === undefined || (target && !(await appAllowed(s, target.id)))) return reply.code(404).send({ error: 'Not found' });
    if (!sql.trim()) return reply.send({ ok: true, message: 'Nothing to check.' });
    if (/^\s*(STATIC|LOV):/i.test(sql)) return reply.send({ ok: true, message: 'Not SQL: a static or shared list of values.' });
    const role = target ? (await owner.one('select db_role from meta.app where id = $1', [target.id]))?.db_role : null;
    const c = await owner.pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local statement_timeout = '5s'`);
      if (target) await c.query(`select set_config('pgapex.app_id', $1, true)`, [String(target.id)]);
      if (role) await c.query(`set local role ${pg.escapeIdentifier(role)}`);
      const problem = await checkSql(c, sql, shape);
      return reply.header('Cache-Control', 'no-store').send(problem ? { ok: problem.severity !== 'error', severity: problem.severity, message: problem.message } : { ok: true, message: `No problems found (planned as ${role ?? 'the owner'}).` });
    } catch (e) {
      return reply.send({ ok: false, severity: 'error', message: (e as Error).message });
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });
}
