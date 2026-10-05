// Working copies (src/workingcopy.ts, src/builder/workingcopies.ts): making a
// copy, the three-way comparison per component, merging into the main
// application, refreshing the copy, conflicts and the builder pages.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { compare, componentOf, createCopy, deleteCopy, describe as describeComponent, fingerprint, mergeCopy, WorkingCopyError } from '../src/workingcopy.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let mainId: number;

const MAIN = 'wc-main';
const lovQuery = async (appId: number, name: string) => (await owner.one('select query from meta.lov where app_id = $1 and name = $2', [appId, name]))?.query;
const setLov = (appId: number, name: string, query: string) => owner.query('update meta.lov set query = $3 where app_id = $1 and name = $2', [appId, name, query]);
const pageName = async (appId: number, no: number) => (await owner.one('select name from meta.page where app_id = $1 and page_no = $2', [appId, no]))?.name;
const setPageName = (appId: number, no: number, name: string) => owner.query('update meta.page set name = $3 where app_id = $1 and page_no = $2', [appId, no, name]);
const merge = async (copyId: number, direction: 'merge' | 'refresh', takeCopy: string[] = []) => {
  const l = (await compare(copyId))!;
  return mergeCopy(copyId, { direction, takeCopy: new Set(takeCopy), state: fingerprint(l.changes), username: 'admin' });
};

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  await owner.query('delete from meta.app where alias like $1', [`${MAIN}%`]);
  mainId = (await owner.one(`select meta.import_app(meta.export_app('hr'), $1) as id`, [MAIN])).id;
  await owner.query(`update meta.automation set enabled = true where app_id = $1`, [mainId]);
  await owner.query(`insert into meta.app_access (app_id, account_id, roles) select $1, id, '{}' from meta.account order by id limit 1`, [mainId]);
});
after(async () => {
  await owner.query('delete from meta.app where alias like $1', [`${MAIN}%`]);
  await app.close();
  await closePools();
});

describe('working copy components', () => {
  test('files group into components; sequence prefixes and page names do not count', () => {
    assert.equal(componentOf('app.json'), 'app');
    assert.equal(componentOf('app.pwa_icon.png'), 'app');
    assert.equal(componentOf('shared/lovs/departments.json'), 'shared/lovs/departments');
    assert.equal(componentOf('shared/lovs/departments.query.sql'), 'shared/lovs/departments');
    assert.equal(componentOf('pages/0010/regions/0020-employees.source.sql'), 'pages/0010/regions/employees');
    assert.equal(componentOf('pages/0010/regions/0030-employees.json'), 'pages/0010/regions/employees');
    assert.equal(componentOf('shared/app-processes/m0005-init.json'), 'shared/app-processes/init');
    assert.equal(componentOf('shared/lovs/2024-codes.json'), 'shared/lovs/2024-codes', 'named components keep their whole key');
    assert.deepEqual(describeComponent('pages/0010/regions/employees'), { label: 'Page 10 › region employees', page: 10 });
    assert.deepEqual(describeComponent('pages/0010/page'), { label: 'Page 10', page: 10 });
    assert.deepEqual(describeComponent('shared/lovs/departments'), { label: 'List of values departments', page: null });
  });
});

