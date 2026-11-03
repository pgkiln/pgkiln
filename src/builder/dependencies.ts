import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { applyBinds, splitStatements } from '../binds.ts';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { devDbForApp } from '../workspace-db.ts';
import { EXPLAINABLE, sqlFields, type SqlShape } from './advisor.ts';
import { COMPONENTS } from './components.ts';
import { appEntries, type Entry } from './search.ts';
import { appHeader, BASE, developer, region, send, shell, type Req } from './ui.ts';

// (sprint 138, AP-5) App Builder → Utilities → Database object dependencies
// (APEX: Database Object Dependencies). Every piece of SQL the Advisor plans
// (region sources, lists of values, conditions, processes, …) and the tables of
// form and grid regions are parsed as the application's database role into a
// temporary SQL-standard function (CREATE FUNCTION … BEGIN ATOMIC), whose
// dependencies PostgreSQL records in pg_depend: the tables, views, sequences
// and functions the statement uses, resolved with the role's search path.
// Nothing runs; the transaction is rolled back. A statement that names an
// object that doesn't exist is reported as a missing object (in red), and the
// role's privileges are compared with what the statements need (SELECT for
// queries, INSERT / UPDATE / DELETE for the target of a DML statement, USAGE
// on sequences, EXECUTE on functions). PL/pgSQL blocks (DO) can't be parsed this
// way and are listed as not scanned.

export type ObjKind = 'table' | 'view' | 'matview' | 'sequence' | 'foreign table' | 'function' | 'procedure' | 'relation';

export interface Use {
  entry: Entry | null;
  field: string;
}

export interface DepObject {
  key: string;
  kind: ObjKind;
  schema: string;
  name: string;
  /** schema-qualified display name (functions with their argument types) */
  display: string;
  /** the Object Browser's reference (regclass / regprocedure text), null for a missing object */
  ref: string | null;
  missing: boolean;
  /** privileges the statements need that the role doesn't have */
  lacking: string[];
  /** the role's privileges on the object */
  privileges: string[];
  usedBy: Use[];
}

export interface Dependencies {
  objects: DepObject[];
  role: string | null;
  scanned: number;
  unscanned: (Use & { message: string })[];
}

interface Fragment extends Use {
  sql: string;
  shape: SqlShape | 'relation';
}

const SYSTEM = new Set(['pg_catalog', 'information_schema', 'meta', 'pg_toast']);

/** Every piece of SQL of an application, and the tables of its form and grid regions. */
async function fragments(appId: number): Promise<Fragment[]> {
  const entries = await appEntries(appId);
  const byKey = new Map(entries.map((e) => [`${e.kind}-${e.id}`, e]));
  const out: Fragment[] = [];
  for (const [kind, spec] of Object.entries(COMPONENTS)) {
    const rows = spec.scope === 'page'
      ? (await owner.query(`select t.* from ${spec.table} t join meta.page p on p.id = t.page_id where p.app_id = $1`, [appId])).rows
      : (await owner.query(`select * from ${spec.table} where app_id = $1`, [appId])).rows;
    for (const row of rows) {
      const entry = byKey.get(`${kind}-${row.id}`) ?? null;
      const label = (name: string) => spec.fields.find((x) => x.name === name)?.label ?? name;
      for (const f of sqlFields(kind, row)) if (f.shape !== 'regex' && typeof row[f.name] === 'string' && row[f.name].trim()) out.push({ entry, field: label(f.name), sql: row[f.name], shape: f.shape });
      if (kind === 'region' && (row.type === 'form' || row.type === 'grid') && typeof row.table_name === 'string' && row.table_name.trim() && !row.rest_source)
        out.push({ entry, field: label('table_name'), sql: row.table_name.trim(), shape: 'relation' });
      if (kind === 'region' && row.type === 'map')
        for (const l of Array.isArray(row.config?.layers) ? row.config.layers : [])
          if (typeof l?.source === 'string' && l.source.trim()) out.push({ entry, field: `Layer "${typeof l.name === 'string' ? l.name : ''}" query`, sql: l.source, shape: 'select' });
      if (kind === 'search_config' && row.source_type !== 'list' && typeof row.source === 'string' && row.source.trim())
        out.push({ entry, field: 'Source', sql: row.source.trim(), shape: row.source_type === 'table' ? 'relation' : 'select' });
      if (kind === 'rest_module')
        for (const h of Array.isArray(row.handlers) ? row.handlers : [])
          if (typeof h?.source === 'string' && h.source.trim() && h.type !== 'plpgsql') out.push({ entry, field: `${h.method} ${h.path}`, sql: h.source, shape: h.type === 'sql' ? 'statements' : 'select' });
      if (kind === 'workflow_definition')
        for (const st of Array.isArray(row.steps) ? row.steps : []) {
          if (st?.type === 'sql' && typeof st.code === 'string') out.push({ entry, field: `step ${st.name}: code`, sql: st.code, shape: 'statements' });
          if (st?.type === 'task' && typeof st.owners === 'string' && st.owners.trim()) out.push({ entry, field: `step ${st.name}: owners`, sql: st.owners, shape: 'select' });
          if (st?.type === 'switch' && Array.isArray(st.cases)) for (const cs of st.cases) if (typeof cs?.when === 'string') out.push({ entry, field: `step ${st.name}: when`, sql: cs.when, shape: 'boolean' });
        }
    }
  }
  return out;
}

