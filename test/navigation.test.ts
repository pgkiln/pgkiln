// Sprint 249 (MG-22, MG-23, MG-27; migration 205).
// MG-22: a branch whose target page is an item's value (checked: a page of this application the user may open,
// else the page itself), and the built-ins APP_PREVIOUS_PAGE / APP_PREVIOUS_URL (the page the user came from,
// as it was opened). MG-23: a branch of a modal dialog page "in the page below" closes the dialog and sends the
// page below to its target. MG-27: &ITEM. substitutions in button labels, escaped.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { previousPage } = await import('../src/runtime/context.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
let appId: number;
const alias = 'nav-s249';
const base = `/a/${alias}`;
const pages: Record<number, number> = {};
const ROLE = 'pgkiln_nav_s249';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Navigation test', 'none', $2) returning id`, [alias, ROLE])).id;
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value) values ($1, 'NOBODY', 'sql', 'select false')`, [appId]);
  const page = async (no: number, mode = 'normal', extra: Record<string, string | null> = {}) => {
    pages[no] = (await owner.one(
      `insert into meta.page (app_id, page_no, name, requires_auth, mode, protection, alias, authz) values ($1, $2, $3, false, $4, $5, $6, $7) returning id`,
      [appId, no, `P${no}`, mode, extra.protection ?? 'unrestricted', extra.alias ?? null, extra.authz ?? null],
    )).id;
    return (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'R', 'static', $2) returning id`,
      [pages[no], `<p>prev=[&APP_PREVIOUS_PAGE.] url=[&APP_PREVIOUS_URL.]</p>`])).id;
  };
  const r1 = await page(1);
  await page(2, 'normal', { alias: 'list-b', protection: 'checksum' });
  const r3 = await page(3);
  await page(4, 'normal', { authz: 'NOBODY' });
  const r5 = await page(5, 'modal');
  await page(6, 'modal');
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P1_X', 'X', 'text')`, [pages[1], r1]);
  await owner.query(`insert into meta.item (page_id, seq, name, label, type) values ($1, 1, 'P2_Y', 'Y', 'text')`, [pages[2]]);
  await owner.query(
    `insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P3_ID', 'Id', 'text'), ($1, $2, 2, 'P3_BACK', 'Back to', 'text'), ($1, $2, 3, 'P3_LABEL', 'Label', 'text')`,
    [pages[3], r3],
  );
  await owner.query(
    `insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 1, 'BACK', 'Back to page &APP_PREVIOUS_PAGE.'), ($1, $2, 2, 'GO', 'Go'),
       ($1, $2, 3, 'GOI', 'Go with items'), ($1, $2, 4, 'STAY', 'Stay as &P3_LABEL.')`,
    [pages[3], r3],
  );
  await owner.query(
    `insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_item, target_items) values
       ($1, 1, 'Back', 'after_processing', 'BACK', 'item', 'APP_PREVIOUS_PAGE', null),
       ($1, 2, 'Go', 'after_processing', 'GO', 'item', 'P3_BACK', null),
       ($1, 3, 'Go with items', 'after_processing', 'GOI', 'item', 'P3_BACK', '{"P2_Y": "&P3_ID."}')`,
    [pages[3]],
  );
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P5_ID', 'Id', 'text')`, [pages[5], r5]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 1, 'OPEN', 'Open'), ($1, $2, 2, 'CLOSE', 'Close')`, [pages[5], r5]);
  await owner.query(
    `insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_page, target_items, in_page_below) values
       ($1, 1, 'Below', 'after_processing', 'OPEN', 'page', 3, '{"P3_ID": "&P5_ID."}', true)`,
    [pages[5]],
  );
  await owner.query(
    `insert into meta.branch (page_id, seq, name, point, target_type, target_page, in_page_below) values ($1, 1, 'Away', 'before_header', 'page', 1, true)`,
    [pages[6]],
  );
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

const prevOf = (body: string) => /prev=\[([^\]]*)\] url=\[([^\]]*)\]/.exec(body)?.slice(1, 3);
const unescape = (s: string) => s.replace(/&amp;/g, '&');

describe('sprint 249 MG-22: APP_PREVIOUS_PAGE and APP_PREVIOUS_URL', () => {
  test('previousPage: the last page when it is another, else the one before', () => {
    const state = { __LAST_PAGE: '3', __LAST_URL: '/a/x/3', __PREV_PAGE: '1', __PREV_URL: '/a/x/1?P1_X=a' };
    assert.deepEqual(previousPage(state, 3), { page: '1', url: '/a/x/1?P1_X=a' });
    assert.deepEqual(previousPage(state, 5), { page: '3', url: '/a/x/3' });
    assert.deepEqual(previousPage({}, 3), { page: null, url: null });
  });

  test('the page the user came from, as it was opened; kept when the page comes back', async () => {
    const b = new Browser(app);
    const first = await b.get(`${base}/1?P1_X=abc&clear=1`);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(prevOf(first.body), ['', ''], 'no previous page yet');
    const three = await b.get(`${base}/3`);
    assert.deepEqual(prevOf(three.body)!.map(unescape), ['1', `${base}/1?P1_X=abc`], 'one-shot parameters (clear) left out');
    assert.match(three.body, />Back to page 1</, 'the button label takes the built-in');
    // the page again (a submit that comes back, a report page): still page 1
    const again = await b.get(`${base}/3?P3_ID=5`);
    assert.equal(prevOf(again.body)![0], '1');
    // a dialog page: its previous page is the page below
    const dlg = await b.get(`${base}/5?dialog=1`);
    assert.equal(prevOf(dlg.body)![0], '3');
    // and the dialog isn't noted: page 3 still came from page 1
    assert.equal(prevOf((await b.get(`${base}/3`)).body)![0], '1');
  });

  test('a branch to APP_PREVIOUS_PAGE without items goes back to that page as it was opened', async () => {
    const b = new Browser(app);
    await b.get(`${base}/1?P1_X=abc`);
    await b.get(`${base}/3`);
    const res = await b.submit(`${base}/3`, { __request: 'BACK' });
    assert.equal(res.statusCode, 303, res.body);
    assert.equal(res.headers.location, `${base}/1?P1_X=abc`);
    const back = await b.get(res.headers.location as string);
    assert.match(back.body, /value="abc"/);
    assert.equal(prevOf(back.body)![0], '3');
  });

  test('without a previous page, the branch goes to the page itself', async () => {
    const b = new Browser(app);
    await b.get(`${base}/3`);
    const res = await b.submit(`${base}/3`, { __request: 'BACK' });
    assert.equal(res.headers.location, `${base}/3`);
  });
});

