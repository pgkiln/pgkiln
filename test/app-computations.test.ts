// Application computations (migration 102; APEX: Shared Components → Application
// Computations): computations of items that run for every page at their point,
// before the page's own. HR (examples/hr) is the fixture; the test's application
// items and computations are removed afterwards.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page22: number;
const ITEMS = ['AC_TEST_GREETING', 'AC_TEST_COPY', 'AC_TEST_LOGIN', 'AC_TEST_SUBMIT'];

const as = async (user: string) => {
  const b = new Browser(app);
  const res = await b.login(user);
  assert.equal(res.statusCode, 303, `login as ${user}`);
  return b;
};
/** The newest session of a user: its state. */
const stateOf = async (user: string) =>
  (await owner.one(`select state from meta.session where app_id = $1 and lower(username) = $2 order by last_seen desc limit 1`, [appId, user])).state as Record<string, string | null>;
const cleanUp = async () => {
  await owner.query(`delete from meta.app_computation where app_id = $1 and item_name like 'AC\\_TEST\\_%' or app_id = $1 and item_name = 'P22_NOTE_AC'`, [appId]);
  await owner.query(`delete from meta.computation where page_id = $1 and item_name like 'AC\\_TEST\\_%'`, [page22]);
  await owner.query(`delete from meta.app_item where app_id = $1 and name like 'AC\\_TEST\\_%'`, [appId]);
};

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  page22 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 22', [appId])).id;
  await cleanUp();
  for (const name of ITEMS) await owner.query('insert into meta.app_item (app_id, name) values ($1, $2)', [appId, name]);
});
after(async () => {
  await cleanUp();
  await app.close();
  await closePools();
});

describe('application computations', () => {
  test('made in Shared Components (Application Logic)', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    assert.match((await dev.get(`/builder/apps/${appId}/shared`)).body, /shared\?type=app_computation">[^<]*(<[^>]*>[^<]*)*Application Computations/);
    await dev.get(`/builder/apps/${appId}/shared?new=app_computation`);
    const res = await dev.submit(`/builder/apps/${appId}/shared/app_computation`, {
      item_name: 'ac_test_greeting', point: 'before_header', seq: '10', type: 'static', expression: 'Hi &APP_USER.',
    });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select point, type, expression from meta.app_computation where app_id = $1 and item_name = 'AC_TEST_GREETING'`, [appId]);
    assert.deepEqual(row, { point: 'before_header', type: 'static', expression: 'Hi &APP_USER.' });
    assert.match((await dev.get(`/builder/apps/${appId}/shared?type=app_computation`)).body, /AC_TEST_GREETING \(before_header, static\)/);
  });

  test('before header: on every page, before the page\'s own computations', async () => {
    // a page computation that copies the application computation's item: it sees the new value
    await owner.query(`insert into meta.computation (page_id, seq, item_name, point, type, expression) values ($1, 1, 'AC_TEST_COPY', 'before_header', 'item', 'AC_TEST_GREETING')`, [page22]);
    const king = await as('king');
    await king.get('/a/hr/1');
    assert.match(String((await stateOf('king')).AC_TEST_GREETING), /^Hi king$/i, 'on another page too');
    await owner.query(`update meta.session set state = state - 'AC_TEST_GREETING' where app_id = $1 and lower(username) = 'king'`, [appId]);
    await king.get('/a/hr/22');
    const st = await stateOf('king');
    assert.match(String(st.AC_TEST_COPY), /^Hi king$/i);
  });

  test('after authentication: once, at sign-in; after submit: before the page\'s computations and validations', async () => {
    await owner.query(`insert into meta.app_computation (app_id, item_name, point, type, expression) values
                         ($1, 'AC_TEST_LOGIN', 'after_authentication', 'sql_query', 'select upper(:APP_USER) || ''!'''),
                         ($1, 'AC_TEST_SUBMIT', 'after_submit', 'static', 'posted &REQUEST.')`, [appId]);
    const king = await as('king');
    assert.equal((await stateOf('king')).AC_TEST_LOGIN, 'KING!');
    await king.get('/a/hr/22');
    assert.equal((await stateOf('king')).AC_TEST_SUBMIT ?? null, null, 'not on a page view');
    await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '2', __request: 'CHECK' });
    assert.equal((await stateOf('king')).AC_TEST_SUBMIT, 'posted CHECK');
  });

  test('a page item is computed on its own page only; conditions and build options apply', async () => {
    await owner.query(`insert into meta.app_computation (app_id, item_name, point, type, expression, condition_type, condition_value) values
                         ($1, 'P22_NOTE_AC', 'before_header', 'static', 'x', null, null),
                         ($1, 'AC_TEST_COPY', 'before_header', 'static', 'never', 'request_in', 'NOPE')`, [appId]);
    const king = await as('king');
    const other = (await king.get('/a/hr/1')).body;
    assert.doesNotMatch(other, /P22_NOTE_AC/, 'no "unknown item" error on another page');
    assert.notEqual((await stateOf('king')).AC_TEST_COPY, 'never');
  });

  test('exported with the application and written as files; the runtime role cannot change them', async () => {
    const doc = (await owner.one('select meta.export_app($1) as d', ['hr'])).d;
    const ours = doc.app_computations.filter((c: { item_name: string }) => c.item_name.startsWith('AC_TEST_'));
    assert.ok(ours.length >= 3);
    assert.equal(ours[0].id, undefined);
    const files = docToFiles(doc, 'text');
    assert.ok([...files.keys()].some((k) => /^shared\/app-computations\/\d+-ac_test_login-after_authentication\.yaml$/.test(k)), [...files.keys()].filter((k) => k.includes('computation')).join(', '));
    // and read back from the files the same
    const back = filesToDoc(files);
    const byItem = (rows: { item_name: string }[]) => [...rows].sort((a, b) => (a.item_name < b.item_name ? -1 : 1));
    assert.deepEqual(byItem(back.app_computations), byItem(doc.app_computations), 'equal sequences in file name order');
    await assert.rejects(runtime.query(`insert into meta.app_computation (app_id, item_name) values ($1, 'AC_TEST_X')`, [appId]), /permission denied/);
    await assert.rejects(runtime.query(`update meta.app_computation set expression = 'x' where app_id = $1`, [appId]), /permission denied/);
  });
});
