import { declarativeCondition } from './conditions.ts';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { applyBinds, splitStatements } from '../binds.ts';
import { owner, runtime, type Db } from '../db.ts';
import { devDbForApp } from '../workspace-db.ts';
import { settingFrom } from '../instance.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { templateProblem } from '../runtime/document.ts';
import { invokeStepReferences, isQuery, outcomeMap, stepProblems, stepWarnings } from '../workflow.ts';
import { handlerProblems } from '../runtime/rest.ts';
import { plpgsqlBlock } from '../runtime/rest-handlers.ts';
import { processProblems } from '../runtime/processes.ts';
import { urlConfigProblem, urlTarget } from '../runtime/url-region.ts';
import { configColumns, searchConfigProblems, textSearchConfig, tsvectorSql } from '../runtime/search.ts';
import { COMPONENTS } from './components.ts';
import { arrayTriggerArg, CATALOG_TYPE, jsonSourceProblems, POSITION, ROW_KEY, viewTriggerArg, type JsonSource } from '../json-sources.ts';
import { DISTANCES, PGVECTOR_MISSING, vectorColumnDims, vectorSchema, type Distance } from '../vector.ts';
import { entriesOf, type Entry } from './search.ts';
import { LOV_CHECKED } from '../runtime/items.ts';
import { appHeader, BASE, developer, region, send, shell, type Req } from './ui.ts';

// App Builder → Advisor (APEX: Advisor): checks an application without
// running it.
//
//  - Every SQL fragment (region sources, lists of values, conditions,
//    validations, processes, dynamic actions, authorization schemes,
//    application processes, automations) is planned with EXPLAIN as the
//    application's database role, binds as NULL, in a transaction that is
//    rolled back. That finds syntax errors, unknown tables and columns, type
//    errors and missing grants, and runs nothing. PL/pgSQL blocks (DO) are
//    compiled into a temporary function, which checks their syntax.
//  - References: pages, items, lists of values, authorization schemes and
//    report layouts that a component names but that don't exist.
//  - With the plpgsql_check extension installed, the PL/pgSQL functions of
//    the schemas the application uses are checked too.

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  entry: Entry | null;
  field: string;
  message: string;
}

export type SqlShape = 'select' | 'boolean' | 'statements' | 'regex';

/** Which fields hold SQL, and of what shape, per component kind (null: decided by the row). */
export function sqlFields(kind: string, row: any): { name: string; shape: SqlShape }[] {
  switch (kind) {
    case 'region':
      return [
        ...(['report', 'classic_report', 'grid', 'chart', 'cards', 'calendar', 'map', 'tree', 'dynamic'].includes(row.type) && row.source?.trim() && !row.rest_source ? [{ name: 'source', shape: 'select' as const }] : []),
        ...conditionSql(row, 'condition'),
      ];
    case 'item':
      return [
        ...(row.lov?.trim() && !/^(STATIC|LOV):/i.test(row.lov.trim()) ? [{ name: 'lov', shape: 'select' as const }] : []),
        { name: 'readonly_condition', shape: 'boolean' },
        ...conditionSql(row),
      ];
    case 'button':
      return [...conditionSql(row, 'condition'), { name: 'badge_query', shape: 'select' }];
    case 'computation':
    case 'app_computation':
      return [
        ...(row.type === 'sql_query' ? [{ name: 'expression', shape: 'select' as const }] : []),
        ...conditionSql(row),
      ];
    case 'branch':
      return conditionSql(row);
    case 'dynamic_action':
      return [
        ...(row.action === 'set_value' ? [{ name: 'code', shape: 'select' as const }] : row.action === 'execute_sql' ? [{ name: 'code', shape: 'statements' as const }] : []),
        ...conditionSql({ condition_type: row.server_condition_type }, 'server_condition_expr'),
      ];
    case 'validation':
      return [
        ...(row.type === 'sql' ? [{ name: 'expression', shape: 'boolean' as const }] : row.type === 'regex' ? [{ name: 'expression', shape: 'regex' as const }]
          : row.type === 'exists' || row.type === 'not_exists' ? [{ name: 'expression', shape: 'select' as const }] : []),
        ...conditionSql(row),
      ];
    case 'process':
      return [
        ...(row.type === 'sql' ? [{ name: 'code', shape: 'statements' as const }] : row.type === 'download' ? [{ name: 'code', shape: 'select' as const }] : []),
        ...conditionSql(row),
      ];
    case 'authz_scheme':
      return row.type === 'sql' ? [{ name: 'value', shape: 'boolean' }] : [];
    case 'lov':
      return /^STATIC:/i.test(row.query?.trim() ?? '') || row.rest_source ? [] : [{ name: 'query', shape: 'select' }];
    case 'app_process':
      return [{ name: 'code', shape: 'statements' }];
    case 'automation':
      return [{ name: 'query', shape: 'select' }];
    case 'automation_action':
      return [{ name: 'code', shape: 'statements' }, { name: 'condition', shape: 'boolean' }];
    case 'document_template':
    case 'report_query':
      return [{ name: 'query', shape: 'select' }];
    case 'task_definition':
      return [{ name: 'action_code', shape: 'statements' }];
    case 'workflow_definition':
      // checked step by step below
      return [];
    case 'rest_module':
      // checked handler by handler below
      return [];
    default:
      return [];
  }
}

/**
 * The SQL of a server-side condition (migrations 029, 147). `field` holds the expression; for regions and
 * buttons (`condition`) no type means SQL.
 */
const conditionSql = (row: any, field = 'condition_expr'): { name: string; shape: SqlShape }[] => {
  const type = row.condition_type || (field === 'condition' && row.condition?.trim() ? 'sql' : null);
  return type === 'sql' ? [{ name: field, shape: 'boolean' }] : type === 'exists' || type === 'not_exists' ? [{ name: field, shape: 'select' }] : [];
};

