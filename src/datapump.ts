import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { owner, ownerUrl } from './db.ts';
import { runScript } from './dumpscript.ts';

// (sprint 103, Database Actions DA-16: Data Pump) Schema Export / Import with pg_dump and pg_restore, as background
// jobs (meta.dump_job, migration 116). Pages: src/builder/datapump.ts.
//
// Export: pg_dump of one schema (or some of its tables), custom or plain format, definitions and/or data, run with an
// argument array (never a shell) and the owner connection's password in PGPASSWORD (never on the command line), to a
// file in the dump directory; the job keeps pg_dump's log, the size and the timing.
//
// Import: a custom or tar archive (an export's file or an upload) of one schema S into a schema T, new or existing.
// pg_restore writes the script (`pg_restore -f -`, no connection of its own) and pgkiln runs it on one connection in
// one transaction (src/dumpscript.ts), between schema renames that make the dump's names point at T:
//
//   begin
//   alter schema S rename to pgkiln_dump_<job>      (when T ≠ S and S exists: the original steps aside)
//   alter schema T rename to S                      (when T exists: the dump's names now mean T)
//   … the script (CREATE SCHEMA S is skipped when T exists; created when the dump has no schema entry) …
//   alter schema S rename to T                      (when T ≠ S)
//   alter schema pgkiln_dump_<job> rename to S
//   commit
//
// Other sessions keep seeing the original S until the commit. Limits: names inside PL/pgSQL bodies and other text
// (dynamic SQL, a function's SET search_path) still say S after a rename; views, defaults, triggers and policies
// refer to objects, not names, so they follow. Files stay in PGKILN_DUMP_DIR for PGKILN_DUMP_KEEP_DAYS days.

export const DUMP_DIR = resolve(process.env.PGKILN_DUMP_DIR || join(tmpdir(), 'pgkiln-dumps'));
export const KEEP_DAYS = Math.max(1, Number(process.env.PGKILN_DUMP_KEEP_DAYS) || 7);
/** the largest upload, in MB (read at every upload) */
export const uploadMaxMb = () => Math.max(1, Number(process.env.PGKILN_DUMP_MAX_MB) || 2048);
const LOG_MAX = 256 * 1024;
const HEARTBEAT_MS = 5000;
/** a running job whose server has not written for this long was interrupted */
const STALE_MS = 2 * 60 * 1000;

export type Format = 'custom' | 'plain';
export type Content = 'all' | 'definitions' | 'data';

export interface ExportOptions {
  format: Format;
  content: Content;
  /** only these tables (and views, sequences) of the schema; empty: the whole schema */
  tables: string[];
  /** leave these tables out (with the whole schema) */
  exclude: string[];
  /** keep GRANTs (plain format: also owners are left out either way) */
  privileges: boolean;
}

export interface ImportOptions {
  target: string;
  content: Content;
  /** drop the dump's objects in the target first (pg_restore --clean --if-exists) */
  clean: boolean;
  privileges: boolean;
}

export interface Job {
  id: number;
  kind: 'export' | 'import';
  status: 'uploaded' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  username: string;
  schema_name: string | null;
  target_schema: string | null;
  options: Record<string, unknown>;
  file_name: string | null;
  original_name: string | null;
  source_job: number | null;
  bytes: number | null;
  log: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  seconds: number | null;
  expires_at: string | null;
  file_live: boolean;
}

export const JOB_COLUMNS = `id::int, kind, status, username, schema_name, target_schema, options, file_name, original_name, source_job::int,
  bytes::float8 as bytes, log, error, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at, to_char(started_at, 'YYYY-MM-DD HH24:MI:SS') as started_at,
  to_char(finished_at, 'YYYY-MM-DD HH24:MI:SS') as finished_at, round(extract(epoch from coalesce(finished_at, now()) - started_at)::numeric, 1)::float8 as seconds,
  to_char(expires_at, 'YYYY-MM-DD') as expires_at, (file_name is not null and (expires_at is null or expires_at > now())) as file_live`;

export const getJob = async (id: number | string) =>
  /^\d{1,15}$/.test(String(id)) ? ((await owner.one<Job>(`select ${JOB_COLUMNS} from meta.dump_job where id = $1`, [id])) ?? null) : null;
export const listJobs = async (limit = 200) => (await owner.query<Job>(`select ${JOB_COLUMNS} from meta.dump_job order by id desc limit $1`, [limit])).rows;

