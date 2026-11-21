// The JSON form region (sprint 246, MG-19, migration 203): a form drawn from a JSON schema, its answers posted as one
// JSON value into a page item and checked against the schema on the server. HR page 74 (examples/hr/hr_110_json_form.sql)
// is the fixture: the "Workplace inspection" and "Company car check" schemas of hr.form_template.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { answersFromBody, checkJsonForm, parseSchema } from '../src/runtime/json-form.ts';
import { english } from '../src/i18n.ts';
import { regionConfigHelp } from '../src/builder/region-help.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let rid: number;
let saved: number;
const tpl: Record<string, string> = {};

before(async () => {
  app = await buildApp({ logger: false });
  const r = await owner.one(`select r.id, (select x.id from meta.region x where x.page_id = p.id and x.static_id = 'jf-saved') as saved
                               from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                              where a.alias = 'hr' and p.page_no = 74 and r.static_id = 'jf-form'`);
  rid = r.id;
  saved = r.saved;
  for (const x of (await owner.query('select id, name from hr.form_template')).rows) tpl[x.name] = String(x.id);
  await owner.query(`delete from hr.form_answer where username in ('KING', 'ALLEN', 'king', 'allen')`);
});

after(async () => {
  await owner.query(`delete from hr.form_answer where username in ('KING', 'ALLEN', 'king', 'allen')`);
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}
const P = () => `jf${rid}:`;
const t = english;

const SCHEMA = {
  type: 'object',
  'x-order': ['name', 'age', 'kind'],
  required: ['name'],
  properties: {
    kind: { type: 'string', enum: ['a', 'b'], 'x-enum-labels': ['Alpha', 'Beta'] },
    age: { type: 'integer', minimum: 0, maximum: 120, title: 'Age' },
    name: { type: 'string', title: 'Name', maxLength: 5 },
    tags: { type: 'array', items: { enum: [1, 2, 3] }, maxItems: 2 },
    ok: { type: 'boolean' },
    when: { type: 'string', format: 'date' },
    at: { type: 'string', format: 'date-time' },
    hour: { type: 'string', format: 'time' },
    mail: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    pick: { type: 'integer', oneOf: [{ const: 10, title: 'Ten' }, { const: 20, title: 'Twenty' }], 'x-widget': 'radio' },
    lines: { type: 'array', minItems: 1, items: { type: 'object', required: ['q'], properties: { q: { type: 'number' }, note: { type: 'string', 'x-widget': 'textarea' } } } },
    fixed: { type: 'string', readOnly: true },
    blob: { type: 'string', contentMediaType: 'image/png', 'x-order': 99 },
    nested: { type: 'object', properties: { inner: { type: 'string' } } },
  },
};

describe('json form: schema, answers and the check', () => {
  test('fields follow x-order, then the rest; each property gets its kind', () => {
    const fields = parseSchema(SCHEMA);
    assert.deepEqual(fields.slice(0, 3).map((f) => f.key), ['name', 'age', 'kind']);
    const kind = Object.fromEntries(fields.map((f) => [f.key, f.kind]));
    assert.deepEqual(kind, {
      name: 'text', age: 'integer', kind: 'select', tags: 'checkboxes', ok: 'boolean', when: 'date', at: 'datetime', hour: 'time', mail: 'email',
      site: 'url', pick: 'radio', lines: 'rows', fixed: 'text', blob: 'text', nested: 'group',
    });
    assert.deepEqual(fields.find((f) => f.key === 'kind')!.options, [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]);
    assert.deepEqual(fields.find((f) => f.key === 'pick')!.options, [{ value: 10, label: 'Ten' }, { value: 20, label: 'Twenty' }]);
    assert.deepEqual(parseSchema('not a schema'), []);
    assert.deepEqual(parseSchema({ type: 'object', properties: { a: 'x' } }), []);
  });

  test('answers are built from the schema only: choices keep their type, rows drop empty and removed ones, read-only keeps the stored value', () => {
    const fields = parseSchema(SCHEMA);
    const body = {
      'f:name': ' Ann ', 'f:age': '42', 'f:kind': 'b', 'f:tags': ['1', '3'], 'f:ok': 'true', 'f:pick': '20', 'f:fixed': 'forged',
      'f:lines/0/q': '1.5', 'f:lines/3/q': '2', 'f:lines/3/#remove': '1', 'f:lines/7/q': '', 'f:lines/7/note': '', 'f:lines/9/note': 'a\r\nb',
      'f:nested/inner': 'x', 'f:other': 'ignored', 'P1_SOMETHING': 'ignored',
    };
    const out = answersFromBody(fields, body, 'f:', { fixed: 'stored', other: 'kept?' });
    assert.deepEqual(out, {
      name: 'Ann', age: 42, kind: 'b', tags: [1, 3], ok: true, pick: 20, fixed: 'stored',
      lines: [{ q: 1.5 }, { note: 'a\nb' }], nested: { inner: 'x' },
    });
  });

  test('the check: required, enum, types, ranges, lengths, formats and counts, at each posted field name', () => {
    const fields = parseSchema(SCHEMA);
    const errors = checkJsonForm(fields, {
      age: 121, kind: 'c', tags: [1, 2, 3], ok: 'yes', when: '2024-02-30', at: '2024-01-01 10:00', hour: '25:00', mail: 'nope', site: 'javascript:alert(1)',
      pick: '10', lines: [{ note: 'no q' }, { q: 'x' }], nested: { inner: 5 },
    }, 'f:', t);
    assert.deepEqual(Object.keys(errors).sort(), [
      'f:age', 'f:at', 'f:hour', 'f:kind', 'f:lines/0/q', 'f:lines/1/q', 'f:mail', 'f:name', 'f:nested/inner', 'f:ok', 'f:pick', 'f:site', 'f:tags', 'f:when',
    ].sort());
    assert.equal(errors['f:name'], 'Name is required.');
    assert.equal(errors['f:age'], 'Age must be at most 120.');
    assert.match(errors['f:kind'], /choose a value from the list/);
    assert.match(errors['f:tags'], /choose at most 2/);
    assert.deepEqual(checkJsonForm(fields, { name: 'Ann', lines: [{ q: 1 }], tags: [1, 2], age: 0, pick: 10, at: '2024-01-01T10:00', hour: '09:30', site: 'https://example.com/x', mail: 'a@b.nl', when: '2024-02-29' }, 'f:', t), {});
    assert.match(checkJsonForm(fields, { name: 'Annabel', lines: [{ q: 1 }] }, 'f:', t)['f:name'], /at most 5 characters/);
    assert.match(checkJsonForm(fields, { name: 'A', lines: [] }, 'f:', t)['f:lines'], /at least 1 rows/);
    assert.match(checkJsonForm(fields, { name: 'A', lines: [{ q: 1 }], age: 1.5 }, 'f:', t)['f:age'], /whole number/);
  });

  test('the region type is registered: Page Designer help names its attributes', () => {
    assert.match(regionConfigHelp('json_form').text, /"item"/);
    assert.match(String(regionConfigHelp('json_form').url), /pages-and-regions#json_form/);
  });
});

describe('json form region on HR page 74', () => {
  test('renders the schema as fields: labels and choices escaped, rows with a template and empty rows without JavaScript', async () => {
    const king = await as('king');
    const res = await king.get('/a/hr/74');
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.match(body, /data-json-form=/);
    assert.match(body, new RegExp(`name="${P()}location"`));
    assert.match(body, new RegExp(`type="radio"[^>]*name="${P()}overall" value="good"`));
    assert.match(body, new RegExp(`type="checkbox"[^>]*name="${P()}hazards" value="trip"`));
    assert.match(body, new RegExp(`type="date"[^>]*name="${P()}inspected_on"`));
    assert.match(body, new RegExp(`type="time"[^>]*name="${P()}start_time"`));
    assert.match(body, new RegExp(`type="datetime-local"[^>]*name="${P()}signed_off_at"`));
    assert.match(body, new RegExp(`type="number"[^>]*name="${P()}score"[^>]*min="0" max="10"`));
    assert.match(body, new RegExp(`name="${P()}contact/name"`));
    assert.match(body, /<template data-jf-template>[\s\S]*name="jf\d+:actions\/__i__\/what"/);
    assert.match(body, /<noscript>[\s\S]*name="jf\d+:actions\/0\/what"[\s\S]*name="jf\d+:actions\/1\/what"[\s\S]*<\/noscript>/);
    // the saved answers region shows once there are some
    assert.doesNotMatch(body, new RegExp(`id="R${saved}"`));
  });

  test('a valid submit stores the answers as one JSON value; the read-only region shows them', async () => {
    const king = await as('king');
    await king.get('/a/hr/74');
    const res = await king.submit('/a/hr/74', {
      __request: 'SAVE', P74_TEMPLATE: tpl['Workplace inspection'],
      [`${P()}location`]: 'B2.14', [`${P()}department`]: '20', [`${P()}inspected_on`]: '2026-11-20', [`${P()}overall`]: 'fair',
      [`${P()}hazards`]: ['trip', 'fire'], [`${P()}score`]: '7', [`${P()}fire_exits_clear`]: 'true',
      [`${P()}actions/0/what`]: 'Fix the cable', [`${P()}actions/0/due`]: '2026-12-01', [`${P()}actions/1/what`]: '',
    });
    assert.equal(res.statusCode, 303, res.body.slice(0, 2000));
    const row = await owner.one(`select answers from hr.form_answer where upper(username) = 'KING' and template_id = $1`, [tpl['Workplace inspection']]);
    assert.deepEqual(row.answers, {
      location: 'B2.14', department: 20, inspected_on: '2026-11-20', overall: 'fair', hazards: ['trip', 'fire'], score: 7,
      fire_exits_clear: true, contact: {}, actions: [{ what: 'Fix the cable', due: '2026-12-01', done: false }],
    });
    const page = (await king.get('/a/hr/74')).body;
    const savedRegion = page.slice(page.indexOf(`id="R${saved}"`));
    assert.match(savedRegion, /Fair/);
    assert.match(savedRegion, /Fix the cable/);
    assert.doesNotMatch(savedRegion.slice(0, savedRegion.indexOf('</section>')), /<input[^>]*name="jf/);
    // the form starts from the stored answers
    assert.match(page, new RegExp(`name="${P()}location" value="B2.14"`));
  });

  test('a submit that fails the check comes back with the errors at the fields and the typed values', async () => {
    const allen = await as('allen');
    await allen.get('/a/hr/74');
    const res = await allen.submit('/a/hr/74', {
      __request: 'SAVE', P74_TEMPLATE: tpl['Workplace inspection'],
      [`${P()}location`]: '<b>x</b>', [`${P()}inspected_on`]: '2026-13-01', [`${P()}score`]: '11',
      [`${P()}actions/0/owner`]: 'Ann',
    });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Overall condition is required\./);
    assert.match(res.body, /Score \(0–10\) must be at most 10\./);
    assert.match(res.body, /Inspection date must be a valid date\./);
    assert.match(res.body, /What is required\./);
    assert.match(res.body, new RegExp(`name="${P()}location" value="&lt;b&gt;x&lt;/b&gt;"`));
    assert.match(res.body, new RegExp(`name="${P()}actions/0/owner" value="Ann"`));
    assert.equal((await owner.query(`select 1 from hr.form_answer where upper(username) = 'ALLEN'`)).rowCount, 0);
  });

  test('another form of the list: the region follows the item (submit on change)', async () => {
    const king = await as('king');
    await king.get('/a/hr/74');
    const res = await king.submit('/a/hr/74', { P74_TEMPLATE: tpl['Company car check'] });
    assert.equal(res.statusCode, 303);
    const page = (await king.get('/a/hr/74')).body;
    assert.match(page, new RegExp(`name="${P()}plate"`));
    assert.doesNotMatch(page, new RegExp(`name="${P()}location"`));
  });
});