/** The DML target of a statement (INSERT INTO x, UPDATE x, DELETE FROM x, MERGE INTO x) and the privilege it needs. */
export function dmlTarget(stmt: string): { name: string; privilege: string } | null {
  const m = /^\s*(?:with\b[\s\S]*?\)\s*)?(insert\s+into|update|delete\s+from|merge\s+into)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i.exec(stmt);
  if (!m) return null;
  const verb = m[1].toLowerCase().split(/\s+/)[0];
  return { name: m[2].replace(/\s+/g, ''), privilege: verb === 'merge' ? 'UPDATE' : verb.toUpperCase() };
}

/** The statements of a fragment as the body of a BEGIN ATOMIC function, and what can't be parsed that way. */
export function bodyOf(sql: string, shape: SqlShape | 'relation'): { statements: string[]; skipped: string[] } {
  const plain = applyBinds(sql.trim().replace(/;+\s*$/, ''), {});
  if (shape === 'boolean') return { statements: [`select (${plain})::boolean`], skipped: [] };
  if (shape === 'select') return EXPLAINABLE.test(plain) ? { statements: [plain], skipped: [] } : { statements: [], skipped: ['not a query'] };
  const statements: string[] = [];
  const skipped: string[] = [];
  for (const stmt of splitStatements(plain)) {
    if (EXPLAINABLE.test(stmt)) statements.push(stmt);
    else if (stmt.trim()) skipped.push(stmt.trim().split(/\s+/).slice(0, 2).join(' '));
  }
  return { statements, skipped };
}

/** A missing object named by an error message of the parser. */
export function missingOf(message: string): { kind: ObjKind; name: string } | null {
  let m = /relation "([^"]+)" does not exist/.exec(message);
  if (m) return { kind: 'relation', name: m[1] };
  m = /^(function|procedure) (.+?\)) does not exist/.exec(message);
  if (m) return { kind: m[1] as ObjKind, name: m[2] };
  return null;
}

const RELKINDS: Record<string, ObjKind> = { r: 'table', p: 'table', v: 'view', m: 'matview', S: 'sequence', f: 'foreign table' };

