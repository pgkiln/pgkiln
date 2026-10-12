// Safe deployments (sprint 51): an import checked by the Advisor before it commits,
// application backups (migration 082), availability and build status (migration 083).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { root } from '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { availabilityRefusal } from '../src/runtime/availability.ts';
import { Browser } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'pgkiln-deploy-'));
const ALIAS = 'hr-deploy';
let app: FastifyInstance;
let doc: any;

const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), ...args], { cwd: tmp, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const file = (name: string, d: unknown) => {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(d));
  return p;
};
/** The export with one region's source changed. */
const withSource = (source: string) => {
  const d = structuredClone(doc);
  const r = d.pages.find((p: any) => p.page_no === 2).regions.find((x: any) => x.type === 'report');
  r.source = source;
  return d;
};
const reportSource = async () =>
  (await owner.one(`select r.source from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                     where a.alias = $1 and p.page_no = 2 and r.type = 'report'`, [ALIAS])).source as string;

before(async () => {
  await owner.query('delete from meta.app where alias = $1', [ALIAS]);
  doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
  app = await buildApp({ logger: false });
  // a copy of HR to deploy over
  assert.equal(cli('import', file('hr.json', doc), '--alias', ALIAS).code, 0);
});

after(async () => {
  await owner.query('delete from meta.app where alias = $1', [ALIAS]);
  rmSync(tmp, { recursive: true, force: true });
  await app.close();
  await closePools();
});

describe('deployments: an import checked before it commits', () => {
  test('--check refuses an application whose SQL names a missing table; nothing changes', async () => {
    const before = await reportSource();
    const r = cli('import', file('bad.json', withSource('select * from hr.no_such_table')), '--replace', '--alias', ALIAS, '--check');
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /ERROR {2}page 2, region .*: .*relation "hr\.no_such_table" does not exist/);
    assert.match(r.out, /Not imported: the check found 1 error\(s\)/);
    assert.equal(await reportSource(), before, 'unchanged');
    assert.equal((await owner.one(`select count(*)::int as n from meta.app_backup b join meta.app a on a.id = b.app_id where a.alias = $1 and b.reason = 'import'`, [ALIAS])).n, 0, 'no backup left behind either');
  });

  test('--dry-run reports and never commits; --force imports despite errors; a clean --check imports', async () => {
    let r = cli('import', file('bad.json', withSource('select ename, nope from hr.emp')), '--replace', '--alias', ALIAS, '--dry-run');
    assert.equal(r.code, 1);
    assert.match(r.out, /column "nope" does not exist[\s\S]*Dry run: nothing was imported/);
    r = cli('import', file('good.json', withSource('select empno, ename from hr.emp')), '--replace', '--alias', ALIAS, '--dry-run');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Check: no problems found/);
    assert.notEqual(await reportSource(), 'select empno, ename from hr.emp');
    r = cli('import', file('bad.json', withSource('select * from hr.no_such_table')), '--replace', '--alias', ALIAS, '--check', '--force');
    assert.equal(r.code, 0, r.out);
    assert.equal(await reportSource(), 'select * from hr.no_such_table');
    r = cli('import', file('good.json', withSource('select empno, ename from hr.emp')), '--replace', '--alias', ALIAS, '--check');
    assert.equal(r.code, 0, r.out);
    assert.equal(await reportSource(), 'select empno, ename from hr.emp');
  });

  test('the MCP import checks by default', async () => {
    const { importDoc } = await import('../src/cli/apps.ts');
    const { withDb } = await import('../src/cli/apps.ts');
    const r = await withDb((db) => importDoc(db, withSource('select * from hr.missing_too'), { alias: ALIAS, replace: true, check: 'check', by: 'test' }));
    assert.equal(r.committed, false);
    assert.ok(r.findings.some((f) => f.severity === 'error' && /missing_too/.test(f.message)));
  });

  test('the builder\'s import checks unless unticked', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get('/builder/import');
    const bad = withSource('select * from hr.no_such_table');
    let res = await dev.submit('/builder/import', { doc: JSON.stringify(bad), alias: 'hr-deploy-b', check: 'true' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one(`select count(*)::int as n from meta.app where alias = 'hr-deploy-b'`)).n, 0);
    assert.match((await dev.get('/builder/import')).body, /the check found 1 error\(s\), nothing was imported: page 2, .*no_such_table/);
    res = await dev.submit('/builder/import', { doc: JSON.stringify(bad), alias: 'hr-deploy-b' });
    assert.equal((await owner.one(`select count(*)::int as n from meta.app where alias = 'hr-deploy-b'`)).n, 1);
    await owner.query(`delete from meta.app where alias = 'hr-deploy-b'`);
  });
});

