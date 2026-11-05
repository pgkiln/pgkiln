// Sprint 155 (CD-1; APEX: Validation types): APEX's validation types, each tested on a submitted value; an
// authorization scheme, Always execute (also for DELETE) and the error's display location; the database refuses a
// validation without the item or expression its type needs.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise } from '../src/builder/advisor.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page: number;
const alias = 'val-s155';
const ROLE = 'pgkiln_s155_val';

/** [type, expression, submitted value, fails?] — each case gets its own item P1_C<n> and message V[<n>] */
const CASES: [string, string | null, string, boolean][] = [
  ['sql', 'false', 'x', true],
  ['sql', ':P1_C1 = \'x\'', 'x', false],
  ['exists', 'select 1 where false', 'x', true],
  ['exists', 'select 1', 'x', false],
  ['not_exists', 'select 1', 'x', true],
  ['function_body', 'return false;', 'x', true],
  ['function_body', 'return true;', 'x', false],
  ['not_null', null, '', true],
  ['not_null', null, 'x', false],
  ['not_null_or_zero', null, '0', true],
  ['not_null_or_zero', null, '', true],
  ['not_zero', null, '0.0', true],
  ['not_zero', null, '', false],
  ['no_spaces', null, 'a b', true],
  ['no_spaces', null, 'ab', false],
  ['alphanumeric', null, 'ab-1', true],
  ['alphanumeric', null, 'Äb1', false],
  ['numeric', null, '12a', true],
  ['numeric', null, '-1.5', false],
  ['numeric', null, '', false],
  ['valid_date', null, '2026-02-30', true],
  ['valid_date', null, '2026-02-28', false],
  ['valid_timestamp', null, '2026-01-01 25:00', true],
  ['valid_timestamp', null, '2026-01-01T10:30', false],
  ['equals', 'X', 'Y', true],
  ['equals', 'X', 'X', false],
  ['not_equals', 'X', 'X', true],
  ['not_equals', 'X', '', false],
  ['in_list', 'A:B', 'C', true],
  ['in_list', 'A:B', 'B', false],
  ['in_list', 'A:B', '', true],
  ['not_in_list', 'A:B', 'A', true],
  ['not_in_list', 'A:B', 'C', false],
  ['chars_only', '0123456789', '12a', true],
  ['chars_only', '0123456789', '120', false],
  ['chars_any', '@', 'abc', true],
  ['chars_any', '@', 'a@c', false],
  ['chars_none', '<>', 'a<b', true],
  ['chars_none', '<>', 'ab', false],
  ['regex', '^[A-Z]+$', 'abc', true],
  ['regex', '^[A-Z]+$', 'ABC', false],
];

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role, date_format) values ($1, 'Validations', 'none', $2, 'DD.MM.YYYY') returning id`, [alias, ROLE])).id;
  page = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [page])).id;
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 1, 'SAVE', 'Save'), ($1, $2, 2, 'DELETE', 'Delete')`, [page, r]);
  for (const [n, [type, expression]] of CASES.entries()) {
    await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, $3, $4, 'text')`, [page, r, 10 + n, `P1_C${n}`]);
    await owner.query(`insert into meta.validation (page_id, seq, name, item_name, type, expression, message) values ($1, $2, $3, $4, $5, $6, $7)`,
      [page, 10 + n, `case ${n}`, `P1_C${n}`, type, expression, `V[${n}]`]);
  }
  // function_error: the body's text is the message
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, 900, 'P1_FE', 'text')`, [page, r]);
  await owner.query(`insert into meta.validation (page_id, seq, name, item_name, type, expression, message) values ($1, 900, 'fe', 'P1_FE', 'function_error', $2, 'unused')`,
    [page, `begin if :P1_FE = 'bad' then return 'FE[' || :P1_FE || ']'; end if; return null; end`]);
  // authorization, Always execute, display location
  await owner.query(`insert into meta.validation (page_id, seq, name, type, expression, message, authz, always_execute) values
    ($1, 950, 'authz', 'sql', 'false', 'X[authz]', 'MUST_NOT_BE_PUBLIC_USER', false),
    ($1, 951, 'always', 'sql', 'false', 'X[always]', null, true),
    ($1, 952, 'not always', 'sql', 'false', 'X[not-always]', null, false)`, [page]);
  for (const [n, loc] of ['notification', 'inline_and_notification', 'inline'].entries()) {
    await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, $3, $4, 'text')`, [page, r, 960 + n, `P1_D${n}`]);
    await owner.query(`insert into meta.validation (page_id, seq, name, item_name, type, message, display_location) values ($1, $2, $3, $4, 'not_null', $5, $6)`,
      [page, 960 + n, `d${n}`, `P1_D${n}`, `D[${loc}]`, loc]);
  }
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

const submit = async (request: string, values: Record<string, string>) => {
  const b = new Browser(app);
  await b.get(`/a/${alias}/1`);
  return (await b.submit(`/a/${alias}/1`, { ...values, __request: request })).body;
};
const messagesOf = (body: string) => /<div class="messages"[\s\S]*?<\/div>\s*<form/.exec(body)?.[0] ?? '';

describe('validation types', () => {
  test('each type passes or fails as APEX\'s does', async () => {
    const body = await submit('SAVE', { ...Object.fromEntries(CASES.map(([, , v], n) => [`P1_C${n}`, v])), P1_FE: 'bad', P1_D0: 'x', P1_D1: 'x', P1_D2: 'x' });
    for (const [n, [type, expr, v, fails]] of CASES.entries())
      assert.equal(body.includes(`V[${n}]`), fails, `${type} ${expr ?? ''} with "${v}" ${fails ? 'fails' : 'passes'}`);
    assert.match(body, /FE\[bad\]/, 'function_error: the returned text is the message');
    assert.doesNotMatch(body, /unused/);
  });

  test('valid_date reads the application\'s date format', async () => {
    const i = CASES.findIndex(([t, , v]) => t === 'valid_date' && v === '2026-02-28');
    const body = await submit('SAVE', { [`P1_C${i}`]: '28.02.2026', P1_D0: 'x', P1_D1: 'x', P1_D2: 'x' });
    assert.doesNotMatch(body, new RegExp(`V\\[${i}\\]`));
    assert.match(await submit('SAVE', { [`P1_C${i}`]: '31.02.2026' }), new RegExp(`V\\[${i}\\]`));
  });

  test('an authorization scheme skips it for others; Always execute runs it for DELETE too', async () => {
    const save = await submit('SAVE', {});
    assert.doesNotMatch(save, /X\[authz\]/, 'the public user fails MUST_NOT_BE_PUBLIC_USER: not validated');
    assert.match(save, /X\[always\]/);
    assert.match(save, /X\[not-always\]/);
    const del = await submit('DELETE', {});
    assert.match(del, /X\[always\]/);
    assert.doesNotMatch(del, /X\[not-always\]/);
    assert.doesNotMatch(del, /V\[\d+\]/, 'the item validations are skipped for DELETE');
  });

  test('display location: the notification, inline and the notification, inline only', async () => {
    const body = await submit('SAVE', {});
    const top = messagesOf(body);
    const rest = body.replace(top, '');
    assert.match(top, /D\[notification\]/);
    assert.doesNotMatch(rest, /D\[notification\]/);
    assert.match(top, /D\[inline_and_notification\]/);
    assert.match(rest, /D\[inline_and_notification\]/);
    assert.doesNotMatch(top, /D\[inline\]/);
    assert.match(rest, /D\[inline\]/);
  });

  test('the database refuses a type without its item or expression', async () => {
    for (const [type, item, expr] of [['equals', null, 'X'], ['in_list', 'P1_C0', null], ['exists', null, ' '], ['numeric', 'p1_c0', null], ['valid_time', 'P1_C0', null]] as const)
      await assert.rejects(owner.query(`insert into meta.validation (page_id, name, type, item_name, expression, message) values ($1, 'x', $2, $3, $4, 'm')`, [page, type, item, expr]),
        /validation_type/, `${type} ${item} ${expr}`);
  });

  test('the Advisor offers a type for a SQL validation that is one', async () => {
    const v = (await owner.one(`insert into meta.validation (page_id, seq, name, type, expression, message) values ($1, 999, 'sql nn', 'sql', ':P1_C0 is not null', 'm') returning id`, [page])).id;
    try {
      const found = (await advise(appId)).findings.filter((f) => f.entry?.kind === 'validation' && f.field === 'Type');
      assert.deepEqual(found.map((f) => f.entry?.label).sort(), ['case 1', 'sql nn'], JSON.stringify(found.map((f) => f.message)));
      assert.ok(found.some((f) => /The SQL validation :P1_C0 is not null can be the type not_null with associated item P1_C0: no query/.test(f.message)));
      assert.ok(found.some((f) => /can be the type equals with associated item P1_C1 and value x/.test(f.message)));
    } finally {
      await owner.query('delete from meta.validation where id = $1', [v]);
    }
  });
});
