// Workflow invoke_api steps (sprint 32): a REST data source or a URL called
// between two transactions, response values into variables, faults and
// retries, the lease, the Advisor and the export. Against a local mock web
// service (CI has no .env and no other web service).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/env.ts';

process.env.PGAPEX_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1';
process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';

const { closePools, owner } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const { invokeStepReferences, runWorkflow, runWorkflows, stepProblems, workflowDiagram } = await import('../src/workflow.ts');

let appId: number;
let mock: http.Server;
let mockBase = '';
const seen: { method: string; url: string; auth: string | null; body: string }[] = [];
let failing = true;
let release: (() => void) | null = null;
let arrived: (() => void) | null = null;

before(async () => {
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? null, body });
      const u = new URL(req.url!, 'http://x');
      const send = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (u.pathname.startsWith('/rates/'))
        return send(200, { base: decodeURIComponent(u.pathname.slice(7)), rates: [{ currency: 'EUR', rate: 0.9 }, { currency: 'GBP', rate: 0.8 }], date: u.searchParams.get('date') });
      if (u.pathname === '/orders') return send(201, { id: 42, echo: JSON.parse(body || 'null') });
      if (u.pathname === '/flaky') return failing ? send(503, { error: 'down' }) : send(200, { ok: true });
      if (u.pathname === '/missing') return send(404, { error: 'no such thing' });
      if (u.pathname === '/hold') {
        arrived?.();
        return void new Promise<void>((r) => (release = r)).then(() => send(200, { held: true }));
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const cred = await owner.one(`insert into meta.web_credential (app_id, name, type, secret_enc) values ($1, 'T_WF_TOKEN', 'bearer', $2) returning id`, [appId, encryptSecret('wf-s3cret')]);
  assert.ok(cred.id);
  await owner.query(
    `insert into meta.rest_source (app_id, name, url, method, credential, params, row_selector, columns)
     values ($1, 'T_WF_RATES', $2, 'GET', 'T_WF_TOKEN', $3, 'rates', $4)`,
    [appId, `${mockBase}/rates/{base}`, JSON.stringify([{ name: 'base', in: 'path', required: true }, { name: 'date', in: 'query', default: '2026-10-05' }]),
      JSON.stringify([{ name: 'currency', type: 'text' }, { name: 'rate', type: 'number' }])],
  );
});

async function cleanup() {
  await owner.query(`delete from meta.workflow where app_id = $1 and name like 'TEST\\_WF\\_%'`, [appId]);
  await owner.query(`delete from meta.workflow_definition where app_id = $1 and name like 'TEST\\_WF\\_%'`, [appId]);
  await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'T\\_WF\\_%'`, [appId]);
  await owner.query(`delete from meta.web_credential where app_id = $1 and name like 'T\\_WF\\_%'`, [appId]);
}

after(async () => {
  release?.();
  await cleanup();
  mock.close();
  await closePools();
});

const define = (name: string, steps: unknown, title = 'Test') =>
  owner.query(`insert into meta.workflow_definition (app_id, name, title, admin_role, steps) values ($1, $2, $3, 'admin', $4)`, [appId, name, title, JSON.stringify(steps)]);
const start = (name: string, vars: Record<string, unknown>, detail: string | null = null) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'blake', true)`, [String(appId)]);
    return (await c.query('select meta.start_workflow($1, $2, $3) as id', [name, detail, vars])).rows[0].id as string;
  });
