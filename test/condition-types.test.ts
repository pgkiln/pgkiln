// Sprint 154 (CD-2; APEX: Server-side Condition): one catalogue of server-side condition types for every
// component. Regions, items, buttons, validations and dynamic actions choose from the same list as processes,
// computations and branches; the simple types are decided without a query; the database refuses malformed ones;
// the Page Designer shows a condition in words (in the builder's language); the Advisor offers a declarative type
// for a SQL condition that is one.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise } from '../src/builder/advisor.ts';
import { declarativeCondition } from '../src/builder/conditions.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page1: number;
let page2: number;
const alias = 'cond-s154';
const ROLE = 'pgkiln_s154_cond';

/** [region title, condition type, expression, value, shown on page 1?] */
const REGIONS: [string, string | null, string | null, string | null, boolean][] = [
  ['always', 'always', null, null, true],
  ['never', 'never', null, null, false],
  ['item-equals', 'item_equals', 'P1_JOB', 'CLERK', true],
  ['item-not-equals', 'item_not_equals', 'P1_JOB', 'CLERK', false],
  ['item-in-list', 'item_in_list', 'P1_JOB', 'CLERK:ANALYST', true],
  ['item-not-in-list', 'item_not_in_list', 'P1_JOB', 'CLERK:ANALYST', false],
  ['item-zero', 'item_zero', 'P1_N', null, true],
  ['item-not-zero', 'item_not_zero', 'P1_N', null, false],
  ['item-null-or-zero', 'item_null_or_zero', 'P1_N', null, true],
  ['item-not-null-or-zero', 'item_not_null_or_zero', 'P1_N', null, false],
  ['empty-null-or-zero', 'item_null_or_zero', 'P1_EMPTY', null, true],
  ['empty-zero', 'item_zero', 'P1_EMPTY', null, false],
  ['item-equals-item', 'item_equals_item', 'P1_JOB', 'P1_OTHER', true],
  ['item-not-equals-item', 'item_not_equals_item', 'P1_JOB', 'P1_OTHER', false],
  ['page-in', 'page_in', null, '1, 3', true],
  ['page-not-in', 'page_not_in', null, '1', false],
  ['dialog', 'page_is_dialog', null, null, false],
  ['not-dialog', 'page_is_not_dialog', null, null, true],
  ['public', 'user_public', null, null, true],
  ['signed-in', 'user_signed_in', null, null, false],
  ['lang-in', 'language_in', null, 'EN,de', true],
  ['lang-not-in', 'language_not_in', null, 'en', false],
  ['function-body', 'function_body', "return :P1_JOB = 'CLERK';", null, true],
  ['function-body-false', 'function_body', 'begin return false; end', null, false],
  ['exists', 'exists', 'select 1', null, true],
  ['not-exists', 'not_exists', 'select 1', null, false],
  // without a type the condition is SQL, as before (migration 147 keeps old exports working)
  ['plain-sql', null, ":P1_JOB = 'CLERK'", null, true],
  ['plain-sql-false', null, ":P1_JOB = 'ANALYST'", null, false],
];

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop owned by ${ROLE}`).catch(() => undefined);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Conditions', 'none', $2) returning id`, [alias, ROLE])).id;
  page1 = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  page2 = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth, mode) values ($1, 2, 'Dialog', false, 'modal') returning id`, [appId])).id;
  const main = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [page1])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values
    ($1, $2, 1, 'P1_JOB', 'hidden'), ($1, $2, 2, 'P1_OTHER', 'hidden'), ($1, $2, 3, 'P1_N', 'hidden'), ($1, $2, 4, 'P1_EMPTY', 'hidden')`, [page1, main]);
  // session state (as in APEX, a default value isn't: conditions read session state)
  await owner.query(`insert into meta.computation (page_id, seq, item_name, point, type, expression) values
    ($1, 1, 'P1_JOB', 'before_header', 'static', 'CLERK'), ($1, 2, 'P1_OTHER', 'before_header', 'static', 'CLERK'), ($1, 3, 'P1_N', 'before_header', 'static', '0')`, [page1]);
  let seq = 10;
  for (const [title, type, expr, value] of REGIONS)
    await owner.query(`insert into meta.region (page_id, seq, title, type, source, condition, condition_type, condition_value) values ($1, $2, $3, 'static', $4, $5, $6, $7)`,
      [page1, seq++, title, `R[${title}]`, expr, type, value]);
  await owner.query(`insert into meta.region (page_id, seq, title, type, source, condition_type) values ($1, 1, 'dialog-only', 'static', 'R[dialog-only]', 'page_is_dialog')`, [page2]);
  // an item, buttons, a validation and dynamic actions with conditions
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type, condition_type) values ($1, $2, 20, 'P1_NEVER', 'text', 'never'), ($1, $2, 21, 'P1_SHOWN', 'text', 'user_public')`, [page1, main]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action, condition_type, condition) values
    ($1, $2, 10, 'SAVE', 'Save', 'submit', null, null), ($1, $2, 20, 'GO', 'Go', 'submit', null, null),
    ($1, $2, 30, 'SECRET', 'Secret', 'submit', 'user_signed_in', null), ($1, $2, 40, 'PLAIN', 'Plain', 'submit', 'item_not_null', 'P1_JOB')`, [page1, main]);
  await owner.query(`insert into meta.validation (page_id, seq, name, type, expression, message, condition_type, condition_value) values
    ($1, 10, 'not on save', 'sql', 'false', 'V[not-on-save]', 'request_not_in', 'SAVE')`, [page1]);
  await owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, action, message, server_condition_type) values
    ($1, 10, 'da-never', 'load', 'alert', 'DA[never]', 'never'), ($1, 20, 'da-public', 'load', 'alert', 'DA[public]', 'user_public')`, [page1]);
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop owned by ${ROLE}`).catch(() => undefined);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

