// (sprint 110, migration 120) Data Reporter datasets and reporting applications: App Builder → Data Reporter
// (/builder/reporter), the dataset's SELECT, files, a reporting application made in two clicks, and its roles
// in the running application (an editor publishes, a viewer opens the report by its stable URL). The HR
// dataset "hr" (examples/hr/hr_63_datasets.sql) is the fixture.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { checkDataset, datasetFile, datasetSql, proposeDataset, proposeJoin, readDatasetFile, readSchemaCatalog, catalogOf } from '../src/datasets.ts';
import { reportingAppCount } from '../src/reporting-app.ts';
import { sourcesOf } from '../src/runtime/data-reporter.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const ALIAS = 'ds110-reports';
const ROLE = 'app_ds110_reports';

async function cleanup() {
  await owner.query('delete from meta.app where alias = $1', [ALIAS]);
  if ((await owner.query('select 1 from pg_roles where rolname = $1', [ROLE])).rowCount) {
    await owner.query(`drop owned by ${ROLE}`);
    await owner.query(`drop role ${ROLE}`);
  }
  await owner.query(`delete from meta.dataset where name like 'ds110%'`);
}

before(async () => {
  app = await buildApp({ logger: false });
  await cleanup();
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

async function builder() {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
  return b;
}
const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

describe('datasets: checks and SQL', () => {
  test('identifiers are checked against the catalog and always quoted; values are literals; operators whitelisted', async () => {
    const cat = await readSchemaCatalog(owner, 'hr');
    const { dataset, errors } = checkDataset({
      name: 'x', label: 'X', schema: 'hr',
      tables: [{ alias: 't1', table: 'emp' }, { alias: 't2', table: 'dept', join: { to: 't1', on: [{ column: 'deptno', ref: 'deptno' }] } }, { alias: 't3', table: 'nope"; drop table x' }],
      columns: [{ name: 'ename', table: 't1', column: 'ename' }, { name: 'evil', table: 't1', column: 'ename"; --' }, { name: 'Bad Name', table: 't1', column: 'job' }],
      filters: [{ table: 't1', column: 'job', op: 'eq', value: "x'; drop table hr.emp; --" }, { table: 't1', column: 'job', op: 'exec', value: '1' }],
    }, catalogOf(cat.objects));
    assert.ok(errors.some((e) => /does not exist/.test(e)));
    assert.ok(errors.some((e) => /bad name/i.test(e)));
    assert.deepEqual(dataset.tables.map((t) => t.table), ['emp', 'dept']);
    assert.deepEqual(dataset.columns.map((c) => c.name), ['ename']);
    assert.equal(dataset.filters.length, 1);
    const sql = datasetSql(dataset);
    assert.match(sql, /"t1"\."ename" as "ename"/);
    assert.match(sql, /left join "hr"\."dept" "t2" on "t2"\."deptno" = "t1"\."deptno"/);
    assert.match(sql, /'x''; drop table hr\.emp; --'/);
    // it runs
    await owner.query(`select * from (${sql}) q limit 1`);
  });

  test('reserved schemas and bad names are refused; a file round-trips', () => {
    const { errors } = checkDataset({ name: '1x', schema: 'meta', tables: [{ alias: 't1', table: 'app' }] });
    assert.ok(errors.some((e) => /not a valid dataset name/.test(e)));
    assert.ok(errors.some((e) => /can't be used/.test(e)));
    const d = checkDataset({ name: 'a', schema: 'hr', tables: [{ alias: 't1', table: 'emp' }], columns: [{ name: 'ename', table: 't1', column: 'ename' }] }).dataset;
    assert.deepEqual(readDatasetFile(datasetFile([d])), [JSON.parse(JSON.stringify(d))]);
    assert.throws(() => readDatasetFile('{"format": "other/1", "datasets": []}'), /Unknown format/);
    assert.throws(() => readDatasetFile('nope'), /not valid JSON/);
  });

  test('joins are proposed from foreign keys in either direction', async () => {
    const cat = await readSchemaCatalog(owner, 'hr');
    assert.deepEqual(proposeJoin('dept', [{ alias: 't1', table: 'emp' }], cat.fks)?.on, [{ column: 'deptno', ref: 'deptno' }]);
    assert.deepEqual(proposeJoin('emp', [{ alias: 't1', table: 'dept' }], cat.fks)?.on, [{ column: 'deptno', ref: 'deptno' }]);
    const p = proposeDataset('ds110_p', 'P', 'hr', ['emp', 'dept'], cat);
    assert.deepEqual(p.errors, []);
    assert.ok(p.dataset.columns.some((c) => c.name === 'dname' && c.label === 'Dname'));
    assert.ok(!p.dataset.columns.some((c) => c.table === 't2' && c.column === 'deptno'), 'the join column is offered once');
  });

  test('a region source may name a dataset', () => {
    const s = sourcesOf({ config: { sources: [{ id: 'hr', dataset: 'hr' }, { id: 'bad', dataset: 'Bad"' }] } });
    assert.deepEqual(s.map((x) => [x.id, x.dataset]), [['hr', 'hr']]);
  });
});

describe('App Builder → Data Reporter', () => {
  test('the home lists datasets; a new dataset on emp and dept gets the join and columns; edit, preview, file', async () => {
    const b = await builder();
    const home = await b.get('/builder/reporter');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Data Reporter/);
    assert.match(home.body, /href="\/builder\/reporter\/datasets\/\d+">HR</);
    assert.match(home.body, /aria-current="page"[^>]*>.*Data Reporter|rail-link" title="Data Reporter" aria-current="page"/s);

    const step = await b.get('/builder/reporter/datasets/new?schema=hr');
    assert.match(step.body, /value="emp"/);
    const created = await b.submit('/builder/reporter/datasets', { schema: 'hr', name: 'ds110_hr', label: 'DS HR', tables: ['emp', 'dept'] });
    assert.equal(created.statusCode, 303);
    const row = await owner.one('select * from meta.dataset where name = $1', ['ds110_hr']);
    assert.equal(row.tables[1].join.on[0].column, 'deptno');
    assert.ok(row.columns.some((c: any) => c.column === 'dname'));

    const page = await b.get(created.headers.location as string);
    assert.match(page.body, /DS HR/);
    assert.match(page.body, /left join &quot;hr&quot;\.&quot;dept&quot;|left join "hr"\."dept"/);
    // offer only ename and dname (renamed), with a label, mask and description; a row filter on job
    const form: Record<string, string> = { label: 'DS HR 2', description: 'Test', t0_alias: 't1', t1_alias: 't2', t1_to: 't1', t1_type: 'inner', t1_on: 'deptno = deptno' };
    let j = 0;
    for (const m of page.body.matchAll(/name="c(\d+)_ref" value="([^"]+)"/g)) {
      form[`c${m[1]}_ref`] = m[2];
      if (m[2] === 't1.ename') Object.assign(form, { [`c${m[1]}_on`]: 'true', [`c${m[1]}_name`]: 'ename', [`c${m[1]}_label`]: 'Name' });
      if (m[2] === 't1.sal') Object.assign(form, { [`c${m[1]}_on`]: 'true', [`c${m[1]}_name`]: 'pay', [`c${m[1]}_label`]: 'Pay', [`c${m[1]}_format`]: '999G990', [`c${m[1]}_desc`]: 'Monthly' });
      j++;
    }
    assert.ok(j > 5);
    Object.assign(form, { f0_col: 't1.job', f0_op: 'ne', f0_value: 'PRESIDENT' });
    const saved = await b.submit(`/builder/reporter/datasets/${row.id}`, form);
    assert.equal(saved.statusCode, 303);
    const after = await owner.one('select * from meta.dataset where id = $1', [row.id]);
    assert.equal(after.label, 'DS HR 2');
    assert.deepEqual(after.columns.map((c: any) => c.name), ['ename', 'pay']);
    assert.equal(after.columns[1].description, 'Monthly');
    assert.equal(after.tables[1].join.type, 'inner');
    assert.deepEqual(after.filters, [{ table: 't1', column: 'job', op: 'ne', value: 'PRESIDENT' }]);

    const preview = await b.get(`/builder/reporter/datasets/${row.id}?preview=1`);
    assert.match(preview.body, /id="preview"/);
    assert.doesNotMatch(preview.body, /KING/, 'the row filter applies');

    // download, then import it again under another name; replace refused without the box
    const file = await b.get(`/builder/reporter/datasets/${row.id}/export`);
    assert.match(String(file.headers['content-disposition']), /ds110_hr\.dataset\.json/);
    const doc = JSON.parse(file.body);
    doc.datasets[0].name = 'ds110_copy';
    await b.get('/builder/reporter/import');
    const imp = await b.upload('/builder/reporter/import', {}, { file: { name: 'x.dataset.json', type: 'application/json', data: Buffer.from(JSON.stringify(doc)) } });
    assert.equal(imp.statusCode, 303);
    assert.ok(await owner.one('select 1 from meta.dataset where name = $1', ['ds110_copy']));
    await b.get('/builder/reporter/import');
    const again = await b.submit('/builder/reporter/import', { text: JSON.stringify(doc) });
    assert.equal(again.statusCode, 303);
    const flash = await b.get('/builder/reporter');
    assert.match(flash.body, /ds110_copy: kept \(same name\)/);
    // a file naming a table that doesn't exist imports nothing
    doc.datasets[0].name = 'ds110_bad';
    doc.datasets[0].tables[0].table = 'no_such_table';
    await b.get('/builder/reporter/import');
    await b.submit('/builder/reporter/import', { text: JSON.stringify(doc) });
    assert.equal(await owner.one('select 1 from meta.dataset where name = $1', ['ds110_bad']), undefined);

    const del = await b.get(`/builder/reporter/datasets/${row.id}`);
    assert.equal(del.statusCode, 200);
    await b.submit(`/builder/reporter/datasets/${row.id}/delete`, {});
    assert.equal(await owner.one('select 1 from meta.dataset where id = $1', [row.id]), undefined);
  });
});

describe('a reporting application on the HR dataset', () => {
  let appId: number;
  let rid: number;
  let reportId: number;

  test('two clicks: Create reporting application on the dataset, then Create', async () => {
    const b = await builder();
    const ws = (await owner.one('select meta.reporting_app_count(1) as n')).n;
    const home = await b.get('/builder/reporter');
    const href = unescape(/href="(\/builder\/reporter\/apps\/new\?dataset=hr)"/.exec(home.body)![1]);
    const form = await b.get(href);
    assert.match(form.body, /value="HR reports"/);
    assert.match(form.body, /name="datasets" value="hr" checked/);
    const res = await b.submit('/builder/reporter/apps', { name: 'HR reports', alias: ALIAS, admin_user: 'king', admin_password: '', datasets: 'hr' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 500));
    const a = await owner.one(`select id, app_type, authentication from meta.app where alias = $1`, [ALIAS]);
    appId = a.id;
    assert.equal(a.app_type, 'reporting');
    assert.equal(await reportingAppCount(1), ws + 1);
    rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.type = 'data_reporter'`, [appId])).id;
    // read only: SELECT on the dataset's tables, nothing else
    const priv = await owner.one(`select has_table_privilege($1, 'hr.emp', 'select') as s, has_table_privilege($1, 'hr.emp', 'update') as u,
                                         has_table_privilege($1, 'hr.leave_request', 'select') as other`, [ROLE]);
    assert.deepEqual(priv, { s: true, u: false, other: false });
    // roles: king administrator (the first user), scott an editor, allen a viewer
    await owner.query(`insert into meta.app_access (app_id, account_id, roles) select $1, id, $3 from meta.account where username = $2`, [appId, 'scott', '{editor}']);
    await owner.query(`insert into meta.app_access (app_id, account_id, roles) select $1, id, '{}' from meta.account where username = $2`, [appId, 'allen']);
    const list = await b.get('/builder/reporter');
    assert.match(list.body, new RegExp(`/a/${ALIAS}/`));
  });

  test('an editor builds "Salary by department" and publishes it', async () => {
    const e = new Browser(app);
    await e.login('scott', 'scott', ALIAS);
    const home = await e.get(`/a/${ALIAS}/1`);
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /reporter-card/);
    const P = `dr${rid}_`;
    const edit = await e.get(`/a/${ALIAS}/1?${P}src=hr&${P}g=dname&${P}af=sum&${P}ac=sal&${P}ch=bar`);
    assert.match(edit.body, /reporter-editor/);
    assert.match(edit.body, /Monthly salary/, 'column descriptions are shown');
    assert.match(edit.body, /RESEARCH/);
    const params = `${P}src=hr&${P}g=dname&${P}af=sum&${P}ac=sal&${P}ch=bar`;
    const saved = await e.submit(`/a/${ALIAS}/1/reporter/${rid}/save`, { params, name: 'Salary by department', description: '', mode: 'save' });
    assert.equal(saved.statusCode, 303);
    reportId = (await owner.one('select id, shared from meta.data_report where app_id = $1 and name = $2', [appId, 'Salary by department'])).id;
    const open = await e.get(`/a/${ALIAS}/1?${P}open=${reportId}`);
    assert.match(open.body, /reporter\/\d+\/publish/);
    const pub = await e.submit(`/a/${ALIAS}/1/reporter/${rid}/publish`, { rep: String(reportId), mode: 'publish' });
    assert.equal(pub.statusCode, 303);
    assert.equal((await owner.one('select shared from meta.data_report where id = $1', [reportId])).shared, true);
    const shown = await e.get(`/a/${ALIAS}/1?${P}open=${reportId}`);
    assert.match(shown.body, new RegExp(`/a/${ALIAS}/reports/${reportId}`));
  });

  test('a viewer opens it by its URL, without the editor or the App Builder; pins it', async () => {
    const v = new Browser(app);
    await v.login('allen', 'allen', ALIAS);
    const go = await v.get(`/a/${ALIAS}/reports/${reportId}`);
    assert.equal(go.statusCode, 303);
    const page = await v.get(go.headers.location as string);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Salary by department/);
    assert.match(page.body, /RESEARCH/);
    assert.doesNotMatch(page.body, /reporter-editor/);
    assert.doesNotMatch(page.body, /\/builder/);
    assert.doesNotMatch(page.body, /reporter\/\d+\/save/);
    const home = await v.get(`/a/${ALIAS}/1`);
    assert.doesNotMatch(home.body, /reporter-card"/, 'no New report for viewers');
    assert.match(home.body, /Salary by department/);
    // ad-hoc parameters are ignored for viewers
    const P = `dr${rid}_`;
    const adhoc = await v.get(`/a/${ALIAS}/1?${P}src=hr&${P}col=ename`);
    assert.doesNotMatch(adhoc.body, /reporter-editor/);
    // pin
    await v.get(go.headers.location as string);
    const pin = await v.submit(`/a/${ALIAS}/1/reporter/${rid}/pin`, { rep: String(reportId), mode: 'pin' });
    assert.equal(pin.statusCode, 303);
    const pinned = await v.get(`/a/${ALIAS}/1`);
    assert.match(pinned.body, /Pinned/);
  });

  test('an administrator unpublishes anyone\'s report; then a viewer no longer sees it', async () => {
    const k = new Browser(app);
    await k.login('king', 'king', ALIAS);
    await k.get(`/a/${ALIAS}/1?dr${rid}_open=${reportId}`);
    const un = await k.submit(`/a/${ALIAS}/1/reporter/${rid}/publish`, { rep: String(reportId), mode: 'unpublish' });
    assert.equal(un.statusCode, 303);
    assert.equal((await owner.one('select shared from meta.data_report where id = $1', [reportId])).shared, false);
    const v = new Browser(app);
    await v.login('allen', 'allen', ALIAS);
    assert.equal((await v.get(`/a/${ALIAS}/reports/${reportId}`)).statusCode, 404);
  });
});
