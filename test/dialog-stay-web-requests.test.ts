// Sprint 240 (MG-7, MG-8; migration 196).
// MG-7: a submit from a modal dialog page closes the dialog unless the button (or the branch taken) has
// stay_in_dialog; a close_dialog process still closes it; a grid's own Save stays. Items of a grid region stand
// in its toolbar.
// MG-8: web requests queued by an Ajax callback (also a chain of SQL processes) or an execute_sql dynamic action
// are made right after it, in the same transaction, within a time budget.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner, runtime } = await import('../src/db.ts');
const wr = await import('../src/webrequests.ts');
const { inDialog } = await import('../src/runtime/logic.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
let appId: number;
let mock: http.Server;
let mockBase = '';
const alias = 'dlg-s240';
const ROLE = 'pgkiln_dlg_s240';
const SCHEMA = 'dlg_s240';
const ids: Record<string, number> = {};

before(async () => {
  app = await buildApp({ logger: false });
  mock = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ q: u.searchParams.get('q') }));
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.line (id serial primary key, name text)`);
  await owner.query(`insert into ${SCHEMA}.line (name) values ('one'), ('two')`);
  await owner.query(`grant select, insert, update, delete on ${SCHEMA}.line to ${ROLE}`);
  await owner.query(`grant usage on sequence ${SCHEMA}.line_id_seq to ${ROLE}`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Dialog test', 'none', $2) returning id`, [alias, ROLE])).id;
  const page = async (no: number, mode: string) =>
    (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth, mode) values ($1, $2, $3, false, $4) returning id`, [appId, no, `P${no}`, mode])).id;
  ids.p1 = await page(1, 'normal');
  ids.p2 = await page(2, 'modal');
  ids.p3 = await page(3, 'modal');
  const p2 = ids.p2;
  ids.form = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Form', 'static', '<p>x</p>') returning id`, [p2])).id;
  ids.grid = (await owner.one(
    `insert into meta.region (page_id, seq, title, type, source, table_name, pk_column, config) values ($1, 20, 'Lines', 'grid', $2, $3, 'id', '{}') returning id`,
    [p2, `select id, name from ${SCHEMA}.line`, `${SCHEMA}.line`],
  )).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P2_N', 'N', 'text'), ($1, $3, 1, 'P2_TOOL', 'Tool', 'text')`, [p2, ids.form, ids.grid]);
  await owner.query(
    `insert into meta.button (page_id, region_id, seq, name, label, stay_in_dialog) values
       ($1, $2, 1, 'STAY', 'Stay', true), ($1, $2, 2, 'CLOSE', 'Close', null), ($1, $2, 3, 'CLOSER', 'Closer', true),
       ($1, $2, 4, 'BR', 'Branch', null), ($1, $2, 5, 'BRX', 'Branch away', true)`,
    [p2, ids.form],
  );
  await owner.query(
    `insert into meta.process (page_id, seq, name, type, point, code, when_button, success_message, config) values
       ($1, 1, 'Note', 'sql', 'submit', 'select ''done'' as p2_n', null, 'Noted &P2_N..', '{}'),
       ($1, 2, 'Close it', 'close_dialog', 'submit', null, 'CLOSER', null, '{}')`,
    [p2],
  );
  await owner.query(`insert into meta.process (page_id, seq, name, type, region_id) values ($1, 3, 'Save lines', 'grid_dml', $2)`, [p2, ids.grid]);
  await owner.query(
    `insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_page, stay_in_dialog) values
       ($1, 1, 'To 3 in the dialog', 'after_processing', 'BR', 'page', 3, true),
       ($1, 2, 'To 3 closing', 'after_processing', 'BRX', 'page', 3, null)`,
    [p2],
  );

  // page 1: Ajax callbacks and an execute_sql dynamic action
  const p1 = ids.p1;
  const r1 = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'Calls', 'static', '<p>x</p>') returning id`, [p1])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 1, 'P1_Q', 'Q', 'text'), ($1, $2, 2, 'P1_REQ', 'Req', 'hidden'), ($1, $2, 3, 'P1_OUT', 'Out', 'text')`, [p1, r1]);
  const queue = `select meta.web_request('${mockBase}/json?q=' || meta.url_encode(:P1_Q)) as p1_req`;
  await owner.query(
    `insert into meta.process (page_id, seq, name, type, point, code, parent_process, config) values
       ($1, 1, 'ONE', 'sql', 'ajax', $2, null, '{}'),
       ($1, 2, 'TWO', 'chain', 'ajax', null, null, '{}'),
       ($1, 3, 'Queue', 'sql', 'ajax', $2, 'TWO', '{}'),
       ($1, 4, 'Read', 'sql', 'ajax', $3, 'TWO', '{}'),
       ($1, 5, 'BAD', 'chain', 'ajax', null, null, '{}'),
       ($1, 6, 'Bad step', 'close_dialog', 'ajax', null, 'BAD', '{}')`,
    [p1, queue, `select meta.web_response(:P1_REQ::bigint) -> 'json' ->> 'q' as p1_out, 'read' as step`],
  );
  ids.da = (await owner.one(
    `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, code, items_to_submit) values ($1, 1, 'Queue', 'click', 'GO', 'execute_sql', 'P1_REQ', $2, 'P1_Q') returning id`,
    [p1, queue],
  )).id;
  ids.da2 = (await owner.one(
    `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, code) values ($1, 2, 'Read', 'click', 'GO', 'set_value', 'P1_OUT', $2) returning id`,
    [p1, `select meta.web_response(:P1_REQ::bigint) -> 'json' ->> 'q'`],
  )).id;
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  mock.close();
  await app.close();
  await closePools();
});