const shown = (body: string) => new Set([...body.matchAll(/R\[([a-z-]+)\]/g)].map((m) => m[1]));

describe('server-side condition types', () => {
  test('regions: each type decides as APEX does', async () => {
    const res = await new Browser(app).get(`/a/${alias}/1`);
    assert.equal(res.statusCode, 200);
    const seen = shown(res.body);
    for (const [title, , , , expected] of REGIONS) assert.equal(seen.has(title), expected, `${title} ${expected ? 'shown' : 'hidden'}`);
    const dialog = await new Browser(app).get(`/a/${alias}/2`);
    assert.ok(shown(dialog.body).has('dialog-only'), 'page_is_dialog holds on a modal page');
  });

  test('items, buttons and dynamic actions that fail their condition are not on the page', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.doesNotMatch(body, /name="P1_NEVER"/);
    assert.match(body, /name="P1_SHOWN"/);
    assert.match(body, /value="SAVE"|data-request="SAVE"|>Save</);
    assert.doesNotMatch(body, />Secret</);
    assert.match(body, />Plain</);
    assert.doesNotMatch(body, /DA\[never\]/);
    assert.match(body, /DA\[public\]/);
  });

  test('a validation runs only when its condition holds (request_not_in SAVE)', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const go = await b.submit(`/a/${alias}/1`, { __request: 'GO' });
    assert.match(go.body, /V\[not-on-save\]/);
    const save = await b.submit(`/a/${alias}/1`, { __request: 'SAVE' });
    assert.doesNotMatch(save.body, /V\[not-on-save\]/);
  });

  test('a button whose condition fails cannot be pressed by a forged request', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    await owner.query(`update meta.validation set condition_value = 'SECRET', condition_type = 'request_in' where page_id = $1`, [page1]);
    try {
      const res = await b.submit(`/a/${alias}/1`, { __request: 'SECRET' });
      assert.doesNotMatch(res.body, /V\[not-on-save\]/, 'SECRET is not a request of this page for the public user');
    } finally {
      await owner.query(`update meta.validation set condition_value = 'SAVE', condition_type = 'request_not_in' where page_id = $1`, [page1]);
    }
  });

  test('the database refuses malformed conditions', async () => {
    const bad: [string, string | null, string | null][] = [
      ['page_in', null, 'one'], ['language_in', null, '12'], ['item_in_list', 'P1_JOB', null], ['item_equals_item', 'P1_JOB', 'p1_other'],
      ['request_not_in', null, 'save;drop'], ['item_zero', 'not an item', null], ['function_body', ' ', null], ['whatever', null, null],
    ];
    for (const [type, expr, value] of bad)
      await assert.rejects(owner.query(`insert into meta.region (page_id, title, type, condition_type, condition, condition_value) values ($1, 'x', 'static', $2, $3, $4)`, [page1, type, expr, value]),
        /region_condition_ok/, `${type} ${expr} ${value}`);
    await assert.rejects(owner.query(`insert into meta.validation (page_id, name, type, message, condition_type) values ($1, 'x', 'sql', 'm', 'page_in')`, [page1]), /validation_condition_ok/);
    await assert.rejects(owner.query(`insert into meta.dynamic_action (page_id, name, action, server_condition_type, server_condition_expr) values ($1, 'x', 'alert', 'item_null', 'x y')`, [page1]), /dynamic_action_server_condition_ok/);
    // a process takes the new types too (its eight-value list is gone)
    const p = await owner.one(`insert into meta.process (page_id, name, type, code, condition_type, condition_value) values ($1, 'p', 'sql', 'select 1', 'language_in', 'nl, pt-br') returning id`, [page1]);
    await owner.query('delete from meta.process where id = $1', [p.id]);
  });
});

