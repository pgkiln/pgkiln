import type { Client } from './db.ts';
import { owner } from './db.ts';
import { checkDataset, datasetOf, storeDataset } from './datasets.ts';
import { describeTeam, exportTeam, importTeam } from './team.ts';
import { serverProblems } from './remote-servers.ts';
import { STATIC_MAX, staticType } from './runtime/static-files.ts';
import { credentialProblems, GRANT_TYPES } from './websources.ts';
import { catalogDocument, fromCatalogDocument, insertCatalog, loadCatalog, replaceCatalog, wholeCatalogProblems } from './restcatalog.ts';

// Workspace utilities → Export / import (APEX: Workspace Utilities → Export,
// "Workspace" components): the components of a workspace as one JSON file
// (format "pgkiln-workspace/1"), and that file imported into the current
// workspace of this or another installation. Applications travel on their own
// (an application export each); this file holds what the workspace shares:
//
//   settings         description, workspace message, environment banner, preferences
//   developers       its developers (user names and workspace administrators; never passwords)
//   app_groups       application groups, with the aliases of their applications
//   extension_links  the Extensions menu
//   rest_catalogs    REST source catalogs and their services
//   sql_scripts      the SQL Workshop's saved scripts
//   blueprints       saved blueprints
//   data_generators  saved data generators (Sample Data)
//   datasets         (sprint 110) Data Reporter datasets (pgkiln-dataset/1 definitions)
//   team             (sprint 113) Team Development: label groups, labels, milestones, templates and issues
//                    (with comments and history; applications by alias), an object (src/team.ts)
//   workspace_files  (sprint 141) static workspace files (content in base64)
//   remote_servers   (sprint 141) remote servers; an existing server keeps its own base URL on import
//                    (the URL is per installation: development, test, production)
//   web_credentials  (sprint 141) the workspace's web credentials, never their secrets (entered again after an import)
//
// Not exported: the workspace's name (the importer's workspace keeps its own),
// isolation and its database roles (installation-specific), script runs and
// other history. An import adds and, by choice, replaces components with the
// same name; it never deletes. Developers are only added when the importing
// installation has a developer of that name.

export const WORKSPACE_FORMAT = 'pgkiln-workspace/1';
export const PARTS = ['settings', 'developers', 'app_groups', 'extension_links', 'rest_catalogs', 'sql_scripts', 'blueprints', 'data_generators', 'datasets', 'team',
  'workspace_files', 'remote_servers', 'web_credentials'] as const;
export type Part = (typeof PARTS)[number];
export const PART_LABELS: Record<Part, string> = {
  settings: 'Settings: description, message, banner and preferences',
  developers: 'Developers and workspace administrators',
  app_groups: 'Application groups',
  extension_links: 'Extension links',
  rest_catalogs: 'REST source catalogs',
  sql_scripts: 'SQL scripts',
  blueprints: 'Blueprints',
  data_generators: 'Data generators',
  datasets: 'Data Reporter datasets',
  team: 'Team Development: labels, milestones, templates and issues',
  workspace_files: 'Static workspace files',
  remote_servers: 'Remote servers (an existing server keeps its base URL)',
  web_credentials: 'Web credentials (without their secrets)',
};

