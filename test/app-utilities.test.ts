// Sprint 138 (AP-5): an application's Utilities (migration 138). The Utilities tab, application and page
// checksums (also on Export), Database object dependencies (BEGIN ATOMIC parse as the app role: tables, views,
// sequences, functions; missing objects; grants), the change history per component with diffs (builder changes,
// import --replace), UI defaults (the wizards' labels, a form item's mask/help/list of values), Upgrade
// application, the icon browser.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { appChecksum, diffDocs, pageChecksums, recordHistory } from '../src/history.ts';
import { replaceApp } from '../src/cli/replace.ts';
import { appDependencies, bodyOf, dmlTarget, missingOf } from '../src/builder/dependencies.ts';
import { lovTables, upgradeCandidates } from '../src/builder/upgrade.ts';
import { COMPONENTS } from '../src/builder/components.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page1: number;
const S = 'util138';
const regions: number[] = [];

const login = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};

/** The property form's values of a component row (every field, as the page designer posts them). */
function formOf(kind: string, row: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const f of COMPONENTS[kind].fields) {
    const v = row[f.name];
    if (f.kind === 'options') continue;
    out[f.name] = v === null || v === undefined ? '' : f.kind === 'bool' ? String(v) : f.kind === 'json' ? JSON.stringify(v) : Array.isArray(v) ? v.join(',') : String(v);
  }
  return out;
}

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  page1 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId])).id;
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; grant usage on schema ${S} to hr_app;
    create table ${S}.secret (id int primary key, note text);
    create view ${S}.emp_v as select empno, ename from hr.emp;
    grant select on ${S}.emp_v to hr_app;
    create function ${S}.twice(int) returns int language sql immutable as 'select $1 * 2';
    revoke execute on function ${S}.twice(int) from public;`);
  for (const [title, source] of [
    ['U138 view', `select empno, ${S}.twice(empno) as t from ${S}.emp_v where empno = :P1_X`],
    ['U138 secret', `select note from ${S}.secret`],
  ])
    regions.push((await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 990, $2, 'report', $3) returning id`, [page1, title, source])).id);
});

after(async () => {
  // (an import --replace below gives every component a new id)
  await owner.query(`delete from meta.region where id = any($1) or (title like 'U138 %' and page_id in (select id from meta.page where app_id = $2))`, [regions, appId]);
  await owner.query(`delete from meta.ui_default where (schema_name = 'hr' and table_name = 'emp') or schema_name = '${S}'`);
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});

describe('sprint 138 AP-5: Utilities', () => {
  test('the Utilities tab gathers the tools; application and page checksums, also on Export', async () => {
    const b = await login();
    const home = (await b.get(`/builder/apps/${appId}`)).body;
    assert.match(home, new RegExp(`href="/builder/apps/${appId}/utilities"`));
    const r = await b.get(`/builder/apps/${appId}/utilities`);
    assert.equal(r.statusCode, 200);
    for (const href of ['advisor', 'utilities/dependencies', 'utilities/history', 'utilities/upgrade', 'search', 'debug', 'activity', 'backups', 'working-copies', 'export'])
      assert.match(r.body, new RegExp(`href="/builder/apps/${appId}/${href}"`), href);
    assert.match(r.body, /href="\/builder\/ui-defaults"/);
    assert.match(r.body, /href="\/builder\/icons"/);
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const sum = appChecksum(doc);
    assert.match(sum, /^[0-9a-f]{64}$/);
    assert.ok(r.body.includes(sum), 'the checksum on the page');
    assert.equal(appChecksum(doc), appChecksum(structuredClone(doc)), 'stable');
    assert.equal(appChecksum({ ...doc, app: { ...doc.app, alias: 'other' } }), sum, 'the alias does not count');
    assert.notEqual(appChecksum({ ...doc, app: { ...doc.app, name: 'Other' } }), sum);
    const pages = pageChecksums(doc);
    assert.ok(pages.has(3) && /^[0-9a-f]{64}$/.test(pages.get(3)!));
    const exp = await b.get(`/builder/apps/${appId}/export`);
    assert.equal(exp.headers['x-pgkiln-checksum'], appChecksum(JSON.parse(exp.body)));
    assert.equal((await b.get('/builder/apps/abc/utilities')).statusCode, 404);
  });

  test('icon browser: pgkiln icons, Lucide icons for a search', async () => {
    const b = await login();
    const all = (await b.get('/builder/icons')).body;
    assert.match(all, /<code>truck<\/code>/);
    const found = (await b.get('/builder/icons?q=bicycle')).body;
    assert.match(found, /<code>bike<\/code>|<code>bicycle<\/code>/);
    assert.match((await b.get('/builder/icons?q=%3Cscript%3E')).body, /&lt;script&gt;/);
  });
});