describe('working copies', () => {
  test('a new copy equals its main application and keeps its own switches', async () => {
    const id = await createCopy(mainId, 'fresh', 'admin');
    try {
      const l = (await compare(id))!;
      assert.deepEqual(l.changes.map((c) => c.id), [], 'nothing differs right after copying');
      const copy = await owner.one('select alias, name from meta.app where id = $1', [id]);
      assert.equal(copy.alias, `${MAIN}-fresh`);
      assert.equal((await owner.one('select count(*)::int as n from meta.automation where app_id = $1 and enabled', [id])).n, 0, 'a copy runs no automations');
      assert.equal(
        (await owner.one('select count(*)::int as n from meta.app_access where app_id = $1', [id])).n,
        (await owner.one('select count(*)::int as n from meta.app_access where app_id = $1', [mainId])).n,
        'the same people may run the copy',
      );
    } finally {
      await deleteCopy(id);
    }
  });

  test('changes on either side merge; the main application keeps its installation state', async () => {
    const id = await createCopy(mainId, 'feature', 'admin');
    try {
      await setLov(id, 'JOBS', 'select job_title as d, job_id as r from hr.job order by 1 -- copy');
      await setPageName(mainId, 2, 'Staff');
      const l = (await compare(id))!;
      const byId = new Map(l.changes.map((c) => [c.id, c]));
      assert.equal(byId.get('shared/lovs/jobs')?.status, 'copy');
      assert.equal(byId.get('shared/lovs/jobs')?.inCopy, 'changed');
      assert.equal(byId.get('pages/0002/page')?.status, 'main');
      assert.equal(l.changes.filter((c) => c.status === 'conflict').length, 0);

      const r = await merge(id, 'merge');
      assert.equal(r.mainId, mainId);
      assert.match(await lovQuery(mainId, 'JOBS'), /-- copy$/, "the copy's change reached the main application");
      assert.equal(await pageName(mainId, 2), 'Staff', "the main application's own change stays");
      assert.equal(await pageName(id, 2), 'Staff', 'the copy now holds the merged result');
      assert.deepEqual((await compare(id))!.changes, [], 'nothing left to merge');
      assert.ok((await owner.one('select count(*)::int as n from meta.automation where app_id = $1 and enabled', [mainId])).n > 0, 'automation switches kept');
      assert.ok((await owner.one('select count(*)::int as n from meta.app_access where app_id = $1', [mainId])).n > 0, 'access kept');
      assert.equal((await owner.one('select alias from meta.app where id = $1', [mainId])).alias, MAIN);
      assert.ok((await owner.one('select merged_at from meta.working_copy where app_id = $1', [id])).merged_at);
    } finally {
      await deleteCopy(id);
    }
  });

  test('a conflict is resolved per component; refresh brings main changes into the copy only', async () => {
    const id = await createCopy(mainId, 'conflict', 'admin');
    try {
      await setLov(id, 'DEPARTMENTS', 'select 1 as d, 1 as r -- copy');
      await setLov(mainId, 'DEPARTMENTS', 'select 2 as d, 2 as r -- main');
      await setPageName(mainId, 4, 'Teams');
      const l = (await compare(id))!;
      const conflict = l.changes.find((c) => c.id === 'shared/lovs/departments')!;
      assert.equal(conflict.status, 'conflict');

      // refresh keeping the copy's version: main untouched, copy gets main's page change
      await merge(id, 'refresh', ['shared/lovs/departments']);
      assert.match(await lovQuery(mainId, 'DEPARTMENTS'), /-- main$/);
      assert.match(await lovQuery(id, 'DEPARTMENTS'), /-- copy$/);
      assert.equal(await pageName(id, 4), 'Teams');
      const after = (await compare(id))!.changes;
      assert.deepEqual(after.map((c) => [c.id, c.status]), [['shared/lovs/departments', 'copy']], 'after a refresh only the copy’s own change is left');

      // a stale comparison is refused
      await assert.rejects(
        mergeCopy(id, { direction: 'merge', takeCopy: new Set(), state: 'stale', username: 'admin' }),
        (e) => e instanceof WorkingCopyError && /changed in the meantime/.test(e.message),
      );
      // a lock on the target is refused
      await assert.rejects(
        mergeCopy(id, { direction: 'merge', takeCopy: new Set(), state: fingerprint(after), username: 'admin', lockedBy: async (appId, pages) => (appId === mainId && pages.has(0) ? 'locked' : null) }),
        (e) => e instanceof WorkingCopyError && e.message === 'locked',
      );
      await merge(id, 'merge');
      assert.match(await lovQuery(mainId, 'DEPARTMENTS'), /-- copy$/);
    } finally {
      await deleteCopy(id);
    }
  });

  test('names, nesting and duplicates are refused; deleting a copy leaves the main application', async () => {
    await assert.rejects(createCopy(mainId, '../x', 'admin'), WorkingCopyError);
    await assert.rejects(createCopy(mainId, '', 'admin'), WorkingCopyError);
    const id = await createCopy(mainId, 'one', 'admin');
    try {
      await assert.rejects(createCopy(mainId, 'ONE', 'admin'), /already a working copy/);
      await assert.rejects(createCopy(id, 'nested', 'admin'), /is a working copy/);
      await assert.rejects(owner.query('insert into meta.working_copy (app_id, main_app_id, name, base, created_by) values ($1, $2, $3, $4, $5)', [mainId, id, 'x', '{"format":"pgapex/2"}', 'admin']), /working copy/);
    } finally {
      assert.ok(await deleteCopy(id));
    }
    assert.equal(await deleteCopy(mainId), false, 'only copies are deleted this way');
    assert.ok(await owner.one('select 1 from meta.app where id = $1', [mainId]));
  });
});

