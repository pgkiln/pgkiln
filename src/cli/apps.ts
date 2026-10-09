// Database access shared by the command line (main.ts) and the MCP server
// (mcp.ts): connecting as the owner, exporting, reading and importing an
// application. Nothing here writes to standard output.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { filesToDoc, type Doc, type FileMap } from '../appfiles.ts';

/** A mistake of the caller (bad argument, missing file): exit code 2. */
export class UsageError extends Error {}

export async function connect() {
  const { default: pg } = await import('pg');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (use --db, the environment or .env)');
  // dates as Postgres sends them, like the server (src/db.ts)
  for (const oid of [1082, 1114, 1184, 1083, 1266]) pg.types.setTypeParser(oid, (v: string) => v);
  const client = new pg.Client({ connectionString: url, application_name: 'pgkiln-cli' });
  await client.connect();
  return client;
}

export type Db = Awaited<ReturnType<typeof connect>>;

export async function withDb<T>(fn: (db: Db) => Promise<T>) {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export async function exportDoc(db: Db, alias: string): Promise<Doc> {
  const r = await db.query('select meta.export_app($1) as doc', [alias]);
  if (!r.rows[0]?.doc) throw new Error(`application ${alias} not found (pgkiln apps lists them)`);
  return r.rows[0].doc;
}

/** A JSON export, an application directory or a .zip of one. */
export async function readSource(path: string): Promise<{ doc: Doc; files?: FileMap }> {
  if (!existsSync(path)) throw new UsageError(`${path} not found`);
  const { readDir, readZip } = await import('./files.ts');
  if (statSync(path).isDirectory()) {
    const files = readDir(path);
    return { doc: filesToDoc(files), files };
  }
  const buf = readFileSync(path);
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const files = readZip(buf);
    return { doc: filesToDoc(files), files };
  }
  try {
    return { doc: JSON.parse(buf.toString('utf8')) };
  } catch (e) {
    throw new Error(`${path}: not a JSON export, a directory or a .zip (${(e as Error).message})`);
  }
}

/**
 * Imports doc as alias in one transaction: a new application, or with replace
 * the existing one updated in place (see replace.ts). Returns its id, whether
 * it replaced one, and its number of supporting object scripts (never run).
 */
export async function importDoc(db: Db, doc: Doc, { alias, replace }: { alias: string; replace: boolean }) {
  await db.query('begin');
  try {
    const exists = (await db.query('select id from meta.app where alias = $1', [alias])).rows[0];
    let id: number;
    if (exists && !replace) throw new UsageError(`application ${alias} exists: use --replace to update it, or --alias for a copy`);
    if (exists) {
      const { replaceApp } = await import('./replace.ts');
      id = await replaceApp(db, doc, alias);
    } else id = (await db.query('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), alias])).rows[0].id;
    await db.query('commit');
    const scripts: number = (await db.query('select count(*)::int as n from meta.supporting_script where app_id = $1', [id])).rows[0].n;
    return { id, replaced: !!exists, scripts };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}
