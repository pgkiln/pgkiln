// Developer toolbar and session state viewer (migration 079).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const DEV = 'devbar_dev';
const DEV_PW = 'Devbar-test-password!';

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false) on conflict do nothing`, [DEV, DEV_PW]);
  await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
});

after(async () => {
  await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
  await owner.query('delete from meta.session where username = $1 and app_id is null', [DEV]);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await app.close();
  await closePools();
});

/** A browser signed in to the builder and to the HR application. */
async function developerBrowser(user = 'admin', password = 'admin') {
  const b = new Browser(app);
  await b.get('/builder/login');
  const res = await b.submit('/builder/login', { username: user, password });
  assert.equal(res.statusCode, 303);
  await b.get('/builder');
  await b.login('king');
  return b;
}

describe('developer toolbar', () => {
  test('a builder session gets a separate toolbar cookie for /a; the app\'s pages show the toolbar', async () => {
    const b = await developerBrowser();
    const token = b.cookies.get('pgkiln_devbar');
    assert.ok(token, 'a toolbar cookie');
    assert.notEqual(token, b.cookies.get('pgkiln_dev'), 'not the builder session\'s token');
    const page = (await b.get('/a/hr/1')).body;
    assert.match(page, /<details class="devbar" open>/);
    const pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId])).id;
    assert.match(page, new RegExp(`href="/builder/pages/${pageId}">Edit page 1</a>`));
    assert.match(page, new RegExp(`href="/builder/apps/${appId}">Application ${appId}</a>`));
    assert.match(page, /href="\/a\/hr\/1\/devbar\/session">Session<\/a>/);
    // not in a dialog
    assert.doesNotMatch((await b.get('/a/hr/7?dialog=1')).body, /class="devbar"/);
  });

  test('without a builder session, or after signing out of the builder, there is no toolbar', async () => {
    const user = new Browser(app);
    await user.login('king');
    assert.doesNotMatch((await user.get('/a/hr/1')).body, /class="devbar"/);
    assert.equal((await user.get('/a/hr/1/devbar/session')).statusCode, 404);

    const b = await developerBrowser();
    const token = b.cookies.get('pgkiln_devbar')!;
    await b.get('/builder');
    await b.submit('/builder/logout', {});
    assert.equal(b.cookies.get('pgkiln_devbar'), undefined, 'the cookie is cleared');
    // the old token is worthless too
    user.cookies.set('pgkiln_devbar', token);
    assert.doesNotMatch((await user.get('/a/hr/1')).body, /class="devbar"/);
  });

  test('a developer sees the toolbar only on applications of their workspaces', async () => {
    const b = await developerBrowser(DEV, DEV_PW);
    assert.ok(b.cookies.get('pgkiln_devbar'));
    assert.doesNotMatch((await b.get('/a/hr/1')).body, /class="devbar"/);
    const ws = (await owner.one('select meta.app_workspace($1) as ws', [appId])).ws;
    await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [ws, DEV]);
    assert.match((await b.get('/a/hr/1')).body, /class="devbar"/);
  });

  test('the session state viewer shows items (never passwords) and clears a page\'s items', async () => {
    const b = await developerBrowser();
    await b.get('/a/hr/2');
    const viewer = await b.get('/a/hr/3/devbar/session');
    assert.equal(viewer.statusCode, 200);
    assert.match(viewer.body, /<h1>Session state<\/h1>/);
    assert.match(viewer.body, /<code>P3_EMPNO<\/code>/);
    assert.match(viewer.body, /<dt>User<\/dt><dd>king<\/dd>/);
    // a password item's value is never shown
    const pw = await owner.one(`insert into meta.item (page_id, seq, name, type) select id, 999, 'P3_DEVBAR_PW', 'password' from meta.page where app_id = $1 and page_no = 3 returning id`, [appId]);
    try {
      await owner.query(`update meta.session set state = state || '{"P3_DEVBAR_PW": "s3cret", "P3_ENAME": "SMITH"}' where app_id = $1 and username = 'king'`, [appId]);
      const body = (await b.get('/a/hr/3/devbar/session')).body;
      assert.doesNotMatch(body, /s3cret/);
      assert.match(body, /\(set, not shown\)/);
      assert.match(body, /<code>SMITH<\/code>/);
      // internal values (__CSRF, __FLASH, …) are left out
      assert.doesNotMatch(body, /<code>__/);
      const csrf = /name="__csrf" value="([^"]+)"/.exec(body)![1];
      const res = await b.post('/a/hr/3/devbar/clear', { __csrf: csrf });
      assert.equal(res.statusCode, 303);
      const state = (await owner.one(`select state from meta.session where app_id = $1 and username = 'king' order by last_seen desc limit 1`, [appId])).state;
      assert.equal(state.P3_ENAME, undefined);
      assert.equal(state.P3_DEVBAR_PW, undefined);
    } finally {
      await owner.query('delete from meta.item where id = $1', [pw.id]);
    }
  });

  test('debug messages for this session only', async () => {
    const b = await developerBrowser();
    const page = (await b.get('/a/hr/1')).body;
    const csrf = /class="devbar-debug">\s*<input type="hidden" name="__csrf" value="([^"]+)"/.exec(page)![1];
    const sessionId = (await owner.one(`select id from meta.session where app_id = $1 and username = 'king' order by last_seen desc limit 1`, [appId])).id;
    const before = (await owner.one('select count(*)::int as n from meta.debug_view where session_id = $1', [sessionId])).n;
    let res = await b.post('/a/hr/1/devbar/debug', { __csrf: csrf, level: '6' });
    assert.equal(res.statusCode, 303);
    assert.match((await b.get('/a/hr/1')).body, /<option value="6" selected>/);
    // the request was recorded (the log is stored after the response)
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await owner.one('select count(*)::int as n from meta.debug_view where session_id = $1', [sessionId])).n > before);
    // another user's session is not recorded
    const other = new Browser(app);
    await other.login('blake');
    await other.get('/a/hr/1');
    const blake = (await owner.one(`select id from meta.session where app_id = $1 and username = 'blake' order by last_seen desc limit 1`, [appId])).id;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await owner.one('select count(*)::int as n from meta.debug_view where session_id = $1', [blake])).n, 0);
    // a forged token or level is refused or ignored
    assert.equal((await b.post('/a/hr/1/devbar/debug', { __csrf: 'forged', level: '9' })).statusCode, 403);
    res = await b.post('/a/hr/1/devbar/debug', { __csrf: csrf, level: '0' });
    assert.match((await b.get('/a/hr/1')).body, /<option value="0" selected>/);
  });
});

describe('Quick edit and the Page Designer\'s help pane (sprint 59)', () => {
  test('the toolbar offers Quick edit; an item or button is found by its name', async () => {
    const b = await developerBrowser();
    const page3 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 3', [appId])).id;
    assert.match((await b.get('/a/hr/1')).body, /<button type="button" class="devbar-quick" data-quick-edit="\/builder\/pages\/\d+" aria-pressed="false" hidden>Quick edit<\/button>/);
    const item = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P3_SAL'`, [page3])).id;
    const toItem = await b.get(`/builder/pages/${page3}/quick?item=p3_sal`);
    assert.equal(toItem.headers.location, `/builder/pages/${page3}?c=item-${item}`);
    const button = (await owner.one(`select id, name from meta.button where page_id = $1 order by id limit 1`, [page3]));
    assert.equal((await b.get(`/builder/pages/${page3}/quick?button=${button.name}`)).headers.location, `/builder/pages/${page3}?c=button-${button.id}`);
    assert.equal((await b.get(`/builder/pages/${page3}/quick?item=NOPE`)).headers.location, `/builder/pages/${page3}`);
  });

  test('the property editor has a help pane, every property is named, the guide section follows the type', async () => {
    const b = await developerBrowser();
    const region = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.type = 'grid' limit 1`, [appId]);
    const body = (await b.get(`/builder/pages/${region.page_id}?c=region-${region.id}`)).body;
    assert.match(body, /<details class="pe-help" open data-guide="https:\/\/pgkiln\.vargar\.eu\/docs\/pages-and-regions#grid-interactive-grid">/);
    assert.match(body, /<div class="pe-help-body" aria-live="polite" data-pe-help>/);
    assert.match(body, /<div class="field" data-prop="title">/);
    assert.match(body, /<div class="field" data-prop="source"/);
  });
});

