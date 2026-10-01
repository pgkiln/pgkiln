// Applies db/migrations/*.sql in order (each once, in a transaction): the
// framework. Uses DATABASE_URL (the owner role).
//   --example <name>  then installs the example application in examples/<name>/
//                     (e.g. --example hr: the HR sample the tests use)
//   --seed            releases up to 0.9 kept the HR sample in db/seed/; with --root
//                     it installs that, otherwise it means --example hr
//   --root <dir>      reads db/ (and db/seed/) from another directory, e.g. an older
//                     release for the upgrade test: git archive v0.8.0 db | tar -x -C
//                     /tmp/old; migrate.ts --seed --root /tmp/old; migrate.ts --example hr
// Examples share one record of applied files (public.pgapex_seed, by file name),
// so a database installed with db/seed/ carries on with examples/hr/.
import '../src/env.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const exampleArg = process.argv.indexOf('--example');
const example = exampleArg > 0 ? process.argv[exampleArg + 1] : null;
if (example !== null && !/^[a-z][a-z0-9_-]*$/.test(example ?? '')) throw new Error('--example needs the name of a directory in examples/, e.g. --example hr');

try {
  await apply('db/migrations', 'pgapex_migration');
  if (process.argv.includes('--seed')) {
    if (existsSync(join(root, 'db/seed'))) await apply('db/seed', 'pgapex_seed');
    else await apply('examples/hr', 'pgapex_seed');
  }
  if (example) await apply(`examples/${example}`, 'pgapex_seed');
} finally {
  await client.end();
}
