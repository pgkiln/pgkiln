// Page groups (sprint 58, migration 089): Shared Components → Page groups,
// the page attribute, the App Builder's page list by group, renaming and
// deleting a group, export and import, the Advisor.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise } from '../src/builder/advisor.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let appId: number;
let savedGroups: { page_no: number; page_group: string | null }[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`delete from meta.page_group where app_id = $1 and name like 'PG test%'`, [appId]);
  savedGroups = (await owner.query('select page_no, page_group from meta.page where app_id = $1', [appId])).rows;
});
after(async () => {
  await owner.query(`delete from meta.page_group where app_id = $1 and name like 'PG test%'`, [appId]);
  for (const p of savedGroups) await owner.query('update meta.page set page_group = $3 where app_id = $1 and page_no = $2', [appId, p.page_no, p.page_group]);
  await app.close();
  await closePools();
});

describe('page groups', () => {
  test('created in Shared Components; pages join them; the page list shows and filters them', async () => {
    await dev.get(`/builder/apps/${appId}/shared?new=page_group`);
    const res = await dev.submit(`/builder/apps/${appId}/shared/page_group`, { name: 'PG test admin', description: 'Administration pages' });
    assert.equal(res.statusCode, 303);
    assert.ok(await owner.one(`select 1 from meta.page_group where app_id = $1 and name = 'PG test admin'`, [appId]));
    const page9 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 9', [appId])).id;
    // the Page Designer offers the group
    const designer = (await dev.get(`/builder/pages/${page9}`)).body;
    assert.match(designer, /<option value="PG test admin">PG test admin<\/option>/);
    await owner.query(`update meta.page set page_group = 'PG test admin' where app_id = $1 and page_no in (9, 10)`, [appId]);
    const list = (await dev.get(`/builder/apps/${appId}`)).body;
    assert.match(list, /<th>Group<\/th>/);
    assert.match(list, /<option value="PG test admin">PG test admin<\/option>/);
    const filtered = (await dev.get(`/builder/apps/${appId}?group=${encodeURIComponent('PG test admin')}`)).body;
    const rows = [...filtered.matchAll(/<tr>\s*<td class="num">(\d+)<\/td>/g)].map((m) => Number(m[1]));
    assert.deepEqual(rows, [9, 10]);
    const none = (await dev.get(`/builder/apps/${appId}?group=-`)).body;
    const ungrouped = [...none.matchAll(/<tr>\s*<td class="num">(\d+)<\/td>/g)].map((m) => Number(m[1]));
    assert.ok(ungrouped.includes(1) && !ungrouped.includes(9) && !ungrouped.includes(10));
  });

  test('renaming a group renames it on its pages; deleting it takes them out', async () => {
    await owner.query(`update meta.page_group set name = 'PG test administration' where app_id = $1 and name = 'PG test admin'`, [appId]);
    assert.equal((await owner.one(`select page_group from meta.page where app_id = $1 and page_no = 9`, [appId])).page_group, 'PG test administration');
    const exported = (await owner.one(`select meta.export_app('hr') as doc`)).doc;
    assert.ok(exported.page_groups.some((g: { name: string }) => g.name === 'PG test administration'));
    const copy = (await owner.one(`select meta.import_app($1::jsonb, 'hr_pg_copy') as id`, [JSON.stringify(exported)])).id;
    try {
      assert.equal((await owner.one(`select page_group from meta.page where app_id = $1 and page_no = 9`, [copy])).page_group, 'PG test administration');
      assert.ok(await owner.one(`select 1 from meta.page_group where app_id = $1 and name = 'PG test administration'`, [copy]));
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy]);
    }
    await owner.query(`delete from meta.page_group where app_id = $1 and name = 'PG test administration'`, [appId]);
    assert.equal((await owner.one(`select page_group from meta.page where app_id = $1 and page_no = 9`, [appId])).page_group, null);
  });

  test('the Advisor reports a page in a group that doesn\'t exist; names are checked', async () => {
    await owner.query(`update meta.page set page_group = 'PG test ghost' where app_id = $1 and page_no = 9`, [appId]);
    const { findings } = await advise(appId);
    assert.ok(findings.some((f) => /Page group PG test ghost doesn't exist/.test(f.message)));
    await owner.query(`update meta.page set page_group = null where app_id = $1 and page_no = 9`, [appId]);
    await assert.rejects(owner.query(`insert into meta.page_group (app_id, name) values ($1, '<script>')`, [appId]), /check/);
  });
});