/** The schemas pgkiln keeps for itself: never exported, imported or replaced here. */
export const reservedSchema = (name: string) => /^(pg_|pgkiln)/i.test(name) || ['meta', 'information_schema', 'pg_catalog', 'pg_toast'].includes(name.toLowerCase());
/** A schema name typed in a form: an identifier PostgreSQL keeps as typed (quoted when it needs to be). */
export const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export const filePath = (name: string) => {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name) || name.startsWith('.')) throw new Error('bad file name');
  return join(DUMP_DIR, name);
};
export const jobFile = (j: Pick<Job, 'file_name'>) => (j.file_name ? filePath(j.file_name) : null);
export const readJobFile = (j: Pick<Job, 'file_name'>) => createReadStream(jobFile(j)!);

// ------------------------------------------------------------------ the client programs

export interface Tools {
  dump: string;
  restore: string;
  major: number;
  version: string;
}
export type ToolState = { ok: true; tools: Tools; server: number } | { ok: false; server: number; reason: string; found: string[] };

const run = (file: string, args: string[], timeout = 10_000) =>
  new Promise<string>((res, rej) => execFile(file, args, { timeout, env: childEnv() }, (err, stdout) => (err ? rej(err) : res(String(stdout)))));

/** The environment of pg_dump and pg_restore: no other secrets of this process. */
function childEnv(password?: string) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PGAPPNAME: 'pgkiln schema export', PGCONNECT_TIMEOUT: '15' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (password) env.PGPASSWORD = password;
  return env;
}

async function candidateDirs() {
  if (process.env.PGKILN_PG_BIN) return [process.env.PGKILN_PG_BIN];
  const dirs: string[] = [];
  const versions = async (base: string, pattern: RegExp, bin: (d: string) => string) => {
    try {
      for (const d of await readdir(base)) if (pattern.test(d)) dirs.push(bin(join(base, d)));
    } catch {
      // not this platform
    }
  };
  await versions('/usr/lib/postgresql', /^\d+$/, (d) => join(d, 'bin')); // Debian, Ubuntu
  await versions('/usr', /^pgsql-\d+$/, (d) => join(d, 'bin')); // RHEL (PGDG)
  await versions('/opt/homebrew/opt', /^postgresql@\d+$/, (d) => join(d, 'bin')); // macOS
  await versions('/usr/local/opt', /^postgresql@\d+$/, (d) => join(d, 'bin'));
  dirs.push(''); // PATH
  return dirs;
}

let cached: { at: number; state: ToolState } | null = null;

/** pg_dump and pg_restore of a major version at least the server's (pg_dump refuses newer servers), the newest found. */
export async function findTools(fresh = false): Promise<ToolState> {
  if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.state;
  const server = Number((await owner.one<{ v: number }>(`select current_setting('server_version_num')::int / 10000 as v`))!.v);
  const found: { dir: string; major: number; version: string }[] = [];
  for (const dir of await candidateDirs()) {
    const bin = (name: string) => (dir ? join(dir, name) : name);
    try {
      const out = await run(bin('pg_dump'), ['--version']);
      await run(bin('pg_restore'), ['--version']);
      const m = /\)\s*(\d+)(\.\d+)?/.exec(out);
      if (m) found.push({ dir, major: Number(m[1]), version: out.trim() });
    } catch {
      // not there
    }
  }
  found.sort((a, b) => b.major - a.major);
  const best = found[0];
  const state: ToolState = best && best.major >= server
    ? { ok: true, server, tools: { dump: best.dir ? join(best.dir, 'pg_dump') : 'pg_dump', restore: best.dir ? join(best.dir, 'pg_restore') : 'pg_restore', major: best.major, version: best.version } }
    : {
        ok: false, server, found: found.map((f) => `${f.version}${f.dir ? ` (${f.dir})` : ''}`),
        reason: best
          ? `pg_dump ${best.major} can't dump a PostgreSQL ${server} server: install the PostgreSQL ${server} client programs (postgresql-client-${server}) or set PGKILN_PG_BIN to their directory.`
          : `pg_dump and pg_restore were not found: install the PostgreSQL ${server} client programs (postgresql-client-${server}) or set PGKILN_PG_BIN to their directory.`,
      };
  cached = { at: Date.now(), state };
  return state;
}