describe('sprint 138 AP-5: database object dependencies', () => {
  test('parsing helpers', () => {
    assert.deepEqual(dmlTarget('insert into sales.orders (id) values (1)'), { name: 'sales.orders', privilege: 'INSERT' });
    assert.deepEqual(dmlTarget('UPDATE "Sales".orders set x = 1'), { name: '"Sales".orders', privilege: 'UPDATE' });
    assert.deepEqual(dmlTarget('with x as (select 1) delete from orders where id in (select * from x)'), { name: 'orders', privilege: 'DELETE' });
    assert.equal(dmlTarget('select 1'), null);
    assert.deepEqual(bodyOf('update t set a = :P3_A; perform x', 'statements').skipped, ['perform x']);
    assert.deepEqual(bodyOf(':P3_A = 1', 'boolean').statements, ['select (NULL = 1)::boolean']);
    assert.deepEqual(missingOf('relation "sales.orders_v" does not exist'), { kind: 'relation', name: 'sales.orders_v' });
    assert.deepEqual(missingOf('function sales.f(integer) does not exist'), { kind: 'function', name: 'sales.f(integer)' });
  });

  test('hr.emp with the pages that use it; grants the role lacks; a dropped view in red', async () => {
    const deps = await appDependencies(appId);
    const emp = deps.objects.find((o) => o.display === 'hr.emp');
    assert.ok(emp, 'hr.emp is listed');
    assert.equal(emp.kind, 'table');
    assert.ok(emp.usedBy.some((u) => u.entry?.pageNo === 3), 'page 3 uses hr.emp');
    assert.equal(emp.missing, false);
    const view = deps.objects.find((o) => o.display === `${S}.emp_v`);
    assert.ok(view && view.kind === 'view' && !view.lacking.length);
    const secret = deps.objects.find((o) => o.display === `${S}.secret`);
    assert.deepEqual(secret?.lacking, ['SELECT'], 'no SELECT grant on the table');
    const fn = deps.objects.find((o) => o.display === `${S}.twice(integer)`);
    assert.deepEqual(fn?.lacking, ['EXECUTE']);
    // a page process's DML target needs its verb's privilege
    const b = await login();
    const page = (await b.get(`/builder/apps/${appId}/utilities/dependencies`)).body;
    assert.match(page, new RegExp(`href="/builder/sql/objects\\?schema=hr&amp;k=table&amp;o=hr.emp"`));
    assert.match(page, /No grant/);

    await owner.query(`drop view ${S}.emp_v`);
    try {
      const after = await appDependencies(appId);
      const gone = after.objects.find((o) => o.display === `${S}.emp_v`);
      assert.ok(gone?.missing, 'the dropped view is missing');
      assert.ok(gone.usedBy.some((u) => u.entry?.kind === 'region' && u.entry.pageNo === 1));
      const html = (await b.get(`/builder/apps/${appId}/utilities/dependencies?show=problems`)).body;
      assert.match(html, new RegExp(`<tr class="dep-problem">[\\s\\S]*?<span class="dep-missing">${S}.emp_v</span>[\\s\\S]*?Missing`));
      assert.doesNotMatch(html, /hr\.emp</, 'only problems');
    } finally {
      await owner.query(`create view ${S}.emp_v as select empno, ename from hr.emp; grant select on ${S}.emp_v to hr_app`);
    }
  });
});

