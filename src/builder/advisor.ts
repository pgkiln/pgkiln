import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { applyBinds, splitStatements } from '../binds.ts';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { templateProblem } from '../runtime/document.ts';
import { invokeStepReferences, stepProblems, stepWarnings } from '../workflow.ts';
import { handlerProblems } from '../runtime/rest.ts';
import { processProblems } from '../runtime/processes.ts';
import { COMPONENTS } from './components.ts';
import { appEntries, type Entry } from './search.ts';
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
function sqlFields(kind: string, row: any): { name: string; shape: SqlShape }[] {
  switch (kind) {
    case 'region':
      return [
        ...(['report', 'grid', 'chart', 'cards', 'calendar', 'map', 'tree', 'dynamic'].includes(row.type) && row.source?.trim() && !row.rest_source ? [{ name: 'source', shape: 'select' as const }] : []),
        { name: 'condition', shape: 'boolean' },
      ];
    case 'item':
      return [
        ...(row.lov?.trim() && !/^(STATIC|LOV):/i.test(row.lov.trim()) ? [{ name: 'lov', shape: 'select' as const }] : []),
        { name: 'readonly_condition', shape: 'boolean' },
      ];
    case 'button':
      return [{ name: 'condition', shape: 'boolean' }, { name: 'badge_query', shape: 'select' }];
    case 'computation':
      return [
        ...(row.type === 'sql_query' ? [{ name: 'expression', shape: 'select' as const }] : []),
        ...conditionSql(row),
      ];
    case 'branch':
      return conditionSql(row);
    case 'dynamic_action':
      return row.action === 'set_value' ? [{ name: 'code', shape: 'select' }] : row.action === 'execute_sql' ? [{ name: 'code', shape: 'statements' }] : [];
    case 'validation':
      return row.type === 'sql' ? [{ name: 'expression', shape: 'boolean' }] : row.type === 'regex' ? [{ name: 'expression', shape: 'regex' }] : [];
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

/** The SQL of a computation's or branch's condition (migration 029). */
const conditionSql = (row: any): { name: string; shape: SqlShape }[] =>
  row.condition_type === 'sql' ? [{ name: 'condition_expr', shape: 'boolean' }] : row.condition_type === 'exists' || row.condition_type === 'not_exists' ? [{ name: 'condition_expr', shape: 'select' }] : [];

const EXPLAINABLE = /^\s*(\(|select|with|values|table|insert|update|delete|merge)\b/i;

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

const ITEM_REF = /(?<![A-Za-z0-9_$&:])(?::|&)(P\d+_[A-Z0-9_]+)\b/gi;
const BUILT_IN = new Set(['MUST_NOT_BE_PUBLIC_USER']);

/** Run every check of an application. */
export async function advise(appId: number): Promise<{ findings: Finding[]; checked: number; plpgsqlCheck: boolean }> {
  const app = await owner.one('select * from meta.app where id = $1', [appId]);
  const entries = await appEntries(appId);
  const byKey = new Map(entries.map((e) => [`${e.kind}-${e.id}`, e]));
  const findings: Finding[] = [];
  let checked = 0;

  // rows with every column (the entries only carry the searchable fields)
  const rowsOf = async (kind: string, table: string, scope: 'page' | 'app') =>
    (scope === 'page'
      ? await owner.query(`select t.*, p.page_no from ${table} t join meta.page p on p.id = t.page_id where p.app_id = $1`, [appId])
      : await owner.query(`select * from ${table} where app_id = $1`, [appId])
    ).rows.map((row) => ({ kind, row }));
  const all = (await Promise.all(Object.entries(COMPONENTS).map(([kind, spec]) => rowsOf(kind, spec.table, spec.scope)))).flat();

  // ---- SQL, as the application's role, rolled back
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local statement_timeout = '5s'`);
    await c.query(`select set_config('pgapex.app_id', $1, true)`, [String(appId)]);
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
    // REST handlers
    for (const { kind, row } of all.filter((x) => x.kind === 'rest_module')) {
      const entry = byKey.get(`${kind}-${row.id}`) ?? null;
      for (const h of Array.isArray(row.handlers) ? row.handlers : []) {
        if (typeof h?.source !== 'string' || !h.source.trim()) continue;
        checked++;
        const problem = await checkSql(c, h.source, h.type === 'sql' ? 'statements' : 'select');
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
        for (const [field, sql, shape] of checks) {
          checked++;
          const problem = await checkSql(c, sql, shape);
          if (problem) findings.push({ ...problem, entry, field });
        }
      }
    }
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }

  // ---- references
  const pageNos = new Set(entries.filter((e) => e.kind === 'page').map((e) => e.pageNo));
  const items = new Set(all.filter((x) => x.kind === 'item' || x.kind === 'app_item').map((x) => x.row.name.toUpperCase()));
  const lovs = new Set(all.filter((x) => x.kind === 'lov').map((x) => x.row.name.toUpperCase()));
  const schemes = new Set(all.filter((x) => x.kind === 'authz_scheme').map((x) => x.row.name));
  const buildOptions = new Set(all.filter((x) => x.kind === 'build_option').map((x) => x.row.name));
  const layouts = new Set(all.filter((x) => x.kind === 'report_layout').map((x) => x.row.name.toUpperCase()));
  const regionIds = new Set(all.filter((x) => x.kind === 'region').map((x) => x.row.id));
  const documents = new Set(all.filter((x) => x.kind === 'document_template').map((x) => x.row.name.toUpperCase()));
  const missing = (entry: Entry | null, field: string, message: string, severity: Severity = 'error') => findings.push({ severity, entry, field, message });

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
    if (kind === 'branch' && row.target_type === 'app'
        && !(await owner.one('select 1 as ok from meta.app a join meta.page p on p.app_id = a.id where a.alias = $1 and p.page_no = $2', [row.target_app, row.target_page])))
      missing(e, 'Application (app)', `Application ${row.target_app} has no page ${row.target_page}.`);
    if (kind === 'button' && row.action === 'document' && !documents.has(String(row.document ?? '').toUpperCase()))
      missing(e, 'Document template', row.document ? `Document template ${row.document} doesn't exist.` : 'A document button needs a document template.');
    if (kind === 'rest_module') for (const problem of handlerProblems(row.handlers)) missing(e, 'Handlers (JSON)', problem);
    if (kind === 'workflow_definition') {
      const tasks = new Set(all.filter((x) => x.kind === 'task_definition').map((x) => x.row.name.toUpperCase()));
      for (const problem of stepProblems(row.steps, tasks)) missing(e, 'Steps (JSON)', problem);
      for (const warning of stepWarnings(row.steps)) missing(e, 'Steps (JSON)', warning, 'warning');
      // invoke_api steps: REST data sources, parameters, web credentials, variables (sprint 32)
      const refs = {
        sources: new Map(all.filter((x) => x.kind === 'rest_source').map((x) => [String(x.row.name).toUpperCase(), x.row])),
        credentials: new Set(all.filter((x) => x.kind === 'web_credential').map((x) => String(x.row.name).toUpperCase())),
        startVars: [...String(row.title ?? '').matchAll(/&([A-Za-z][A-Za-z0-9_]*)\./g)].map((m) => m[1]),
      };
      const invokeRefs = invokeStepReferences(row.steps, refs);
      for (const problem of invokeRefs.errors) missing(e, 'Steps (JSON)', problem);
      for (const warning of invokeRefs.warnings) missing(e, 'Steps (JSON)', warning, 'warning');
      if (row.dev_version) {
        const field = `Steps of version ${row.dev_version} (development)`;
        for (const problem of stepProblems(row.dev_steps, tasks)) missing(e, field, problem, 'warning');
        for (const warning of stepWarnings(row.dev_steps)) missing(e, field, warning, 'warning');
        const devRefs = invokeStepReferences(row.dev_steps, refs);
        for (const problem of [...devRefs.errors, ...devRefs.warnings]) missing(e, field, problem, 'warning');
      }
    }
    if (kind === 'document_template') {
      const problem = templateProblem(row.template ?? '');
      if (problem) missing(e, 'Template (HTML)', problem);
      if (row.layout && !layouts.has(String(row.layout).toUpperCase())) missing(e, 'Report layout', `Report layout ${row.layout} doesn't exist (the default layout is used).`, 'warning');
    }
  }

  // ---- PL/pgSQL functions of the app's schemas, with plpgsql_check when installed
  const plpgsqlCheck = !!(await owner.one(`select 1 as ok from pg_extension where extname = 'plpgsql_check'`));
  if (plpgsqlCheck && app.db_role) {
    const res = await owner.query(
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
    const main = html`${appHeader(a, 'advisor')}
      ${region('Advisor', html`<p class="muted u-mt0">Checked ${checked} pieces of SQL as the role <code>${a.db_role ?? '(owner)'}</code> (planned with EXPLAIN and rolled back, nothing is run), and every reference to pages, items, lists of values, authorization schemes and report layouts.
          ${plpgsqlCheck ? 'PL/pgSQL functions were checked with plpgsql_check.' : html`Install the <code>plpgsql_check</code> extension to check PL/pgSQL functions too.`}</p>
        <p><span class="tag tag-error">${count('error')} errors</span> <span class="tag tag-warning">${count('warning')} warnings</span> <span class="tag tag-info">${count('info')} notes</span>
          <a class="btn u-mt0" href="${BASE}/apps/${a.id}/advisor">${icon('history')} Check again</a></p>
        ${list}`)}`;
    return send(reply, s, shell(s, `Advisor · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Advisor']], main));
  });
}