/** The owner connection for pg_dump: the URL without its password, and the password apart. */
function connection() {
  const u = new URL(ownerUrl);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { dbname: u.toString(), password };
}

/** A name as a pg_dump pattern that matches only itself. */
const pattern = (name: string) => `"${name.replace(/"/g, '""')}"`;
const q = (name: string) => pg.escapeIdentifier(name);

// ------------------------------------------------------------------ jobs

const running = new Map<number, { child?: ChildProcess; cancel?: () => void }>();

/** A job's log, kept short (the start and the end of a long one). */
class Log {
  text = '';
  add(line: string) {
    this.text += `${line.replace(/\s+$/, '')}\n`;
    if (this.text.length > LOG_MAX) this.text = `${this.text.slice(0, LOG_MAX / 4)}\n… (log shortened) …\n${this.text.slice(-LOG_MAX / 2)}`;
  }
}

async function track<T>(id: number, log: Log, work: () => Promise<T>) {
  const beat = setInterval(() => void owner.query('update meta.dump_job set heartbeat_at = now(), log = $2 where id = $1', [id, log.text]).catch(() => {}), HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}

async function finish(id: number, log: Log, error: Error | null, bytes?: number | null) {
  const cancelled = error?.message === 'cancelled';
  if (error && !(error as { logged?: boolean }).logged) log.add(cancelled ? 'Cancelled.' : `Failed: ${error.message}`);
  await owner.query(
    `update meta.dump_job set status = $2, error = $3, log = $4, bytes = coalesce($5, bytes), finished_at = now(), heartbeat_at = null where id = $1`,
    [id, cancelled ? 'cancelled' : error ? 'failed' : 'succeeded', cancelled ? null : error?.message ?? null, log.text, bytes ?? null],
  );
  running.delete(id);
}

/** Waits for a program; its stderr goes to the log. */
function wait(child: ChildProcess, log: Log, name: string) {
  const lines = createInterface({ input: child.stderr! });
  lines.on('line', (l) => log.add(l));
  return new Promise<void>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code, signal) => (code === 0 ? res() : rej(new Error(signal === 'SIGTERM' ? 'cancelled' : `${name} ended with exit code ${code ?? signal}`))));
  });
}

export class DumpError extends Error {}

const schemaTables = async (schema: string) =>
  (await owner.query<{ n: string }>(`select c.relname as n from pg_class c join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') order by 1`, [schema])).rows.map((r) => r.n);

/** The schemas an administrator may export: not pgkiln's own or PostgreSQL's, not an extension's. */
export const exportableSchemas = async () =>
  (await owner.query<{ n: string }>(
    `select nspname as n from pg_namespace n
      where not exists (select 1 from pg_depend d where d.classid = 'pg_namespace'::regclass and d.objid = n.oid and d.deptype = 'e')
      order by 1`)).rows.map((r) => r.n).filter((n) => !reservedSchema(n));

export { schemaTables };