describe('sprint 138 AP-5: change history', () => {
  test('who changed page 3\'s Salary item, with a diff; filters by developer and date', async () => {
    const b = await login();
    const item = await owner.one(`select i.* from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1 and i.name = 'P3_SAL'`, [appId]);
    await b.get(`/builder/apps/${appId}/pages/3?c=item-${item.id}`);
    try {
      const r = await b.submit(`/builder/pages/${item.page_id}/c/item/${item.id}`, { ...formOf('item', item), label: 'Pay per month' });
      assert.equal(r.statusCode, 303);
      assert.equal((await owner.one('select label from meta.item where id = $1', [item.id])).label, 'Pay per month');
      const ch = await owner.one(`select * from meta.component_change where app_id = $1 and component like 'pages/0003/items/%' and label ilike '%p3_sal%' order by id desc limit 1`, [appId]);
      assert.ok(ch, 'recorded');
      assert.equal(ch.changed_by, 'admin');
      assert.equal(ch.op, 'changed');
      assert.equal(ch.page_no, 3);
      const list = (await b.get(`/builder/apps/${appId}/utilities/history?dev=admin&page=3`)).body;
      assert.match(list, /Page 3 › item p3_sal/i);
      assert.match(list, /<td data-label="Developer">admin<\/td>/);
      const diff = (await b.get(`/builder/apps/${appId}/utilities/history?c=${ch.id}`)).body;
      assert.match(diff, /<span class="diff-del">-label: Salary<\/span>/);
      assert.match(diff, /<span class="diff-add">\+label: Pay per month<\/span>/);
      const none = (await b.get(`/builder/apps/${appId}/utilities/history?dev=nobody`)).body;
      assert.match(none, /No changes with these filters/);
      const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
      assert.match((await b.get(`/builder/apps/${appId}/utilities/history?from=${tomorrow}`)).body, /No changes with these filters/);
      // Recently updated pages on the Utilities page
      assert.match((await b.get(`/builder/apps/${appId}/utilities`)).body, /Recently updated pages[\s\S]*?\/utilities\/history\?page=3/);
    } finally {
      await owner.query('update meta.item set label = $2 where id = $1', [item.id, item.label]);
      await recordHistory(appId, null);
    }
  });

  test('an import --replace is recorded per component, without a developer', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const changed = structuredClone(doc);
    const lov = changed.lovs.find((l: { name: string }) => l.name === 'JOBS');
    const was = lov.query;
    lov.query = `${was} -- u138`;
    await owner.tx((c) => replaceApp(c, changed, 'hr', { backup: null }));
    try {
      const ch = await owner.one(`select * from meta.component_change where app_id = $1 order by id desc limit 1`, [appId]);
      assert.equal(ch.source, 'import');
      assert.equal(ch.changed_by, null);
      assert.match(ch.label, /List of values jobs/i);
      assert.equal(diffDocs(doc, changed).length, 1);
    } finally {
      await owner.tx((c) => replaceApp(c, doc, 'hr', { backup: null }));
    }
  });
});

describe('sprint 138 AP-5: UI defaults', () => {
  test('the UI default label of hr.emp.sal makes the next generated form use it (with its mask and help)', async () => {
    const b = await login();
    const page = (await b.get('/builder/ui-defaults?schema=hr&table=emp')).body;
    const i = Number(/name="c\.(\d+)\.name" value="sal"/.exec(page)?.[1]);
    assert.ok(Number.isInteger(i));
    const r = await b.submit('/builder/ui-defaults', { schema: 'hr', table: 'emp', mode: 'save', [`c.${i}.name`]: 'sal', [`c.${i}.label`]: 'Monthly salary', [`c.${i}.format_mask`]: '999G990D00', [`c.${i}.help`]: 'Gross, per month.', [`c.${i}.alignment`]: 'end' });
    assert.equal(r.statusCode, 303);
    const d = await owner.one(`select * from meta.ui_default where schema_name = 'hr' and table_name = 'emp' and column_name = 'sal'`);
    assert.equal(d.label, 'Monthly salary');
    assert.equal(d.updated_by, 'admin');
    await owner.tx(async (c) => {
      const pid = (await c.query(`select meta.generate_page('hr', 'form', 'hr.emp'::regclass, 9138, '{}'::jsonb) as id`)).rows[0].id;
      const sal = (await c.query(`select label, config, help from meta.item where page_id = $1 and source_column = 'sal'`, [pid])).rows[0];
      assert.equal(sal.label, 'Monthly salary');
      assert.equal(sal.config.format_mask, '999G990D00');
      assert.equal(sal.help, 'Gross, per month.');
      const other = (await c.query(`select label, help from meta.item where page_id = $1 and source_column = 'comm'`, [pid])).rows[0];
      assert.equal(other.help, null, 'other columns keep the wizard\'s defaults');
      const rep = (await c.query(`select meta.generate_page('hr', 'report_form', 'hr.emp'::regclass, 9139, '{"form_page": 9137}'::jsonb) as id`)).rows[0].id;
      const heads = (await c.query(`select config from meta.region where page_id = $1 and type = 'report'`, [rep])).rows[0].config.headings;
      assert.equal(heads.sal, 'Monthly salary', 'report headings too');
      throw new Error('u138 rollback');
    }).catch((e) => {
      if ((e as Error).message !== 'u138 rollback') throw e;
    });
    // an empty row removes the UI default; a bad mask is refused
    assert.match((await b.get((await b.submit('/builder/ui-defaults', { schema: 'hr', table: 'emp', mode: 'save', [`c.${i}.name`]: 'sal', [`c.${i}.format_mask`]: '999<b>' })).headers.location as string)).body, /Format mask of sal/);
    await b.submit('/builder/ui-defaults', { schema: 'hr', table: 'emp', mode: 'save', [`c.${i}.name`]: 'sal' });
    assert.equal((await owner.one(`select count(*)::int as n from meta.ui_default where schema_name = 'hr' and table_name = 'emp' and column_name = 'sal'`)).n, 0);
  });

  test('seed from column comments: a short comment is the label, a longer one the help', async () => {
    await owner.query(`create table ${S}.product (id int primary key, name text, descr text);
      comment on column ${S}.product.name is 'Product name';
      comment on column ${S}.product.descr is 'What the product is, in a sentence or two that the shop shows under its name on every page.'`);
    const b = await login();
    await b.get(`/builder/ui-defaults?schema=${S}&table=product`);
    assert.equal((await b.submit('/builder/ui-defaults', { schema: S, table: 'product', mode: 'seed' })).statusCode, 303);
    const rows = (await owner.query(`select column_name, label, help from meta.ui_default where schema_name = $1 and table_name = 'product' order by 1`, [S])).rows;
    assert.deepEqual(rows.map((r) => [r.column_name, r.label, !!r.help]), [['descr', null, true], ['name', 'Product name', false]]);
  });
});