const MAX_ITEMS = 5000;
const BANNER_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'];
type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** The workspace's components as a document (the parts asked for). */
export async function exportWorkspace(workspaceId: number, parts: readonly Part[] = PARTS, meta: { version?: string; by?: string | null } = {}) {
  const w = await owner.one('select * from meta.workspace where id = $1', [workspaceId]);
  if (!w) throw new Error('No such workspace.');
  const want = (p: Part) => parts.includes(p);
  const doc: Json = { format: WORKSPACE_FORMAT, exported_at: new Date().toISOString(), pgkiln: meta.version ?? null, exported_by: meta.by ?? null, workspace: w.name };
  if (want('settings'))
    doc.settings = { description: w.description, message: w.message, banner_label: w.banner_label, banner_color: w.banner_color, sql_workshop: w.sql_workshop, rest_services: w.rest_services, builder_home: w.builder_home ?? null };
  if (want('developers'))
    doc.developers = (await owner.query('select username, is_admin as admin from meta.workspace_member where workspace_id = $1 order by username', [workspaceId])).rows;
  if (want('app_groups'))
    doc.app_groups = (await owner.query(
      `select g.name, g.description,
              coalesce((select json_agg(a.alias order by a.alias) from meta.app_group_member m join meta.app a on a.id = m.app_id where m.group_id = g.id), '[]') as apps
         from meta.app_group g where g.workspace_id = $1 order by lower(g.name)`, [workspaceId])).rows;
  if (want('extension_links'))
    doc.extension_links = (await owner.query('select label, url, description, position from meta.workspace_link where workspace_id = $1 order by position, lower(label)', [workspaceId])).rows;
  if (want('rest_catalogs')) {
    const ids = (await owner.query<{ id: number }>('select id from meta.rest_catalog where workspace_id = $1 order by lower(name)', [workspaceId])).rows;
    doc.rest_catalogs = [];
    for (const { id } of ids) doc.rest_catalogs.push(catalogDocument((await loadCatalog(id))!));
  }
  if (want('sql_scripts'))
    doc.sql_scripts = (await owner.query('select name, description, content from meta.sql_script where workspace_id = $1 order by name', [workspaceId])).rows;
  if (want('blueprints'))
    doc.blueprints = (await owner.query('select name, spec from meta.blueprint where workspace_id = $1 order by lower(name), id', [workspaceId])).rows;
  if (want('data_generators'))
    // (seed is a bigint: pg returns a string)
    doc.data_generators = (await owner.query('select name, description, schema_name, seed, tables from meta.data_generator where workspace_id = $1 order by name', [workspaceId])).rows
      .map((g) => ({ ...g, seed: g.seed === null ? null : Number(g.seed) }));
  if (want('datasets'))
    doc.datasets = (await owner.query('select * from meta.dataset where workspace_id = $1 order by name', [workspaceId])).rows.map(datasetOf);
  if (want('team')) doc.team = await exportTeam(workspaceId);
  if (want('workspace_files'))
    doc.workspace_files = (await owner.query(`select name, mime, translate(encode(content, 'base64'), E'\n', '') as content from meta.workspace_file where workspace_id = $1 order by name`, [workspaceId])).rows;
  if (want('remote_servers'))
    doc.remote_servers = (await owner.query('select static_id, name, description, base_url, env_var, credential from meta.remote_server where workspace_id = $1 order by static_id', [workspaceId])).rows;
  if (want('web_credentials'))
    // secrets never leave the installation
    doc.web_credentials = (await owner.query(
      'select name, description, type, username, header_name, token_url, scope, valid_for, grant_type, oauth_username from meta.workspace_credential where workspace_id = $1 order by name', [workspaceId])).rows;
  return doc;
}

/** What a workspace file holds: the parts and their sizes (for the import form). */
export function describeWorkspaceFile(doc: unknown): { workspace: string | null; exported_at: string | null; counts: Partial<Record<Part, number>> } {
  if (!isObj(doc) || doc.format !== WORKSPACE_FORMAT) throw new Error(`Not a workspace export (format ${WORKSPACE_FORMAT}).`);
  const counts: Partial<Record<Part, number>> = {};
  for (const p of PARTS) {
    const v = doc[p];
    if (v === undefined) continue;
    if (p === 'team') {
      counts[p] = describeTeam(v);
      continue;
    }
    if (p === 'settings' ? !isObj(v) : !Array.isArray(v)) throw new Error(`The file's "${p}" is not ${p === 'settings' ? 'an object' : 'a list'}.`);
    if (Array.isArray(v) && v.length > MAX_ITEMS) throw new Error(`The file has more than ${MAX_ITEMS} ${p.replace('_', ' ')}.`);
    counts[p] = Array.isArray(v) ? v.length : 1;
  }
  return { workspace: typeof doc.workspace === 'string' ? doc.workspace : null, exported_at: typeof doc.exported_at === 'string' ? doc.exported_at : null, counts };
}