/** Scan an application. */
export async function appDependencies(appId: number): Promise<Dependencies> {
  const app = await owner.one<{ db_role: string | null }>('select db_role from meta.app where id = $1', [appId]);
  if (!app) throw new Error('application not found');
  const frags = await fragments(appId);
  const found = new Map<string, { cls: 'pg_class' | 'pg_proc'; oid: number; needs: Set<string>; uses: Use[] }>();
  const missing = new Map<string, DepObject>();
  const unscanned: Dependencies['unscanned'] = [];
  let scanned = 0;
  const note = (cls: 'pg_class' | 'pg_proc', oid: number, use: Use, need: string | null) => {
    const k = `${cls}:${oid}`;
    if (!found.has(k)) found.set(k, { cls, oid, needs: new Set(), uses: [] });
    const f = found.get(k)!;
    if (need) f.needs.add(need);
    if (!f.uses.some((u) => u.entry === use.entry && u.field === use.field)) f.uses.push(use);
  };
  const own = await devDbForApp(appId);
  const c = await own.pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local statement_timeout = '5s'`);
    await c.query(`select set_config('pgkiln.app_id', $1, true)`, [String(appId)]);
    if (app.db_role) await c.query(`set local role ${pg.escapeIdentifier(app.db_role)}`);
    for (const f of frags) {
      const use: Use = { entry: f.entry, field: f.field };
      await c.query('savepoint deps');
      try {
        if (f.shape === 'relation') {
          scanned++;
          const r = (await c.query<{ oid: number | null }>('select to_regclass($1)::oid::int as oid', [f.sql])).rows[0];
          if (r?.oid) note('pg_class', r.oid, use, 'SELECT');
          else addMissing(missing, { kind: 'relation', name: f.sql }, use);
          continue;
        }
        const { statements, skipped } = bodyOf(f.sql, f.shape);
        if (skipped.length) unscanned.push({ ...use, message: `Not scanned (only SELECT, INSERT, UPDATE, DELETE and MERGE are parsed): ${skipped.join(', ')}` });
        if (!statements.length) continue;
        scanned++;
        // the extended protocol (a parameter list) takes exactly one statement
        await c.query(`create function pg_temp.__pgkiln_deps() returns void language sql begin atomic ${statements.join(';\n')}; end`, []);
        const deps = (await c.query<{ cls: 'pg_class' | 'pg_proc'; oid: number }>(
          `select distinct d.refclassid::regclass::text as cls, d.refobjid::int as oid from pg_depend d
            where d.classid = 'pg_proc'::regclass and d.objid = 'pg_temp.__pgkiln_deps()'::regprocedure
              and d.refclassid in ('pg_class'::regclass, 'pg_proc'::regclass)`)).rows;
        // what the statements need: the target of a DML statement its verb's privilege, everything else SELECT
        const targets = new Map<number, string>();
        for (const st of statements) {
          const t = dmlTarget(st);
          if (!t) continue;
          const oid = (await c.query<{ oid: number | null }>('select to_regclass($1)::oid::int as oid', [t.name])).rows[0]?.oid;
          if (oid) targets.set(oid, t.privilege);
        }
        for (const d of deps) note(d.cls, d.oid, use, d.cls === 'pg_proc' ? 'EXECUTE' : (targets.get(d.oid) ?? 'SELECT'));
      } catch (e) {
        const message = (e as Error).message;
        const m = missingOf(message);
        if (m) addMissing(missing, m, use);
        else unscanned.push({ ...use, message });
      } finally {
        await c.query('rollback to savepoint deps');
      }
    }
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }

  // the objects, their kinds and the role's privileges (as the owner: the catalog)
  const objects: DepObject[] = [...missing.values()];
  const rels = [...found.values()].filter((f) => f.cls === 'pg_class');
  const procs = [...found.values()].filter((f) => f.cls === 'pg_proc');
  const role = app.db_role;
  if (rels.length) {
    const rows = (await owner.query(
      `select c.oid::int as oid, c.relkind::text as relkind, n.nspname as schema, c.relname as name, c.oid::regclass::text as ref,
              array_remove(array[
                case when $2::text is null or has_table_privilege($2, c.oid, 'SELECT') then 'SELECT' end,
                case when c.relkind <> 'S' and ($2::text is null or has_table_privilege($2, c.oid, 'INSERT')) then 'INSERT' end,
                case when c.relkind <> 'S' and ($2::text is null or has_table_privilege($2, c.oid, 'UPDATE')) then 'UPDATE' end,
                case when c.relkind <> 'S' and ($2::text is null or has_table_privilege($2, c.oid, 'DELETE')) then 'DELETE' end,
                case when c.relkind = 'S' and ($2::text is null or has_sequence_privilege($2, c.oid, 'USAGE')) then 'USAGE' end], null) as privileges,
              $2::text is null or has_schema_privilege($2, n.oid, 'USAGE') as schema_usage
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = any ($1::oid[])`,
      [rels.map((r) => r.oid), role])).rows;
    for (const r of rows) {
      if (SYSTEM.has(r.schema)) continue;
      const f = found.get(`pg_class:${r.oid}`)!;
      const kind = RELKINDS[r.relkind] ?? 'relation';
      // a sequence used by nextval() needs USAGE (or UPDATE); one only read, SELECT
      const needs = kind === 'sequence' ? ['USAGE'] : [...f.needs];
      const lacking = [...(r.schema_usage ? [] : [`USAGE on schema ${r.schema}`]), ...needs.filter((p) => !r.privileges.includes(p))];
      objects.push({ key: `pg_class:${r.oid}`, kind, schema: r.schema, name: r.name, display: `${r.schema}.${r.name}`, ref: r.ref, missing: false, lacking, privileges: r.privileges, usedBy: f.uses });
    }
  }
  if (procs.length) {
    const rows = (await owner.query(
      `select p.oid::int as oid, p.prokind::text as prokind, n.nspname as schema, p.proname as name, p.oid::regprocedure::text as ref,
              pg_get_function_identity_arguments(p.oid) as args,
              $2::text is null or has_function_privilege($2, p.oid, 'EXECUTE') as exec,
              $2::text is null or has_schema_privilege($2, n.oid, 'USAGE') as schema_usage
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = any ($1::oid[])`,
      [procs.map((r) => r.oid), role])).rows;
    for (const r of rows) {
      if (SYSTEM.has(r.schema)) continue;
      const f = found.get(`pg_proc:${r.oid}`)!;
      const lacking = [...(r.schema_usage ? [] : [`USAGE on schema ${r.schema}`]), ...(r.exec ? [] : ['EXECUTE'])];
      objects.push({ key: `pg_proc:${r.oid}`, kind: r.prokind === 'p' ? 'procedure' : 'function', schema: r.schema, name: r.name, display: `${r.schema}.${r.name}(${r.args})`, ref: r.ref, missing: false, lacking, privileges: r.exec ? ['EXECUTE'] : [], usedBy: f.uses });
    }
  }
  const rank = (o: DepObject) => (o.missing ? 0 : o.lacking.length ? 1 : 2);
  objects.sort((a, b) => rank(a) - rank(b) || (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
  return { objects, role, scanned, unscanned };
}

function addMissing(missing: Map<string, DepObject>, m: { kind: ObjKind; name: string }, use: Use) {
  const key = `missing:${m.kind}:${m.name}`;
  if (!missing.has(key)) {
    const dot = m.name.indexOf('.');
    missing.set(key, { key, kind: m.kind, schema: dot > 0 ? m.name.slice(0, dot) : '', name: dot > 0 ? m.name.slice(dot + 1) : m.name, display: m.name, ref: null, missing: true, lacking: [], privileges: [], usedBy: [] });
  }
  const o = missing.get(key)!;
  if (!o.usedBy.some((u) => u.entry === use.entry && u.field === use.field)) o.usedBy.push(use);
}

const OB_KIND: Partial<Record<ObjKind, string>> = { table: 'table', view: 'view', matview: 'matview', sequence: 'sequence', function: 'function', procedure: 'procedure' };
const KIND_ICON: Record<ObjKind, string> = { table: 'table', view: 'layers', matview: 'layers', sequence: 'hash', 'foreign table': 'table', function: 'code', procedure: 'code', relation: 'table' };

/** The Object Browser's address of an object (null: it has no page there). */
export const objectUrl = (o: Pick<DepObject, 'kind' | 'schema' | 'ref'>) =>
  o.ref && OB_KIND[o.kind] ? `${BASE}/sql/objects?${new URLSearchParams({ schema: o.schema, k: OB_KIND[o.kind]!, o: o.ref })}` : null;

const useLink = (u: Use) =>
  u.entry
    ? html`<li><a href="${u.entry.url}">${icon(u.entry.icon)}<span>${u.entry.kindLabel}: ${u.entry.label}</span></a>${u.entry.pageNo !== null && u.entry.kind !== 'page' ? html` <span class="tag">page ${u.entry.pageNo}</span>` : ''} <span class="muted small">${u.field}</span></li>`
    : html`<li><span class="muted small">${u.field}</span></li>`;

export async function dependencyRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/utilities/dependencies`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = /^\d{1,9}$/.test(req.params.id) ? await owner.one('select * from meta.app where id = $1', [req.params.id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const deps = await appDependencies(a.id);
    const filter = String(req.query?.q ?? '').trim().slice(0, 100).toLowerCase();
    const onlyProblems = req.query?.show === 'problems';
    const shown = deps.objects.filter((o) => (!filter || o.display.toLowerCase().includes(filter)) && (!onlyProblems || o.missing || o.lacking.length));
    const missingN = deps.objects.filter((o) => o.missing).length;
    const grantsN = deps.objects.filter((o) => o.lacking.length).length;
    const pages = (o: DepObject) => [...new Set(o.usedBy.map((u) => u.entry?.pageNo).filter((p): p is number => p !== null && p !== undefined))].sort((x, y) => x - y);
    const rows: Raw = shown.length
      ? html`<div class="table-wrap"><table class="table dep-table"><thead><tr><th scope="col">Object</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Pages</th><th scope="col">Used by</th></tr></thead>
        <tbody>${shown.map((o) => {
          const url = objectUrl(o);
          const status = o.missing
            ? html`<span class="tag tag-error">Missing</span>`
            : o.lacking.length
              ? html`<span class="tag tag-error">No grant</span> <span class="small dep-missing">${deps.role} lacks ${o.lacking.join(', ')}</span>`
              : html`<span class="tag tag-success">OK</span> <span class="muted small">${o.privileges.join(', ')}</span>`;
          return html`<tr${o.missing || o.lacking.length ? raw(' class="dep-problem"') : ''}>
            <td data-label="Object">${icon(KIND_ICON[o.kind])} ${url ? html`<a href="${url}">${o.display}</a>` : html`<span class="dep-missing">${o.display}</span>`}</td>
            <td data-label="Type">${o.kind === 'relation' ? 'table or view' : o.kind}</td>
            <td data-label="Status">${status}</td>
            <td data-label="Pages">${pages(o).join(', ')}</td>
            <td data-label="Used by"><details class="dep-uses"><summary>${o.usedBy.length} component${o.usedBy.length === 1 ? '' : 's'}</summary><ul class="dep-list">${o.usedBy.map(useLink)}</ul></details></td>
          </tr>`;
        })}</tbody></table></div>`
      : html`<p class="muted">No objects${filter || onlyProblems ? ' match' : ''}.</p>`;
    const main = html`${appHeader(a, 'utilities', s)}
      ${region('Database object dependencies', html`<p class="muted u-mt0">The tables, views, sequences and functions the application's SQL uses (${deps.scanned} statements parsed as the role <code>${deps.role ?? '(the runtime connection)'}</code>; nothing is run), with the components that use them. Missing objects and privileges the role lacks are marked.</p>
        <p><span class="tag">${deps.objects.length} objects</span> <span class="tag tag-error">${missingN} missing</span> <span class="tag tag-warning">${grantsN} without the grants they need</span></p>
        <form method="get" class="filter-bar" role="search">
          <div class="field"><label class="label" for="dep-q">Filter</label><input id="dep-q" name="q" type="search" value="${filter}" placeholder="e.g. sales.orders"></div>
          <div class="field"><label class="label" for="dep-show">Show</label><select id="dep-show" name="show"><option value="">All objects</option><option value="problems"${onlyProblems ? raw(' selected') : ''}>Only problems</option></select></div>
          <div class="buttons"><button class="btn">${icon('filter')} Filter</button></div>
        </form>
        ${rows}`)}
      ${deps.unscanned.length ? region('Not scanned', html`<ul class="hits findings">${deps.unscanned.map((u) => html`<li class="finding-info">${u.entry ? html`<a href="${u.entry.url}">${icon(u.entry.icon)}<span>${u.entry.kindLabel}: ${u.entry.label}</span></a>` : html`<span>${u.field}</span>`}<span></span><span class="tag tag-info">Note</span><span class="hit-snippet"><b>${u.field}:</b> ${u.message}</span></li>`)}</ul>`) : ''}`;
    return send(reply, s, shell(s, `Object dependencies · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Utilities', `${BASE}/apps/${a.id}/utilities`], ['Object dependencies']], main));
  });
}
