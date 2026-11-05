// Sprint 157 (CD-4; APEX: page process types): Close Dialog with items to return, Clear Session State, User
// Preferences, Print Report, Human Task – Create and – Manage, Server Side Geocoding without a geocoder, Form –
// Initialization; their settings are checked before they run.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { declarativeProblems } from '../src/runtime/process-types.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const alias = 'proc-s157';
const ROLE = 'pgkiln_s157_proc';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Processes', 'none', $2) returning id`, [alias, ROLE])).id;
  const p1 = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const p2 = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth, mode) values ($1, 2, 'Dialog', false, 'modal') returning id`, [appId])).id;
  const r1 = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [p1])).id;
  const r2 = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [p2])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, 1, 'P1_A', 'text'), ($1, $2, 2, 'P1_B', 'text'), ($1, $2, 3, 'P1_TASK', 'text'), ($1, $2, 4, 'P1_ADDR', 'text'), ($1, $2, 5, 'P1_LOC', 'text')`, [p1, r1]);
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, 1, 'P2_X', 'text')`, [p2, r2]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values
    ($1, $2, 1, 'CLEAR', 'Clear'), ($1, $2, 2, 'PREF', 'Pref'), ($1, $2, 3, 'PRINT', 'Print'), ($1, $2, 4, 'TASK', 'Task'), ($1, $2, 5, 'CANCEL_TASK', 'Cancel task'), ($1, $2, 6, 'GEO', 'Geo')`, [p1, r1]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 1, 'DONE', 'Done')`, [p2, r2]);
  await owner.query(`insert into meta.report_query (app_id, name, query, format) values ($1, 'NUMBERS', 'select g as n from generate_series(1, 3) g', 'csv')`, [appId]);
  await owner.query(`insert into meta.task_definition (app_id, name, subject) values ($1, 'CHECK_IT', 'Check &WHAT.')`, [appId]);
  const proc = (page: number, seq: number, name: string, type: string, button: string | null, config: unknown) =>
    owner.query(`insert into meta.process (page_id, seq, name, type, when_button, config) values ($1, $2, $3, $4, $5, $6)`, [page, seq, name, type, button, JSON.stringify(config)]);
  await proc(p1, 1, 'init', 'form_init', null, {});
  await proc(p1, 10, 'clear', 'clear_session_state', 'CLEAR', { items: ['P1_A'] });
  await proc(p1, 20, 'pref', 'user_preferences', 'PREF', { action: 'set', preference: 'last_b', item: 'P1_B' });
  await proc(p1, 30, 'print', 'print_report', 'PRINT', { document: 'NUMBERS' });
  await proc(p1, 40, 'task', 'human_task_create', 'TASK', { definition: 'CHECK_IT', detail_pk: '&P1_B.', parameters: { what: '&P1_B.' }, id_item: 'P1_TASK' });
  await proc(p1, 50, 'cancel', 'human_task_manage', 'CANCEL_TASK', { action: 'cancel', task: '&P1_TASK.', comment: 'not needed' });
  await proc(p1, 60, 'geo', 'server_geocoding', 'GEO', { address_item: 'P1_ADDR', coordinates_item: 'P1_LOC' });
  await proc(p2, 10, 'close', 'close_dialog', 'DONE', { items: ['P2_X'] });
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

const value = (body: string, name: string) => new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(body)?.[1] ?? new RegExp(`value="([^"]*)"[^>]*name="${name}"`).exec(body)?.[1] ?? '';

describe('process types (CD-4)', () => {
  test('Clear Session State empties the named items only; Form – Initialization does nothing', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { P1_A: 'one', P1_B: 'two', __request: 'CLEAR' });
    assert.equal(res.statusCode, 303);
    const page = (await b.get(`/a/${alias}/1`)).body;
    assert.equal(value(page, 'P1_A'), '');
    assert.equal(value(page, 'P1_B'), 'two');
  });

  test('User Preferences: nothing to store for the public user, and no error', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    assert.equal((await b.submit(`/a/${alias}/1`, { P1_B: 'remembered', __request: 'PREF' })).statusCode, 303);
    assert.equal((await owner.query(`select 1 from meta.user_preference where app_id = $1`, [appId])).rowCount, 0);
  });

  test('Print Report answers with the report query\'s file', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { __request: 'PRINT' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-disposition']), /^attachment/);
    assert.match(res.body, /^\uFEFF?n\r?\n1\r?\n2\r?\n3/);
  });

  test('Human Task – Create puts the id in an item; – Manage cancels it', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    await b.submit(`/a/${alias}/1`, { P1_B: 'the roof', __request: 'TASK' });
    const id = value((await b.get(`/a/${alias}/1`)).body, 'P1_TASK');
    assert.match(id, /^\d+$/);
    const task = await owner.one(`select subject, detail_pk, state from meta.task where id = $1`, [id]);
    assert.deepEqual([task.subject, task.detail_pk], ['Check the roof', 'the roof']);
    // – Manage calls the task functions, which decide who may: the public user may not cancel it
    const res = await b.submit(`/a/${alias}/1`, { P1_TASK: id, __request: 'CANCEL_TASK' });
    assert.equal(res.statusCode, 422);
    assert.equal((await owner.one(`select state from meta.task where id = $1`, [id])).state, task.state);
  });

  test('Server Side Geocoding without a geocoder says so', async () => {
    const saved = process.env.GEOCODER_URL;
    delete process.env.GEOCODER_URL;
    try {
      const b = new Browser(app);
      await b.get(`/a/${alias}/1`);
      const res = await b.submit(`/a/${alias}/1`, { P1_ADDR: 'Dam 1, Amsterdam', __request: 'GEO' });
      assert.equal(res.statusCode, 422);
      assert.match(res.body, /No geocoder is set up/);
    } finally {
      if (saved !== undefined) process.env.GEOCODER_URL = saved;
    }
  });

  test('Close Dialog closes the modal page and hands its items to the page below', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/2?dialog=1`);
    const res = await b.submit(`/a/${alias}/2`, { P2_X: 'chosen <1>', __dialog: '1', __request: 'DONE' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-dialog-close="1"/);
    assert.match(res.body, /data-dialog-items="\{&quot;P2_X&quot;:&quot;chosen &lt;1&gt;&quot;\}"/);
  });

  test('settings are checked: the builder and the run refuse what is wrong', () => {
    assert.match(declarativeProblems('close_dialog', { items: ['p2_x'] }).join(), /item names/);
    assert.match(declarativeProblems('clear_session_state', {}).join(), /Name "items"/);
    assert.match(declarativeProblems('human_task_manage', { action: 'approve' }).join(), /"task"/);
    assert.match(declarativeProblems('human_task_manage', { action: 'complete', task: '1' }).join(), /"outcome"/);
    assert.match(declarativeProblems('print_report', { document: 'x; drop' }).join(), /"document"/);
    assert.deepEqual(declarativeProblems('user_preferences', { action: 'reset', preference: 'X' }), []);
  });
});
