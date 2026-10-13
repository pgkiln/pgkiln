// Sprint 66: a blueprint from an existing application (src/blueprint-from-app.ts),
// with the HR sample: its tables, pages and menu as a blueprint that checks
// without problems and creates a working copy, sample rows only when asked for.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { checkBlueprint } = await import('../src/blueprint.ts');
const { blueprintFromApp, checkValues, firstTable } = await import('../src/blueprint-from-app.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
let admin: InstanceType<typeof Browser>;
let hrId: number;
const DEV = 'bpa66_dev';
const WS = 'BPA66 Workspace';
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function cleanup() {
  await owner.query(`delete from meta.app where alias = 'hr-copy'`);
  await owner.query(`delete from meta.account where username = 'bpa66_admin'`);
  await owner.query(`drop schema if exists hr_copy cascade`);
  if ((await owner.query(`select 1 from pg_roles where rolname = 'app_hr_copy'`)).rowCount) {
    await owner.query('revoke app_hr_copy from pgkiln_runtime').catch(() => {});
    await owner.query('drop owned by app_hr_copy').catch(() => {});
    await owner.query('drop role app_hr_copy');
  }
  await owner.query('delete from meta.workspace where name = $1', [WS]);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
}

before(async () => {
  await cleanup();
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  admin = new Browser(app);
  await admin.get('/builder/login');
  await admin.post('/builder/login', { __csrf: admin.lastCsrf, username: 'admin', password: 'admin' });
  await admin.get('/builder');
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('a blueprint from an application', () => {
  test('the first table after FROM; value lists from CHECK constraints', () => {
    assert.equal(firstTable('select e.ename from hr.emp e join hr.dept d using (deptno)'), 'hr.emp');
    assert.equal(firstTable('select * from "Sales"."Orders"'), 'sales.orders');
    assert.equal(firstTable('select 1'), null);
    assert.deepEqual(checkValues(`CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'it''s'::text])))`), ['PENDING', 'APPROVED', "it's"]);
    assert.equal(checkValues('CHECK ((days > 0))'), null);
  });

  test('HR: its tables, pages and menu make a blueprint without problems; no rows unless asked for', async () => {
    const { spec, notes } = await blueprintFromApp(hrId);
    assert.deepEqual(checkBlueprint(spec).problems, []);
    assert.equal(spec.alias, 'hr-copy');
    assert.equal(spec.schema, 'hr_copy');
    const emp = spec.tables.find((t) => t.name === 'emp')!;
    assert.ok(emp.columns.some((c: any) => c.name === 'empno' && c.required && c.unique), 'the old key stays a required, unique column');
    assert.ok(!emp.columns.some((c: any) => c.name === 'photo'), 'binary data is left out');
    const leave = spec.tables.find((t) => t.name === 'leave_request')!;
    assert.deepEqual((leave.columns.find((c: any) => c.name === 'status') as any).values, ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN']);
    assert.deepEqual(spec.pages.find((p: any) => p.page === 2), { type: 'report_form', table: 'emp', page: 2, form_page: 3, label: 'Employees' });
    assert.equal((spec.pages.find((p: any) => p.page === 10) as any).type, 'grid');
    assert.ok(!spec.pages.some((p: any) => p.page === 3), 'the form page belongs to the report');
    assert.ok((spec as any).navigation.length > 5);
    assert.equal((spec as any).sample_data, undefined);
    assert.ok(notes.some((n) => /hr\.emp's key is empno/.test(n)));
    assert.ok(!spec.tables.some((t) => ['app', 'region', 'page'].includes(t.name)), 'never pgkiln\'s own tables');
  });

  test('the builder opens it in the editor; with sample rows, review and create make a working copy', async () => {
    const page = await admin.get('/builder/blueprints');
    assert.match(page.body, /From an application/);
    assert.equal((await admin.post('/builder/blueprints/from-app', { app: String(hrId) })).statusCode, 403, 'CSRF');
    const res = await admin.submit('/builder/blueprints/from-app', { app: String(hrId), rows: 'true' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /A blueprint of HR/);
    assert.match(res.body, /note(s)? on what didn/);
    const spec = unescape(/<textarea[^>]*name="spec"[^>]*>([\s\S]*?)<\/textarea>/.exec(res.body)![1]);
    const parsed = JSON.parse(spec);
    assert.ok(parsed.sample_data.find((d: any) => d.table === 'emp').rows.length >= 10);
    const review = await admin.submit('/builder/blueprints/review', { name: 'HR copy', spec });
    const sig = /name="sig" value="([^"]+)"/.exec(review.body)?.[1];
    assert.ok(sig, /<li>([^<]*)<\/li>/.exec(review.body)?.[1] ?? 'no review');
    const created = await admin.submit('/builder/blueprints/create', { name: 'HR copy', spec: unescape(/name="spec" value="([^"]*)"/.exec(review.body)![1]), sig, admin_user: 'bpa66_admin', admin_password: 'Bpa66-password!' });
    assert.equal(created.statusCode, 303, /No application was created: ([^<]*)/.exec(created.body)?.[1] ?? '');
    assert.equal((await owner.one(`select count(*)::int as n from hr_copy.emp`)).n, (await owner.one(`select count(*)::int as n from hr.emp`)).n);
    const b = new Browser(app);
    await b.login('bpa66_admin', 'Bpa66-password!', 'hr-copy');
    const run = await b.get('/a/hr-copy/2');
    assert.equal(run.statusCode, 200);
    assert.match(run.body, /KING/i);
  });

  test('only applications of the developer\'s workspace', async () => {
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password('Bpa66-dev-password!'), false)`, [DEV]);
    const ws = (await owner.one(`insert into meta.workspace (name) values ($1) returning id`, [WS])).id;
    await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
    await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [ws, DEV]);
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: DEV, password: 'Bpa66-dev-password!' });
    const page = await dev.get('/builder/blueprints');
    assert.doesNotMatch(page.body, /From an application/, 'no applications in this workspace');
    assert.equal((await dev.submit('/builder/blueprints/from-app', { app: String(hrId) })).statusCode, 404);
  });
});
