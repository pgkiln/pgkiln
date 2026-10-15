// The page designer's Comment Out and its gallery labels (sprint 90, parity handoff PD-4): a component is
// left out of the page by the build option COMMENTED_OUT (made with the status Exclude when first needed),
// and the gallery's labels are in title case like APEX's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pid: number;
let region: number;
let item: number;
const PAGE_NO = 9390;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  await owner.query(`delete from meta.build_option where app_id = $1 and name = 'COMMENTED_OUT'`, [appId]);
  pid = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Comment test') returning id`, [appId, PAGE_NO])).id;
  region = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Shown region', 'static', '<p>visible text</p>') returning id`, [pid])).id;
  item = (await owner.one(`insert into meta.item (page_id, region_id, seq, name, label) values ($1, $2, 10, 'P9390_NAME', 'Name') returning id`, [pid, region])).id;
});
after(async () => {
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [appId, PAGE_NO]);
  await owner.query(`delete from meta.build_option where app_id = $1 and name = 'COMMENTED_OUT'`, [appId]);
  await app.close();
  await closePools();
});

const developer = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
};

describe('Comment Out', () => {
  test('a region is left out of the page and struck through in the tree; Uncomment brings it back', async () => {
    const b = await developer();
    await b.get(`/builder/apps/${appId}/pages/${PAGE_NO}`);
    let res = await b.submit(`/builder/pages/${pid}/layout/comment`, { kind: 'region', id: String(region), on: 'true' });
    assert.equal(res.statusCode, 303);
    const opt = await owner.one(`select status from meta.build_option where app_id = $1 and name = 'COMMENTED_OUT'`, [appId]);
    assert.equal(opt.status, 'exclude', 'made when first needed');
    assert.equal((await owner.one('select build_option from meta.region where id = $1', [region])).build_option, 'COMMENTED_OUT');
    const designer = (await b.get(`/builder/apps/${appId}/pages/${PAGE_NO}`)).body;
    assert.match(designer, new RegExp(`data-kind="region" data-id="${region}"[^>]*data-commented>`));
    const king = new Browser(app);
    await king.login('king');
    assert.doesNotMatch((await king.get(`/a/hr/${PAGE_NO}`)).body, /visible text/);
    // an item too; Uncomment only clears COMMENTED_OUT
    await b.submit(`/builder/pages/${pid}/layout/comment`, { kind: 'item', id: String(item), on: 'true' });
    assert.equal((await owner.one('select build_option from meta.item where id = $1', [item])).build_option, 'COMMENTED_OUT');
    res = await b.submit(`/builder/pages/${pid}/layout/comment`, { kind: 'region', id: String(region), on: 'false' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select build_option from meta.region where id = $1', [region])).build_option, null);
    assert.match((await king.get(`/a/hr/${PAGE_NO}`)).body, /visible text/);
    await owner.query(`update meta.item set build_option = 'LEAVE_FORECAST' where id = $1`, [item]);
    await b.submit(`/builder/pages/${pid}/layout/comment`, { kind: 'item', id: String(item), on: 'false' });
    assert.equal((await owner.one('select build_option from meta.item where id = $1', [item])).build_option, 'LEAVE_FORECAST', 'another build option stays');
    await owner.query('update meta.item set build_option = null where id = $1', [item]);
  });

  test('only components of the page, of a kind with a build option; developers with the token', async () => {
    const b = await developer();
    await b.get(`/builder/apps/${appId}/pages/${PAGE_NO}`);
    const other = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 1 limit 1`, [appId])).id;
    assert.equal((await b.submit(`/builder/pages/${pid}/layout/comment`, { kind: 'region', id: String(other), on: 'true' })).statusCode, 404);
    assert.equal((await owner.one('select build_option from meta.region where id = $1', [other])).build_option, null);
    assert.equal((await b.submit(`/builder/pages/${pid}/layout/comment`, { kind: 'page', id: String(pid), on: 'true' })).statusCode, 400);
    assert.equal((await b.submit(`/builder/pages/${pid}/layout/comment`, { kind: 'region; drop table x', id: String(region) })).statusCode, 400);
    assert.equal((await b.post(`/builder/pages/${pid}/layout/comment`, { __csrf: 'forged', kind: 'region', id: String(region) })).statusCode, 403);
    const king = new Browser(app);
    await king.login('king');
    assert.equal((await king.post(`/builder/pages/${pid}/layout/comment`, { __csrf: king.lastCsrf, kind: 'region', id: String(region) })).headers.location, '/builder/login');
  });
});

describe('the gallery', () => {
  test('labels in title case, like APEX\'s', async () => {
    const b = await developer();
    const page = (await b.get(`/builder/apps/${appId}/pages/${PAGE_NO}`)).body;
    for (const label of ['Interactive Report', 'Faceted Search', 'Region Display Selector', 'Login', 'Text Field', 'Select List', 'Popup LOV', 'Submit Page'])
      assert.match(page, new RegExp(`class="pd-gal"[^>]*>[\\s\\S]{0,400}?<span>${label.replace(/[()]/g, '\\$&')}</span>`), label);
    assert.match(page, /title="Region Display Selector: drag onto the layout, or open to create"/, 'the full name as a tooltip');
  });
});