/** Starts pg_dump of a schema in the background; the job's id. */
export async function startExport(username: string, schema: string, o: ExportOptions): Promise<number> {
  const tools = await findTools();
  if (!tools.ok) throw new DumpError(tools.reason);
  if (!(await exportableSchemas()).includes(schema)) throw new DumpError(`There is no schema "${schema}" to export.`);
  const tables = await schemaTables(schema);
  const unknown = [...o.tables, ...o.exclude].filter((t) => !tables.includes(t));
  if (unknown.length) throw new DumpError(`Not in ${schema}: ${unknown.join(', ')}`);
  if (o.tables.length && o.exclude.length) throw new DumpError('Choose tables to include or to leave out, not both.');
  await mkdir(DUMP_DIR, { recursive: true, mode: 0o700 });
  const id = Number((await owner.one<{ id: number }>(
    `insert into meta.dump_job (kind, status, username, schema_name, options, started_at, heartbeat_at, expires_at)
     values ('export', 'running', $1, $2, $3, now(), now(), now() + make_interval(days => $4)) returning id`,
    [username, schema, JSON.stringify(o), KEEP_DAYS],
  ))!.id);
  const file = `export-${id}-${schema.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}.${o.format === 'plain' ? 'sql' : 'dump'}`;
  await owner.query('update meta.dump_job set file_name = $2 where id = $1', [id, file]);
  const { dbname, password } = connection();
  const args = [
    `--format=${o.format === 'plain' ? 'p' : 'c'}`, `--file=${filePath(file)}`, '--verbose',
    ...(o.tables.length ? o.tables.map((t) => `--table=${pattern(schema)}.${pattern(t)}`) : [`--schema=${pattern(schema)}`]),
    ...o.exclude.map((t) => `--exclude-table=${pattern(schema)}.${pattern(t)}`),
    ...(o.content === 'definitions' ? ['--schema-only'] : o.content === 'data' ? ['--data-only'] : []),
    ...(o.format === 'plain' ? ['--no-owner'] : []),
    ...(o.privileges ? [] : ['--no-privileges']),
    `--dbname=${dbname}`,
  ];
  const log = new Log();
  log.add(`pg_dump ${tools.tools.version.replace(/^pg_dump\s*/, '')}: schema ${schema}${o.tables.length ? `, tables ${o.tables.join(', ')}` : ''}${o.exclude.length ? `, without ${o.exclude.join(', ')}` : ''}; ${o.format} format, ${o.content === 'all' ? 'definitions and data' : o.content}${o.privileges ? '' : ', no grants'}`);
  const child = spawn(tools.tools.dump, args, { env: childEnv(password), stdio: ['ignore', 'ignore', 'pipe'] });
  running.set(id, { child });
  void track(id, log, () => wait(child, log, 'pg_dump'))
    .then(async () => finish(id, log, null, (await stat(filePath(file))).size))
    .catch(async (e: Error) => {
      await rm(filePath(file), { force: true }).catch(() => {});
      await owner.query('update meta.dump_job set file_name = null where id = $1', [id]).catch(() => {});
      await finish(id, log, e).catch((x) => console.error('schema export:', x.message));
    });
  return id;
}

// ------------------------------------------------------------------ archives

export interface TocEntry {
  id: number;
  desc: string;
  schema: string | null;
  name: string;
}
export interface Toc {
  header: [string, string][];
  entries: TocEntry[];
  schemas: string[];
  /** the archive creates its schema (a dump of a whole schema; not of some tables) */
  schemaEntry: boolean;
  counts: [string, number][];
  list: string;
}

// pg_restore -l: "215; 1259 16390 TABLE hr employees owner" (desc can have spaces, the owner can be empty)
const DESCS = [
  'TABLE DATA', 'SEQUENCE SET', 'SEQUENCE OWNED BY', 'FK CONSTRAINT', 'CHECK CONSTRAINT', 'MATERIALIZED VIEW DATA', 'MATERIALIZED VIEW', 'DEFAULT ACL',
  'ROW SECURITY', 'TEXT SEARCH CONFIGURATION', 'TEXT SEARCH DICTIONARY', 'FOREIGN TABLE', 'INDEX ATTACH', 'TABLE ATTACH', 'LARGE OBJECT', 'BLOB DATA', 'BLOBS',
  'SCHEMA', 'TABLE', 'VIEW', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'AGGREGATE', 'TYPE', 'DOMAIN', 'CONSTRAINT', 'INDEX', 'TRIGGER', 'POLICY', 'RULE',
  'COMMENT', 'ACL', 'DEFAULT', 'EXTENSION', 'COLLATION', 'STATISTICS', 'OPERATOR', 'CAST', 'PUBLICATION', 'SUBSCRIPTION', 'EVENT TRIGGER', 'SERVER',
  'USER MAPPING', 'FOREIGN DATA WRAPPER', 'CONVERSION', 'ENCODING', 'STDSTRINGS', 'SEARCHPATH', 'DATABASE', 'DATABASE PROPERTIES',
];

export function parseToc(text: string): Toc {
  const header: [string, string][] = [];
  const entries: TocEntry[] = [];
  for (const line of text.split('\n')) {
    const h = /^;\s+([A-Za-z][A-Za-z ]+?):\s+(.*)$/.exec(line);
    if (h) {
      header.push([h[1].trim(), h[2].trim()]);
      continue;
    }
    const m = /^(\d+);\s+\d+\s+\d+\s+(.*)$/.exec(line);
    if (!m) continue;
    const desc = DESCS.find((d) => m[2].startsWith(`${d} `));
    if (!desc) continue;
    const rest = m[2].slice(desc.length + 1).split(' ');
    const schema = rest[0] === '-' ? null : rest[0];
    entries.push({ id: Number(m[1]), desc, schema, name: rest.slice(1, -1).join(' ') || rest.slice(1).join(' ') });
  }
  const schemas = [...new Set(entries.flatMap((e) => (e.desc === 'SCHEMA' ? [e.name] : e.schema ? [e.schema] : [])))];
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.desc, (counts.get(e.desc) ?? 0) + 1);
  return { header, entries, schemas, schemaEntry: entries.some((e) => e.desc === 'SCHEMA'), counts: [...counts], list: text };
}