const asAdmin = <T>(fn: (c: import('pg').PoolClient) => Promise<T>) =>
  owner.tx(async (c) => {
    await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'king', true), set_config('request.jwt.claims', '{"roles": ["admin"]}', true)`, [String(appId)]);
    return fn(c);
  });
/** Run until this workflow stops moving (another server on the same database may take steps too). */
async function settle(id: string) {
  for (let i = 0; i < 50; i++) {
    await runWorkflows();
    const w = await owner.one('select state from meta.workflow where id = $1', [id]);
    if (!w || w.state !== 'active') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const wf = (id: string) => owner.one('select state, current_step, error, vars, wait_until from meta.workflow where id = $1', [id]);
const events = async (id: string) =>
  (await owner.query('select step, event, detail from meta.workflow_event where workflow_id = $1 order by id', [id])).rows.map((e) => `${e.step ?? '-'}:${e.event}${e.detail ? `:${e.detail}` : ''}`);

describe('invoke_api steps: definitions', () => {
  test('stepProblems checks the call, the variables and the time limit', () => {
    assert.deepEqual(stepProblems([{ name: 'A', type: 'invoke_api', source: 'RATES', params: { base: '&CUR.' }, variables: { RATE: 'rates[0].rate' }, status_variable: 'HTTP', timeout: 20 }]), []);
    assert.deepEqual(stepProblems([{ name: 'A', type: 'invoke_api', url: 'https://api.example.com/x/&ID.', method: 'post', body: '{"a": &A.}', response_variable: 'R' }]), []);
    const bad = stepProblems([
      { name: 'A', type: 'invoke_api' },
      { name: 'B', type: 'invoke_api', source: 'X', url: 'https://x.example/' },
      { name: 'C', type: 'invoke_api', url: 'https://&HOST./x' },
      { name: 'D', type: 'invoke_api', url: 'https://x.example/', method: 'TRACE', variables: { rate: 'x' } },
      { name: 'E', type: 'invoke_api', source: 'X', variables: { R: 1 }, status_variable: 'DETAIL_PK' },
      { name: 'F', type: 'invoke_api', source: 'X', timeout: 61 },
      { name: 'G', type: 'invoke_api', source: 'X', params: { a: 1 } },
    ]);
    for (const re of [/A\): It needs either "source"/, /B\): It needs either/, /C\): "url" starts with/, /D\): "method" is one of/, /D\): variable names are upper case/,
      /E\): "variables" is an object/, /E\): DETAIL_PK is set by the workflow itself/, /F\): "timeout" is a number of seconds from 1 to 60/, /G\): "params" is an object of strings/])
      assert.ok(bad.some((p) => re.test(p)), `${re}: ${bad.join(' | ')}`);
  });

  test('the diagram shows the step type', () => {
    const svg = String(workflowDiagram([{ name: 'RATE', type: 'invoke_api', source: 'EXCHANGE' }, { name: 'POST', type: 'invoke_api', url: 'https://x.example/', method: 'post' }]));
    assert.match(svg, /wf-node wf-invoke_api/);
    assert.match(svg, /invoke API EXCHANGE/);
    assert.match(svg, /invoke API POST URL/);
  });

  test('Advisor references: unknown sources, parameters and credentials, required parameters, unset variables', () => {
    const refs = {
      sources: new Map([['RATES', { params: [{ name: 'base', required: true }, { name: 'date', default: 'x' }], columns: [{ name: 'rate' }] }]]),
      credentials: new Set(['TOKEN']),
      startVars: ['CUR'],
    };
    const steps = [
      { name: 'A', type: 'invoke_api', source: 'rates', params: { base: '&CUR.', nope: '&MISSING.' } },
      { name: 'B', type: 'invoke_api', source: 'NOPE' },
      { name: 'C', type: 'invoke_api', source: 'RATES', params: {} },
      { name: 'D', type: 'invoke_api', url: 'https://x.example/&RATE./&ORDER_NO./&LATER.', credential: 'OTHER', body: '{"x": &TASK_OUTCOME.}' },
      { name: 'E', type: 'sql', code: 'select 1 as order_no' },
      { name: 'F', type: 'invoke_api', url: 'https://x.example/', variables: { LATER: 'a' } },
    ];
    const { errors, warnings } = invokeStepReferences(steps, refs);
    assert.deepEqual(errors, [
      'Step A: REST data source RATES has no parameter nope.',
      "Step B: REST data source NOPE doesn't exist.",
      "Step D: web credential OTHER doesn't exist.",
    ]);
    assert.deepEqual(warnings, [
      'Step A: no step sets the variable MISSING; give it when the workflow starts, or &MISSING. is sent as written.',
      'Step C: parameter base of RATES is required but gets no value.',
    ]);
    assert.deepEqual(invokeStepReferences([{ name: 'S', type: 'sql', code: 'select 1' }], refs), { errors: [], warnings: [] });
  });
});

describe('invoke_api steps: running', () => {
  test('a REST data source with its credential: parameters from variables, values and status into variables', async () => {
    await define('TEST_WF_SOURCE', [
      { name: 'RATE', type: 'invoke_api', source: 'T_WF_RATES', params: { base: '&CUR.' }, variables: { EUR: 'rates[0].rate', DAY: 'date' }, status_variable: 'HTTP' },
      { name: 'ROWS', type: 'invoke_api', source: 'T_WF_RATES', params: { base: '&DETAIL_PK.', date: '&DAY.' } },
      { name: 'CHECK', type: 'sql', code: 'select (:EUR::numeric * 10)::int as eur10, :CURRENCY as first_currency' },
    ]);
    const n = seen.length;
    const id = await start('TEST_WF_SOURCE', { cur: 'USD/1' }, 'JPY');
    await settle(id);
    const w = await wf(id);
    assert.equal(w.state, 'completed', w.error);
    assert.equal(w.vars.EUR, 0.9);
    assert.equal(w.vars.HTTP, 200);
    assert.equal(w.vars.DAY, '2026-10-05');
    // without "variables": the first row's columns of the source
    assert.equal(w.vars.CURRENCY, 'EUR');
    assert.equal(w.vars.RATE, 0.9);
    assert.equal(w.vars.EUR10, 9);
    const calls = seen.slice(n);
    assert.deepEqual(calls.map((c) => c.url), ['/rates/USD%2F1?date=2026-10-05', '/rates/JPY?date=2026-10-05']);
    assert.ok(calls.every((c) => c.auth === 'Bearer wf-s3cret'));
    const ev = await events(id);
    assert.ok(ev.includes('RATE:waiting:calling REST data source T_WF_RATES'), ev.join(' | '));
    assert.ok(ev.includes('RATE:step:HTTP 200'), ev.join(' | '));
    // the secret is nowhere in the instance
    assert.doesNotMatch(JSON.stringify([w, ev]), /wf-s3cret/);
  });

  test('a URL: POST with a JSON body from variables, the whole response into a variable', async () => {
    await define('TEST_WF_URL', [
      { name: 'ORDER', type: 'invoke_api', url: `${mockBase}/orders`, method: 'POST', body: '{"note": &NOTE., "who": &INITIATOR., "keep": &UNKNOWN_X.}', response_variable: 'ORDER', variables: { ORDER_ID: 'id' } },
      { name: 'NEXT', type: 'sql', code: "select (:ORDER::jsonb->'echo'->>'note') as note_back" },
    ]);
    const n = seen.length;
    const id = await start('TEST_WF_URL', { note: 'he said "hi"' });
    await settle(id);
    const w = await wf(id);
    assert.equal(w.state, 'completed', w.error);
    assert.equal(seen[n].method, 'POST');
    assert.deepEqual(JSON.parse(seen[n].body), { note: 'he said "hi"', who: 'blake', keep: '&UNKNOWN_X.' });
    assert.equal(w.vars.ORDER_ID, 42);
    assert.equal(w.vars.ORDER.id, 42);
    assert.equal(w.vars.NOTE_BACK, 'he said "hi"');
  });

  test('a failing call faults the step; the console retry calls again', async () => {
    failing = true;
    await define('TEST_WF_FLAKY', [{ name: 'CALL', type: 'invoke_api', url: `${mockBase}/flaky`, variables: { OK: 'ok' } }, { name: 'END', type: 'end' }]);
    const id = await start('TEST_WF_FLAKY', {});
    await settle(id);
    let w = await wf(id);
    assert.equal(w.state, 'faulted');
    assert.equal(w.current_step, 'CALL');
    assert.match(w.error, /Step CALL: the web service answered 503/);
    failing = false;
    await asAdmin((c) => c.query('select meta.retry_workflow($1)', [id]));
    await settle(id);
    w = await wf(id);
    assert.equal(w.state, 'completed', w.error);
    assert.equal(w.vars.OK, true);
  });

  test('with status_variable an error status goes on; hosts off the allow-list fault the step', async () => {
    await define('TEST_WF_STATUS', [
      { name: 'CALL', type: 'invoke_api', url: `${mockBase}/missing`, status_variable: 'STATUS', variables: { E: 'error' } },
      { name: 'BAD', type: 'invoke_api', url: 'http://169.254.169.254/latest/meta-data/' },
    ]);
    const id = await start('TEST_WF_STATUS', {});
    await settle(id);
    const w = await wf(id);
    assert.equal(w.vars.STATUS, 404);
    assert.equal(w.vars.E, null, 'an error response is not read');
    assert.equal(w.state, 'faulted');
    assert.equal(w.current_step, 'BAD');
    assert.match(w.error, /allow-list|private/);
  });

  test('no transaction is open during the call; a workflow terminated meanwhile drops the result', async () => {
    await define('TEST_WF_HOLD', [{ name: 'CALL', type: 'invoke_api', url: `${mockBase}/hold`, variables: { HELD: 'held' }, timeout: 5 }, { name: 'END', type: 'end' }]);
    const id = await start('TEST_WF_HOLD', {});
    const there = new Promise<void>((r) => (arrived = r));
    const running = runWorkflow(id);
    await there;
    // the row is not locked, the path waits with a lease and says what it calls
    const w = await owner.tx(async (c) => (await c.query(`select state, current_step, wait_until > now() + interval '30 seconds' as leased from meta.workflow where id = $1 for update nowait`, [id])).rows[0]);
    assert.deepEqual(w, { state: 'waiting', current_step: 'CALL', leased: true });
    const idle = await owner.one(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'idle in transaction' and query like '%meta.workflow%'`);
    assert.equal(idle.n, 0);
    // a second runner leaves it alone while the lease lasts
    assert.equal(await runWorkflow(id), 0);
    await asAdmin((c) => c.query('select meta.terminate_workflow($1)', [id]));
    release!();
    await running;
    const after = await wf(id);
    assert.equal(after.state, 'terminated');
    assert.equal(after.vars.HELD, undefined);
  });

  test('a lease that runs out (the server stopped during the call) faults the step instead of calling again', async () => {
    await define('TEST_WF_LOST', [{ name: 'CALL', type: 'invoke_api', url: `${mockBase}/orders`, method: 'POST' }, { name: 'END', type: 'end' }]);
    const id = await start('TEST_WF_LOST', {});
    // what a crash leaves: waiting at the step, the lease over
    await owner.query(`update meta.workflow set state = 'waiting', wait_until = now() - interval '1 second' where id = $1`, [id]);
    const n = seen.length;
    await runWorkflow(id);
    const w = await wf(id);
    assert.equal(w.state, 'faulted');
    assert.match(w.error, /didn't finish/);
    assert.equal(seen.length, n, 'no second call');
  });

  test('in a parallel branch: the other branch goes on, the join waits for the call', async () => {
    await define('TEST_WF_BRANCH', [
      { name: 'SPLIT', type: 'parallel', branches: ['CALL', 'LOCAL'], join: 'J' },
      { name: 'CALL', type: 'invoke_api', source: 'T_WF_RATES', params: { base: 'EUR' }, variables: { GBP: 'rates[1].rate' }, next: 'J' },
      { name: 'LOCAL', type: 'sql', code: "select 'x' as local", next: 'J' },
      { name: 'J', type: 'join' },
      { name: 'SUM', type: 'sql', code: 'select :GBP::numeric as gbp_again' },
    ]);
    const id = await start('TEST_WF_BRANCH', {});
    await settle(id);
    for (let i = 0; i < 20 && (await wf(id)).state !== 'completed'; i++) await runWorkflows();
    const w = await wf(id);
    assert.equal(w.state, 'completed', w.error);
    assert.equal(w.vars.GBP, 0.8);
    assert.equal(w.vars.LOCAL, 'x');
    assert.equal(Number(w.vars.GBP_AGAIN), 0.8);
  });

  test('the Advisor and the builder page report invoke_api problems; the diagram shows the step', async () => {
    await define('TEST_WF_ADVISOR', [
      { name: 'CALL', type: 'invoke_api', source: 'T_WF_NOPE', next: 'RATE' },
      { name: 'RATE', type: 'invoke_api', source: 'T_WF_RATES', params: { date: '&WHEN.' }, credential: 'T_WF_GONE' },
    ], 'Rates &CUR.');
    const { advise } = await import('../src/builder/advisor.ts');
    const mine = (await advise(appId)).findings.filter((f) => f.entry?.label === 'TEST_WF_ADVISOR').map((f) => `${f.severity}: ${f.message}`);
    assert.ok(mine.includes("error: Step CALL: REST data source T_WF_NOPE doesn't exist."), mine.join(' | '));
    assert.ok(mine.includes("error: Step RATE: web credential T_WF_GONE doesn't exist."), mine.join(' | '));
    assert.ok(mine.includes('warning: Step RATE: parameter base of T_WF_RATES is required but gets no value.'), mine.join(' | '));
    assert.ok(mine.includes('warning: Step RATE: no step sets the variable WHEN; give it when the workflow starts, or &WHEN. is sent as written.'), mine.join(' | '));
    const { buildApp } = await import('../src/app.ts');
    const { Browser } = await import('./helpers.ts');
    const app = await buildApp({ logger: false });
    try {
      const dev = new Browser(app);
      await dev.get('/builder/login');
      await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
      const def = await owner.one(`select id from meta.workflow_definition where app_id = $1 and name = 'TEST_WF_ADVISOR'`, [appId]);
      const page = (await dev.get(`/builder/apps/${appId}/shared?c=workflow_definition-${def.id}`)).body;
      assert.match(page, /REST data source T_WF_NOPE doesn&#39;t exist|REST data source T_WF_NOPE doesn't exist/);
      assert.match(page, /wf-node wf-invoke_api/);
      assert.match(page, /invoke API T_WF_RATES/);
      assert.match((await dev.get(`/builder/apps/${appId}/shared?new=workflow_definition`)).body, /Invoke API: /);
    } finally {
      await app.close();
    }
  });

  test('the export carries the step configuration', async () => {
    const steps = [{ name: 'RATE', type: 'invoke_api', source: 'T_WF_RATES', params: { base: '&CUR.' }, variables: { EUR: 'rates[0].rate' }, status_variable: 'HTTP', timeout: 15 }];
    await define('TEST_WF_EXPORT', steps);
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const def = JSON.stringify(doc).includes('TEST_WF_EXPORT');
    assert.ok(def);
    const found = (doc.workflow_definitions ?? []).find((d: any) => d.name === 'TEST_WF_EXPORT');
    assert.deepEqual(found.steps, steps);
  });
});