describe('sprint 138 AP-5: upgrade application', () => {
  test('candidates with a preview, upgrade one, recorded in the history', async () => {
    assert.deepEqual(lovTables('select d.dname d, d.deptno r from hr.dept d join "x"."Y" y on true'), ['hr.dept', '"x"."Y"']);
    await owner.query(`create table ${S}.ev (id int primary key, happened date, at timestamptz)`);
    await owner.query(`insert into ${S}.ev select g, current_date, now() from generate_series(1, 1500) g; analyze ${S}.ev; grant select on ${S}.ev to hr_app`);
    const pid = (await owner.one(`insert into meta.page (app_id, page_no, name, title) values ($1, 9140, 'U138', 'U138') returning id`, [appId])).id;
    try {
      const rid = (await owner.one(`insert into meta.region (page_id, seq, title, type, table_name, pk_column) values ($1, 10, 'Ev', 'form', '${S}.ev', 'id') returning id`, [pid])).id;
      const day = (await owner.one(`insert into meta.item (page_id, region_id, seq, name, label, type, source_column) values ($1, $2, 10, 'P9140_HAPPENED', 'Happened', 'text', 'happened') returning id`, [pid, rid])).id;
      await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, source_column) values ($1, $2, 20, 'P9140_AT', 'At', 'text', 'at')`, [pid, rid]);
      const sel = (await owner.one(`insert into meta.item (page_id, region_id, seq, name, label, type, lov) values ($1, $2, 30, 'P9140_EV', 'Event', 'select', 'select id d, id r from ${S}.ev') returning id`, [pid, rid])).id;
      const all = await upgradeCandidates(appId);
      assert.ok(all.some((c) => c.key === `date_picker:${day}` && c.after.type === 'date'));
      assert.ok(all.some((c) => c.rule === 'date_picker' && c.label.includes('P9140_AT') && c.after.type === 'datetime'));
      assert.ok(all.some((c) => c.key === `popup_lov:${sel}`));
      const b = await login();
      const prev = (await b.get(`/builder/apps/${appId}/utilities/upgrade?preview=date_picker:${day}`)).body;
      assert.match(prev, /<span class="diff-del">-  &quot;type&quot;: &quot;text&quot;<\/span>|<span class="diff-del">-  "type": "text"<\/span>/);
      assert.equal((await b.submit(`/builder/apps/${appId}/utilities/upgrade`, { key: `date_picker:${day}` })).statusCode, 303);
      assert.equal((await owner.one('select type from meta.item where id = $1', [day])).type, 'date');
      const h = await owner.one(`select * from meta.component_change where app_id = $1 and source = 'upgrade' order by id desc limit 1`, [appId]);
      assert.equal(h.changed_by, 'admin');
      // again: nothing to upgrade (a stale key changes nothing)
      const again = await b.submit(`/builder/apps/${appId}/utilities/upgrade`, { key: `date_picker:${day}` });
      assert.match((await b.get(again.headers.location as string)).body, /Nothing to upgrade/);
      assert.equal((await b.submit(`/builder/apps/${appId}/utilities/upgrade`, { rule: 'popup_lov' })).statusCode, 303);
      assert.equal((await owner.one('select type from meta.item where id = $1', [sel])).type, 'popup_lov');
    } finally {
      await owner.query('delete from meta.page where id = $1', [pid]);
      await recordHistory(appId, null);
    }
  });
});