describe('deployments: backups', () => {
  test('an import over the application backs up the version it replaces; restore brings it back (and backs up again)', async () => {
    const id = (await owner.one('select id from meta.app where alias = $1', [ALIAS])).id;
    await owner.query('delete from meta.app_backup where app_id = $1', [id]);
    const before = await reportSource();
    assert.equal(cli('import', file('next.json', withSource('select 1 as x')), '--replace', '--alias', ALIAS).code, 0);
    const b = await owner.one(`select * from meta.app_backup where app_id = $1 order by id desc limit 1`, [id]);
    assert.equal(b.reason, 'import');
    assert.match(b.created_by, /^pgkiln import \(/);
    assert.equal(b.doc.pages.find((p: any) => p.page_no === 2).regions.find((x: any) => x.type === 'report').source, before);

    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await dev.get(`/builder/apps/${id}/backups`)).body;
    assert.match(page, /before an import/);
    const dl = await dev.get(`/builder/apps/${id}/backups/${b.id}/download`);
    assert.equal(dl.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(JSON.parse(dl.body).format, 'pgkiln/2');
    await dev.submit(`/builder/apps/${id}/backups/${b.id}/restore`, {});
    assert.equal(await reportSource(), before, 'restored');
    const newest = await owner.one(`select reason, created_by from meta.app_backup where app_id = $1 order by id desc limit 1`, [id]);
    assert.deepEqual(newest, { reason: 'restore', created_by: 'admin' });
    assert.equal((await owner.one(`select count(*)::int as n from meta.activity_log where app_id = $1 and event = 'backup_restored'`, [id])).n, 1);
  });

  test('daily backups only when the application changed; the newest backups_keep are kept; 0 makes none', async () => {
    const { backupTick } = await import('../src/builder/backups.ts');
    const id = (await owner.one('select id from meta.app where alias = $1', [ALIAS])).id;
    await owner.query('delete from meta.app_backup where app_id = $1', [id]);
    await backupTick();
    assert.equal((await owner.one(`select count(*)::int as n from meta.app_backup where app_id = $1 and reason = 'daily'`, [id])).n, 1);
    // a day later, unchanged: none; changed: one
    await owner.query(`update meta.app_backup set created_at = created_at - interval '2 days' where app_id = $1`, [id]);
    await backupTick();
    assert.equal((await owner.one(`select count(*)::int as n from meta.app_backup where app_id = $1`, [id])).n, 1, 'unchanged: skipped');
    await owner.query(`update meta.app set name = name || ' (changed)' where id = $1`, [id]);
    await backupTick();
    assert.equal((await owner.one(`select count(*)::int as n from meta.app_backup where app_id = $1`, [id])).n, 2);
    await owner.query('update meta.app set backups_keep = 2 where id = $1', [id]);
    for (let i = 0; i < 3; i++) await owner.query(`select meta.backup_app($1, 'manual', 'test')`, [id]);
    assert.equal((await owner.one(`select count(*)::int as n from meta.app_backup where app_id = $1`, [id])).n, 2);
    await owner.query('update meta.app set backups_keep = 0 where id = $1', [id]);
    assert.equal((await owner.one(`select meta.backup_app($1, 'manual', 'test') as b`, [id])).b, null);
    await owner.query('update meta.app set backups_keep = 25 where id = $1', [id]);
  });
});

describe('deployments: availability and build status', () => {
  test('who may use the application', () => {
    const dev = { username: 'king', developer: true };
    const user = { username: 'king', developer: false };
    const anon = { username: null, developer: false };
    assert.equal(availabilityRefusal({ availability: 'available' }, anon), null);
    assert.equal(availabilityRefusal({ availability: 'unavailable' }, dev)?.status, 503, 'unavailable: also for developers');
    assert.equal(availabilityRefusal({ availability: 'unavailable', availability_message: 'Back at 2' }, user)?.message, 'Back at 2');
    assert.equal(availabilityRefusal({ availability: 'developers' }, dev), null);
    assert.equal(availabilityRefusal({ availability: 'developers' }, user)?.key, 'app.developers_only');
    assert.equal(availabilityRefusal({ availability: 'restricted', availability_users: ['KING'] }, user), null);
    assert.equal(availabilityRefusal({ availability: 'restricted', availability_users: ['scott'] }, user)?.status, 403);
    assert.equal(availabilityRefusal({ availability: 'restricted', availability_users: ['scott'] }, anon)?.signIn, true);
    assert.equal(availabilityRefusal({ availability: 'restricted', availability_users: [] }, dev), null);
  });

  test('pages follow the availability; developers with a builder session get through', async () => {
    const id = (await owner.one('select id from meta.app where alias = $1', [ALIAS])).id;
    await owner.query(`insert into meta.app_access (app_id, account_id, roles) select $1, account_id, roles from meta.app_access where app_id = (select id from meta.app where alias = 'hr') on conflict do nothing`, [id]);
    const user = new Browser(app);
    await user.login('king', 'king', ALIAS);
    assert.equal((await user.get(`/a/${ALIAS}/1`)).statusCode, 200);
    try {
      await owner.query(`update meta.app set availability = 'unavailable', availability_message = 'Upgrading; back at 14:00.' where id = $1`, [id]);
      let res = await user.get(`/a/${ALIAS}/1`);
      assert.equal(res.statusCode, 503);
      assert.match(res.body, /Upgrading; back at 14:00\./);
      assert.equal((await new Browser(app).get(`/a/${ALIAS}/login`)).statusCode, 503, 'no sign-in form either');

      await owner.query(`update meta.app set availability = 'developers', availability_message = null where id = $1`, [id]);
      res = await user.get(`/a/${ALIAS}/1`);
      assert.equal(res.statusCode, 503);
      assert.match(res.body, /available to its developers only/);
      const dev = new Browser(app);
      await dev.get('/builder/login');
      await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
      await dev.get('/builder');
      await dev.login('king', 'king', ALIAS);
      assert.equal((await dev.get(`/a/${ALIAS}/1`)).statusCode, 200);

      await owner.query(`update meta.app set availability = 'restricted', availability_users = '{scott}' where id = $1`, [id]);
      res = await user.get(`/a/${ALIAS}/1`);
      assert.equal(res.statusCode, 403);
      assert.match(res.body, /not available to your account/);
      await owner.query(`update meta.app set availability_users = '{KING}' where id = $1`, [id]);
      assert.equal((await user.get(`/a/${ALIAS}/1`)).statusCode, 200);
      // not signed in: sign in first
      res = await new Browser(app).get(`/a/${ALIAS}/1`);
      assert.equal(res.statusCode, 302);
      assert.match(String(res.headers.location), /\/login\?next=/);
    } finally {
      await owner.query(`update meta.app set availability = 'available', availability_users = '{}', availability_message = null where id = $1`, [id]);
    }
  });

  test('availability and build status are not exported and survive an import over the application', async () => {
    const id = (await owner.one('select id from meta.app where alias = $1', [ALIAS])).id;
    await owner.query(`update meta.app set availability = 'developers', build_status = 'run_only' where id = $1`, [id]);
    try {
      const d = (await owner.one(`select meta.export_app($1) as d`, [ALIAS])).d;
      assert.equal(d.app.availability, undefined);
      assert.equal(d.app.build_status, undefined);
      // a deployment: the command line imports over a Run only application
      assert.equal(cli('import', file('again.json', doc), '--replace', '--alias', ALIAS).code, 0);
      assert.deepEqual(await owner.one('select availability, build_status from meta.app where id = $1', [id]), { availability: 'developers', build_status: 'run_only' });
    } finally {
      await owner.query(`update meta.app set availability = 'available', build_status = 'run_and_build' where id = $1`, [id]);
    }
  });

  test('Run only: the builder refuses changes, except to the availability, backups, locks and comments', async () => {
    const id = (await owner.one('select id from meta.app where alias = $1', [ALIAS])).id;
    const page = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [id])).id;
    await owner.query(`update meta.app set build_status = 'run_only' where id = $1`, [id]);
    try {
      const dev = new Browser(app);
      await dev.get('/builder/login');
      await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
      const designer = (await dev.get(`/builder/pages/${page}`)).body;
      assert.match(designer, /The application is Run only/);
      const name = (await owner.one('select name from meta.page where id = $1', [page])).name;
      await dev.submit(`/builder/pages/${page}`, { page_no: '1', name: 'Changed', mode: 'normal', protection: 'checksum' });
      assert.equal((await owner.one('select name from meta.page where id = $1', [page])).name, name, 'refused');
      assert.match((await dev.get(`/builder/apps/${id}`)).body, /Run only/);
      // a backup may be made; the availability may be changed back
      await dev.submit(`/builder/apps/${id}/backups`, { note: 'while run only' });
      assert.equal((await owner.one(`select count(*)::int as n from meta.app_backup where app_id = $1 and note = 'while run only'`, [id])).n, 1);
      await dev.get(`/builder/apps/${id}/availability`);
      await dev.submit(`/builder/apps/${id}/availability`, { availability: 'available', build_status: 'run_and_build' });
      assert.equal((await owner.one('select build_status from meta.app where id = $1', [id])).build_status, 'run_and_build');
      assert.equal((await owner.one(`select count(*)::int as n from meta.activity_log where app_id = $1 and event = 'availability'`, [id])).n, 1);
    } finally {
      await owner.query(`update meta.app set build_status = 'run_and_build' where id = $1`, [id]);
    }
  });
});
