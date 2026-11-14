// (sprint 192, NX-F5) The last step of scripts/oracle-e2e.sh: open every page of an application imported from APEX
// as a user and say which show data and which show a region error.
//   npx tsx scripts/apex-e2e-pages.ts <alias> [--expect 3:Welles,8:King]
// Gives the account demo (made when missing) access with every role the application's authorization schemes name,
// signs in, opens each page without arguments and prints ok / FAIL with the first error. --expect: text each of those
// pages must show (data that came from Oracle). Exits 1 when an --expect page fails or lacks its text; other pages'
// errors are printed (APEX's own administration pages read APEX views that PostgreSQL doesn't have).
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from '../test/helpers.ts';

const alias = process.argv[2];
const expectArg = process.argv[process.argv.indexOf('--expect') + 1];
if (!alias || alias.startsWith('-')) {
  console.error('usage: npx tsx scripts/apex-e2e-pages.ts <alias> [--expect 3:Welles,8:King]');
  process.exit(2);
}
const expect = new Map<number, string>(process.argv.includes('--expect') && expectArg
  ? expectArg.split(',').map((x) => x.split(':')).map(([p, t]) => [Number(p), t] as [number, string]) : []);

const app = await buildApp({ logger: false });
let failed = false;
try {
  const a = await owner.one<{ id: number }>('select id from meta.app where alias = $1', [alias]);
  if (!a) throw new Error(`no application ${alias}`);
  const roles = (await owner.query<{ value: string }>(`select value from meta.authz_scheme where app_id = $1 and type = 'role'`, [a.id])).rows.map((r) => r.value);
  let acc = await owner.one<{ id: number }>(`select id from meta.account where lower(username) = 'demo'`);
  if (!acc) {
    await owner.query(`insert into meta.account (username, password_hash) values ('demo', crypt('demo', gen_salt('bf')))`);
    acc = (await owner.one<{ id: number }>(`select id from meta.account where lower(username) = 'demo'`))!;
  }
  await owner.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, $3)
    on conflict (app_id, account_id) do update set roles = excluded.roles`, [a.id, acc.id, roles]);
  const user = new Browser(app);
  const login = await user.login('demo', 'demo', alias);
  if (login.statusCode !== 303) throw new Error(`demo can't sign in to ${alias} (${login.statusCode})`);
  const pages = (await owner.query<{ page_no: number; name: string }>('select page_no, name from meta.page where app_id = $1 order by 1', [a.id])).rows;
  let ok = 0;
  for (const p of pages) {
    const res = await user.get(`/a/${alias}/${p.page_no}`);
    const error = /class="alert alert-error"[^>]*>([\s\S]{0,300})/.exec(res.body)?.[1] ?? /class="region-error[^"]*"[^>]*>([\s\S]{0,300})/.exec(res.body)?.[1];
    const want = expect.get(p.page_no);
    const shows = !want || res.body.includes(want);
    const good = res.statusCode === 200 && !error && shows;
    if (good) ok++;
    if (!good && expect.has(p.page_no)) failed = true;
    console.log(`${good ? 'ok  ' : 'FAIL'} page ${p.page_no} ${p.name}${res.statusCode !== 200 ? ` (${res.statusCode})` : ''}${want ? (shows ? ` shows "${want}"` : ` does not show "${want}"`) : ''}${error ? `: ${error.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}` : ''}`);
  }
  console.log(`${ok} of ${pages.length} pages open without an error${expect.size ? `; ${expect.size} page(s) must show data from Oracle` : ''}`);
} catch (e) {
  console.error((e as Error).message);
  failed = true;
} finally {
  await app.close();
  await closePools();
}
process.exit(failed ? 1 : 0);
