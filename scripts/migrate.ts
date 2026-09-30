// Applies db/migrations/*.sql in order (each once, in a transaction), then
// optionally db/seed/*.sql (--seed). Uses DATABASE_URL (the owner role).
// --root <dir> reads db/ from another directory, e.g. an older release for
// the upgrade test: git archive v0.6.0 db | tar -x -C /tmp/old, then
// migrate.ts --seed --root /tmp/old, then migrate.ts --seed.
import '../src/env.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { root as appRoot } from '../src/env.ts';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? process.argv[rootArg + 1] : appRoot;

let client: pg.Client;
for (let attempt = 1; ; attempt++) {
  // a pg.Client cannot be reused after a failed connect
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    break;
  } catch (e) {
    if (attempt >= 30) throw e;
    await new Promise((r) => setTimeout(r, 1000)); // database still starting
  }
}

async function apply(dir: string, table: string) {
  await client.query(`create table if not exists public.${table} (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await client.query(`select name from public.${table}`)).rows.map((r) => r.name));
  for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    process.stdout.write(`applying ${dir}/${file} ... `);
    try {
      await client.query('begin');
      await client.query(readFileSync(join(root, dir, file), 'utf8'));
      await client.query(`insert into public.${table} (name) values ($1)`, [file]);
      await client.query('commit');
      console.log('ok');
    } catch (e) {
      await client.query('rollback');
      console.log('FAILED');
      throw e;
    }
  }
}

try {
  await apply('db/migrations', 'pgapex_migration');
  if (process.argv.includes('--seed')) await apply('db/seed', 'pgapex_seed');
} finally {
  await client.end();
}
