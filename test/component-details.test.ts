// Sprint 115 (WS-11, migration 124): APEX 26.1 component details. The popup LOV's dialog
// loads page after page as it scrolls (the search endpoint pages; app.js scrolls), the
// dynamic actions wait_popup / remove_wait_popup, and menu entries that run dynamic
// actions of event menu_entry. HR page 47 (examples/hr/hr_68_component_details.sql) is
// the fixture; the browser side is in test/e2e/component-details.test.ts.
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

const as = async (user: string) => {
  const b = new Browser(app);
  const res = await b.login(user);
  assert.equal(res.statusCode, 303, `login as ${user}`);
  return b;
};
const developer = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
};
const meta = (body: string) => JSON.parse(/<script type="application\/json" id="pgkiln-meta">([\s\S]*?)<\/script>/.exec(body)![1]);
const search = async (b: Browser, form: Record<string, string>) => {
  await b.get('/a/hr/47');
  const res = await b.post('/a/hr/47/lov/P47_REF/search', { __csrf: b.lastCsrf, ...form });
  return { status: res.statusCode, json: res.statusCode === 200 ? JSON.parse(res.body) : null };
};
const menuOk = async (menu: unknown) => (await owner.one('select meta.button_menu_ok($1::jsonb) as ok', [JSON.stringify(menu)])).ok;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 47', [appId])).id;
});
after(async () => {
  await app.close();
  await closePools();
});

describe('popup LOV: page after page', () => {
  test('the select names the endpoint and the "Loading more" text; the first rows work without JavaScript', async () => {
    const b = await as('king');
    const body = (await b.get('/a/hr/47')).body;
    assert.match(body, /<select id="P47_REF" name="P47_REF" data-popup-lov="\/a\/hr\/47\/lov\/P47_REF\/search"[^>]* data-loading-label="Loading more…"/);
    assert.match(body, /<option value="1">REF-00001/);
  });

  test('6,000 rows in 60 pages of 100: the last page says there is no more', async () => {
    const b = await as('king');
    const first = await search(b, { q: '', p: '0' });
    assert.equal(first.json.rows.length, 100);
    assert.equal(first.json.more, true);
    assert.equal(first.json.rows[0].value, '1');
    const before = await search(b, { q: '', p: '58' });
    assert.equal(before.json.more, true);
    const last = await search(b, { q: '', p: '59' });
    assert.equal(last.json.rows.length, 100);
    assert.equal(last.json.more, false);
    assert.equal(last.json.rows.at(-1).value, '6000');
    assert.match(last.json.rows.at(-1).display, /^REF-06000/);
    const beyond = await search(b, { q: '', p: '60' });
    assert.deepEqual([beyond.json.rows.length, beyond.json.more], [0, false]);
  });

  test('a search pages within its matches', async () => {
    const b = await as('king');
    const r = await search(b, { q: 'research', p: '14' });
    assert.equal(r.json.rows.length, 100);
    assert.equal(r.json.more, false, '1,500 research rows: 15 pages');
    assert.ok(r.json.rows.every((x: any) => /Research/.test(x.display)));
  });
});