describe('the builder and the Advisor', () => {
  const developer = async (lang = 'en') => {
    const b = new Browser(app);
    await owner.query(`update meta.developer set language = $1 where username = 'admin'`, [lang]);
    await b.get(`/builder/login?lang=${lang}`);
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    return b;
  };
  after(() => owner.query(`update meta.developer set language = 'en' where username = 'admin'`));

  test('the Page Designer tree shows each condition in words, in the builder language', async () => {
    let body = (await (await developer()).get(`/builder/apps/${appId}/pages/1`)).body;
    assert.match(body, /title="When P1_JOB is one of CLERK, ANALYST" data-condition="item_in_list"/);
    assert.match(body, /title="When the SQL expression is true" data-condition="sql"/);
    assert.match(body, /title="When the user is signed in" data-condition="user_signed_in"/);
    assert.match(body, /title="On page 1, 3" data-condition="page_in"/);
    body = (await (await developer('de')).get(`/builder/apps/${appId}/pages/1`)).body;
    assert.match(body, /title="Wenn P1_JOB einer von CLERK, ANALYST ist"/);
  });

  test('the property editor lists every type for a region, an item and a dynamic action', async () => {
    const b = await developer();
    const region = (await owner.one(`select id from meta.region where page_id = $1 and title = 'never'`, [page1])).id;
    const body = (await b.get(`/builder/apps/${appId}/pages/1?c=region-${region}`)).body;
    for (const t of ['request_not_in', 'item_in_list', 'page_is_dialog', 'language_in', 'function_body', 'never'])
      assert.match(body, new RegExp(`<option value="${t}"`), t);
    assert.match(body, /<option value="never" selected/);
  });

  test('declarative types for SQL conditions: only exact equivalents', () => {
    assert.deepEqual(declarativeCondition(':P3_ID is not null'), { condition_type: 'item_not_null', condition_expr: 'P3_ID', condition_value: null });
    assert.deepEqual(declarativeCondition(' :P3_ID IS NULL; '), { condition_type: 'item_null', condition_expr: 'P3_ID', condition_value: null });
    assert.deepEqual(declarativeCondition(":REQUEST in ('SAVE', 'CREATE')"), { condition_type: 'request_in', condition_expr: null, condition_value: 'SAVE,CREATE' });
    assert.deepEqual(declarativeCondition(":REQUEST = 'SAVE'"), { condition_type: 'request_in', condition_expr: null, condition_value: 'SAVE' });
    assert.deepEqual(declarativeCondition(":P2_JOB in ('CLERK','ANALYST')"), { condition_type: 'item_in_list', condition_expr: 'P2_JOB', condition_value: 'CLERK:ANALYST' });
    assert.deepEqual(declarativeCondition(":P2_JOB = 'O''Brien'"), { condition_type: 'item_equals', condition_expr: 'P2_JOB', condition_value: "O'Brien" });
    // not the same in SQL (an empty item makes them null), or more than one bind: stays SQL
    for (const s of [":P2_JOB <> 'X'", ":P2_JOB not in ('A')", ":P2_JOB in ('A:B')", ":P2_JOB = ''", ':P2_A = :P2_B', ":P2_A = 'x' and :P2_B is null", ':p2_x is null'])
      assert.equal(declarativeCondition(s), null, s);
  });

  test('the Advisor offers the declarative type for a SQL condition that is one', async () => {
    // the order of the findings follows the rows, which an upgraded database may return the other way round
    const found = (await advise(appId)).findings.filter((f) => f.field === 'Server-side condition')
      .sort((x, y) => String(x.entry?.label).localeCompare(String(y.entry?.label)));
    assert.deepEqual(found.map((f) => [f.severity, f.entry?.label]), [['info', 'plain-sql'], ['info', 'plain-sql-false']]);
    assert.match(found[0].message, /The SQL condition :P1_JOB = 'CLERK' can be the condition type item_equals \(expression P1_JOB, value CLERK\)/);
  });
});
