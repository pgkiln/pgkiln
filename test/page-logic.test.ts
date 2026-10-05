// Page logic, part 2 (migration 039): download, execution chain (in the
// foreground and in the background) and workflow processes, server-side
// conditions on processes, branches to a function's URL and to another
// application, and the dynamic action event "dialog_closed". HR page 28
// ("Employee toolkit", examples/hr/hr_29_toolkit.sql) is the fixture.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { runProcessJobs } from '../src/process-jobs.ts';
import { urlChecksum } from '../src/security.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const cleanup: (() => Promise<unknown>)[] = [];

const as = async (user: string) => {
  const b = new Browser(app);
  const res = await b.login(user);
  assert.equal(res.statusCode, 303, `login as ${user}`);
  await b.get('/a/hr/28');
  return b;
};
const developer = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
};
const meta = (body: string) => JSON.parse(/<script type="application\/json" id="pgapex-meta">([\s\S]*?)<\/script>/.exec(body)![1]);
/** Insert a row for one test; removed again after all tests. */
const temp = async (sql: string, params: unknown[]) => {
  const row = (await owner.query(sql, params)).rows[0];
  const table = /insert into (meta\.[a-z_]+)/.exec(sql)![1];
  cleanup.push(() => owner.query(`delete from ${table} where id = $1`, [row.id]));
  return row;
};
const kingDocs = () => owner.query('delete from hr.emp_document where empno = 7839');

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 28', [appId])).id;
  await owner.query(`delete from meta.process_job where app_id = $1`, [appId]);
});
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
after(async () => {
  await kingDocs();
  await owner.query(`delete from meta.process_job where app_id = $1`, [appId]);
  await owner.query(`delete from meta.app where alias like 'logic-other%'`);
  await app.close();
  await closePools();
});

describe('download process', () => {
  test('one row: the file as it is, an attachment that is never sniffed, sandboxed, not cached', async () => {
    const king = await as('king');
    const res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'CARD' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/vcard');
    assert.match(String(res.headers['content-disposition']), /^attachment; filename="king\.vcf"; filename\*=UTF-8''king\.vcf$/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(String(res.headers['content-security-policy']), /sandbox/);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.match(res.body, /BEGIN:VCARD[\s\S]*FN:King[\s\S]*END:VCARD/);
  });

  test('several rows: one zip file with unique names; none: a message', async () => {
    await kingDocs();
    const king = await as('king');
    let res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'DOCUMENTS' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /There is no file to download/);
    await owner.query(
      `insert into hr.emp_document (empno, filename, mime_type, content, uploaded_by) values
         (7839, 'contract.txt', 'text/plain', convert_to('first', 'UTF8'), 'king'),
         (7839, 'contract.txt', 'text/plain', convert_to('second', 'UTF8'), 'king'),
         (7839, '../../etc/passwd', 'text/plain', convert_to('third', 'UTF8'), 'king')`,
    );
    res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'DOCUMENTS' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(String(res.headers['content-disposition']), /filename="documents-7839\.zip"/);
    const files = unzipSync(new Uint8Array(res.rawPayload));
    assert.deepEqual(Object.keys(files).sort(), ['_.._etc_passwd', 'contract (2).txt', 'contract.txt']);
    assert.equal(Buffer.from(files['contract (2).txt']).toString(), 'second');
    await kingDocs();
  });

  test('the query runs as the app role, with row level security: another user gets no file', async () => {
    await owner.query(`insert into hr.emp_document (empno, filename, mime_type, content, uploaded_by) values (7839, 'secret.txt', 'text/plain', '\\x00'::bytea, 'king')`);
    const scott = await as('scott');
    const res = await scott.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'DOCUMENTS' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /There is no file to download/);
    await kingDocs();
  });

  test('a download process on load sends the file instead of the page', async () => {
    await temp(
      `insert into meta.process (page_id, seq, name, type, point, code, condition_type, condition_expr, config)
       values ($1, 1, 'Load download', 'download', 'load', $$select 'x,y' as content, 'list.csv' as filename, 'text/csv' as mime_type$$, 'sql', $$:P28_ENAME = 'GETFILE'$$, '{}') returning id`,
      [pageId],
    );
    const king = await as('king');
    assert.match((await king.get('/a/hr/28')).headers['content-type'] as string, /text\/html/, 'condition false: the page');
    const res = await king.get(`/a/hr/28?P28_ENAME=GETFILE&cs=${urlChecksum(appId, 28, 'king', { P28_ENAME: 'GETFILE' })}`);
    assert.equal(res.headers['content-type'], 'text/csv');
    assert.equal(res.body, 'x,y');
  });
});