describe('working copies in the builder', () => {
  test('create, compare with differences, merge with a conflict choice, delete', async () => {
    let page = await dev.get(`/builder/apps/${mainId}/working-copies`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /No working copies/);
    let res = await dev.submit('/builder/working-copies', { main_app_id: String(mainId), name: 'ui' });
    assert.equal(res.statusCode, 303);
    const id = (await owner.one(`select app_id from meta.working_copy where main_app_id = $1 and name = 'ui'`, [mainId])).app_id;
    try {
      page = await dev.get(`/builder/apps/${mainId}/working-copies`);
      assert.match(page.body, new RegExp(`/builder/apps/${id}/compare`));
      assert.match((await dev.get(`/builder/apps/${id}/working-copies`)).body, /This application is the working copy/);
      assert.match((await dev.get(`/builder/apps/${id}/compare`)).body, /nothing to merge/);

      await setLov(id, 'JOBS', 'select 1 as d, 1 as r -- ui copy');
      await setLov(mainId, 'JOBS', 'select 1 as d, 1 as r -- ui main');
      page = await dev.get(`/builder/apps/${id}/compare?c=${encodeURIComponent('shared/lovs/jobs')}`);
      assert.match(page.body, /1 conflict\b/);
      assert.match(page.body, /name="r_0" value="copy" required/);
      assert.match(page.body, /<pre class="code-block diff">--- main\/shared\/lovs\/jobs.json/);
      assert.match(page.body, /\+  &quot;query&quot;: &quot;select 1 as d, 1 as r -- ui copy&quot;/);

      const state = /name="state" value="([0-9a-f]+)"/.exec(page.body)![1];
      res = await dev.submit(`/builder/apps/${id}/merge`, { state, direction: 'merge' });
      assert.equal(res.statusCode, 303, 'a missing conflict choice goes back with a message');
      assert.match(await lovQuery(mainId, 'JOBS'), /-- ui main$/);
      res = await dev.submit(`/builder/apps/${id}/merge`, { state, direction: 'merge', r_0: 'copy' });
      assert.equal(res.headers.location, `/builder/apps/${mainId}`);
      assert.match(await lovQuery(mainId, 'JOBS'), /-- ui copy$/);
      assert.ok(await owner.one(`select 1 from meta.activity_log where app_id = $1 and event = 'working_copy' and detail like 'merged ui%'`, [mainId]));

      res = await dev.submit(`/builder/apps/${id}/working-copy/delete`, {});
      assert.equal(res.headers.location, `/builder/apps/${mainId}/working-copies`);
      assert.equal(await owner.one('select 1 from meta.app where id = $1', [id]), undefined);
    } finally {
      await deleteCopy(id);
    }
  });
});