export const EXPLAINABLE = /^\s*(\(|select|with|values|table|insert|update|delete|merge)\b/i;

/**
 * The problem with one piece of SQL, or null. Runs inside the caller's
 * transaction, each check in its own savepoint; nothing is executed.
 */
export async function checkSql(c: pg.PoolClient, sql: string, shape: SqlShape): Promise<{ severity: Severity; message: string } | null> {
  const plain = applyBinds(sql.trim().replace(/;+\s*$/, ''), {});
  const attempt = async (text: string) => {
    await c.query('savepoint advisor');
    try {
      await c.query(text);
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query('rollback to savepoint advisor');
    }
  };
  if (shape === 'boolean') {
    const err = await attempt(`explain select (${plain})::boolean`);
    return err ? { severity: 'error', message: err } : null;
  }
  if (shape === 'regex') {
    const err = await attempt(`select '' ~ ${pg.escapeLiteral(sql)}`);
    return err ? { severity: 'error', message: `Invalid regular expression: ${err}` } : null;
  }
  if (shape === 'select') {
    if (!EXPLAINABLE.test(plain)) return { severity: 'warning', message: 'Expected a SELECT.' };
    const err = await attempt(`explain ${plain}`);
    return err ? { severity: 'error', message: err } : null;
  }
  // statements: each one planned; DO blocks compiled; others can't be checked without running them
  const unchecked: string[] = [];
  for (const stmt of splitStatements(plain)) {
    const doBlock = /^\s*do\s+(?:language\s+plpgsql\s+)?(\$([A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*)\1\s*(?:language\s+plpgsql)?\s*$/i.exec(stmt);
    let err: string | null;
    if (doBlock) err = await attempt(`create function pg_temp.__advisor_check() returns void language plpgsql as ${doBlock[1]}${doBlock[3]}${doBlock[1]}`);
    else if (EXPLAINABLE.test(stmt)) err = await attempt(`explain ${stmt}`);
    else {
      unchecked.push(stmt.split(/\s+/).slice(0, 2).join(' '));
      continue;
    }
    if (err) return { severity: 'error', message: err };
  }
  return unchecked.length ? { severity: 'info', message: `Not checked (only SELECT, INSERT, UPDATE, DELETE, MERGE and DO can be checked without running them): ${unchecked.join(', ')}` } : null;
}

/** process types that write data (sprint 144: the security checks below; a sql process when its code has DML) */
const WRITES = ['form_dml', 'grid_dml', 'sql'];
type Row = { kind: string; row: any };
/** (sprint 147) an application as rows: from the database (advise) or from an export's files (adviseDoc) */
export interface AppRows { app: any; pages: any[]; all: Row[]; entries: Entry[]; byKey: Map<string, Entry> }
/** (sprint 144) session limits above which the Advisor warns (APEX CodeScan's session limits) */
export const SESSION_LIMITS = { idleMinutes: 120, maxHours: 24 };

/**
 * (sprint 144, AP-10; APEX 26.2: APEXlang static analysis / SQLcl CodeScan) Security defaults of an application:
 *  - a page anyone can open (no sign-in) with a process that writes data;
 *  - a signed-in page that writes data with neither the page nor the process behind an authorization scheme, in an
 *    application that has schemes (info: every signed-in user may use it);
 *  - a page with unrestricted protection whose items take values from the URL without a checksum (APEX: value
 *    protection; hidden items never take posted values in pgkiln, so URL values are the way in);
 *  - the installation's session limits above SESSION_LIMITS.
 */
/** (sprint 147) the processes of a page that write data: saves, and SQL with a writing statement, not behind a scheme */
const writesOf = (all: Row[], page: any) => all
  .filter((x) => x.kind === 'process' && x.row.page_id === page.id && WRITES.includes(x.row.type) && !x.row.authz
    && (x.row.build_option ?? '') !== 'COMMENTED_OUT' && (x.row.type !== 'sql' || /\b(insert|update|delete|merge|truncate)\b/i.test(String(x.row.code ?? ''))))
  .sort((a, b) => (a.row.seq ?? 0) - (b.row.seq ?? 0)).map((x) => String(x.row.name));

function pageSecurityFindings(x: AppRows): Finding[] {
  const out: Finding[] = [];
  const schemes = x.all.filter((r) => r.kind === 'authz_scheme').length;
  for (const p of [...x.pages].filter((p) => (p.build_option ?? '') !== 'COMMENTED_OUT').sort((a, b) => a.page_no - b.page_no)) {
    const entry = x.byKey.get(`page-${p.id}`) ?? null;
    const writes = writesOf(x.all, p);
    const items = x.all.filter((r) => r.kind === 'item' && r.row.page_id === p.id && r.row.type !== 'display').length;
    if (writes.length && !p.requires_auth)
      out.push({ severity: 'warning', entry, field: 'Security → Authentication', message: `Page ${p.page_no} needs no sign-in, and its process ${writes.join(', ')} writes data: anyone can run it. Require authentication, or put the process behind an authorization scheme.` });
    else if (writes.length && !p.authz && schemes)
      out.push({ severity: 'info', entry, field: 'Security → Authorization scheme', message: `Page ${p.page_no} writes data (${writes.join(', ')}) with no authorization scheme on the page or the process: every signed-in user may use it.` });
    if (p.protection === 'unrestricted' && items)
      out.push({ severity: writes.length ? 'warning' : 'info', entry, field: 'Security → Page protection', message: `Page ${p.page_no} is unrestricted: a link can set its items without a checksum${writes.length ? ', and the page writes data' : ''}. Use checksum protection unless the URL is meant to be typed.` });
  }
  return out;
}

async function securityFindings(x: AppRows, query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>): Promise<Finding[]> {
  const out = pageSecurityFindings(x);
  const settings = (await query(`select name, value from meta.setting where name in ('session_idle_minutes', 'session_max_hours')`).catch(() => ({ rows: [] }))).rows;
  const idle = settingFrom('session_idle_minutes', settings);
  const max = settingFrom('session_max_hours', settings);
  if (idle > SESSION_LIMITS.idleMinutes)
    out.push({ severity: 'warning', entry: null, field: 'Instance settings → Session idle time', message: `Sessions end after ${idle} minutes without requests; more than ${SESSION_LIMITS.idleMinutes} leaves unattended sessions open.` });
  if (max > SESSION_LIMITS.maxHours)
    out.push({ severity: 'warning', entry: null, field: 'Instance settings → Maximum session length', message: `Sessions last up to ${max} hours; more than ${SESSION_LIMITS.maxHours} keeps a stolen session usable for long.` });
  return out;
}

/**
 * (sprint 146, AP-8) JSON sources whose views no longer match their data profile. Create views makes each view from
 * the profile; editing the profile afterwards (or changing the view by hand) leaves the database behind. Per view:
 * missing (error: pages on it fail), not made by this source (no json_source_write trigger: warning), and the
 * profile against the catalog: its columns and their types, and the trigger's argument, which says what the view
 * writes back (a column added, removed, moved to another path or made read only). Read as the owner.
 */
export async function jsonSourceFindings(sources: unknown, query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>): Promise<Finding[]> {
  const out: Finding[] = [];
  const list = (Array.isArray(sources) ? sources : []) as JsonSource[];
  for (const x of list) {
    if (!x || typeof x.schema !== 'string' || typeof x.view !== 'string' || !Array.isArray(x.columns)) continue;
    const field = `JSON source ${x.name}`;
    const views = [
      { view: x.view, arg: viewTriggerArg(x), cols: x.columns, extra: [] as string[] },
      ...(x.arrays ?? []).map((a) => ({ view: a.view, arg: arrayTriggerArg(x, a), cols: a.columns, extra: [ROW_KEY, POSITION] })),
    ];
    const rows = (await query(
      `select c.relname as view,
              (select array_agg(array[a.attname::text, format_type(a.atttypid, a.atttypmod)] order by a.attnum)
                 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols,
              (select convert_from(substring(t.tgargs from 1 for greatest(length(t.tgargs) - 1, 0)), 'UTF8')
                 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'json_source_write') as arg
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = any ($2) and c.relkind = 'v'`, [x.schema, views.map((v) => v.view)])).rows;
    const found = new Map(rows.map((r) => [r.view as string, r]));
    for (const v of views) {
      const name = `${x.schema}.${v.view}`;
      const again = 'Shared Components → JSON sources → Create views makes it again.';
      const r = found.get(v.view);
      if (!r) { out.push({ severity: 'error', entry: null, field, message: `View ${name} doesn't exist: pages and reports on it fail. ${again}` }); continue; }
      if (r.arg == null) { out.push({ severity: 'warning', entry: null, field, message: `View ${name} wasn't made by this JSON source (it has no json_source_write trigger): it doesn't write back to ${x.table}.${x.column}.` }); continue; }
      const actual = new Map((r.cols ?? []).map(([n, t]: string[]) => [n, t]));
      const problems: string[] = [];
      for (const n of [...x.key, ...v.extra]) if (!actual.has(n)) problems.push(`no column ${n}`);
      for (const c of v.cols) {
        const t = actual.get(c.name);
        if (t === undefined) problems.push(`no column ${c.name}`);
        else if (CATALOG_TYPE[c.type] && t !== CATALOG_TYPE[c.type]) problems.push(`${c.name} is ${t}, the profile says ${c.type}`);
      }
      const known = new Set([...x.key, ...v.extra, ...v.cols.map((c) => c.name)]);
      for (const n of actual.keys()) if (!known.has(n as string)) problems.push(`column ${n} isn't in the profile`);
      let arg: unknown = null;
      try { arg = JSON.parse(r.arg); } catch { /* compared as text below */ }
      if (!problems.length && JSON.stringify(arg) !== JSON.stringify(v.arg)) problems.push('it writes back other paths than the profile names (a path, a read-only column or the key changed)');
      if (problems.length) out.push({ severity: 'warning', entry: null, field, message: `View ${name} is out of date with the profile: ${problems.join('; ')}. ${again}` });
    }
  }
  return out;
}

/**
 * (sprint 147) Checks on the application's own rows, with no database: the login page (087) and page groups (089).
 */
function structureFindings(x: AppRows): Finding[] {
  const out: Finding[] = [];
  const { app, pages, all } = x;
  if (app.login_page) {
    const page = pages.find((p) => Number(p.page_no) === Number(app.login_page));
    const field = 'Application settings → Login page';
    if (!page) out.push({ severity: 'error', entry: null, field, message: `Page ${app.login_page} doesn't exist: the built-in sign-in page is shown instead.` });
    else if (page.requires_auth) out.push({ severity: 'error', entry: null, field, message: `Page ${app.login_page} requires authentication: the built-in sign-in page is shown instead.` });
    else if (!all.some((r) => r.kind === 'region' && r.row.type === 'login' && r.row.page_id === page.id))
      out.push({ severity: 'error', entry: null, field, message: `Page ${app.login_page} has no Login region: nobody can sign in.` });
  }
  // (154, CD-2) a SQL condition one declarative type can say: no query, and it reads in words in the tree
  for (const r of all) {
    const field = r.kind === 'region' || r.kind === 'button' ? 'condition'
      : ['item', 'validation', 'process', 'computation', 'app_computation', 'branch'].includes(r.kind) ? 'condition_expr' : null;
    if (!field || (r.row.build_option ?? '') === 'COMMENTED_OUT') continue;
    const sql = (r.row.condition_type ?? (field === 'condition' ? 'sql' : null)) === 'sql' ? r.row[field] : null;
    const d = sql ? declarativeCondition(sql) : null;
    if (!d) continue;
    const what = [d.condition_expr && `expression ${d.condition_expr}`, d.condition_value && `value ${d.condition_value}`].filter(Boolean).join(', ');
    out.push({ severity: 'info', entry: x.byKey.get(`${r.kind}-${r.row.id}`) ?? null, field: 'Server-side condition',
      message: `The SQL condition ${String(sql).trim()} can be the condition type ${d.condition_type}${what ? ` (${what})` : ''}: decided without a query, and shown in words.` });
  }
  // (155, CD-1) a SQL validation one declarative type says exactly
  const VALIDATION_OF: Record<string, string> = { item_not_null: 'not_null', item_equals: 'equals', item_in_list: 'in_list' };
  for (const r of all) {
    if (r.kind !== 'validation' || r.row.type !== 'sql' || (r.row.build_option ?? '') === 'COMMENTED_OUT') continue;
    const d = declarativeCondition(r.row.expression);
    const type = d && VALIDATION_OF[d.condition_type ?? ''];
    if (!d || !type) continue;
    out.push({ severity: 'info', entry: x.byKey.get(`validation-${r.row.id}`) ?? null, field: 'Type',
      message: `The SQL validation ${String(r.row.expression).trim()} can be the type ${type} with associated item ${d.condition_expr}${d.condition_value ? ` and value ${d.condition_value}` : ''}: no query.` });
  }
  const groups = new Set(all.filter((r) => r.kind === 'page_group').map((r) => r.row.name));
  for (const p of [...pages].sort((a, b) => a.page_no - b.page_no))
    if (p.page_group != null && !groups.has(p.page_group))
      out.push({ severity: 'warning', entry: null, field: `Page ${p.page_no} → Page group`, message: `Page group ${p.page_group} doesn't exist (Shared Components → Page groups).` });
  return out;
}

/**
 * (sprint 147) References between the application's components: pages, items, lists of values, schemes, build options,
 * layouts, regions, processes, workflow steps. `ext.workspace` (the remote servers and web credentials of the
 * application's workspace) and `ext.otherAppPage` (a branch to another application) need a database: without them
 * (an export checked offline) those checks are skipped.
 */
async function referenceFindings(x: AppRows, ext: {
  workspace: { servers: Map<string, string | null>; credentials: Set<string> } | null;
  otherAppPage: ((alias: string, pageNo: number) => Promise<boolean>) | null;
}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const { entries, all, byKey } = x;
  const pageNos = new Set(entries.filter((e) => e.kind === 'page').map((e) => e.pageNo));
  const items = new Set(all.filter((x) => x.kind === 'item' || x.kind === 'app_item').map((x) => x.row.name.toUpperCase()));
  const lovs = new Set(all.filter((x) => x.kind === 'lov').map((x) => x.row.name.toUpperCase()));
  const schemes = new Set(all.filter((x) => x.kind === 'authz_scheme').map((x) => x.row.name));
  const buildOptions = new Set(all.filter((x) => x.kind === 'build_option').map((x) => x.row.name));
  const layouts = new Set(all.filter((x) => x.kind === 'report_layout').map((x) => x.row.name.toUpperCase()));
  const regionIds = new Set(all.filter((x) => x.kind === 'region').map((x) => x.row.id));
  // (104) a document button names a document template or a report query
  const documents = new Set(all.filter((x) => x.kind === 'document_template' || x.kind === 'report_query').map((x) => x.row.name.toUpperCase()));
  const missing = (entry: Entry | null, field: string, message: string, severity: Severity = 'error') => findings.push({ severity, entry, field, message });
  // (141) remote servers and web credentials of the application's workspace (sources and invoke steps may name them)
  const wsServers = ext.workspace?.servers ?? new Map<string, string | null>();
  const wsCredentials = ext.workspace?.credentials ?? new Set<string>();
  const appCredentials = new Set(all.filter((x) => x.kind === 'web_credential').map((x) => String(x.row.name).toUpperCase()));

  for (const e of entries) {
    for (const f of e.fields) {
      if (!f.value) continue;
      if (f.kind === 'page' && f.value && !pageNos.has(Number(f.value))) missing(e, f.label, `Page ${f.value} doesn't exist.`);
      if (f.kind === 'build_option' && !buildOptions.has(f.value.replace(/^!/, '')))
        missing(e, f.label, `Build option ${f.value.replace(/^!/, '')} doesn't exist, so the component is always left out.`);
      if (f.kind === 'authz') {
        const name = f.value.replace(/^!/, '');
        if (!schemes.has(name) && !BUILT_IN.has(name)) missing(e, f.label, `Authorization scheme ${name} doesn't exist (nobody passes it).`);
      }
      for (const m of f.value.matchAll(/LOV:([A-Za-z0-9_]+)/g)) if (!lovs.has(m[1].toUpperCase())) missing(e, f.label, `List of values ${m[1].toUpperCase()} doesn't exist.`);
      if (f.kind === 'code' || f.kind === 'text' || f.kind === 'textarea' || f.kind === 'json')
        for (const m of f.value.matchAll(ITEM_REF))
          if (!items.has(m[1].toUpperCase())) missing(e, f.label, `Item ${m[1].toUpperCase()} doesn't exist (its value is always empty).`, 'warning');
      if (f.kind === 'json') {
        let cfg: any;
        try {
          cfg = JSON.parse(f.value);
        } catch {
          continue;
        }
        if (cfg?.link?.page !== undefined && !pageNos.has(Number(cfg.link.page))) missing(e, f.label, `The link goes to page ${cfg.link.page}, which doesn't exist.`);
        if (cfg?.link?.items) for (const k of Object.keys(cfg.link.items)) if (!items.has(k.toUpperCase())) missing(e, f.label, `The link sets item ${k}, which doesn't exist.`, 'warning');
        if (cfg?.pdf?.layout && !layouts.has(String(cfg.pdf.layout).toUpperCase())) missing(e, f.label, `Report layout ${cfg.pdf.layout} doesn't exist (the built-in layout is used).`, 'warning');
        if (typeof cfg?.public_reports === 'string' && !schemes.has(cfg.public_reports)) missing(e, f.label, `Authorization scheme ${cfg.public_reports} doesn't exist.`);
        if (e.kind === 'region' && cfg?.report !== undefined && !regionIds.has(Number(cfg.report))) missing(e, f.label, `Region ${cfg.report} doesn't exist.`);
      }
    }
  }
  // forms and grids
  for (const { kind, row } of all) {
    const e = byKey.get(`${kind}-${row.id}`) ?? null;
    // a grid on a REST data source takes its key from the source's key columns when it has no primary key column
    const restKeys = row.rest_source
      ? all.find((x) => x.kind === 'rest_source' && String(x.row.name).toUpperCase() === String(row.rest_source).toUpperCase())?.row.key_columns
      : null;
    if (kind === 'region' && row.type === 'grid' && (!(row.table_name || row.rest_source) || !(row.pk_column || restKeys?.length)))
      missing(e, 'Source', 'A grid needs a table (or a REST data source with key columns) and a primary key column.');
    if (kind === 'region' && row.type === 'grid' && !all.some((x) => x.kind === 'process' && x.row.type === 'grid_dml' && x.row.region_id === row.id))
      missing(e, 'Source', 'No grid_dml process saves this grid, so it is read-only.', 'info');
    if (kind === 'region' && row.type === 'form' && row.pk_item && !items.has(String(row.pk_item).toUpperCase())) missing(e, 'Primary key item', `Item ${row.pk_item} doesn't exist.`);
    // (140) a list item (select list, radio group, shuttle, select one or many …) shows no choices without a list of values
    if (kind === 'item' && LOV_CHECKED.has(row.type) && !String(row.lov ?? '').trim())
      missing(e, 'List of values', `A ${row.type} item needs a list of values: it has no choices, and no value passes the check on submit.`, 'warning');
    // (078) a URL region: a literal origin, valid attributes
    if (kind === 'region' && row.type === 'url') {
      const target = urlTarget(row.source);
      if ('error' in target) missing(e, 'Source', target.error);
      const problem = urlConfigProblem(row.config);
      if (problem) missing(e, 'Attributes', problem);
    }
    if (kind === 'computation' && !items.has(String(row.item_name).toUpperCase())) missing(e, 'Item', `Item ${row.item_name} doesn't exist (the computation sets nothing).`);
    if (kind === 'computation' && row.type === 'item' && !items.has(String(row.expression).toUpperCase())) missing(e, 'Expression', `Item ${row.expression} doesn't exist (its value is always empty).`, 'warning');
    if (kind === 'process' && (row.type === 'form_dml' || row.type === 'grid_dml') && !row.region_id) missing(e, 'Region', `A ${row.type} process needs its region.`);
    if (kind === 'process') {
      for (const problem of processProblems(row.type, row.config)) missing(e, 'Configuration', problem);
      if (row.parent_process && !all.some((x) => x.kind === 'process' && x.row.page_id === row.page_id && x.row.type === 'chain' && x.row.name === row.parent_process))
        missing(e, 'Chain (parent process)', `There is no chain process "${row.parent_process}" on this page, so this process never runs.`);
      if (row.type === 'workflow' && (row.config?.action ?? 'start') === 'start' && row.config?.definition
          && !all.some((x) => x.kind === 'workflow_definition' && x.row.name === String(row.config.definition).toUpperCase()))
        missing(e, 'Configuration', `Workflow definition ${row.config.definition} doesn't exist.`);
    }
    if (kind === 'branch' && row.target_type === 'page' && row.target_page && !pageNos.has(Number(row.target_page))) missing(e, 'Page', `Page ${row.target_page} doesn't exist.`);
    if (kind === 'branch' && row.target_type === 'app' && ext.otherAppPage && !(await ext.otherAppPage(row.target_app, row.target_page)))
      missing(e, 'Application (app)', `Application ${row.target_app} has no page ${row.target_page}.`);
    if (kind === 'button' && row.action === 'document' && !documents.has(String(row.document ?? '').toUpperCase()))
      missing(e, 'Document template', row.document ? `Document template or report query ${row.document} doesn't exist.` : 'A document button needs a document template or a report query.');
    if (kind === 'rest_module') for (const problem of handlerProblems(row.handlers)) missing(e, 'Handlers (JSON)', problem);
    if (kind === 'rest_source') {
      // (141) an export may name a server or credential this workspace doesn't have (yet): it imports, and says so here
      if (ext.workspace && row.server && !wsServers.has(row.server))
        missing(e, 'Remote server', `Remote server ${row.server} doesn't exist in this application's workspace: add it under Workspace utilities → Remote servers (calls fail until then).`, 'warning');
      const credential = row.credential || (row.server ? wsServers.get(row.server) : null);
      if (ext.workspace && credential && !appCredentials.has(credential) && !wsCredentials.has(credential))
        missing(e, 'Web credential', `Web credential ${credential} is neither the application's nor its workspace's (calls fail until it exists).`, 'warning');
    }
    if (kind === 'workflow_definition') {
      const tasks = new Set(all.filter((x) => x.kind === 'task_definition').map((x) => x.row.name.toUpperCase()));
      const outcomes = outcomeMap(all.filter((x) => x.kind === 'task_definition').map((x) => x.row));
      for (const problem of stepProblems(row.steps, tasks, { outcomes, drafts: false })) missing(e, 'Steps (JSON)', problem);
      for (const warning of stepWarnings(row.steps)) missing(e, 'Steps (JSON)', warning, 'warning');
      // invoke_api steps: REST data sources, parameters, web credentials, variables (sprint 32)
      const refs = {
        sources: new Map(all.filter((x) => x.kind === 'rest_source').map((x) => [String(x.row.name).toUpperCase(), x.row])),
        credentials: new Set([...appCredentials, ...wsCredentials]),
        startVars: [...String(row.title ?? '').matchAll(/&([A-Za-z][A-Za-z0-9_]*)\./g)].map((m) => m[1]),
      };
      const invokeRefs = invokeStepReferences(row.steps, refs);
      for (const problem of invokeRefs.errors) missing(e, 'Steps (JSON)', problem);
      for (const warning of invokeRefs.warnings) missing(e, 'Steps (JSON)', warning, 'warning');
      if (row.dev_version) {
        const field = `Steps of version ${row.dev_version} (development)`;
        for (const problem of stepProblems(row.dev_steps, tasks, { outcomes })) missing(e, field, problem, 'warning');
        for (const warning of stepWarnings(row.dev_steps)) missing(e, field, warning, 'warning');
        const devRefs = invokeStepReferences(row.dev_steps, refs);
        for (const problem of [...devRefs.errors, ...devRefs.warnings]) missing(e, field, problem, 'warning');
      }
    }
    if (kind === 'report_query' && row.layout && !layouts.has(String(row.layout).toUpperCase())) missing(e, 'Report layout', `Report layout ${row.layout} doesn't exist (the default layout is used).`, 'warning');
    if (kind === 'app_computation' && row.type === 'item' && !items.has(String(row.expression).toUpperCase())) missing(e, 'Expression', `Item ${row.expression} doesn't exist (its value is always empty).`, 'warning');
    if (kind === 'document_template') {
      const problem = templateProblem(row.template ?? '');
      if (problem) missing(e, 'Template (HTML)', problem);
      if (row.layout && !layouts.has(String(row.layout).toUpperCase())) missing(e, 'Report layout', `Report layout ${row.layout} doesn't exist (the default layout is used).`, 'warning');
    }
  }

  return findings;
}

const ITEM_REF = /(?<![A-Za-z0-9_$&:])(?::|&)(P\d+_[A-Z0-9_]+)\b/gi;
const BUILT_IN = new Set(['MUST_NOT_BE_PUBLIC_USER']);

/**
 * Run every check of an application. With `tx` (a client in a transaction,
 * e.g. an import that hasn't committed yet) everything is read and checked
 * on that client, inside a savepoint that is rolled back.
 */
export async function advise(appId: number, tx?: pg.ClientBase, opts: { db?: Db } = {}): Promise<{ findings: Finding[]; checked: number; plpgsqlCheck: boolean }> {
  const query = (sql: string, params: unknown[] = []) => (tx ? tx.query(sql, params) : owner.query(sql, params));
  const one = async (sql: string, params: unknown[] = []) => (await query(sql, params)).rows[0];
  const app = await one('select * from meta.app where id = $1', [appId]);
  const pages = (await query('select * from meta.page where app_id = $1 order by page_no', [appId])).rows;
  const findings: Finding[] = [];
  let checked = 0;

  // rows with every column (the entries only carry the searchable fields)
  const rowsOf = async (kind: string, table: string, scope: 'page' | 'app') =>
    (scope === 'page'
      ? await query(`select t.*, p.page_no from ${table} t join meta.page p on p.id = t.page_id where p.app_id = $1`, [appId])
      : await query(`select * from ${table} where app_id = $1`, [appId])
    ).rows.map((row) => ({ kind, row }));
  // one client (an import's transaction) runs one query at a time; the pool may run them side by side
  const lists: { kind: string; row: any }[][] = [];
  if (tx) for (const [kind, spec] of Object.entries(COMPONENTS)) lists.push(await rowsOf(kind, spec.table, spec.scope));
  else lists.push(...(await Promise.all(Object.entries(COMPONENTS).map(([kind, spec]) => rowsOf(kind, spec.table, spec.scope)))));
  const all = lists.flat();
  const byKind = new Map<string, any[]>();
  for (const x of all) byKind.set(x.kind, [...(byKind.get(x.kind) ?? []), x.row]);
  for (const [kind, spec] of Object.entries(COMPONENTS))
    byKind.get(kind)?.sort((a, b) => spec.scope === 'page' ? (a.page_no - b.page_no || (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id) : a.id - b.id);
  const entries = entriesOf(appId, pages, byKind);
  const byKey = new Map(entries.map((e) => [`${e.kind}-${e.id}`, e]));
  const rows: AppRows = { app, pages, all, entries, byKey };

  // metadata checks, as the owner (before the role switch below: the application's role can't read meta)
  findings.push(...structureFindings(rows));
  // (sprint 130, SEC-3) administrators of the application who sign in with only a password
  if (app.authentication === 'app_users' && (app.local_login || (app.ldap_directories ?? []).length)) {
    const covered = app.mfa === 'required' || (app.mfa === 'roles' && (app.mfa_roles ?? []).includes('admin'));
    const admins = covered ? 0 : (await one(`select count(*)::int as n from meta.app_access where app_id = $1 and 'admin' = any(roles)`, [appId])).n;
    if (admins)
      findings.push({ severity: 'warning', entry: null, field: 'Application settings → Two-factor sign-in',
        message: `${admins === 1 ? 'A user' : `${admins} users`} with the admin role sign${admins === 1 ? 's' : ''} in with only a password: require two-factor sign-in (Required, or Required for roles: admin).` });
  }
  findings.push(...(await securityFindings(rows, query)));
  findings.push(...(await jsonSourceFindings(app.json_sources, query)));
  // ---- SQL, as the application's role, rolled back (a savepoint in the caller's transaction)
  // (090) an isolated workspace's application: planned on the workspace's developer login, in a
  // transaction of its own (planning can run the application's functions; RESET ROLE there only
  // reaches that login, never the owner); `opts.db` names the login for an import into the workspace
  const own = opts.db && opts.db !== owner ? opts.db : await devDbForApp(appId);
  const inTx = !!tx && own === owner;
  const c = (inTx ? tx : await (own === owner ? owner : own).pool.connect()) as pg.PoolClient;
  try {
    await c.query(inTx ? 'savepoint advisor_all' : 'begin');
    await c.query(`set local statement_timeout = '5s'`);
    await c.query(`select set_config('pgkiln.app_id', $1, true)`, [String(appId)]);
    if (app.db_role) await c.query(`set local role ${pg.escapeIdentifier(app.db_role)}`);
    for (const { kind, row } of all) {
      for (const f of sqlFields(kind, row)) {
        const sql = row[f.name];
        if (typeof sql !== 'string' || !sql.trim()) continue;
        checked++;
        const problem = await checkSql(c, sql, f.shape);
        const entry = byKey.get(`${kind}-${row.id}`) ?? null;
        const label = COMPONENTS[kind].fields.find((x) => x.name === f.name)?.label ?? f.name;
        if (problem) findings.push({ ...problem, entry, field: label });
      }
    }
    // a map region's further layers (config.layers[].source)
    for (const { kind, row } of all.filter((x) => x.kind === 'region' && x.row.type === 'map')) {
      const entry = byKey.get(`${kind}-${row.id}`) ?? null;
      for (const l of Array.isArray(row.config?.layers) ? row.config.layers : []) {
        if (typeof l?.source !== 'string' || !l.source.trim()) continue;
        checked++;
        const problem = await checkSql(c, l.source, 'select');
        if (problem) findings.push({ ...problem, entry, field: `Layer "${typeof l.name === 'string' ? l.name : ''}" query` });
      }
    }
    // (080) search configurations: their source with the columns they name
    for (const { kind, row } of all.filter((x) => x.kind === 'search_config' && x.row.source_type !== 'list')) {
      const entry = byKey.get(`${kind}-${row.id}`) ?? null;
      const problems = searchConfigProblems(row);
      if (problems.length) {
        findings.push({ severity: 'error', entry, field: 'Source', message: problems.join(' ') });
        continue;
      }
      let cols = configColumns(row).map((x) => `t.${pg.escapeIdentifier(x)}`).join(', ') || '*';
      // (135) a full-text configuration: its tsvector matched with its text search configuration
      const fulltext = row.search_type === 'fulltext' || row.search_type === 'hybrid';
      // (136) a vector or hybrid configuration also reads its vector (and key) column
      const vectorType = row.search_type === 'vector' || row.search_type === 'hybrid';
      if (vectorType) cols = [cols === '*' ? 't.*' : cols, ...[row.vector_column, row.key_column].filter(Boolean).map((x: string) => `t.${pg.escapeIdentifier(x)}`)].join(', ');
      if (fulltext) {
        const cfg = await textSearchConfig(c, row.fts_config, app.language);
        if (row.fts_config && cfg !== row.fts_config)
          findings.push({ severity: 'error', entry, field: 'Text search configuration', message: `Text search configuration ${row.fts_config} doesn't exist (pg_ts_config): ${cfg} is used instead.` });
        const lit = `${pg.escapeLiteral(cfg)}::regconfig`;
        // (ts_rank_cd takes only a tsvector: text @@ tsquery would pass)
        cols = `${cols === '*' ? 't.*' : cols}, ts_rank_cd(${tsvectorSql(row, lit)}, websearch_to_tsquery(${lit}, 'x'))`;
      }
      checked++;
      const problem = await checkSql(c, `select ${cols} from ${row.source_type === 'table' ? row.source.trim() : `(${row.source})`} t`, 'select');
      if (problem) findings.push({ ...problem, entry, field: fulltext ? 'Source / tsvector' : 'Source' });
      // (135) a full-text search on a table without a GIN index on its tsvector reads every row
      if (fulltext && !problem && row.source_type === 'table') {
        const vector = String(row.fts_vector ?? '').trim();
        const column = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(vector) ? vector : null;
        await c.query('savepoint advisor_fts');
        const ix = (await c.query<{ checkable: boolean; gin: boolean }>(
          `select cl.relkind in ('r', 'p', 'm') as checkable,
                  exists (select from pg_catalog.pg_index i join pg_catalog.pg_class ic on ic.oid = i.indexrelid join pg_catalog.pg_am am on am.oid = ic.relam
                           where i.indrelid = cl.oid and am.amname = 'gin'
                             and case when $2::text is not null
                                      then (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = cl.oid and a.attname = $2 and not a.attisdropped) = any (i.indkey::int2[])
                                      else i.indexprs is not null and pg_catalog.pg_get_indexdef(i.indexrelid) ~* 'to_tsvector' end) as gin
             from pg_catalog.pg_class cl where cl.oid = $1::regclass`, [row.source.trim(), column]).catch(async () => {
          await c.query('rollback to savepoint advisor_fts');
          return { rows: [] };
        })).rows[0];
        if (ix?.checkable && (!ix.gin || !vector))
          findings.push({
            severity: 'warning', entry, field: 'tsvector column or expression',
            message: column
              ? `${row.source.trim()}.${column} has no GIN index: every search reads the whole table (create index … on ${row.source.trim()} using gin (${pg.escapeIdentifier(column)})).`
              : vector
                ? `${row.source.trim()} has no GIN index on a to_tsvector expression: every search reads the whole table.`
                : `The tsvector is built from the searchable columns on every search, so no index can help: add a tsvector column with a GIN index (SQL Workshop › Table Properties › Add full-text search) and name it here.`,
          });
      }
    }
    // (136) vector and hybrid configurations: pgvector, the provider, the column's dimensions and its index
    for (const { kind, row } of all.filter((x) => x.kind === 'search_config' && (x.row.search_type === 'vector' || x.row.search_type === 'hybrid') && !searchConfigProblems(x.row).length)) {
      const entry = byKey.get(`${kind}-${row.id}`) ?? null;
      const schema = await vectorSchema(c);
      if (!schema) {
        findings.push({ severity: 'error', entry, field: 'Search type', message: PGVECTOR_MISSING });
        continue;
      }
      const provider = (Array.isArray(app.vector_providers) ? app.vector_providers : []).find((p: { name: string }) => p.name === row.vector_provider);
      if (!provider) findings.push({ severity: 'error', entry, field: 'Vector provider', message: `There is no vector provider ${row.vector_provider} (Shared Components → Vector providers).` });
      if (row.source_type !== 'table') continue;
      await c.query('savepoint advisor_vec');
      const info = await (async () => {
        const dims = await vectorColumnDims(c, row.source.trim(), row.vector_column);
        const ix = (await c.query<{ ok: boolean; ops: string | null }>(
          `select exists (select from pg_catalog.pg_index i join pg_catalog.pg_class ic on ic.oid = i.indexrelid join pg_catalog.pg_am am on am.oid = ic.relam
                           where i.indrelid = $1::regclass and am.amname in ('hnsw', 'ivfflat')
                             and (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = $1::regclass and a.attname = $2) = any (i.indkey::int2[])) as ok,
                  (select string_agg(o.opcname, ',') from pg_catalog.pg_index i join pg_catalog.pg_opclass o on o.oid = any (i.indclass::oid[])
                    where i.indrelid = $1::regclass and (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = $1::regclass and a.attname = $2) = any (i.indkey::int2[])) as ops`,
          [row.source.trim(), row.vector_column])).rows[0];
        return { dims, ix };
      })().catch(async () => {
        await c.query('rollback to savepoint advisor_vec');
        return null;
      });
      if (!info) continue;
      if (info.dims === undefined) findings.push({ severity: 'error', entry, field: 'Vector column', message: `${row.source.trim()} has no column ${row.vector_column}.` });
      else if (info.dims === null) findings.push({ severity: 'error', entry, field: 'Vector column', message: `${row.source.trim()}.${row.vector_column} is not a vector(n) column.` });
      else if (provider && info.dims !== provider.dimensions)
        findings.push({ severity: 'error', entry, field: 'Vector column', message: `${row.source.trim()}.${row.vector_column} is vector(${info.dims}), vector provider ${provider.name} gives ${provider.dimensions} dimensions.` });
      if (info.dims && !info.ix?.ok)
        findings.push({ severity: 'warning', entry, field: 'Vector column', message: `${row.source.trim()}.${row.vector_column} has no HNSW index: every search reads the whole table (SQL Workshop › Table Properties › Add vector column adds one).` });
      else if (info.dims && info.ix?.ops && !info.ix.ops.split(',').includes(DISTANCES[(row.distance ?? 'cosine') as Distance].opclass))
        findings.push({ severity: 'warning', entry, field: 'Distance', message: `The index on ${row.vector_column} is for ${info.ix.ops}, not ${DISTANCES[(row.distance ?? 'cosine') as Distance].opclass}: the ${row.distance ?? 'cosine'} search can't use it.` });
    }
    // the search regions name existing configurations
    for (const { kind, row } of all.filter((x) => x.kind === 'region' && x.row.type === 'search')) {
      const names: unknown[] = Array.isArray(row.config?.configs) ? row.config.configs : [];
      for (const n of names)
        if (!all.some((x) => x.kind === 'search_config' && x.row.name === String(n).toUpperCase()))
          findings.push({ severity: 'error', entry: byKey.get(`${kind}-${row.id}`) ?? null, field: 'Attributes', message: `Search configuration ${String(n)} doesn't exist.` });
    }
    // REST handlers
    for (const { kind, row } of all.filter((x) => x.kind === 'rest_module')) {
      const entry = byKey.get(`${kind}-${row.id}`) ?? null;
      for (const h of Array.isArray(row.handlers) ? row.handlers : []) {
        if (typeof h?.source !== 'string' || !h.source.trim()) continue;
        checked++;
        // (117) a PL/pgSQL handler is compiled as the DO block it runs as
        let block: string | null = null;
        if (h.type === 'plpgsql') try {
          block = plpgsqlBlock(h.source);
        } catch (e) {
          findings.push({ severity: 'error', message: (e as Error).message, entry, field: `${h.method} ${h.path}` });
          continue;
        }
        const problem = await checkSql(c, block ?? h.source, h.type === 'sql' || block ? 'statements' : 'select');
        if (problem) findings.push({ ...problem, entry, field: `${h.method} ${h.path}` });
      }
    }
    // workflow steps: sql code, switch conditions, task owner queries
    for (const { kind, row } of all.filter((x) => x.kind === 'workflow_definition')) {
      const entry = byKey.get(`${kind}-${row.id}`) ?? null;
      // the active version, and the one in development (migration 027)
      const versions: [string, unknown][] = [['', row.steps], ...(row.dev_version ? [[`version ${row.dev_version}, `, row.dev_steps] as [string, unknown]] : [])];
      for (const [v, steps] of versions) for (const st of Array.isArray(steps) ? steps : []) {
        const checks: [string, string, SqlShape][] = [];
        if (st?.type === 'sql' && typeof st.code === 'string') checks.push([`${v}step ${st.name}: code`, st.code, 'statements']);
        if (st?.type === 'task' && typeof st.owners === 'string' && st.owners.trim()) checks.push([`${v}step ${st.name}: owners`, st.owners, 'select']);
        if (st?.type === 'switch' && Array.isArray(st.cases)) for (const cs of st.cases) if (typeof cs?.when === 'string') checks.push([`${v}step ${st.name}: when`, cs.when, 'boolean']);
        // (123) a send_mail step's recipients query
        if (st?.type === 'send_mail' && typeof st.to === 'string' && isQuery(st.to)) checks.push([`${v}step ${st.name}: to`, st.to, 'select']);
        for (const [field, sql, shape] of checks) {
          checked++;
          const problem = await checkSql(c, sql, shape);
          if (problem) findings.push({ ...problem, entry, field });
        }
      }
    }
  } finally {
    if (inTx) {
      await c.query('rollback to savepoint advisor_all');
      await c.query('release savepoint advisor_all');
    } else {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  }

  // ---- references
  const wsServers = new Map((await query('select static_id, credential from meta.remote_server where workspace_id = meta.app_workspace($1)', [appId])).rows.map((r) => [r.static_id as string, r.credential as string | null]));
  const wsCredentials = new Set((await query('select name from meta.workspace_credential where workspace_id = meta.app_workspace($1)', [appId])).rows.map((r) => r.name as string));
  findings.push(...(await referenceFindings(rows, {
    workspace: { servers: wsServers, credentials: wsCredentials },
    otherAppPage: async (alias, pageNo) => !!(await one('select 1 as ok from meta.app a join meta.page p on p.app_id = a.id where a.alias = $1 and p.page_no = $2', [alias, pageNo])),
  })));

  // ---- (117) REST modules refuse (403) to run as a superuser, a role that bypasses RLS or a member of pgkiln's
  // owner: say so here before the endpoints fail. Without a db_role the runtime connection's own user is the role.
  if (all.some((x) => x.kind === 'rest_module')) {
    const role = await (app.db_role ? owner : runtime).one(
      `select r.rolname, r.rolsuper or r.rolbypassrls or pg_has_role(r.oid, n.nspowner, 'MEMBER') as bad
         from pg_roles r, pg_namespace n where r.rolname = coalesce($1, current_user) and n.nspname = 'meta'`,
      [app.db_role ?? null],
    );
    if (!role || role.bad)
      findings.push({ severity: 'error', entry: null, field: 'REST modules',
        message: `The handlers would run as ${role?.rolname ?? app.db_role}, a role that bypasses row level security or owns pgkiln, so every REST module endpoint answers 403. Give the application its own database role (Settings → Security), or set RUNTIME_DATABASE_URL to the least-privilege runtime role.` });
  }

  // ---- PL/pgSQL functions of the app's schemas, with plpgsql_check when installed
  const plpgsqlCheck = !!(await one(`select 1 as ok from pg_extension where extname = 'plpgsql_check'`));
  if (plpgsqlCheck && app.db_role) {
    const res = await query(
      `select p.oid::regprocedure::text as fn, r.level, r.message, r.lineno
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang and l.lanname = 'plpgsql'
         cross join lateral plpgsql_check_function_tb(p.oid) r
        where p.prorettype <> 'trigger'::regtype
          and n.nspname in (select nspname from pg_namespace ns where has_schema_privilege($1, ns.oid, 'USAGE') and nspname not in ('pg_catalog', 'information_schema', 'meta', 'public') and nspname not like 'pg\\_%')
        order by 1, r.lineno`,
      [app.db_role],
    );
    for (const r of res.rows)
      findings.push({ severity: r.level === 'error' ? 'error' : r.level === 'warning' ? 'warning' : 'info', entry: null, field: `${r.fn}${r.lineno ? `, line ${r.lineno}` : ''}`, message: r.message });
  }
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.entry?.pageNo ?? 0) - (b.entry?.pageNo ?? 0));
  return { findings, checked, plpgsqlCheck };
}

const SEVERITY_LABEL: Record<Severity, string> = { error: 'Error', warning: 'Warning', info: 'Note' };

// ------------------------------------------------------------------ (sprint 147) offline: an export without a database

/** The export's list of a kind of component (app.json's keys: lovs, nav, list_entries, data_load_definitions …). */
const docKey = (kind: string) =>
  kind === 'nav_entry' ? 'nav' : kind === 'data_load_def' ? 'data_load_definitions'
    : kind.endsWith('y') ? `${kind.slice(0, -1)}ies` : /(s|ch)$/.test(kind) ? `${kind}es` : `${kind}s`;

/**
 * An export (meta.export_app's JSON, or filesToDoc of its files) as the rows the checks read. Rows keep the ids the
 * export carries (regions: processes and buttons name them by region_id); the others, and pages, get ids of their
 * own (negative, so they never meet an exported id).
 */
export function rowsOfDoc(doc: any): AppRows {
  if (!doc || typeof doc !== 'object' || !doc.app || typeof doc.app !== 'object') throw new Error('not an application export (no "app")');
  let next = 0;
  const idOf = (row: any) => (typeof row?.id === 'number' ? row.id : --next);
  // the checks read names as text (a database row always has one)
  const named = (row: any) => ({ ...row, name: typeof row.name === 'string' ? row.name : String(row.name ?? '') });
  const pages = (Array.isArray(doc.pages) ? doc.pages : []).filter((p: any) => p && typeof p === 'object').map((p: any) => ({ ...named(p), id: --next }));
  const all: Row[] = [];
  for (const [kind, spec] of Object.entries(COMPONENTS)) {
    if (spec.scope === 'page') {
      for (const p of pages) {
        const list = (doc.pages.find((d: any) => d && d.page_no === p.page_no)?.[docKey(kind)] ?? []) as any[];
        for (const row of Array.isArray(list) ? list : []) if (row && typeof row === 'object') all.push({ kind, row: { ...named(row), id: idOf(row), page_id: p.id, page_no: p.page_no } });
      }
    } else {
      const list = doc[docKey(kind)];
      for (const row of Array.isArray(list) ? list : []) if (row && typeof row === 'object') all.push({ kind, row: { ...named(row), id: idOf(row) } });
    }
  }
  const byKind = new Map<string, any[]>();
  for (const x of all) byKind.set(x.kind, [...(byKind.get(x.kind) ?? []), x.row]);
  const entries = entriesOf(0, pages, byKind);
  return { app: doc.app, pages, all, entries, byKey: new Map(entries.map((e) => [`${e.kind}-${e.id}`, e])) };
}

/**
 * The checks that need no database, on an export: references between its components, the login page and page
 * groups, the pages' security defaults, workflow steps, process settings and JSON source profiles. Not done
 * offline: planning SQL (it needs the application's tables and role), the catalog (vector and full-text columns, JSON
 * source views, plpgsql_check), the workspace's remote servers and credentials, branches to other applications, and
 * the installation's session limits and users.
 */
export async function adviseDoc(doc: any): Promise<{ findings: Finding[]; checked: number }> {
  const x = rowsOfDoc(doc);
  const findings: Finding[] = [...structureFindings(x), ...pageSecurityFindings(x)];
  for (const src of Array.isArray(x.app.json_sources) ? x.app.json_sources : []) {
    if (!src || typeof src !== 'object') continue;
    const problems = jsonSourceProblems(src);
    if (problems.length) findings.push({ severity: 'error', entry: null, field: `JSON source ${src?.name ?? ''}`, message: problems.join(' ') });
  }
  findings.push(...(await referenceFindings(x, { workspace: null, otherAppPage: null })));
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.entry?.pageNo ?? 0) - (b.entry?.pageNo ?? 0));
  return { findings, checked: 0 };
}

export async function advisorRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/advisor`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = /^\d+$/.test(req.params.id) ? await owner.one('select * from meta.app where id = $1', [req.params.id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const { findings, checked, plpgsqlCheck } = await advise(a.id);
    const count = (sev: Severity) => findings.filter((f) => f.severity === sev).length;
    const list: Raw = findings.length
      ? html`<ul class="hits findings">${findings.map((f) => html`<li class="finding-${f.severity}">
          ${f.entry ? html`<a href="${f.entry.url}">${icon(f.entry.icon)}<span>${f.entry.kindLabel}: ${f.entry.label}</span></a>` : html`<span>${icon('code')} ${f.field}</span>`}
          ${f.entry?.pageNo !== null && f.entry?.pageNo !== undefined && f.entry.kind !== 'page' ? html`<span class="tag">page ${f.entry.pageNo}</span>` : html`<span></span>`}
          <span class="tag tag-${f.severity}">${SEVERITY_LABEL[f.severity]}</span>
          <span class="hit-snippet">${f.entry ? html`<b>${f.field}:</b> ` : ''}${f.message}</span>
        </li>`)}</ul>`
      : html`<div class="alert alert-success" role="status">No problems found.</div>`;
    const main = html`${appHeader(a, 'advisor', s)}
      ${region('Advisor', html`<p class="muted u-mt0">Checked ${checked} pieces of SQL as the role <code>${a.db_role ?? '(owner)'}</code> (planned with EXPLAIN and rolled back, nothing is run), and every reference to pages, items, lists of values, authorization schemes and report layouts.
          ${plpgsqlCheck ? 'PL/pgSQL functions were checked with plpgsql_check.' : html`Install the <code>plpgsql_check</code> extension to check PL/pgSQL functions too.`}</p>
        <p><span class="tag tag-error">${count('error')} errors</span> <span class="tag tag-warning">${count('warning')} warnings</span> <span class="tag tag-info">${count('info')} notes</span>
          <a class="btn u-mt0" href="${BASE}/apps/${a.id}/advisor">${icon('history')} Check again</a></p>
        ${list}`)}`;
    return send(reply, s, shell(s, `Advisor · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Advisor']], main));
  });
}