describe('execution chains and workflow processes', () => {
  test('a chain runs its children in sequence: the lookup, then the workflow with its variables; Stop terminates it', async () => {
    const king = await as('king');
    let res = await king.submit('/a/hr/28', { P28_EMPNO: '7788', __request: 'ONBOARD' });
    assert.equal(res.statusCode, 303);
    const body = (await king.get('/a/hr/28')).body;
    const id = /id="P28_WORKFLOW_ID"[^>]*>(\d+)</.exec(body)?.[1];
    assert.ok(id, 'the workflow id is in P28_WORKFLOW_ID');
    assert.match(body, new RegExp(`Workflow ${id} started`));
    const wf = await owner.one('select name, detail_pk, vars, initiator, state, version from meta.workflow where id = $1', [id]);
    assert.equal(wf.name, 'ONBOARDING');
    assert.equal(wf.detail_pk, '7788');
    assert.equal(wf.vars.ENAME, 'Scott');
    assert.equal(Number(wf.vars.SAL), 3000);
    assert.equal(wf.initiator, 'king');
    res = await king.submit('/a/hr/28', { P28_EMPNO: '7788', __request: 'STOP' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select state from meta.workflow where id = $1', [id])).state, 'terminated');
    assert.match((await king.get('/a/hr/28')).body, new RegExp(`Workflow ${id} terminated`));
  });

  test('another user cannot terminate the workflow; an unknown version is refused', async () => {
    const king = await as('king');
    await king.submit('/a/hr/28', { P28_EMPNO: '7788', __request: 'ONBOARD' });
    const id = /id="P28_WORKFLOW_ID"[^>]*>(\d+)</.exec((await king.get('/a/hr/28')).body)![1];
    const allen = await as('allen');
    await owner.query(`update meta.session set state = state || jsonb_build_object('P28_WORKFLOW_ID', $1::text) where username = 'allen'`, [id]);
    const res = await allen.submit('/a/hr/28', { P28_EMPNO: '7788', __request: 'STOP' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /You cannot terminate this workflow/);
    assert.equal((await owner.one('select state from meta.workflow where id = $1', [id])).state, 'active');
    await owner.query(`update meta.workflow set state = 'terminated' where id = $1`, [id]);
    const p = await owner.one(`select id, config from meta.process where page_id = $1 and name = 'Start the workflow'`, [pageId]);
    await owner.query(`update meta.process set config = config || '{"version": "99"}' where id = $1`, [p.id]);
    try {
      const r = await king.submit('/a/hr/28', { P28_EMPNO: '7788', __request: 'ONBOARD' });
      assert.equal(r.statusCode, 422);
      assert.match(r.body, /has no version 99/);
    } finally {
      await owner.query('update meta.process set config = $2 where id = $1', [p.id, p.config]);
    }
  });

  test('children have their own conditions and authorization; a failing child stops the chain and rolls it back', async () => {
    const chain = await temp(`insert into meta.process (page_id, seq, name, type, when_button, config) values ($1, 90, 'Test chain', 'chain', 'OPEN', '{}') returning id`, [pageId]);
    await temp(`insert into meta.process (page_id, seq, name, type, parent_process, code, condition_type, condition_expr, condition_value) values ($1, 1, 'Skipped', 'sql', 'Test chain', 'select 1/0', 'item_equals', 'P28_EMPNO', '1') returning id`, [pageId]);
    await temp(`insert into meta.process (page_id, seq, name, type, parent_process, code, authz) values ($1, 2, 'Not allowed', 'sql', 'Test chain', 'select 1/0', 'NO_SUCH_SCHEME') returning id`, [pageId]);
    await temp(`insert into meta.process (page_id, seq, name, type, parent_process, code, success_message) values ($1, 3, 'Runs', 'sql', 'Test chain', $$select 'ran' as p28_ename$$, 'Child ran.') returning id`, [pageId]);
    const king = await as('king');
    let res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' });
    assert.equal(res.statusCode, 303);
    assert.match((await king.get(String(res.headers.location))).body, /Child ran\./);
    // a failing child: the whole submit fails
    await temp(`insert into meta.process (page_id, seq, name, type, parent_process, code) values ($1, 4, 'Fails', 'sql', 'Test chain', $2) returning id`,
      [pageId, "do $b$ begin raise exception 'child failed'; end $b$"]);
    res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /child failed/);
    void chain;
  });
});

describe('background chains', () => {
  test('queued by the submit, run by the server, status for the user and the developer', async () => {
    const king = await as('king');
    const res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'RECALC' });
    assert.equal(res.statusCode, 303);
    let body = (await king.get('/a/hr/28')).body;
    const id = /id="P28_JOB_ID"[^>]*>(\d+)</.exec(body)?.[1];
    assert.ok(id);
    assert.match(body, new RegExp(`Started in the background \\(job ${id}\\)`));
    const job = await owner.one('select state, app_user, roles, binds, steps_total from meta.process_job where id = $1', [id]);
    assert.equal(job.state, 'queued');
    assert.equal(job.app_user, 'king');
    assert.deepEqual([...job.roles].sort(), ['admin', 'manager']);
    assert.equal(job.binds.P28_EMPNO, '7839');
    assert.equal(job.steps_total, 2);
    assert.ok(await runProcessJobs() >= 1);
    const done = await owner.one('select state, message, error, steps_done from meta.process_job where id = $1', [id]);
    assert.equal(done.state, 'completed', done.error);
    assert.equal(done.message, 'Salaries checked. Department checked.');
    assert.equal(done.steps_done, 2);
    body = (await king.get('/a/hr/28')).body;
    assert.match(body, /My background jobs[\s\S]*completed[\s\S]*Salaries checked\. Department checked\./);
    // the developer sees the runs in the page designer
    const dev = await developer();
    const chain = await owner.one(`select id from meta.process where page_id = $1 and name = 'Year-end check'`, [pageId]);
    const pd = await dev.get(`/builder/pages/${pageId}?c=process-${chain.id}`);
    assert.match(pd.body, /Jobs[\s\S]*completed[\s\S]*king/);
  });

  test("the starter's roles apply in the background; a failing child fails the job; types that need the request are refused", async () => {
    const chain = await owner.one(`select id from meta.process where page_id = $1 and name = 'Year-end check'`, [pageId]);
    void chain;
    await temp(`insert into meta.process (page_id, seq, name, type, parent_process, code, condition_type, condition_expr, success_message)
                values ($1, 60, 'Admins only', 'sql', 'Year-end check', 'select 1', 'sql', $$meta.has_role('admin')$$, 'Admin step.') returning id`, [pageId]);
    const king = await as('king');
    await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'RECALC' });
    const scott = await as('scott');
    await scott.submit('/a/hr/28', { P28_EMPNO: '7788', __request: 'RECALC' });
    await runProcessJobs();
    const jobs = (await owner.query(`select app_user, state, message from meta.process_job where app_id = $1 order by id desc limit 2`, [appId])).rows;
    assert.equal(jobs.find((j) => j.app_user === 'king')!.message, 'Salaries checked. Department checked. Admin step.');
    assert.equal(jobs.find((j) => j.app_user === 'scott')!.message, 'Salaries checked. Department checked.');
    // each user sees only their own jobs
    const scottPage = (await scott.get('/a/hr/28')).body;
    assert.doesNotMatch(scottPage, /Admin step\./);
    const fail = await temp(`insert into meta.process (page_id, seq, name, type, parent_process, code) values ($1, 70, 'Breaks', 'sql', 'Year-end check', $2) returning id`,
      [pageId, "do $b$ begin raise exception 'year end broke'; end $b$"]);
    await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'RECALC' });
    await runProcessJobs();
    let last = await owner.one(`select state, error from meta.process_job where app_id = $1 order by id desc limit 1`, [appId]);
    assert.equal(last.state, 'failed');
    assert.match(last.error, /year end broke/);
    await owner.query(`update meta.process set type = 'download', code = $$select 'x'$$ where id = $1`, [fail.id]);
    await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'RECALC' });
    await runProcessJobs();
    last = await owner.one(`select state, error from meta.process_job where app_id = $1 order by id desc limit 1`, [appId]);
    assert.equal(last.state, 'failed');
    assert.match(last.error, /cannot run in the background/);
  });

  test('several servers: every job runs once; a job whose server stopped is failed, not run again', async () => {
    const king = await as('king');
    for (let i = 0; i < 4; i++) await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'RECALC' });
    const counts = await Promise.all([runProcessJobs(), runProcessJobs(), runProcessJobs()]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 4);
    assert.equal((await owner.one(`select count(*)::int as n from meta.process_job where app_id = $1 and state in ('queued', 'running')`, [appId])).n, 0);
    await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'RECALC' });
    const stuck = await owner.one(`update meta.process_job set state = 'running', updated_at = now() - interval '10 minutes' where app_id = $1 and state = 'queued' returning id`, [appId]);
    await runProcessJobs();
    const row = await owner.one('select state, error from meta.process_job where id = $1', [stuck.id]);
    assert.equal(row.state, 'failed');
    assert.match(row.error, /server running it stopped/);
  });
});

