// (sprint 166) Checks one App Gallery sample app while you write it:
//   npx tsx scripts/check-sample.ts examples/gallery/samples/sample-processes.sql [--keep]
// Removes an earlier install (application, schema, role), runs the script in one transaction as
// the owner (what the gallery's Install does), signs in as demo / demo and opens every page:
// each must answer 200 without an error region, and nothing may land in the error log. Prints
// each page's result. Without --keep the sample is removed again. Whether every catalogued value
// is used by some sample is test/sample-coverage.test.ts's job.
import { readFileSync } from 'node:fs';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from '../test/helpers.ts';

const file = process.argv[2];
const keep = process.argv.includes('--keep');
if (!file) {
  console.error('usage: npx tsx scripts/check-sample.ts <sample.sql> [--keep]');
  process.exit(2);
}
const sql = readFileSync(file, 'utf8');
const schema = /create schema (\w+);/.exec(sql)?.[1];
const role = /create role (\w+) nologin/.exec(sql)?.[1];
const alias = /insert into meta\.app \([^)]*\)\s*values \('([a-z0-9_-]+)'/.exec(sql)?.[1];
if (!schema || !role || !alias) {
  console.error('the script must create its schema, its role (create role … nologin) and the application (insert into meta.app … values (\'alias\', …)');
  process.exit(2);
}

async function remove() {
  await owner.query('delete from meta.app where alias = $1', [alias]);
  await owner.query(`drop schema if exists ${schema} cascade`);
  if ((await owner.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) {
    await owner.query(`drop owned by ${role} cascade`).catch(() => {});
    await owner.query(`drop role ${role}`);
  }
}

let failed = false;
const app = await buildApp({ logger: false });
try {
  await remove();
  await owner.tx(async (c) => {
    await c.query(sql);
  });
  console.log(`installed ${alias}`);
  const a = (await owner.one<{ id: number }>('select id from meta.app where alias = $1', [alias]))!;
  const logged = (await owner.one(`select coalesce(max(id), 0) as id from meta.activity_log where app_id = $1`, [a.id])).id;
  const user = new Browser(app);
  const login = await user.login('demo', 'demo', alias);
  if (login.statusCode !== 303) throw new Error(`demo / demo can't sign in (${login.statusCode})`);
  const pages = (await owner.query<{ page_no: number; name: string }>('select page_no, name from meta.page where app_id = $1 order by 1', [a.id])).rows;
  for (const p of pages) {
    const res = await user.get(`/a/${alias}/${p.page_no}`);
    const error = /class="alert alert-error"[^>]*>([\s\S]{0,300})/.exec(res.body)?.[1];
    const ok = res.statusCode === 200 && !error;
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} page ${p.page_no} ${p.name}${res.statusCode !== 200 ? ` (${res.statusCode})` : ''}${error ? `: ${error.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}` : ''}`);
  }
  const errors = (await owner.query(`select page_no, detail from meta.activity_log where app_id = $1 and event = 'error' and id > $2`, [a.id, logged])).rows;
  for (const e of errors) {
    failed = true;
    console.log(`FAIL error log, page ${e.page_no}: ${e.detail}`);
  }
} catch (e) {
  failed = true;
  console.log(`FAIL ${(e as Error).message}`);
} finally {
  if (!keep) await remove();
  await app.close();
  await closePools();
}
console.log(failed ? 'FAILED' : 'all pages render');
process.exit(failed ? 1 : 0);
