// Report queries (migration 104; APEX: Shared Components → Report Queries): a named
// query printed as PDF, Excel, CSV, JSON, XML or HTML; a page downloads it with
// ?doc=NAME. HR is the fixture; the test's report queries are removed afterwards.
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
let king: Browser;

const cleanUp = () => owner.query(`delete from meta.report_query where app_id = $1 and name like 'RQ\\_TEST\\_%'`, [appId]);
const add = (name: string, format: string, extra: Record<string, string> = {}) =>
  owner.query(`insert into meta.report_query (app_id, name, query, format, file_name, title, authz) values ($1, $2, $3, $4, $5, $6, $7)`,
    [appId, name, extra.query ?? 'select ename, job, sal from hr.emp where deptno = 10 order by ename', format, extra.file_name ?? null, extra.title ?? null, extra.authz ?? null]);

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanUp();
  king = new Browser(app);
  assert.equal((await king.login('king')).statusCode, 303);
});
after(async () => {
  await cleanUp();
  await app.close();
  await closePools();
});

describe('report queries', () => {
  test('made in Shared Components (Files and Reports)', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    assert.match((await dev.get(`/builder/apps/${appId}/shared`)).body, /shared\?type=report_query"/);
    await dev.get(`/builder/apps/${appId}/shared?new=report_query`);
    const res = await dev.submit(`/builder/apps/${appId}/shared/report_query`, {
      name: 'rq_test_staff', description: 'Staff', query: 'select ename from hr.emp where deptno = :P1_NOPE', format: 'csv',
    });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(await owner.one(`select format, description from meta.report_query where app_id = $1 and name = 'RQ_TEST_STAFF'`, [appId]), { format: 'csv', description: 'Staff' });
    assert.match((await dev.get(`/builder/apps/${appId}/shared?type=report_query`)).body, /RQ_TEST_STAFF \(csv\)/);
  });

  test('downloaded from any page with ?doc=NAME, in its format, with the file name and session state', async () => {
    await add('RQ_TEST_CSV', 'csv', { file_name: 'staff-&APP_USER.', query: `select ename, job from hr.emp where deptno = 10 and :APP_USER is not null order by ename` });
    const csv = await king.get('/a/hr/1?doc=rq_test_csv');
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /^text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /attachment; filename="staff-king\.csv"/i);
    const names = (await owner.query(`select ename from hr.emp where deptno = 10 order by ename`)).rows.map((r) => r.ename as string);
    assert.match(csv.body, /^\uFEFF?"?ename"?,"?job"?/i, 'headings (after a byte order mark for Excel)');
    for (const n of names) assert.match(csv.body, new RegExp(n));

    await add('RQ_TEST_JSON', 'json');
    const json = await king.get('/a/hr/1?doc=RQ_TEST_JSON');
    assert.match(String(json.headers['content-type']), /^application\/json/);
    assert.deepEqual(JSON.parse(json.body).map((r: { ename: string }) => r.ename), names);

    await add('RQ_TEST_XLSX', 'xlsx');
    const xlsx = await king.get('/a/hr/1?doc=RQ_TEST_XLSX');
    assert.match(String(xlsx.headers['content-type']), /spreadsheetml/);
    assert.equal(xlsx.rawPayload.subarray(0, 2).toString(), 'PK');

    await add('RQ_TEST_PDF', 'pdf', { title: 'Staff of &APP_USER.' });
    const pdf = await king.get('/a/hr/1?doc=RQ_TEST_PDF');
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.match(String(pdf.headers['content-disposition']), /filename="rq_test_pdf\.pdf"/);
  });

  test('an HTML file is sandboxed; its authorization applies; an unknown name is refused', async () => {
    await add('RQ_TEST_HTML', 'html', { query: `select '<script>alert(1)</script>' as note` });
    const res = await king.get('/a/hr/1?doc=RQ_TEST_HTML');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-security-policy']), /sandbox/);
    assert.match(String(res.headers['content-disposition']), /^attachment/);
    assert.doesNotMatch(res.body, /<script>alert/);
    await add('RQ_TEST_NOBODY', 'csv', { authz: '!MUST_NOT_BE_PUBLIC_USER' });
    assert.equal((await king.get('/a/hr/1?doc=RQ_TEST_NOBODY')).statusCode, 403);
    assert.equal((await king.get('/a/hr/1?doc=RQ_TEST_GHOST')).statusCode, 403);
  });

  test('exported with the application and written as files; the runtime role cannot change them', async () => {
    const doc = (await owner.one('select meta.export_app($1) as d', ['hr'])).d;
    assert.ok(doc.report_queries.some((q: { name: string }) => q.name === 'RQ_TEST_CSV'));
    const files = docToFiles(doc, 'json');
    assert.ok(files.has('shared/report-queries/rq_test_csv.json'));
    assert.ok(files.has('shared/report-queries/rq_test_csv.query.sql'), 'a long query in its own file');
    assert.deepEqual(filesToDoc(files).report_queries, doc.report_queries);
    await assert.rejects(runtime.query(`insert into meta.report_query (app_id, name, query) values ($1, 'RQ_TEST_X', 'select 1')`, [appId]), /permission denied/);
    await assert.rejects(runtime.query(`update meta.report_query set query = 'select 2' where app_id = $1`, [appId]), /permission denied/);
  });
});