describe('branches', () => {
  test('function returning a URL: the PL/pgSQL result is where the browser goes', async () => {
    const king = await as('king');
    const pending = (await owner.one(`select count(*)::int as n from hr.leave_request where empno = 7839 and status = 'PENDING'`)).n;
    const res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' });
    assert.equal(res.headers.location, pending ? '/a/hr/6' : '/a/hr/12');
  });

  test('a function result outside the application is refused; null means the next branch', async () => {
    const b = await owner.one(`select id, target_function from meta.branch where page_id = $1 and name = 'Open the right page'`, [pageId]);
    try {
      for (const bad of ['//evil.example/x', 'https://evil.example', 'javascript:alert(1)', '../builder', '\\\\evil.example', '6\r\nSet-Cookie: x=1']) {
        await owner.query('update meta.branch set target_function = $2 where id = $1', [b.id, `begin return ${pgLiteral(bad)}; end`]);
        const king = await as('king');
        const res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' });
        assert.equal(res.headers.location, '/a/hr/28', bad);
      }
      await owner.query('update meta.branch set target_function = $2 where id = $1', [b.id, 'begin return null; end']);
      const king = await as('king');
      assert.equal((await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' })).headers.location, '/a/hr/28');
    } finally {
      await owner.query('update meta.branch set target_function = $2 where id = $1', [b.id, b.target_function]);
    }
  });

  test('to another application: only one that exists, items signed for that application, page and user', async () => {
    const other = (await owner.one(`insert into meta.app (alias, name) values ('logic-other', 'Other') returning id`)).id;
    await owner.query(`insert into meta.page (app_id, page_no, name, protection) values ($1, 1, 'Start', 'checksum')`, [other]);
    await temp(
      `insert into meta.branch (page_id, seq, name, when_button, target_type, target_app, target_page, target_items)
       values ($1, 1, 'Elsewhere', 'OPEN', 'app', 'logic-other', 1, '{"P1_EMPNO": "&P28_EMPNO."}') returning id`,
      [pageId],
    );
    const king = await as('king');
    const res = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' });
    const cs = urlChecksum(other, 1, 'king', { P1_EMPNO: '7839' });
    assert.equal(res.headers.location, `/a/logic-other/1?P1_EMPNO=7839&cs=${cs}`);
    // a missing application or page: the branch doesn't apply (the next one does)
    await owner.query(`update meta.branch set target_page = 2 where name = 'Elsewhere' and page_id = $1`, [pageId]);
    const res2 = await (await as('king')).submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' });
    assert.match(String(res2.headers.location), /^\/a\/hr\/(6|12)$/);
  });
});

describe('dynamic action "dialog closed"', () => {
  test('the page carries the action; the closing dialog names its page; the action brings the dialog\'s message', async () => {
    const king = await as('king');
    const page = await king.get('/a/hr/28');
    const da = meta(page.body).das.find((d: any) => d.event === 'dialog_closed');
    assert.ok(da);
    assert.deepEqual(da.trigger, ['3']);
    assert.equal(da.action, 'refresh_region');
    // a page submitted inside a dialog answers with the closing page, which names itself
    const closed = await king.submit('/a/hr/28', { P28_EMPNO: '7839', __dialog: '1', __request: 'OPEN' });
    assert.equal(closed.statusCode, 200);
    assert.match(closed.body, /data-dialog-close="1" data-dialog-page="28"/);
    await king.get('/a/hr/28');
    await owner.query(`update meta.session set state = state || '{"__FLASH": "Employee saved."}' where username = 'king'`);
    const res = await king.submit(`/a/hr/28/da/${da.id}`, { __dialog_closed: '1', P28_EMPNO: '7839' });
    assert.equal(res.statusCode, 200, res.body);
    const json = JSON.parse(res.body);
    assert.ok(json.regions[da.region], 'the team region comes back');
    assert.equal(json.flash, 'Employee saved.', 'with the dialog\'s success message');
    // taken: the next page doesn't show it again
    const again = JSON.parse((await king.submit(`/a/hr/28/da/${da.id}`, { __dialog_closed: '1' })).body);
    assert.equal(again.flash, undefined);
  });
});

describe('builder', () => {
  test('process configurations are checked; the new fields are in the property editor', async () => {
    const dev = await developer();
    assert.match((await dev.get(`/builder/pages/${pageId}?new=process`)).body, /name="parent_process"/);
    const form = {
      name: 'Bad', type: 'workflow', point: 'submit', config: '{"action": "explode"}', seq: '99', parent_process: '', code: '', region_id: '', when_button: '',
      condition_type: '', condition_expr: '', condition_value: '', success_message: '', authz: '', build_option: '',
    };
    await dev.submit(`/builder/pages/${pageId}/c/process`, form);
    assert.equal((await owner.one(`select count(*)::int as n from meta.process where page_id = $1 and name = 'Bad'`, [pageId])).n, 0, 'not saved');
    // a valid one is saved, with its chain and condition
    await dev.submit(`/builder/pages/${pageId}/c/process`, { ...form, name: 'Good', config: '{"action": "retry", "instance": "&P28_WORKFLOW_ID."}', parent_process: 'Onboard', condition_type: 'item_not_null', condition_expr: 'P28_WORKFLOW_ID' });
    const good = await owner.one(`select id, parent_process, condition_type from meta.process where page_id = $1 and name = 'Good'`, [pageId]);
    assert.equal(good?.parent_process, 'Onboard');
    assert.equal(good.condition_type, 'item_not_null');
    await owner.query('delete from meta.process where id = $1', [good.id]);
    const chain = await owner.one(`select id from meta.process where page_id = $1 and name = 'Onboard'`, [pageId]);
    const pd = (await dev.get(`/builder/pages/${pageId}?c=process-${chain.id}`)).body;
    assert.match(pd, /name="parent_process"/);
    assert.match(pd, /<option value="chain" selected/);
    const branch = await owner.one(`select id from meta.branch where page_id = $1 and name = 'Open the right page'`, [pageId]);
    const bd = (await dev.get(`/builder/pages/${pageId}?c=branch-${branch.id}`)).body;
    assert.match(bd, /name="target_function"/);
    assert.match(bd, /name="target_app"/);
  });
});

function pgLiteral(s: string) {
  return `'${s.replace(/'/g, "''").replace(/\\/g, '\\\\')}'`.replace(/^'/, "E'");
}