export interface ImportResult {
  added: number;
  replaced: number;
  skipped: number;
  lines: string[];
}

/**
 * Import a workspace file into a workspace (inside the caller's transaction:
 * any error rolls everything back). `replace`: a component with the same name
 * is replaced; otherwise it is kept and the file's one skipped.
 */
export async function importWorkspace(c: Client, workspaceId: number, doc: unknown, parts: readonly Part[], opts: { replace: boolean; by: string | null }): Promise<ImportResult> {
  describeWorkspaceFile(doc);
  const d = doc as Json;
  const r: ImportResult = { added: 0, replaced: 0, skipped: 0, lines: [] };
  const want = (p: Part) => parts.includes(p) && d[p] !== undefined;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max).trim() : null);
  const tally = (what: string, added: number, replaced: number, skipped: number, extra = '') => {
    r.added += added;
    r.replaced += replaced;
    r.skipped += skipped;
    const bits = [added && `${added} added`, replaced && `${replaced} replaced`, skipped && `${skipped} kept (same name)`].filter(Boolean);
    r.lines.push(`${what}: ${bits.length ? bits.join(', ') : 'nothing to import'}${extra}.`);
  };
  /** insert, or replace / skip on the same name; returns 'added' | 'replaced' | 'skipped' */
  const upsert = async (existing: { id: number } | undefined, insert: () => Promise<unknown>, update: (id: number) => Promise<unknown>) => {
    if (!existing) return (await insert(), 'added' as const);
    if (!opts.replace) return 'skipped' as const;
    return (await update(existing.id), 'replaced' as const);
  };
  const count = () => ({ added: 0, replaced: 0, skipped: 0 });

  if (want('settings')) {
    const s = d.settings as Json;
    await c.query(
      `update meta.workspace set description = $2, message = $3, banner_label = $4, banner_color = coalesce($5, banner_color),
              sql_workshop = coalesce($6, sql_workshop), rest_services = coalesce($7, rest_services),
              builder_home = case when $8::boolean then $9 else builder_home end where id = $1`,
      [workspaceId, text(s.description, 2000), text(s.message, 2000), text(s.banner_label, 40), BANNER_COLORS.includes(s.banner_color) ? s.banner_color : null,
        typeof s.sql_workshop === 'boolean' ? s.sql_workshop : null, typeof s.rest_services === 'boolean' ? s.rest_services : null,
        // (119) what /builder opens; older files have no key and keep the current value
        'builder_home' in s, s.builder_home === 'home' ? 'home' : null],
    );
    r.lines.push('Settings: description, message, banner and preferences set from the file.');
  }

  if (want('developers')) {
    const devs = (d.developers as Json[]).filter((x) => isObj(x) && typeof x.username === 'string');
    const known = new Set((await c.query<{ username: string }>('select username from meta.developer where username = any($1::text[])', [devs.map((x) => x.username)])).rows.map((x) => x.username));
    let added = 0;
    let updated = 0;
    for (const x of devs.filter((x) => known.has(x.username))) {
      const res = await c.query<{ inserted: boolean }>(
        `insert into meta.workspace_member (workspace_id, username, is_admin) values ($1, $2, $3)
         on conflict (workspace_id, username) do update set is_admin = case when $4 then excluded.is_admin else meta.workspace_member.is_admin end
         returning (xmax = 0) as inserted`, [workspaceId, x.username, x.admin === true, opts.replace]);
      if (res.rows[0]?.inserted) added++;
      else updated++;
    }
    const missing = devs.length - known.size;
    tally('Developers', added, opts.replace ? updated : 0, opts.replace ? 0 : updated, missing ? `; ${missing} not a developer of this installation (add them under Developers first)` : '');
  }

  if (want('app_groups')) {
    const n = count();
    let placed = 0;
    for (const g of d.app_groups as Json[]) {
      if (!isObj(g)) continue;
      const existing = (await c.query<{ id: number }>('select id from meta.app_group where workspace_id = $1 and name = $2', [workspaceId, g.name])).rows[0];
      const what = await upsert(existing,
        () => c.query('insert into meta.app_group (workspace_id, name, description) values ($1, $2, $3)', [workspaceId, g.name, text(g.description, 2000)]),
        (id) => c.query('update meta.app_group set description = $2 where id = $1', [id, text(g.description, 2000)]));
      n[what]++;
      if (what === 'skipped') continue;
      // the group's applications: those of this workspace with these aliases
      const res = await c.query(
        `insert into meta.app_group_member (app_id, group_id)
         select a.id, (select id from meta.app_group where workspace_id = $1 and name = $2) from meta.app a
          where a.alias = any($3::text[]) and meta.app_workspace(a.id) = $1
         on conflict (app_id) do update set group_id = excluded.group_id`,
        [workspaceId, g.name, Array.isArray(g.apps) ? g.apps.filter((x: unknown) => typeof x === 'string') : []]);
      placed += res.rowCount ?? 0;
    }
    tally('Application groups', n.added, n.replaced, n.skipped, placed ? `; ${placed} application(s) of this workspace placed in them` : '');
  }

  if (want('extension_links')) {
    const n = count();
    for (const l of d.extension_links as Json[]) {
      if (!isObj(l)) continue;
      const existing = (await c.query<{ id: number }>('select id from meta.workspace_link where workspace_id = $1 and label = $2', [workspaceId, l.label])).rows[0];
      const vals = [l.url, text(l.description, 500), Number.isInteger(l.position) ? l.position : 0];
      n[await upsert(existing,
        () => c.query('insert into meta.workspace_link (workspace_id, label, url, description, position) values ($1, $2, $3, $4, $5)', [workspaceId, l.label, ...vals]),
        (id) => c.query('update meta.workspace_link set url = $2, description = $3, position = $4 where id = $1', [id, ...vals]))]++;
    }
    tally('Extension links', n.added, n.replaced, n.skipped);
  }

  if (want('rest_catalogs')) {
    const n = count();
    for (const raw of d.rest_catalogs as Json[]) {
      const cat = fromCatalogDocument(isObj(raw) ? raw : {});
      const problems = wholeCatalogProblems(cat);
      if (problems.length) throw new Error(`REST source catalog ${cat.name || '?'}: ${problems.slice(0, 5).join(' ')}`);
      const existing = (await c.query<{ id: number }>('select id from meta.rest_catalog where workspace_id = $1 and lower(name) = lower($2)', [workspaceId, cat.name])).rows[0];
      n[await upsert(existing, () => insertCatalog(c, workspaceId, cat, opts.by), (id) => replaceCatalog(c, id, cat))]++;
    }
    tally('REST source catalogs', n.added, n.replaced, n.skipped);
  }

  if (want('sql_scripts')) {
    const n = count();
    for (const x of d.sql_scripts as Json[]) {
      if (!isObj(x)) continue;
      const existing = (await c.query<{ id: number }>('select id from meta.sql_script where workspace_id = $1 and name = $2', [workspaceId, x.name])).rows[0];
      const content = typeof x.content === 'string' ? x.content : '';
      n[await upsert(existing,
        () => c.query('insert into meta.sql_script (workspace_id, name, description, content, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)', [workspaceId, x.name, text(x.description, 2000), content, opts.by]),
        (id) => c.query('update meta.sql_script set description = $2, content = $3, updated_by = $4, updated_at = now() where id = $1', [id, text(x.description, 2000), content, opts.by]))]++;
    }
    tally('SQL scripts', n.added, n.replaced, n.skipped);
  }

  if (want('blueprints')) {
    const n = count();
    for (const x of d.blueprints as Json[]) {
      if (!isObj(x) || !isObj(x.spec)) throw new Error(`Blueprint ${isObj(x) ? x.name : '?'}: the specification is an object.`);
      const existing = (await c.query<{ id: number }>('select id from meta.blueprint where workspace_id = $1 and lower(trim(name)) = lower(trim($2)) order by id limit 1', [workspaceId, x.name])).rows[0];
      n[await upsert(existing,
        () => c.query('insert into meta.blueprint (workspace_id, name, spec, created_by) values ($1, $2, $3, $4)', [workspaceId, x.name, x.spec, opts.by]),
        (id) => c.query('update meta.blueprint set spec = $2, updated_at = now() where id = $1', [id, x.spec]))]++;
    }
    tally('Blueprints', n.added, n.replaced, n.skipped);
  }

  if (want('data_generators')) {
    const n = count();
    for (const x of d.data_generators as Json[]) {
      if (!isObj(x)) continue;
      const existing = (await c.query<{ id: number }>('select id from meta.data_generator where workspace_id = $1 and name = $2', [workspaceId, x.name])).rows[0];
      const seed = Number.isInteger(x.seed) ? x.seed : typeof x.seed === 'string' && /^\d{1,10}$/.test(x.seed) ? Number(x.seed) : null;
      const vals = [text(x.description, 1000), x.schema_name, seed, JSON.stringify(Array.isArray(x.tables) ? x.tables : [])];
      n[await upsert(existing,
        () => c.query('insert into meta.data_generator (workspace_id, name, description, schema_name, seed, tables, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $7)', [workspaceId, x.name, ...vals, opts.by]),
        (id) => c.query('update meta.data_generator set description = $2, schema_name = $3, seed = $4, tables = $5, updated_by = $6, updated_at = now() where id = $1', [id, ...vals, opts.by]))]++;
    }
    tally('Data generators', n.added, n.replaced, n.skipped);
  }

  if (want('datasets')) {
    // (sprint 110) checked for form here; App Builder → Data Reporter shows what doesn't match this database
    const n = count();
    for (const x of d.datasets as Json[]) {
      const { dataset, errors } = checkDataset(isObj(x) ? x : {});
      if (errors.length || !dataset.columns.length) throw new Error(`Dataset ${isObj(x) ? x.name : '?'}: ${errors.slice(0, 5).join(' ') || 'it offers no columns.'}`);
      const existing = (await c.query<{ id: number }>('select id from meta.dataset where workspace_id = $1 and name = $2', [workspaceId, dataset.name])).rows[0];
      n[await upsert(existing, () => storeDataset(c, workspaceId, dataset, opts.by), () => storeDataset(c, workspaceId, dataset, opts.by))]++;
    }
    tally('Data Reporter datasets', n.added, n.replaced, n.skipped);
  }

  if (want('team')) {
    // (sprint 113) labels, milestones, templates and issues of Team Development (src/team.ts)
    const t = await importTeam(c, workspaceId, d.team, opts);
    tally('Team Development', t.added, t.replaced, t.skipped, t.issues ? `; ${t.issues} issue(s) with their comments` : '');
  }

  if (want('workspace_files')) {
    // (sprint 141) the same names, types and sizes as an upload
    const n = count();
    for (const x of d.workspace_files as Json[]) {
      const name = isObj(x) && typeof x.name === 'string' ? x.name : '';
      const type = staticType(name);
      if (!type) throw new Error(`Static workspace file ${JSON.stringify(name).slice(0, 110)}: not an allowed name or type.`);
      const content = typeof x.content === 'string' ? Buffer.from(x.content, 'base64') : Buffer.alloc(0);
      if (content.length > STATIC_MAX) throw new Error(`Static workspace file ${name}: larger than ${STATIC_MAX / 1024 / 1024} MB.`);
      const existing = (await c.query<{ id: number }>('select id from meta.workspace_file where workspace_id = $1 and name = $2', [workspaceId, name])).rows[0];
      n[await upsert(existing,
        () => c.query('insert into meta.workspace_file (workspace_id, name, mime, content, updated_by) values ($1, $2, $3, $4, $5)', [workspaceId, name, type, content, opts.by]),
        (id) => c.query('update meta.workspace_file set mime = $2, content = $3, updated_by = $4, updated_at = now() where id = $1', [id, type, content, opts.by]))]++;
    }
    tally('Static workspace files', n.added, n.replaced, n.skipped);
  }

  if (want('remote_servers')) {
    // (sprint 141) the base URL is this installation's: an existing server keeps its own, a new one takes the file's
    const n = count();
    for (const x of d.remote_servers as Json[]) {
      if (!isObj(x)) continue;
      const v = { static_id: x.static_id, name: x.name, description: text(x.description, 2000), base_url: text(x.base_url, 2000), env_var: text(x.env_var, 80), credential: text(x.credential, 60) };
      const problems = serverProblems(v);
      if (problems.length) throw new Error(`Remote server ${typeof x.static_id === 'string' ? x.static_id : '?'}: ${problems.join(' ')}`);
      const existing = (await c.query<{ id: number }>('select id from meta.remote_server where workspace_id = $1 and static_id = $2', [workspaceId, v.static_id])).rows[0];
      n[await upsert(existing,
        () => c.query('insert into meta.remote_server (workspace_id, static_id, name, description, base_url, env_var, credential, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8)',
          [workspaceId, v.static_id, v.name, v.description, v.base_url, v.env_var, v.credential, opts.by]),
        (id) => c.query(`update meta.remote_server set name = $2, description = $3, env_var = $4, credential = $5, base_url = coalesce(base_url, $6),
                                updated_by = $7, updated_at = now() where id = $1`, [id, v.name, v.description, v.env_var, v.credential, v.base_url, opts.by]))]++;
    }
    tally('Remote servers', n.added, n.replaced, n.skipped, n.replaced ? '; existing servers kept their base URL' : '');
  }

  if (want('web_credentials')) {
    // (sprint 141) without secrets: an existing credential keeps its own, a new one gets them entered in the builder
    const n = count();
    for (const x of d.web_credentials as Json[]) {
      if (!isObj(x)) continue;
      const v = {
        name: String(x.name ?? ''), description: text(x.description, 2000),
        type: ['basic', 'header', 'bearer', 'oauth2', 'aws_sigv4'].includes(x.type) ? x.type : 'basic',
        username: text(x.username, 500), header_name: text(x.header_name, 64), token_url: text(x.token_url, 2000), scope: text(x.scope, 500),
        valid_for: Array.isArray(x.valid_for) ? x.valid_for.filter((u: unknown) => typeof u === 'string') : [],
        grant_type: GRANT_TYPES.includes(x.grant_type) ? x.grant_type : 'client_credentials', oauth_username: text(x.oauth_username, 500),
      };
      const problems = [...(/^[A-Z][A-Z0-9_]{0,59}$/.test(v.name) ? [] : ['the name is upper case letters, digits and _.']), ...credentialProblems(v)];
      if (problems.length) throw new Error(`Web credential ${v.name || '?'}: ${problems.join(' ')}`);
      const vals = [v.description, v.type, v.username, v.header_name, v.token_url, v.scope, v.valid_for, v.grant_type, v.oauth_username];
      const existing = (await c.query<{ id: number }>('select id from meta.workspace_credential where workspace_id = $1 and name = $2', [workspaceId, v.name])).rows[0];
      n[await upsert(existing,
        () => c.query(`insert into meta.workspace_credential (workspace_id, name, description, type, username, header_name, token_url, scope, valid_for, grant_type, oauth_username, updated_by)
                       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [workspaceId, v.name, ...vals, opts.by]),
        (id) => c.query(`update meta.workspace_credential set description = $2, type = $3, username = $4, header_name = $5, token_url = $6, scope = $7, valid_for = $8,
                                grant_type = $9, oauth_username = $10, updated_by = $11, updated_at = now() where id = $1`, [id, ...vals, opts.by]))]++;
    }
    tally('Web credentials', n.added, n.replaced, n.skipped, n.added ? '; enter their secrets under Workspace utilities → Web credentials' : '');
  }
  return r;
}