describe('sprint 249 MG-22: a branch target from an item', () => {
  const go = async (back: string, request = 'GO', id = '') => {
    const b = new Browser(app);
    await b.get(`${base}/3`);
    return { b, res: await b.submit(`${base}/3`, { __request: request, P3_BACK: back, P3_ID: id }) };
  };

  test('a page number or alias of the application', async () => {
    assert.equal((await go('1')).res.headers.location, `${base}/1`);
    assert.equal((await go(' 2 ')).res.headers.location, `${base}/2`);
    assert.equal((await go('LIST-B')).res.headers.location, `${base}/2`);
  });

  test('anything else goes to the page itself: another site, a path, no page, the global page, a page the user may not open', async () => {
    for (const v of ['https://evil.example', '//evil.example', '/a/other/1', '1/../../x', '999', '0', '4', '-1', '1e1', ''])
      assert.equal((await go(v)).res.headers.location, `${base}/3`, v);
  });

  test('items for the target page are signed, and the target accepts them', async () => {
    const { b, res } = await go('2', 'GOI', '42');
    const loc = String(res.headers.location);
    assert.match(loc, new RegExp(`^${base}/2\\?P2_Y=42&cs=[0-9a-f]+`));
    const page = await b.get(loc);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /value="42"/);
    // tampered: refused by the target page's checksum
    assert.equal((await b.get(loc.replace('P2_Y=42', 'P2_Y=43'))).statusCode, 403);
  });
});

describe('sprint 249 MG-23: a branch in the page below', () => {
  test('a submit closes the dialog and hands the page below the target, items signed', async () => {
    const b = new Browser(app);
    await b.get(`${base}/5?dialog=1`);
    const res = await b.submit(`${base}/5`, { __request: 'OPEN', __dialog: '1', P5_ID: '7' });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /data-dialog-close="1"/);
    const goto = unescape(/data-dialog-goto="([^"]+)"/.exec(res.body)![1]);
    assert.match(goto, new RegExp(`^${base}/3\\?P3_ID=7&cs=[0-9a-f]+$`));
    // without JavaScript, Continue goes there too
    assert.ok(res.body.includes(`href="${goto.replace(/&/g, '&amp;')}"`));
    const page = await b.get(goto);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /id="P3_ID"[^>]*value="7"|value="7"[^>]*id="P3_ID"/);
  });

  test('another button of the dialog closes it as before (no target)', async () => {
    const b = new Browser(app);
    await b.get(`${base}/5?dialog=1`);
    const res = await b.submit(`${base}/5`, { __request: 'CLOSE', __dialog: '1' });
    assert.match(res.body, /data-dialog-close/);
    assert.doesNotMatch(res.body, /data-dialog-goto/);
  });

  test('a before-header branch in a dialog: the dialog closes and the page below goes there; outside one, a redirect', async () => {
    const b = new Browser(app);
    const dlg = await b.get(`${base}/6?dialog=1`);
    assert.equal(dlg.statusCode, 200);
    assert.match(dlg.body, new RegExp(`data-dialog-goto="${base}/1"`));
    const plain = await b.get(`${base}/6`);
    assert.equal(plain.statusCode, 303);
    assert.equal(plain.headers.location, `${base}/1`);
  });

  test('the database refuses in_page_below with stay_in_dialog, and an item target without an item', async () => {
    await assert.rejects(owner.query(`update meta.branch set stay_in_dialog = true where page_id = $1`, [pages[5]]), /branch_below_check/);
    await assert.rejects(owner.query(`update meta.branch set target_item = null where page_id = $1 and name = 'Go'`, [pages[3]]), /branch_item_check/);
    await assert.rejects(owner.query(`update meta.branch set target_item = 'P3 X' where page_id = $1 and name = 'Go'`, [pages[3]]), /target_item_check/);
  });
});

describe('sprint 249 MG-27: item values in button labels', () => {
  test('substituted and escaped', async () => {
    const b = new Browser(app);
    await b.get(`${base}/3`);
    await b.submit(`${base}/3`, { __request: 'STAY', P3_LABEL: '<b>Bob</b> & "co"' });
    const page = await b.get(`${base}/3`);
    assert.match(page.body, />Stay as &lt;b&gt;Bob&lt;\/b&gt; &amp; &quot;co&quot;</);
    assert.doesNotMatch(page.body, /<b>Bob<\/b>/);
  });
});
