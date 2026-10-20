// Sprint 116 (WS-12): the App Builder list shows who changed an application
// last (meta.app_change, migration 125), its number of working copies and the
// application lock, in the report and in the cards.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const alias = 'applist-116';
const DEV = 'dev_applist116';
const DEV_PW = 'Dev-applist-116-password!';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias like 'applist-116%'`);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  await owner.query(`insert into meta.workspace_member (workspace_id, username) values (1, $1) on conflict do nothing`, [DEV]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'App list 116', 'none') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
});

after(async () => {
  await owner.query(`delete from meta.app where alias like 'applist-116%'`);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
  await app.close();
  await closePools();
});

const builder = async (user = 'admin', password = 'admin') => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: user, password })).statusCode, 303, `builder sign-in as ${user}`);
  await b.get('/builder');
  return b;
};
const changedBy = async (id = appId) => (await owner.one<{ updated_by: string }>('select updated_by from meta.app_change where app_id = $1', [id]))?.updated_by;
const addRegion = (b: Browser, title: string) => b.submit(`/builder/pages/${pageId}/c/region`, { title, type: 'static', columns: '12', template: 'standard', config: '' });
/** The row of the test application in the App Builder report. */
const reportRow = async (b: Browser) => {
  const body = (await b.get(`/builder/apps?q=${alias}&view=report`)).body;
  const row = new RegExp(`<tr data-filter-row>\\s*<td class="num">${appId}</td>[\\s\\S]*?</tr>`).exec(body);
  assert.ok(row, 'the application is listed');
  return { body, row: row[0] };
};

describe('App Builder list: updated by, working copies, lock (WS-12)', () => {
  test('a change in the builder records the developer; the list shows it', async () => {
    const admin = await builder();
    assert.equal(await changedBy(), undefined);
    const { body } = await reportRow(admin);
    assert.match(body, /<th scope="col">Updated by<\/th><th scope="col" class="num">Working copies<\/th>/);
    await admin.get(`/builder/pages/${pageId}`);
    assert.equal((await addRegion(admin, 'By admin')).statusCode, 303);
    assert.equal(await changedBy(), 'admin');
    const { row } = await reportRow(admin);
    assert.match(row, /<td class="ab-by">admin<\/td>/);
    assert.match(row, /<td class="num">0<\/td>/, 'no working copies yet');
    assert.doesNotMatch(row, /ab-lock/);
    // another developer's change takes over
    const dev = await builder(DEV, DEV_PW);
    await dev.get(`/builder/pages/${pageId}`);
    assert.equal((await addRegion(dev, 'By dev')).statusCode, 303);
    assert.equal(await changedBy(), DEV);
    assert.match((await reportRow(admin)).row, new RegExp(`<td class="ab-by">${DEV}</td>`));
  });

  test('locks and comments are not changes; a refused change is not recorded', async () => {
    const admin = await builder();
    const dev = await builder(DEV, DEV_PW);
    await owner.query(`update meta.app_change set updated_by = 'someone' where app_id = $1`, [appId]);
    await admin.get(`/builder/apps/${appId}`);
    assert.equal((await admin.submit(`/builder/apps/${appId}/lock`, { page_no: '0', note: 'release' })).statusCode, 303);
    assert.equal((await admin.submit(`/builder/apps/${appId}/comments`, { page_no: '0', body: 'a note' })).statusCode, 303);
    assert.equal(await changedBy(), 'someone');
    // the other developer is refused by the lock
    await dev.get(`/builder/pages/${pageId}`);
    await addRegion(dev, 'Refused');
    assert.equal(await owner.one(`select 1 from meta.region where page_id = $1 and title = 'Refused'`, [pageId]), undefined);
    assert.equal(await changedBy(), 'someone');
    // the list shows the lock and its owner, in the report and in the cards
    const { row } = await reportRow(dev);
    assert.match(row, /<span class="ab-lock" role="img" aria-label="Locked by admin" title="Locked by admin"><svg/);
    const cards = (await dev.get(`/builder/apps?q=${alias}&view=grid`)).body;
    assert.match(cards, /<span class="tag ab-locked" title="Locked by admin">[\s\S]*?Locked by admin<\/span><\/span>/);
    await admin.get(`/builder/apps/${appId}`);
    assert.equal((await admin.submit(`/builder/apps/${appId}/unlock`, { page_no: '0' })).statusCode, 303);
    assert.doesNotMatch((await reportRow(dev)).row, /ab-lock/);
    await dev.get('/builder/apps?view=report');
  });

  test('working copies: counted on the main application, linked; the copy records its creator', async () => {
    const dev = await builder(DEV, DEV_PW);
    await dev.get(`/builder/apps/${appId}/working-copies`);
    assert.equal((await dev.submit('/builder/working-copies', { main_app_id: String(appId), name: 'one' })).statusCode, 303);
    const copy = (await owner.one(`select id from meta.app where alias = $1`, [`${alias}-one`])).id;
    assert.equal(await changedBy(copy), DEV);
    // a second copy with the same name is refused (an error message): nothing recorded
    await owner.query(`delete from meta.app_change where app_id = $1`, [appId]);
    await dev.get(`/builder/apps/${appId}/working-copies`);
    assert.equal((await dev.submit('/builder/working-copies', { main_app_id: String(appId), name: 'one' })).statusCode, 303);
    assert.equal(await changedBy(), undefined);
    const { row } = await reportRow(dev);
    assert.match(row, new RegExp(`<td class="num"><a href="/builder/apps/${appId}/working-copies" aria-label="1 working copy of App list 116">1</a></td>`));
    const cards = (await dev.get(`/builder/apps?q=${alias}&view=grid`)).body;
    assert.match(cards, new RegExp(`<a class="tag" href="/builder/apps/${appId}/working-copies"><svg[^]*?</svg> 1 working copy</a>`));
    await dev.get('/builder/apps?view=report');
  });

  test('an import records the developer who imported; the record is not exported', async () => {
    const admin = await builder();
    const doc = (await owner.one(`select meta.export_app($1) as d`, [alias])).d;
    assert.doesNotMatch(JSON.stringify(doc), /app_change|updated_by/);
    await admin.get('/builder/import');
    assert.equal((await admin.submit('/builder/import', { doc: JSON.stringify(doc), alias: `${alias}-imp`, check: '' })).statusCode, 303);
    const imp = (await owner.one(`select id from meta.app where alias = $1`, [`${alias}-imp`])).id;
    assert.equal(await changedBy(imp), 'admin');
    // the Updated column follows the last change; sorting by it puts the import first
    const body = (await admin.get(`/builder/apps?q=${alias}&view=report&sort=updated`)).body;
    assert.ok(body.indexOf(`<td class="num">${imp}</td>`) < body.indexOf(`<td class="num">${appId}</td>`));
    await admin.get('/builder/apps?view=report&sort=name');
  });
});