/** The table of contents of an archive (pg_restore -l; no connection). */
export async function readToc(file: string): Promise<Toc> {
  const tools = await findTools();
  if (!tools.ok) throw new DumpError(tools.reason);
  try {
    return parseToc(await run(tools.tools.restore, ['--list', file], 60_000));
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message);
    throw new DumpError(/text format|psql/i.test(msg)
      ? 'This is a plain SQL dump: run it in SQL Scripts, or export the schema again in custom format.'
      : `pg_restore can't read this file as a custom or tar archive. ${msg.replace(/^.*?pg_restore: (error: )?/s, '')}`.trim());
  }
}

/** The one schema an archive may be imported from, or why not. */
export function archiveSchema(toc: Toc): string {
  if (toc.schemas.length !== 1) throw new DumpError(toc.schemas.length ? `The archive holds ${toc.schemas.length} schemas (${toc.schemas.join(', ')}): import a dump of one schema.` : 'The archive holds no schema objects.');
  const s = toc.schemas[0];
  if (reservedSchema(s)) throw new DumpError(`The archive is a dump of ${s}, which pgkiln keeps for itself.`);
  if (toc.entries.some((e) => ['EXTENSION', 'DATABASE', 'PUBLICATION', 'SUBSCRIPTION', 'EVENT TRIGGER', 'SERVER', 'USER MAPPING', 'FOREIGN DATA WRAPPER', 'LARGE OBJECT', 'BLOBS', 'BLOB DATA'].includes(e.desc)))
    throw new DumpError('The archive holds objects outside a schema (extensions, large objects, servers…): pgkiln imports one schema\'s tables, views, functions and data.');
  return s;
}

/** Imports an archive (an upload's job, or a new job for an export's file) in the background; the job's id. */
export async function startImport(username: string, source: Job, o: ImportOptions): Promise<number> {
  const tools = await findTools();
  if (!tools.ok) throw new DumpError(tools.reason);
  if (!source.file_live) throw new DumpError('The file of this job is no longer kept.');
  if (!SCHEMA_NAME.test(o.target)) throw new DumpError('The target schema: letters, digits, _ and $, up to 63, not starting with a digit.');
  if (reservedSchema(o.target)) throw new DumpError(`${o.target} is pgkiln's or PostgreSQL's own schema.`);
  const file = jobFile(source)!;
  const toc = await readToc(file);
  const schema = archiveSchema(toc);
  let id: number;
  if (source.kind === 'import' && source.status === 'uploaded') {
    id = source.id;
    const r = await owner.query(
      `update meta.dump_job set status = 'running', schema_name = $2, target_schema = $3, options = $4, started_at = now(), heartbeat_at = now()
        where id = $1 and status = 'uploaded'`, [id, schema, o.target, JSON.stringify(o)]);
    if (!r.rowCount) throw new DumpError('This upload is already being imported.');
  } else {
    id = Number((await owner.one<{ id: number }>(
      `insert into meta.dump_job (kind, status, username, schema_name, target_schema, options, source_job, started_at, heartbeat_at)
       values ('import', 'running', $1, $2, $3, $4, $5, now(), now()) returning id`,
      [username, schema, o.target, JSON.stringify(o), source.id]))!.id);
  }
  const log = new Log();
  log.add(`pg_restore ${tools.tools.version.replace(/^pg_dump\s*/, '')}: ${source.original_name ?? source.file_name} (schema ${schema}) into ${o.target}; ${o.content === 'all' ? 'definitions and data' : o.content}${o.clean ? ', existing objects dropped first' : ''}${o.privileges ? '' : ', no grants'}`);
  const state: { cancelled: boolean; child?: ChildProcess; client?: pg.Client } = { cancelled: false };
  running.set(id, {
    cancel: () => {
      state.cancelled = true;
      state.child?.kill('SIGTERM');
      // the server stops what it runs; the transaction rolls back
      if (state.client) void owner.query('select pg_cancel_backend($1)', [(state.client as unknown as { processID: number }).processID]).catch(() => {});
    },
  });
  void track(id, log, () => restore(id, tools.tools, file, toc, schema, o, log, state))
    .then(() => finish(id, log, null))
    .catch((e: Error) => finish(id, log, state.cancelled ? new Error('cancelled') : e).catch((x) => console.error('schema import:', x.message)));
  return id;
}