describe('wait popup', () => {
  test('wait_popup and remove_wait_popup reach the page with their messages; the default text travels too', async () => {
    const b = await as('king');
    const m = meta((await b.get('/a/hr/47')).body);
    const waits = m.das.filter((d: any) => d.action === 'wait_popup');
    assert.deepEqual(waits.map((d: any) => [d.event, d.trigger.join(','), d.message]), [
      ['click', 'RECALC', 'Recalculating…'],
      ['click', 'CHECK', 'Checking…'],
      ['menu_entry', 'COUNT', 'Counting employees…'],
    ]);
    assert.equal(m.das.filter((d: any) => d.action === 'remove_wait_popup').length, 2);
    assert.equal(m.texts['da.wait'], 'Please wait…');
  });

  test('the database knows the new actions and event; others are refused', async () => {
    const ins = (event: string, action: string) =>
      owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, action) values ($1, 999, 'cd test', $2, $3)`, [pageId, event, action]);
    try {
      await ins('menu_entry', 'wait_popup');
      await ins('before_submit', 'remove_wait_popup');
      await assert.rejects(ins('menu_chosen', 'show'), /dynamic_action_event_check/);
      await assert.rejects(ins('click', 'spinner'), /dynamic_action_action_check/);
    } finally {
      await owner.query(`delete from meta.dynamic_action where page_id = $1 and name = 'cd test'`, [pageId]);
    }
  });

  test('the long process and the Ajax call behind the wait popups', async () => {
    const b = await as('king');
    await b.get('/a/hr/47');
    const t0 = Date.now();
    const res = await b.post('/a/hr/47', { __csrf: b.lastCsrf, __request: 'RECALC', P47_REF: '', P47_RESULT: '' });
    assert.equal(res.statusCode, 303);
    assert.ok(Date.now() - t0 >= 1900, 'the process takes two seconds');
    const check = (await owner.one(`select id from meta.dynamic_action where page_id = $1 and name = 'The check'`, [pageId])).id;
    await b.get('/a/hr/47');
    const da = await b.post(`/a/hr/47/da/${check}`, { __csrf: b.lastCsrf });
    assert.equal(da.statusCode, 200, da.body);
    assert.match(JSON.parse(da.body).items.P47_RESULT, /^14 employees, checked at \d\d:\d\d:\d\d$/);
  });
});

describe('dynamic actions on menu entries', () => {
  test('an action entry is a button for app.js (nothing without JavaScript), next to links and requests', async () => {
    const b = await as('king');
    const body = (await b.get('/a/hr/47')).body;
    const menu = /<details class="menu btn-menu" data-button="ACTIONS">[\s\S]*?<\/details>/.exec(body)?.[0] ?? '';
    assert.match(menu, /<button type="button" data-menu-entry="COUNT">/);
    assert.match(menu, /<button type="button" data-menu-entry="HELLO">/);
    assert.match(menu, /<a href="\/a\/hr\/26"/);
    const m = meta(body);
    assert.deepEqual(m.das.filter((d: any) => d.event === 'menu_entry').map((d: any) => [d.trigger.join(','), d.action]), [
      ['COUNT', 'wait_popup'],
      ['COUNT', 'execute_sql'],
      ['COUNT', 'remove_wait_popup'],
      ['HELLO', 'show_success'],
    ]);
  });

  test('menu entries: exactly one of page, request or action; an action is a name in capitals', async () => {
    assert.equal(await menuOk([{ label: 'A', action: 'EXPORT' }, { label: 'B', page: 3 }, { label: 'C', request: 'X' }]), true);
    assert.equal(await menuOk([{ label: 'A', action: 'EXPORT', page: 3 }]), false);
    assert.equal(await menuOk([{ label: 'A', action: 'EXPORT', request: 'X' }]), false);
    assert.equal(await menuOk([{ label: 'A' }]), false);
    assert.equal(await menuOk([{ label: 'A', action: 'export' }]), false);
    assert.equal(await menuOk([{ label: 'A', action: 7 }]), false);
    assert.equal(await menuOk([{ label: 'A', action: `X${'Y'.repeat(60)}` }]), false);
  });

  test('the builder offers the event and the actions, names a wrong menu entry and shows the event in the tree', async () => {
    const dev = await developer();
    const da = (await owner.one(`select id from meta.dynamic_action where page_id = $1 and name = 'Hello'`, [pageId])).id;
    const page = (await dev.get(`/builder/pages/${pageId}?c=dynamic_action-${da}`)).body;
    assert.match(page, /<option value="menu_entry" selected>/);
    assert.match(page, /<option value="wait_popup">/);
    assert.match(page, /<option value="remove_wait_popup">/);
    assert.match(page, /Events: Menu entry chosen/);
    const btn = await owner.one(`select * from meta.button where page_id = $1 and name = 'ACTIONS'`, [pageId]);
    const form = { name: 'ACTIONS', label: 'Actions', action: 'menu', seq: String(btn.seq), region_id: String(btn.region_id), target_items: '' };
    await dev.get(`/builder/pages/${pageId}?c=button-${btn.id}`);
    // the message is flashed on the page the save returns to
    const flashed = async (menu: string) => {
      const res = await dev.submit(`/builder/pages/${pageId}/c/button/${btn.id}`, { ...form, menu });
      assert.equal(res.statusCode, 303);
      return (await dev.get(String(res.headers.location))).body;
    };
    assert.match(await flashed('[{"label": "Both", "action": "X", "page": 3}]'), /Menu entry (&quot;|&#34;|")Both(&quot;|&#34;|"): exactly one of/);
    assert.match(await flashed('[{"label": "Low", "action": "export"}]'), /is a name in capitals/);
    assert.deepEqual((await owner.one('select menu from meta.button where id = $1', [btn.id])).menu, btn.menu, 'not saved');
  });

  test('export and import: action entries and menu_entry dynamic actions travel', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const page = doc.pages.find((p: any) => p.page_no === 47);
    assert.ok(page.buttons.find((b: any) => b.name === 'ACTIONS').menu.some((e: any) => e.action === 'COUNT'));
    assert.equal(page.dynamic_actions.filter((d: any) => d.event === 'menu_entry').length, 4);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr-cd-copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const copy = (await owner.one(`select meta.export_app('hr-cd-copy') as d`)).d.pages.find((p: any) => p.page_no === 47);
      assert.deepEqual(copy.buttons.find((b: any) => b.name === 'ACTIONS').menu, page.buttons.find((b: any) => b.name === 'ACTIONS').menu);
      assert.deepEqual(copy.dynamic_actions.map((d: any) => [d.event, d.action]), page.dynamic_actions.map((d: any) => [d.event, d.action]));
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });
});
