// SQL Workshop → Sample Data (sprint 35): generators proposed from the
// catalog, seeded generation, preview (rolled back), insert in one
// transaction (parents first), SQL and CSV downloads, saved definitions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { unzipSync, strFromU8 } from 'fflate';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { cleanDef, describe as describeTable, generateAll, maker, parseAfter, parseCheck, plan, propose, rng, tableSpec, type ColumnInfo } from '../src/sampledata.ts';
import { defFromBody } from '../src/builder/sampledata.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
const S = 'ws_sd';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S};
    create type ${S}.tier as enum ('bronze', 'silver', 'gold');
    create table ${S}.customer (
      id int generated always as identity primary key,
      first_name text not null, last_name text not null, email varchar(60) not null unique, phone text,
      tier ${S}.tier, status text not null default 'NEW' check (status in ('NEW', 'ACTIVE', 'CLOSED')),
      score int check (score between 1 and 5), created timestamptz not null default now(),
      initials text generated always as (left(first_name, 1) || left(last_name, 1)) stored);
    create table ${S}.orders (
      order_no serial primary key, customer_id int not null references ${S}.customer, ordered date not null, shipped date,
      amount numeric(8,2) check (amount >= 0), note text, "odd col" text, check (shipped >= ordered));
    create table ${S}.country (code char(2) primary key, name text not null unique);
    create table ${S}.parent0 (id int primary key);
    create table ${S}.lonely (id int primary key, parent_id int not null references ${S}.parent0);`);
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
});

after(async () => {
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`delete from meta.data_generator where schema_name = $1`, [S]);
  await app.close();
  await closePools();
});

const count = async (t: string) => (await owner.one(`select count(*)::int as n from ${S}.${t}`)).n as number;

/** The generator form's fields, as the browser would post them. */
function fields(body: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const add = (k: string, v: string) => {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  };
  const form = body.slice(body.indexOf('<form method="post" action="/builder/sql/sample-data">'));
  const un = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const m of form.matchAll(/<input ([^>]*)>/g)) {
    const name = /name="([^"]+)"/.exec(m[1])?.[1];
    if (!name || name === '__csrf') continue;
    add(name, un(/value="([^"]*)"/.exec(m[1])?.[1] ?? ''));
  }
  for (const m of form.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) add(m[1], /<option value="([^"]+)" selected>/.exec(m[2])?.[1] ?? '');
  return out;
}

const setGen = (f: Record<string, string | string[]>, column: string, generator: string, options?: string, nulls?: string) => {
  const key = Object.keys(f).find((k) => k.startsWith('c_') && f[k] === column)!;
  const id = key.slice(2);
  f[`g_${id}`] = generator;
  if (options !== undefined) f[`o_${id}`] = options;
  if (nulls !== undefined) f[`n_${id}`] = nulls;
};

const form = async (tables: string[]) => {
  const res = await dev.get(`/builder/sql/sample-data?schema=${S}&${tables.map((t) => `t=${t}`).join('&')}`);
  assert.equal(res.statusCode, 200);
  return { body: res.body, f: fields(res.body) };
};

describe('Sample Data: proposals and generators', () => {
  test('CHECK constraints: ranges, value lists, lengths and column comparisons', () => {
    assert.deepEqual(parseCheck('CHECK (((score >= 1) AND (score <= 5)))', 'score'), { min: 1, max: 5, maxLength: undefined });
    assert.deepEqual(parseCheck(`CHECK ((status = ANY (ARRAY['NEW'::text, 'O''K'::text])))`, 'status').values, ['NEW', "O'K"]);
    assert.deepEqual(parseCheck(`CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))`, 'kind').values, ['a', 'b']);
    assert.equal(parseCheck('CHECK ((amount > (0)::numeric))', 'amount').min, 1);
    assert.equal(parseCheck('CHECK ((basal >= 0))', 'sal').min, undefined, 'another column ending in the same letters');
    assert.equal(parseCheck('CHECK ((length(code) <= 10))', 'code').maxLength, 10);
    assert.deepEqual(parseCheck('CHECK (("odd col" >= 3))', 'odd col').min, 3);
    assert.deepEqual(parseAfter('CHECK ((shipped >= ordered))', 'shipped', 'ordered'), { column: 'ordered', strict: false });
    assert.deepEqual(parseAfter('CHECK ((a < b))', 'b', 'a'), { column: 'a', strict: true });
    assert.equal(parseAfter('CHECK ((shipped >= ordered))', 'ordered', 'shipped'), null);
  });

  test('describe() reads identity, generated, serial, enum, unique, checks and foreign keys; propose() follows names and types', async () => {
    const c = (await describeTable(owner.pool, S, 'customer'))!;
    const col = (n: string) => c.columns.find((x) => x.name === n)!;
    assert.equal(col('id').auto, 'identity');
    assert.equal(col('id').noInsert, true);
    assert.equal(col('initials').auto, 'generated');
    assert.deepEqual(col('tier').values, ['bronze', 'silver', 'gold']);
    assert.equal(col('email').unique, true);
    assert.equal(col('email').maxLength, 60);
    const o = (await describeTable(owner.pool, S, 'orders'))!;
    assert.equal(o.columns.find((x) => x.name === 'order_no')!.auto, 'serial');
    assert.deepEqual(o.fks.map((f) => [f.columns, f.refTable, f.refColumns]), [[['customer_id'], 'customer', ['id']]]);
    const today = new Date('2026-10-05T00:00:00Z');
    const spec = Object.fromEntries(tableSpec(c, 20, undefined, today).columns.map((x) => [x.column, `${x.generator} ${x.options}`.trim()]));
    assert.deepEqual(spec, {
      id: 'skip', first_name: 'first_name', last_name: 'last_name', email: 'email', phone: 'phone', tier: 'list bronze, silver, gold',
      status: 'list NEW, ACTIVE, CLOSED', score: 'integer 1..5', created: 'timestamp 2024-10-05..2026-10-05', initials: 'skip',
    });
    const os = Object.fromEntries(tableSpec(o, 20, undefined, today).columns.map((x) => [x.column, `${x.generator} ${x.options}`.trim()]));
    assert.equal(os.order_no, 'skip');
    assert.equal(os.customer_id, 'foreign_key');
    assert.equal(os.shipped, 'date ordered + 0..14');
    assert.equal(os.amount, 'decimal 10.00..10000.00');
    assert.equal(os.note, 'sentence 4..12');
    const base = { type: 'text', base: 'text', array: false, notNull: false, default: null, auto: null, noInsert: false, maxLength: null, precision: null, scale: null, values: null, min: null, max: null, unique: false, fk: null, after: null } as ColumnInfo;
    assert.equal(propose({ ...base, name: 'birth_date', base: 'date' }, today).options, '1956-10-05..2008-10-05');
    assert.equal(propose({ ...base, name: 'country_code', maxLength: 2, base: 'bpchar' }).generator, 'code');
    assert.equal(propose({ ...base, name: 'id', base: 'int4', unique: true }, today, 42).options, '42');
    assert.equal(propose({ ...base, name: 'created_by' }).generator, 'username');
    assert.equal(propose({ ...base, name: 'payload', base: 'jsonb', notNull: true }).generator, 'fixed');
  });

  test('options are checked; the same seed gives the same values and columns have streams of their own', async () => {
    const c = { name: 'x', base: 'int4', maxLength: null, scale: null } as ColumnInfo;
    for (const [generator, options] of [['integer', '5..1'], ['integer', 'a..b'], ['date', '2026-13-45..2026-01-01'], ['list', ' , '], ['sequence', '1, 0'], ['boolean', '150'], ['words', '0..2'], ['time', '25:00..26:00']])
      assert.equal(typeof maker({ column: 'x', generator: generator as any, options, nulls: 0 }, c), 'string', `${generator} ${options}`);
    assert.equal(typeof maker({ column: 'x', generator: 'date', options: 'start + 0..3', nulls: 0 }, c, []), 'string', 'relative to an unknown column');
    const r1 = rng(7);
    const r2 = rng(7);
    assert.deepEqual([r1(), r1(), r1()], [r2(), r2(), r2()]);
    const def = cleanDef({ schema: S, seed: 99, tables: [{ table: 'customer', rows: 30, columns: [] }] });
    const c1 = (await describeTable(owner.pool, S, 'customer'))!;
    def.tables[0] = tableSpec(c1, 30);
    const a = await generateAll(owner.pool, (await plan(owner.pool, def)).tables, 99);
    const b = await generateAll(owner.pool, (await plan(owner.pool, def)).tables, 99);
    assert.deepEqual(a, b, 'same seed');
    const other = await generateAll(owner.pool, (await plan(owner.pool, def)).tables, 100);
    assert.notDeepEqual(a[0].rows, other[0].rows, 'another seed');
    // changing the phone column leaves the others alone
    def.tables[0].columns.find((x) => x.column === 'phone')!.generator = 'word';
    const changed = await generateAll(owner.pool, (await plan(owner.pool, def)).tables, 99);
    const idx = (n: string) => a[0].columns.indexOf(n);
    assert.deepEqual(changed[0].rows.map((r) => r[idx('email')]), a[0].rows.map((r) => r[idx('email')]));
    assert.notDeepEqual(changed[0].rows.map((r) => r[idx('phone')]), a[0].rows.map((r) => r[idx('phone')]));
    // names and e-mail addresses of a row belong together, e-mail addresses are unique and fit varchar(60)
    for (const r of a[0].rows) {
      const [first, last, email] = [r[idx('first_name')]!, r[idx('last_name')]!, r[idx('email')]!];
      assert.ok(email.startsWith(`${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z0-9]/g, '')}`), `${first} ${last} ${email}`);
      assert.match(email, /@example\.(com|org|net)$/);
      assert.ok(email.length <= 60);
    }
    assert.equal(new Set(a[0].rows.map((r) => r[idx('email')])).size, 30);
  });

  test('defFromBody reads the posted form; cleanDef never trusts the shape', () => {
    const d = defFromBody({ schema: S, seed: '12', t: 'customer', rows_0: '5', c_0_0: 'first_name', g_0_0: 'first_name', o_0_0: '', n_0_0: '150', c_0_1: 'x', g_0_1: '__proto__' } as any);
    assert.equal(d.seed, 12);
    assert.deepEqual(d.tables[0].columns, [{ column: 'first_name', generator: 'first_name', options: '', nulls: 100 }, { column: 'x', generator: 'skip', options: '', nulls: 0 }]);
    assert.equal(cleanDef({ seed: -1 }).seed, null);
    assert.equal(cleanDef({ seed: 2 ** 33 }).seed, null);
    assert.deepEqual(cleanDef({ tables: 'x' }).tables, []);
  });
});

describe('Sample Data: the builder pages', () => {
  test('the workshop tab, the schema and table steps; meta and system schemas are not offered', async () => {
    const res = await dev.get('/builder/sql/sample-data');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /href="\/builder\/sql\/sample-data" aria-current="page"/);
    assert.match(res.body, new RegExp(`<option value="${S}">`));
    assert.doesNotMatch(res.body, /<option value="(meta|information_schema|pg_catalog)"/);
    const step2 = await dev.get(`/builder/sql/sample-data?schema=${S}`);
    assert.match(step2.body, /name="t" value="customer"/);
    assert.match(step2.body, /name="t" value="orders"/);
    assert.match((await dev.get('/builder/sql')).body, /href="\/builder\/sql\/sample-data"/);
  });

  test('preview inserts and rolls back, fills in the seed; insert adds parents first in one transaction', async () => {
    const { body, f } = await form(['orders', 'customer']);
    assert.match(body, /<strong>customer_id<\/strong><span class="muted small">integer · not null · → ws_sd\.customer\(id\)/);
    f.rows_0 = '25';
    f.rows_1 = '6';
    setGen(f, 'note', 'fixed', `it's "quoted" <b>bold</b>`, '50');
    const preview = await dev.submit('/builder/sql/sample-data', { ...f, action: 'preview' });
    assert.equal(preview.statusCode, 200, preview.body.slice(0, 2000));
    assert.match(preview.body, /Rolled back: nothing was saved/);
    assert.match(preview.body, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.equal(await count('customer'), 0);
    assert.equal(await count('orders'), 0);
    const seed = /name="seed" value="(\d+)"/.exec(preview.body)?.[1];
    assert.ok(seed, 'the seed is filled in');
    const emails = (page: string) => [.../<h3 class="u-mt1">customer[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(page)![1].matchAll(/<td>([^<]+@example\.\w+)<\/td>/g)].map((m) => m[1]);
    const previewed = emails(preview.body);
    assert.equal(previewed.length, 6);

    const ins = await dev.submit('/builder/sql/sample-data', { ...fields(preview.body), action: 'insert' });
    assert.equal(ins.statusCode, 200);
    assert.match(ins.body, /customer: 6 row\(s\), orders: 25 row\(s\) inserted/);
    assert.equal(await count('customer'), 6);
    assert.equal(await count('orders'), 25);
    // the same seed: the same names as in the preview (identity values differ)
    assert.deepEqual(emails(ins.body), previewed);
    // constraints hold: foreign keys to the new customers, shipped after ordered, unique e-mail addresses
    assert.equal((await owner.one(`select count(*)::int as n from ${S}.orders o join ${S}.customer c on c.id = o.customer_id`)).n, 25);
    assert.equal((await owner.one(`select count(*)::int as n from ${S}.orders where shipped < ordered`)).n, 0);
    assert.equal((await owner.one(`select count(*) filter (where note is null)::int as nulls, count(*) filter (where note = $1)::int as fixed from ${S}.orders`, [`it's "quoted" <b>bold</b>`])).fixed > 0, true);
    const log = await owner.one(`select detail from meta.activity_log where event = 'sample_data' order by id desc limit 1`);
    assert.match(log.detail, new RegExp(`${S}, seed ${seed}: customer 6, orders 25`));

    // a second run continues: new unique e-mail addresses next to the existing ones
    const again = await dev.submit('/builder/sql/sample-data', { ...fields(ins.body), action: 'insert' });
    assert.match(again.body, /inserted/);
    assert.equal(await count('customer'), 12);
  });

  test('an error rolls back the whole run and is shown', async () => {
    const before = await count('customer');
    const { f } = await form(['customer', 'orders']);
    f.rows_0 = '3';
    f.rows_1 = '3';
    setGen(f, 'amount', 'fixed', '-5');
    const res = await dev.submit('/builder/sql/sample-data', { ...f, action: 'insert' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Nothing was inserted: the transaction was rolled back\. orders: new row for relation &quot;orders&quot; violates check constraint/);
    assert.equal(await count('customer'), before, 'the parents are rolled back too');
    // problems found before running: NOT NULL with nulls, GENERATED ALWAYS, bad options, too many rows
    setGen(f, 'amount', 'decimal', '1..2');
    setGen(f, 'ordered', 'date', '2026-01-01..2026-01-31', '10');
    setGen(f, 'first_name', 'integer', 'abc');
    f.rows_1 = '999999999';
    const bad = await dev.submit('/builder/sql/sample-data', { ...f, action: 'preview' });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /orders\.ordered is NOT NULL: nulls must be 0%/);
    assert.match(bad.body, /customer\.first_name \(Whole number \(range\)\): min\.\.max with whole numbers/);
    assert.match(bad.body, /At most 100,000 rows in one run/);
    const g = fields((await form(['customer'])).body);
    setGen(g, 'id', 'integer', '1..10');
    assert.match((await dev.submit('/builder/sql/sample-data', { ...g, action: 'preview' })).body, /customer\.id is GENERATED ALWAYS AS IDENTITY: it can only be skipped/);
  });

  test('a NOT NULL foreign key to an empty parent explains what to do', async () => {
    const { f } = await form(['lonely']);
    const res = await dev.submit('/builder/sql/sample-data', { ...f, action: 'preview' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /lonely\.parent_id: ws_sd\.parent0 has no rows to refer to\. Generate parent0 in the same run/);
    // with the parent in the same run it works, the parent's key is a sequence
    const both = await form(['lonely', 'parent0']);
    const ok = await dev.submit('/builder/sql/sample-data', { ...both.f, action: 'insert' });
    assert.equal(ok.statusCode, 200);
    assert.equal(await count('lonely'), 20);
    assert.equal(await count('parent0'), 20);
  });

  test('downloads: SQL (same seed, same file; runs as a script) and CSV (one file, or a zip per table)', async () => {
    await owner.query(`delete from ${S}.orders`);
    const { f } = await form(['country']);
    f.seed = '4242';
    f.rows_0 = '5';
    setGen(f, 'code', 'code', 'AA');
    setGen(f, 'name', 'fixed', `Côte d'Ivoire`);
    const nameKey = Object.keys(f).find((k) => f[k] === 'name' && k.startsWith('c_'))!;
    assert.ok(nameKey);
    setGen(f, 'name', 'country');
    const a = await dev.submit('/builder/sql/sample-data', { ...f, action: 'sql' });
    assert.equal(a.statusCode, 200);
    assert.match(String(a.headers['content-disposition']), /attachment; filename="sample-data\.sql"/);
    assert.match(a.body, /^-- sample-data: generated by pgkiln/);
    assert.match(a.body, /insert into "ws_sd"\."country" \("code", "name"\) values/);
    const b = await dev.submit('/builder/sql/sample-data', { ...f, action: 'sql' });
    assert.equal(a.body, b.body, 'deterministic');
    await owner.query(a.body);
    assert.equal(await count('country'), 5);
    const csv = await dev.submit('/builder/sql/sample-data', { ...f, action: 'csv' });
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(csv.body, /^\ufeffcode,name\r\n[A-Z]{2},/);
    const two = await form(['customer', 'orders']);
    two.f.seed = '1';
    two.f.rows_0 = '2';
    two.f.rows_1 = '3';
    const zip = await dev.submit('/builder/sql/sample-data', { ...two.f, action: 'csv' });
    assert.equal(zip.headers['content-type'], 'application/zip');
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    assert.deepEqual(Object.keys(files).sort(), ['customer.csv', 'orders.csv']);
    assert.match(strFromU8(files['orders.csv']), /^\ufeff?customer_id,ordered,shipped,amount,note,odd col\r\n/);
  });

  test('save, open, rerun, update and delete a generator definition', async () => {
    const { f } = await form(['customer']);
    f.rows_0 = '4';
    f.seed = '7';
    setGen(f, 'phone', 'list', 'n/a', '0');
    const noName = await dev.submit('/builder/sql/sample-data', { ...f, action: 'save' });
    assert.equal(noName.statusCode, 422);
    const saved = await dev.submit('/builder/sql/sample-data', { ...f, action: 'save', name: 'Test customers', description: 'four of them' });
    assert.equal(saved.statusCode, 303);
    const id = /\/sample-data\/(\d+)$/.exec(String(saved.headers.location))![1];
    const row = await owner.one('select * from meta.data_generator where id = $1', [id]);
    assert.equal(row.schema_name, S);
    assert.equal(row.seed, '7');
    assert.equal(row.created_by, 'admin');
    assert.deepEqual(row.tables[0].columns.find((c: any) => c.column === 'phone'), { column: 'phone', generator: 'list', options: 'n/a', nulls: 0 });
    const list = await dev.get('/builder/sql/sample-data');
    assert.match(list.body, new RegExp(`href="/builder/sql/sample-data/${id}">Test customers</a>`));
    const open = await dev.get(`/builder/sql/sample-data/${id}`);
    assert.match(open.body, /name="id" value="\d+"/);
    assert.match(open.body, /name="seed" value="7"/);
    const g = fields(open.body);
    const ins = await dev.submit('/builder/sql/sample-data', { ...g, action: 'insert' });
    assert.match(ins.body, /customer: 4 row\(s\) inserted/);
    assert.equal((await owner.one(`select count(*)::int as n from ${S}.customer where phone = 'n/a'`)).n, 4);
    const dup = await dev.submit('/builder/sql/sample-data', { ...f, action: 'save', name: 'Test customers' });
    assert.match(dup.body, /A generator named Test customers exists already/);
    const upd = await dev.submit('/builder/sql/sample-data', { ...g, action: 'save', name: 'Test customers 2' });
    assert.equal(upd.statusCode, 303);
    assert.equal((await owner.one('select name from meta.data_generator where id = $1', [id])).name, 'Test customers 2');
    await dev.get(`/builder/sql/sample-data/${id}`);
    assert.equal((await dev.submit(`/builder/sql/sample-data/${id}/delete`, {})).statusCode, 303);
    assert.equal(await owner.one('select 1 from meta.data_generator where id = $1', [id]), undefined);
    assert.equal((await dev.get(`/builder/sql/sample-data/${id}`)).statusCode, 404);
  });
});