async function restore(id: number, tools: Tools, file: string, toc: Toc, schema: string, o: ImportOptions, log: Log, state: { cancelled: boolean; child?: ChildProcess; client?: pg.Client }) {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'pgkiln schema import' });
  state.client = client;
  client.on('error', () => {});
  await client.connect();
  let listFile: string | null = null;
  try {
    await client.query('begin');
    const exists = async (name: string) => !!(await client.query('select 1 from pg_namespace where nspname = $1', [name])).rowCount;
    const targetExists = await exists(o.target);
    const aside = `pgkiln_dump_${id}`;
    const moveAside = o.target !== schema && (await exists(schema));
    if (o.content === 'data' && !targetExists) throw new DumpError(`${o.target} doesn't exist: import the definitions too, or choose an existing schema.`);
    if (moveAside) {
      await client.query(`alter schema ${q(schema)} rename to ${q(aside)}`);
      log.add(`Schema ${schema} renamed to ${aside} for the import (other sessions still see ${schema}).`);
    }
    if (targetExists && o.target !== schema) await client.query(`alter schema ${q(o.target)} rename to ${q(schema)}`);
    if (!targetExists && (!toc.schemaEntry || o.content === 'data')) await client.query(`create schema ${q(schema)}`);
    const args = ['--file=-', '--no-owner', '--no-security-labels', '--no-tablespaces', '--no-publications', '--no-subscriptions'];
    if (o.content === 'definitions') args.push('--schema-only');
    if (o.content === 'data') args.push('--data-only');
    if (o.clean && o.content !== 'data') args.push('--clean', '--if-exists');
    if (!o.privileges) args.push('--no-privileges');
    let lines = toc.list.split('\n');
    // the schema is there: leave out its CREATE (and DROP) SCHEMA
    if (targetExists && toc.schemaEntry) lines = lines.map((l) => (/^\d+;\s+\d+\s+\d+\s+SCHEMA - /.test(l) ? `;${l}` : l));
    // data only: the tables' foreign keys are there, so referenced tables load first (pg_dump orders data by name)
    if (o.content === 'data') lines = await dataOrder(client, schema, toc, lines);
    if (lines.join('\n') !== toc.list) {
      listFile = `${file}.${id}.list`;
      await writeFile(listFile, lines.join('\n'), { mode: 0o600 });
      args.push(`--use-list=${listFile}`);
    }
    args.push(file);
    const child = spawn(tools.restore, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child;
    const exited = wait(child, log, 'pg_restore');
    exited.catch(() => {});
    let stats;
    try {
      stats = await runScript(client, createInterface({ input: child.stdout!, crlfDelay: Infinity }), schema, (l) => log.add(l));
    } catch (e) {
      child.kill('SIGTERM');
      throw e;
    }
    await exited;
    if (state.cancelled) throw new Error('cancelled');
    if (o.target !== schema) await client.query(`alter schema ${q(schema)} rename to ${q(o.target)}`);
    if (moveAside) await client.query(`alter schema ${q(aside)} rename to ${q(schema)}`);
    await client.query('commit');
    log.add(`Done: ${stats.statements} statements, ${stats.tables} table${stats.tables === 1 ? '' : 's'} with ${stats.rows} row${stats.rows === 1 ? '' : 's'} into ${o.target}.`);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    if (!state.cancelled) log.add(`Failed: ${(e as Error).message}`);
    log.add('Rolled back: nothing was changed.');
    (e as { logged?: boolean }).logged = true;
    throw e;
  } finally {
    if (listFile) await rm(listFile, { force: true }).catch(() => {});
    await client.end().catch(() => {});
  }
}