const status = async (id: string | number) => (await owner.one('select status from meta.web_request_log where id = $1', [id])).status;

describe('sprint 240 MG-7: a submit that stays in the dialog', () => {
  const submit = async (button: string) => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/2?dialog=1`);
    return { b, res: await b.submit(`/a/${alias}/2`, { __request: button, __dialog: '1', P2_N: 'x' }) };
  };

  test('a button with stay_in_dialog shows the dialog page again, with the success message', async () => {
    const { b, res } = await submit('STAY');
    assert.equal(res.statusCode, 303, res.body);
    assert.equal(res.headers.location, `/a/${alias}/2?dialog=1`);
    const again = await b.get(res.headers.location as string);
    assert.match(again.body, /Noted done\./);
    assert.match(again.body, /name="__dialog" value="1"/);
  });

  test('without it the dialog closes (as before); a close_dialog process closes it anyway', async () => {
    for (const button of ['CLOSE', 'CLOSER']) {
      const { res } = await submit(button);
      assert.equal(res.statusCode, 200, button);
      assert.doesNotMatch(String(res.headers.location ?? ''), /dialog/);
      assert.match(res.body, /data-dialog-close|dialog-close/, button);
    }
  });

  test('a branch with stay_in_dialog goes to its target inside the dialog; one without closes it', async () => {
    const { res } = await submit('BR');
    assert.equal(res.statusCode, 303);
    assert.match(String(res.headers.location), new RegExp(`^/a/${alias}/3.*[?&]dialog=1`));
    // the button stays, but the branch taken (without stay) decides: the dialog closes
    const away = await submit('BRX');
    assert.equal(away.res.statusCode, 200);
  });

  test('outside a dialog the option changes nothing', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/2`);
    const res = await b.submit(`/a/${alias}/2`, { __request: 'STAY', P2_N: 'x' });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `/a/${alias}/2`);
  });

  test("a grid's own Save stays in the dialog", async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/2?dialog=1`);
    const res = await b.submit(`/a/${alias}/2`, { __request: `GRID_SAVE_${ids.grid}`, __dialog: '1' });
    assert.equal(res.statusCode, 303, res.body);
    assert.match(String(res.headers.location), /^\/a\/dlg-s240\/2\?dialog=1/);
  });

  test('inDialog adds dialog=1 once, before a fragment', () => {
    assert.equal(inDialog('/a/x/3'), '/a/x/3?dialog=1');
    assert.equal(inDialog('/a/x/3?P3_ID=1&cs=abc#top'), '/a/x/3?P3_ID=1&cs=abc&dialog=1#top');
    assert.equal(inDialog('/a/x/3?dialog=1'), '/a/x/3?dialog=1');
  });
});

describe('sprint 240 MG-7: items of a grid region stand in its toolbar', () => {
  test('the item is rendered inside the grid toolbar, before the search', async () => {
    const b = new Browser(app);
    const res = await b.get(`/a/${alias}/2`);
    const toolbar = /<div class="report-toolbar grid-toolbar">([\s\S]*?)<div class="search"/.exec(res.body);
    assert.ok(toolbar, 'a grid toolbar');
    assert.match(toolbar[1], /id="P2_TOOL"/);
    assert.equal(res.body.match(/id="P2_TOOL"/g)?.length, 1, 'once');
  });
});

describe('sprint 240 MG-8: web requests made right after Ajax callbacks and execute_sql actions', () => {
  const call = async (b: InstanceType<typeof Browser>, name: string, form: Record<string, string> = {}) =>
    b.post(`/a/${alias}/1/ajax/${name}`, { __csrf: b.lastCsrf, ...form });

  test('an Ajax callback: its request is made before the answer (status ok, no scheduler)', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await call(b, 'ONE', { P1_Q: 'one' });
    assert.equal(res.statusCode, 200, res.body);
    const id = JSON.parse(res.body).items.P1_REQ;
    assert.ok(id);
    assert.equal(await status(id), 'ok');
  });

  test('a chain of SQL processes: the second step reads the response of the first; the answer is its rows', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await call(b, 'TWO', { P1_Q: 'a b&c' });
    assert.equal(res.statusCode, 200, res.body);
    const out = JSON.parse(res.body);
    assert.equal(out.data.step, 'read');
    assert.equal(out.data.p1_out, 'a b&c');
    assert.equal(out.items.P1_OUT, 'a b&c');
  });

  test("a chain's step can't be called on its own; a chain with another process type is refused", async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    assert.equal((await call(b, 'Read')).statusCode, 403);
    const bad = await call(b, 'BAD');
    assert.equal(bad.statusCode, 400);
    assert.match(JSON.parse(bad.body).error, /SQL processes only/);
  });

  test('execute_sql: made right after it, so the next action (set_value) reads the response', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const r1 = await b.post(`/a/${alias}/1/da/${ids.da}`, { __csrf: b.lastCsrf, P1_Q: 'via da' });
    assert.equal(r1.statusCode, 200, r1.body);
    const id = JSON.parse(r1.body).items.P1_REQ;
    assert.equal(await status(id), 'ok');
    const r2 = await b.post(`/a/${alias}/1/da/${ids.da2}`, { __csrf: b.lastCsrf });
    assert.equal(JSON.parse(r2.body).items.P1_OUT, 'via da');
  });

  test('the time budget: a request with no time left is made by the server after the commit', async () => {
    const id = await runtime.tx(async (c) => {
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'ann', true)`, [String(appId)]);
      await c.query(`set local role ${ROLE}`);
      const q = (await c.query(`select meta.web_request($1) as id`, [`${mockBase}/json?q=late`])).rows[0].id;
      const seen: string[] = [];
      assert.equal(await wr.runPending(c as any, appId, (_r, res) => seen.push(res.message ?? ''), 0), 1);
      assert.deepEqual(seen, [wr.DEFERRED_MESSAGE]);
      return q;
    });
    const row = await owner.one('select status, next_attempt_at, message from meta.web_request_log where id = $1', [id]);
    assert.equal(row.status, 'retry');
    assert.ok(row.next_attempt_at);
    assert.equal(row.message, wr.DEFERRED_MESSAGE);
    await owner.query(`update meta.web_request_log set next_attempt_at = now() where id = $1`, [id]);
    await wr.webRequestTick();
    assert.equal(await status(id), 'ok');
  });
});

describe('sprint 240: the Advisor', () => {
  test('flags a chain called as an Ajax callback with a non-SQL step, and stay_in_dialog where it changes nothing', async () => {
    const { advise } = await import('../src/builder/advisor.ts');
    const btn = (await owner.one(`insert into meta.button (page_id, seq, name, label, stay_in_dialog) values ($1, 9, 'NOWHERE', 'Nowhere', true) returning id`, [ids.p1])).id;
    try {
      const { findings } = await advise(appId);
      const msgs = findings.map((f) => `${f.severity}: ${f.message}`);
      assert.ok(msgs.some((m) => /^error: A chain called as an Ajax callback runs SQL processes only: "Bad step" \(close_dialog\)/.test(m)), msgs.join('\n'));
      assert.ok(msgs.some((m) => /^info: Page 1 is not a modal dialog page/.test(m)));
      assert.ok(!msgs.some((m) => /Page 2 is not a modal/.test(m)), 'page 2 is modal');
      assert.ok(!msgs.some((m) => /"TWO"|calling this sql/.test(m)));
    } finally {
      await owner.query('delete from meta.button where id = $1', [btn]);
    }
  });
});
