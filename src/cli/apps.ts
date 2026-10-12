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

/** One problem the Advisor found in an import (see src/builder/advisor.ts). */
export interface ImportFinding {
  severity: 'error' | 'warning' | 'info';
  where: string;
  field: string;
  message: string;
}

/**
 * How an import checks the application before it commits (sprint 51):
 *  - off:     no check;
 *  - check:   the Advisor runs in the import's transaction; errors refuse the import (nothing changes);
 *  - force:   the Advisor runs and reports, the import commits anyway;
 *  - dry-run: the Advisor runs and reports, the import is always rolled back.
 */
export type ImportCheck = 'off' | 'check' | 'force' | 'dry-run';

/**
 * Imports doc as alias in one transaction: a new application, or with replace
 * the existing one updated in place (see replace.ts). Returns its id, whether
 * it replaced one, its number of supporting object scripts (never run), the
 * Advisor's findings (with a check) and whether it was committed.
 */
export async function importDoc(db: Db, doc: Doc, { alias, replace, check = 'off', by = null }: { alias: string; replace: boolean; check?: ImportCheck; by?: string | null }) {
  await db.query('begin');
  try {
    const exists = (await db.query('select id from meta.app where alias = $1', [alias])).rows[0];
    let id: number;
    if (exists && !replace) throw new UsageError(`application ${alias} exists: use --replace to update it, or --alias for a copy`);
    if (exists) {
      const { replaceApp } = await import('./replace.ts');
      id = await replaceApp(db, doc, alias, { backup: { reason: 'import', user: by } });
    } else id = (await db.query('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), alias])).rows[0].id;
    const scripts: number = (await db.query('select count(*)::int as n from meta.supporting_script where app_id = $1', [id])).rows[0].n;
    let findings: ImportFinding[] = [];
    if (check !== 'off') {
      // the application as imported, before anything is committed: SQL planned as its role, references
      const { advise } = await import('../builder/advisor.ts');
      findings = (await advise(id, db)).findings.map((f) => ({
        severity: f.severity,
        where: f.entry ? `${f.entry.pageNo !== null ? `page ${f.entry.pageNo}, ` : ''}${f.entry.kindLabel.toLowerCase()} ${f.entry.label}` : 'database',
        field: f.field,
        message: f.message,
      }));
      if (check === 'dry-run' || (check === 'check' && findings.some((f) => f.severity === 'error'))) {
        await db.query('rollback');
        return { id, replaced: !!exists, scripts, findings, committed: false };
      }
    }
    await db.query('commit');
    return { id, replaced: !!exists, scripts, findings, committed: true };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}

/** The Advisor's findings of an import, one per line, errors first. */
export function formatFindings(findings: ImportFinding[]) {
  if (!findings.length) return 'Check: no problems found.\n';
  const count = (sev: ImportFinding['severity']) => findings.filter((f) => f.severity === sev).length;
  return findings.map((f) => `${f.severity.toUpperCase()}  ${f.where}${f.field ? ` (${f.field})` : ''}: ${f.message}\n`).join('') +
    `Check: ${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} note(s).\n`;
}
