// Sprint 76: the interactive report like APEX's: the Actions menu as a short
// list of dialogs, a column heading's menu with the column's values, the
// search's column list, hidden columns, the pager ("1–14 of 14", rows per
// page) and date items in the application's date format.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { parseDateMask } from '../src/runtime/format.ts';
import { Browser, formFields } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let rid: number;
const alias = 'rui-s76';
const ROLE = 'pgkiln_s76_rui';
const SCHEMA = 'rui76';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop owned by ${ROLE}`).catch(() => undefined);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`
    create schema ${SCHEMA};
    create table ${SCHEMA}.emp (id int primary key, name text not null, job text, secret text, hired date);
    insert into ${SCHEMA}.emp select g, 'E' || g, (array['CLERK', 'ANALYST', 'MANAGER'])[1 + g % 3], 's' || g, date '2020-01-01' + g from generate_series(1, 14) g;
    grant usage on schema ${SCHEMA} to ${ROLE};
    grant select, insert, update, delete on all tables in schema ${SCHEMA} to ${ROLE};
  `);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Report UI', 'none', $2) returning id`, [alias, ROLE])).id;
  const page = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  rid = (await owner.one(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 10, 'Staff', 'report', $2, $3) returning id`,
    [page, `select id, name, job, secret from ${SCHEMA}.emp`, { hidden: ['secret'] }])).id;
  const form = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 2, 'Form', false) returning id`, [appId])).id;
  const fr = (await owner.one(`insert into meta.region (page_id, seq, title, type, table_name, pk_column, pk_item) values ($1, 10, 'Emp', 'form', $2, 'id', 'P2_ID') returning id`, [form, `${SCHEMA}.emp`])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type, source_column) values ($1, $2, 10, 'P2_ID', 'hidden', 'id'), ($1, $2, 15, 'P2_NAME', 'text', 'name'), ($1, $2, 20, 'P2_HIRED', 'date', 'hired')`, [form, fr]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action, target_page) values ($1, $2, 10, 'SAVE', 'Save', 'submit', 2), ($1, $2, 20, 'CREATE', 'Create', 'submit', 2)`, [form, fr]);
  await owner.query(`insert into meta.process (page_id, seq, name, type, region_id) values ($1, 10, 'dml', 'form_dml', $2)`, [form, fr]);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop owned by ${ROLE}`);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

const page = (q = '') => new Browser(app).get(`/a/${alias}/1${q}`).then((r) => r.body);

describe('the interactive report', () => {
  test('Actions: a short menu whose entries hold their forms (dialogs with JavaScript)', async () => {
    const body = await page();
    const menu = /<details class="menu actions-menu">[\s\S]*?<\/ul><\/div>\s*<\/details>/.exec(body)![0];
    // the first level: the submenus' own lists left out
    const firstLevel = menu.replace(/(<details class="ir-item ir-sub">[\s\S]*?)<ul class="ir-menu">[\s\S]*?<\/ul>/g, '$1');
    const entries = [...firstLevel.matchAll(/<li><details class="ir-item/g)].length;
    assert.ok(entries >= 8 && entries <= 12, `${entries} entries`);
    assert.match(menu, /data-ir-dialog="filter"><summary>[\s\S]*?Filter[\s\S]*?name="r\d+_fc"[\s\S]*?name="r\d+_fo"[\s\S]*?name="r\d+_fv"/);
    assert.doesNotMatch(menu, /value="secret"/, 'a hidden column is offered nowhere');
  });

  test("a heading's menu: its values with counts, with the report's filters; hidden columns refused", async () => {
    const b = new Browser(app);
    const body = (await b.get(`/a/${alias}/1`)).body;
    assert.match(body, new RegExp(`<th scope="col"[^>]* data-col="job" data-label="Job" data-asc="[^"]*r${rid}_s=3[^"]*" data-desc="[^"]*r${rid}_d=desc[^"]*" data-hide="[^"]*r${rid}_x=job[^"]*" data-break="[^"]*r${rid}_b=job`));
    const values = await b.get(`/a/${alias}/1/report/${rid}/values?col=job`);
    assert.equal(values.statusCode, 200);
    assert.deepEqual(JSON.parse(values.body).values, [{ value: 'ANALYST', count: 5 }, { value: 'CLERK', count: 4 }, { value: 'MANAGER', count: 5 }]);
    const filtered = await b.get(`/a/${alias}/1/report/${rid}/values?col=job&r${rid}_f=${encodeURIComponent('name|eq|E3')}`);
    assert.deepEqual(JSON.parse(filtered.body).values, [{ value: 'CLERK', count: 1 }]);
    for (const col of ['secret', 'nope', 'job"; select 1 --'])
      assert.equal((await b.get(`/a/${alias}/1/report/${rid}/values?col=${encodeURIComponent(col)}`)).statusCode, 403, col);
    assert.equal((await b.get(`/a/${alias}/1/report/999999/values?col=job`)).statusCode, 403);
    await owner.query(`update meta.region set config = config || '{"interactive": false}' where id = $1`, [rid]);
    try {
      assert.equal((await b.get(`/a/${alias}/1/report/${rid}/values?col=job`)).statusCode, 403, 'not an interactive report');
    } finally {
      await owner.query(`update meta.region set config = config - 'interactive' where id = $1`, [rid]);
    }
  });

  test('the search in one column; a hidden column is not searched; hide a column and show it again', async () => {
    const rows = (body: string) => [...body.matchAll(/<td class="num" data-label="Id">(\d+)<\/td>/g)].map((m) => Number(m[1]));
    assert.match(await page(), new RegExp(`<select id="r${rid}_qc" class="search-scope" name="r${rid}_qc"`));
    // "E1" matches E1, E10–E14 by name; in the job column nothing
    assert.equal(rows(await page(`?r${rid}_q=E1&r${rid}_qc=name`)).length, 6);
    assert.equal(rows(await page(`?r${rid}_q=E1&r${rid}_qc=job`)).length, 0);
    assert.equal(rows(await page(`?r${rid}_q=s3&r${rid}_qc=secret`)).length, 0, 'the hidden column is not searched');
    const hidden = await page(`?r${rid}_x=job`);
    assert.doesNotMatch(hidden, /data-label="Job"/);
    assert.match(hidden, /Hidden: <b>Job<\/b>/);
  });

  test('the pager: the range and the total on one page, rows per page, first and last', async () => {
    const one = await page();
    assert.match(one, /<div class="pager"><span>1–14 of 14<\/span><form method="get" action="\/a\/rui-s76\/1" class="pager-size">/);
    assert.match(one, new RegExp(`<select id="r${rid}_size" name="r${rid}_n" data-go>`));
    const p2 = await page(`?r${rid}_n=5&r${rid}_p=2`);
    assert.match(p2, /6–10 of 14/);
    assert.doesNotMatch(p2, /aria-label="(First|Last) page"/, 'page 2 of 3: Previous and Next are the first and the last');
    const p3 = await page(`?r${rid}_n=2&r${rid}_p=3`);
    assert.match(p3, /5–6 of 14/);
    assert.match(p3, /aria-label="First page"/);
    assert.match(p3, new RegExp(`href="[^"]*r${rid}_p=7[^"]*" aria-label="Last page"`));
  });
});

describe('date items in the application\'s date format', () => {
  test('masks read back; real dates only', () => {
    assert.equal(parseDateMask('23-05-1987', 'DD-MM-YYYY', 'en'), '1987-05-23');
    assert.equal(parseDateMask('23-may-1987', 'DD-MON-YYYY', 'en'), '1987-05-23');
    assert.equal(parseDateMask('1987-05-23', 'DD.MM.YYYY', 'en'), '1987-05-23', 'ISO is read too');
    for (const bad of ['31-02-1987', '1987', 'x; drop', '23/05/1987']) assert.equal(parseDateMask(bad, 'DD-MM-YYYY', 'en'), null, bad);
    assert.equal(parseDateMask('10:30', 'HH24:MI', 'en'), null, 'a time mask is not a date mask');
  });

  test('a new row: typed in the format, stored as a date; a wrong date is refused', async () => {
    await owner.query(`update meta.app set date_format = 'DD.MM.YYYY' where id = $1`, [appId]);
    try {
      const b = new Browser(app);
      const body = (await b.get(`/a/${alias}/2`)).body;
      assert.match(body, /<input type="text" id="P2_HIRED" name="P2_HIRED" value="" placeholder="DD.MM.YYYY" autocomplete="off" data-date-mask="DD.MM.YYYY"/);
      assert.match(body, /data-date-pick="P2_HIRED"/);
      const bad = await b.post(`/a/${alias}/2`, { ...formFields(body), P2_HIRED: '31.02.2021', __request: 'CREATE' });
      assert.match(bad.body, /must be a valid date/);
      await owner.query(`delete from ${SCHEMA}.emp where id = 99`);
      await owner.query(`alter table ${SCHEMA}.emp alter column id set default 99`);
      const ok = await b.post(`/a/${alias}/2`, { ...formFields(bad.body), P2_NAME: 'New', P2_HIRED: '23.05.1987', __request: 'CREATE' });
      assert.ok([200, 303].includes(ok.statusCode), `${ok.statusCode} ${/role="alert"[^]*?<\/div>/.exec(ok.body)?.[0]}`);
      assert.equal((await owner.one(`select hired::text as d from ${SCHEMA}.emp where id = 99`)).d, '1987-05-23');
    } finally {
      await owner.query(`update meta.app set date_format = null where id = $1`, [appId]);
      await owner.query(`alter table ${SCHEMA}.emp alter column id drop default`);
    }
  });
});
