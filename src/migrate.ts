// Applies db/migrations/*.sql in order (each once, in a transaction): the
// framework, then optionally an example application from examples/<name>/.
// Used by scripts/migrate.ts (npm run db:migrate, …) and `pgkiln migrate`.
// Examples share one record of applied files (public.pgapex_seed, by file
// name), so a database installed with db/seed/ carries on with examples/hr/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export interface MigrateOptions {
  /** connection string of the owner role */
  databaseUrl?: string;
  /** directory holding db/ and examples/ */
  root: string;
  /** install examples/<name>/ after the migrations */
  example?: string | null;
  /** releases up to 0.9 kept the HR sample in db/seed/: install that if present, else examples/hr */
  seed?: boolean;
  /** seconds to wait for the database to accept connections */
  waitSeconds?: number;
  log?: (s: string) => void;
}

/**
 * The files in db/migrations/ that the database has not applied yet. The
 * server checks this when it starts: code newer than the database fails
 * with "column … does not exist" on many pages otherwise.
 */
export async function pendingMigrations(root: string, databaseUrl?: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl ?? process.env.DATABASE_URL, application_name: 'pgapex-migrate' });
  await client.connect();
  try {
    const table = (await client.query(`select to_regclass('public.pgapex_migration') is not null as ok`)).rows[0].ok;
    const done = new Set(table ? (await client.query('select name from public.pgapex_migration')).rows.map((r) => r.name) : []);
    return readdirSync(join(root, 'db/migrations')).filter((f) => f.endsWith('.sql') && !done.has(f)).sort();
  } finally {
    await client.end();
  }
}

// errors waiting won't fix: a wrong password or user (28P01, 28000), a missing
// database (3D000) or role, too few privileges (42501)
const permanent = new Set(['28P01', '28000', '3D000', '42501']);

/**
 * A connected client, retrying once a second for up to `seconds` while the
 * database is still starting; errors that waiting won't fix are thrown at once.
 * Each attempt gives up after at most 10 seconds, so an unreachable host (dropped
 * packets) fails within about `seconds` too, not after the OS's TCP timeout.
 */
export async function connectWhenReady(connectionString: string | undefined, applicationName: string, seconds: number, onWait?: () => void): Promise<pg.Client> {
  const deadline = Date.now() + seconds * 1000;
  for (let attempt = 1; ; attempt++) {
    // a pg.Client cannot be reused after a failed connect
    const client = new pg.Client({ connectionString, application_name: applicationName, connectionTimeoutMillis: Math.max(1000, Math.min(10_000, deadline - Date.now())) });
    try {
      await client.connect();
      return client;
    } catch (e) {
      if (permanent.has((e as { code?: string }).code ?? '') || Date.now() + 1000 >= deadline) throw e;
      if (attempt === 1) onWait?.();
      await new Promise((r) => setTimeout(r, 1000)); // database still starting
    }
  }
}

/** Returns the names of the files applied. */
export async function migrate(o: MigrateOptions): Promise<string[]> {
  const log = o.log ?? ((s: string) => process.stdout.write(s));
  if (o.example != null && !/^[a-z][a-z0-9_-]*$/.test(o.example)) throw new Error('--example needs the name of a directory in examples/, e.g. --example hr');
  if (o.example && !existsSync(join(o.root, 'examples', o.example))) throw new Error(`no example named ${o.example} in ${join(o.root, 'examples')}`);
  const client = await connectWhenReady(o.databaseUrl ?? process.env.DATABASE_URL, 'pgapex-migrate', o.waitSeconds ?? 30);
  const applied: string[] = [];
  const startedAt = new Date();
  // an empty database: this run installs pgkiln, else it upgrades it
  const fresh = !(await client.query(`select to_regclass('public.pgapex_migration') is not null as ok`)).rows[0].ok;
  let failure: string | null = null;
  async function apply(dir: string, table: string) {
    await client.query(`create table if not exists public.${table} (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query(`select name from public.${table}`)).rows.map((r) => r.name));
    for (const file of readdirSync(join(o.root, dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log(`applying ${dir}/${file} ... `);
      try {
        await client.query('begin');
        await client.query(readFileSync(join(o.root, dir, file), 'utf8'));
        await client.query(`insert into public.${table} (name) values ($1)`, [file]);
        await client.query('commit');
        log('ok\n');
        applied.push(`${dir}/${file}`);
      } catch (e) {
        await client.query('rollback');
        log('FAILED\n');
        failure = `${dir}/${file}: ${(e as Error).message}`;
        throw e;
      }
    }
  }
  try {
    await apply('db/migrations', 'pgapex_migration');
    if (o.seed) {
      if (existsSync(join(o.root, 'db/seed'))) await apply('db/seed', 'pgapex_seed');
      else await apply('examples/hr', 'pgapex_seed');
    }
    if (o.example) await apply(`examples/${o.example}`, 'pgapex_seed');
  } finally {
    if (applied.length || failure) await recordRun(client, o.root, { startedAt, fresh, applied, failure }).catch(() => {});
    await client.end();
  }
  return applied;
}

/**
 * The install/upgrade log (Builder → Workspace utilities → Installation): one
 * row per run of the migrations that applied something or failed. Created
 * here, like public.pgapex_migration, so it exists before the first migration.
 */
async function recordRun(client: pg.Client, root: string, r: { startedAt: Date; fresh: boolean; applied: string[]; failure: string | null }) {
  await client.query(`create table if not exists public.pgapex_install_log (
    id bigserial primary key,
    started_at timestamptz not null,
    finished_at timestamptz not null default now(),
    version text,
    kind text not null check (kind in ('install', 'upgrade')),
    applied text[] not null default '{}',
    status text not null check (status in ('ok', 'failed')),
    error text,
    db_user text not null default current_user)`);
  let version: string | null = null;
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {
    // a root without package.json (an unpacked release is fine without it)
  }
  await client.query(
    'insert into public.pgapex_install_log (started_at, version, kind, applied, status, error) values ($1, $2, $3, $4, $5, $6)',
    [r.startedAt, version, r.fresh ? 'install' : 'upgrade', r.applied, r.failure ? 'failed' : 'ok', r.failure?.slice(0, 4000) ?? null],
  );
}