/** The archive's list with its TABLE DATA entries in foreign key order of the schema's tables (parents first). */
async function dataOrder(client: pg.ClientBase, schema: string, toc: Toc, lines: string[]) {
  const deps = new Map((await client.query<{ t: string; deps: string[] }>(
    `select c.relname as t, array(select distinct p.relname::text from pg_constraint k join pg_class p on p.oid = k.confrelid
                                   where k.conrelid = c.oid and k.contype = 'f' and p.relnamespace = c.relnamespace and p.oid <> c.oid) as deps
       from pg_class c where c.relnamespace = (select oid from pg_namespace where nspname = $1) and c.relkind in ('r', 'p')`, [schema])).rows.map((r) => [r.t, r.deps]));
  const rank = new Map<string, number>();
  const visit = (t: string, seen: Set<string>): number => {
    if (rank.has(t)) return rank.get(t)!;
    if (seen.has(t)) return 0; // a cycle: as listed
    seen.add(t);
    const r = Math.max(0, ...(deps.get(t) ?? []).map((d) => visit(d, seen) + 1));
    rank.set(t, r);
    return r;
  };
  const data = new Map(toc.entries.filter((e) => e.desc === 'TABLE DATA').map((e) => [e.id, e.name]));
  const at: number[] = [];
  lines.forEach((l, i) => {
    const m = /^(\d+);/.exec(l);
    if (m && data.has(Number(m[1]))) at.push(i);
  });
  const sorted = at.map((i) => lines[i]).sort((a, b) => visit(data.get(Number(a.split(';')[0]))!, new Set()) - visit(data.get(Number(b.split(';')[0]))!, new Set()));
  const out = [...lines];
  at.forEach((i, k) => (out[i] = sorted[k]));
  return out;
}

/** Cancels a running job of this server. */
export function cancelJob(id: number) {
  const r = running.get(id);
  if (!r) return false;
  if (r.child && !r.cancel) r.child.kill('SIGTERM');
  r.cancel?.();
  return true;
}

/** Removes a finished job and its file (an export's file stays while an import of it runs). */
export async function deleteJob(j: Job) {
  if (j.status === 'running') throw new DumpError('The job is running: cancel it first.');
  if (j.file_name && !(await owner.one(`select 1 as x from meta.dump_job where source_job = $1 and status = 'running'`, [j.id])))
    await rm(filePath(j.file_name), { force: true });
  await owner.query('delete from meta.dump_job where id = $1', [j.id]);
}

/** An uploaded file's job: the file is already in the dump directory. */
export async function uploadJob(username: string, fileName: string, originalName: string, bytes: number) {
  return Number((await owner.one<{ id: number }>(
    `insert into meta.dump_job (kind, status, username, file_name, original_name, bytes, expires_at)
     values ('import', 'uploaded', $1, $2, $3, $4, now() + make_interval(days => $5)) returning id`,
    [username, fileName, originalName.slice(0, 255), bytes, KEEP_DAYS]))!.id);
}

/**
 * The scheduler's chore (src/automations.ts): jobs whose server stopped are marked failed; files past their days are
 * removed (the job stays in the list); files no job knows (an upload cut off) after a day.
 */
export async function dumpTick() {
  await owner.query(
    `update meta.dump_job set status = 'failed', error = 'interrupted: the server stopped while the job ran', finished_at = now(), heartbeat_at = null
      where status = 'running' and (heartbeat_at is null or heartbeat_at < now() - make_interval(secs => $1))`, [STALE_MS / 1000]);
  const expired = (await owner.query<{ id: number; file_name: string }>(
    `select id::int, file_name from meta.dump_job where file_name is not null and expires_at < now()
        and not exists (select 1 from meta.dump_job i where i.source_job = dump_job.id and i.status = 'running')`)).rows;
  for (const j of expired) {
    await rm(filePath(j.file_name), { force: true }).catch(() => {});
    await owner.query('update meta.dump_job set file_name = null where id = $1', [j.id]);
  }
  let names: string[];
  try {
    names = await readdir(DUMP_DIR);
  } catch {
    return;
  }
  const known = new Set((await owner.query<{ f: string }>('select file_name as f from meta.dump_job where file_name is not null')).rows.map((r) => r.f));
  for (const n of names) {
    if (known.has(n) || !/^(export|upload)-/.test(n)) continue;
    const st = await stat(join(DUMP_DIR, n)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 86_400_000) await rm(join(DUMP_DIR, n), { force: true }).catch(() => {});
  }
}
