// Sprint 139 (AP-6): OpenTelemetry. A fake OTLP/HTTP collector receives what pgkiln sends: a trace per
// application request with a span per SQL statement (literals replaced unless values are included), the
// page and a hashed user; a failing REST call as an error span with the traceparent passed on; logs of
// failed sign-ins; metrics over OTLP and /metrics; a workspace switched off or with its own collector;
// head sampling that still keeps failures; browser spans relayed with a signed token.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { exportMetrics, flush, stopTelemetry } = await import('../src/telemetry/export.ts');
const { parsePairs, refreshTelemetry, saveInstanceTelemetry, saveWorkspaceTelemetry } = await import('../src/telemetry/config.ts');
const { parseTraceparent, redactText, rootSpan, sanitizeSql } = await import('../src/telemetry/trace.ts');
const { webRequest } = await import('../src/webclient.ts');
const { Browser } = await import('./helpers.ts');

interface Received { path: string; headers: http.IncomingHttpHeaders; body: any }
let received: Received[] = [];
let collector: http.Server;
let base = '';
let app: FastifyInstance;
let hrWs: number;

type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: { key: string; value: Record<string, unknown> }[]; status: { code: number; message?: string } };
const spans = (path = '/v1/traces'): OtlpSpan[] =>
  received.filter((r) => r.path.endsWith(path)).flatMap((r) => r.body.resourceSpans.flatMap((x: any) => x.scopeSpans.flatMap((s: any) => s.spans)));
const logs = () => received.filter((r) => r.path.endsWith('/v1/logs')).flatMap((r) => r.body.resourceLogs.flatMap((x: any) => x.scopeLogs.flatMap((s: any) => s.logRecords)));
const attr = (s: { attributes: OtlpSpan['attributes'] }, k: string) => {
  const v = s.attributes.find((a) => a.key === k)?.value;
  return v ? Object.values(v)[0] : undefined;
};

const settings = (over: Record<string, string> = {}) => ({
  enabled: 'true', endpoint: base, headers: 'x-api-key=collector-secret-139', service_name: 'pgkiln-test', sample: '1', user: 'hashed',
  values: 'false', traces: 'true', logs: 'true', metrics: 'true', builder: 'false', browser: 'false', prometheus: 'false', ...over,
});

const signedIn = async () => {
  const b = new Browser(app);
  await b.get('/a/hr/login');
  assert.equal((await b.submit('/a/hr/login', { username: 'king', password: 'king' })).statusCode, 303);
  return b;
};

before(async () => {
  collector = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/fail') return res.writeHead(500).end('broken');
      if (req.url === '/echo') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ traceparent: req.headers.traceparent ?? null }));
      received.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  app = await buildApp({ logger: false });
  hrWs = (await owner.one(`select meta.app_workspace(id) as ws from meta.app where alias = 'hr'`)).ws;
});

beforeEach(async () => {
  await saveInstanceTelemetry(settings());
  await owner.query(`update meta.workspace set telemetry = 'instance', telemetry_endpoint = null, telemetry_headers_enc = null, telemetry_values = false`);
  await refreshTelemetry(true);
  await flush();
  received = [];
});

after(async () => {
  await owner.query(`delete from meta.setting where name like 'otel\\_%' or name like 'metrics\\_%'`);
  await owner.query(`update meta.workspace set telemetry = 'instance', telemetry_endpoint = null, telemetry_headers_enc = null, telemetry_values = false`);
  await stopTelemetry();
  await app.close();
  await closePools();
  collector.close();
});

describe('values kept out', () => {
  test('sanitizeSql replaces literals and numbers, keeps identifiers, parameters and function bodies', () => {
    assert.equal(sanitizeSql(`select * from hr.emp where ename = 'KING' and sal > 5000 and "col 1" = $1 -- note 'x'`),
      'select * from hr.emp where ename = ? and sal > ? and "col 1" = $1');
    assert.equal(sanitizeSql(`select E'it\\'s', 'a''b', $q$secret$q$, t1.c2 from t1`), 'select ?, ?, ?, t1.c2 from t1');
    assert.equal(sanitizeSql('create function f() returns int language sql as $$ select 1 $$'), 'create function f() returns int language sql as $$ select 1 $$');
  });
  test('redactText hides quoted values, key values, e-mail addresses and long numbers', () => {
    assert.equal(redactText(`duplicate key value violates unique constraint "emp_pk": Key (email)=(king@example.com) 'secret' 123456`),
      `duplicate key value violates unique constraint "emp_pk": Key (email)=(?) '?' ?`);
  });
  test('traceparent and header pairs', () => {
    assert.deepEqual(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', sampled: true });
    for (const bad of ['', '00-0000000000000000000000000000000-00f067aa0ba902b7-01', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01', 'x', 42])
      assert.equal(parseTraceparent(bad), null);
    assert.deepEqual(parsePairs('a=1, b=x%3Dy,bad, c = 3'), { a: '1', b: 'x=y', c: '3' });
  });
});

describe('traces', () => {
  test('HR page 2: one trace with the page span, its SQL spans, the page and a hashed user', async () => {
    const b = await signedIn();
    await flush();
    received = [];
    assert.equal((await b.get('/a/hr/2')).statusCode, 200);
    await flush();
    const all = spans();
    const root = all.find((s) => attr(s, 'pgkiln.page') === '2' && !s.parentSpanId);
    assert.ok(root, 'the page span');
    assert.equal(root.name, 'GET /a/:alias/:page');
    assert.equal(attr(root, 'pgkiln.app.alias'), 'hr');
    assert.equal(attr(root, 'http.response.status_code'), '200');
    assert.match(String(attr(root, 'enduser.id')), /^u:/);
    assert.ok(!JSON.stringify(root).toLowerCase().includes('"king"'), 'no user name');
    const sql = all.filter((s) => s.traceId === root.traceId && attr(s, 'db.system.name') === 'postgresql');
    assert.ok(sql.length >= 3, `SQL spans: ${sql.length}`);
    assert.ok(sql.every((s) => s.parentSpanId), 'children of the page');
    assert.ok(sql.some((s) => /hr\.emp/i.test(String(attr(s, 'db.query.text')))), 'the report\'s query');
    assert.ok(sql.every((s) => !/'[^?]/.test(String(attr(s, 'db.query.text')))), 'no string literals');
    assert.ok(sql.every((s) => attr(s, 'db.query.parameter.1') === undefined), 'no bind values');
    // headers to the collector, resource
    const r = received.find((x) => x.path === '/v1/traces')!;
    assert.equal(r.headers['x-api-key'], 'collector-secret-139');
    const res = r.body.resourceSpans[0].resource.attributes;
    assert.equal(res.find((a: any) => a.key === 'service.name').value.stringValue, 'pgkiln-test');
  });

  test('a failing REST call is an error span, and the traceparent goes with it', async () => {
    let traceId = '';
    await rootSpan('test rest', {}, async (span) => {
      traceId = span!.traceId;
      const echo = await webRequest(`${base}/echo`, {});
      assert.equal(parseTraceparent(JSON.parse(echo.body.toString()).traceparent)?.traceId, traceId);
      const res = await webRequest(`${base}/fail`, {});
      assert.equal(res.status, 500);
    });
    await flush();
    const failed = spans().find((s) => s.traceId === traceId && attr(s, 'http.response.status_code') === '500');
    assert.ok(failed, 'the call span');
    assert.equal(failed.status.code, 2);
    assert.equal(failed.name, 'HTTP GET');
    assert.equal(attr(failed, 'url.full'), undefined, 'the full URL is a value');
  });

  test('with values included: statements with their literals and bind values', async () => {
    await saveInstanceTelemetry(settings({ values: 'true' }));
    const b = await signedIn();
    await b.get('/a/hr/2?x=1');
    await flush();
    const all = spans();
    assert.ok(all.some((s) => attr(s, 'db.query.parameter.1') !== undefined), 'bind values');
    assert.ok(all.some((s) => attr(s, 'url.query') === 'x=1'), 'the query string');
  });

  test('sample ratio 0: nothing sent, except a trace with an error', async () => {
    await saveInstanceTelemetry(settings({ sample: '0' }));
    const b = await signedIn();
    await b.get('/a/hr/2');
    await rootSpan('failing job', {}, async () => {
      await webRequest(`${base}/fail`, {});
    }).catch(() => {});
    await flush();
    const all = spans();
    assert.equal(all.filter((s) => attr(s, 'pgkiln.page') === '2').length, 0);
    assert.ok(all.some((s) => s.name === 'failing job'), 'the failing trace');
  });

  test('a workspace switched off sends nothing; one with its own collector also sends there', async () => {
    await saveWorkspaceTelemetry(hrWs, { mode: 'off' });
    const b = await signedIn();
    await b.get('/a/hr/2');
    await flush();
    assert.equal(spans().filter((s) => attr(s, 'pgkiln.app.alias') === 'hr').length, 0);
    await saveWorkspaceTelemetry(hrWs, { mode: 'own', endpoint: `${base}/own`, headers: 'x-team=hr' });
    received = [];
    await b.get('/a/hr/2');
    await flush();
    const own = received.filter((r) => r.path === '/own/v1/traces');
    assert.ok(own.length, 'the own collector');
    assert.equal(own[0].headers['x-team'], 'hr');
    assert.equal(own[0].body.resourceSpans[0].resource.attributes.find((a: any) => a.key === 'pgkiln.workspace.id').value.intValue, String(hrWs));
    assert.ok(spans().some((s) => attr(s, 'pgkiln.app.alias') === 'hr'), 'the instance\'s too');
  });

  test('without a collector nothing is traced', async () => {
    await saveInstanceTelemetry(settings({ enabled: 'false' }));
    const b = await signedIn();
    await b.get('/a/hr/2');
    await flush();
    assert.equal(received.length, 0);
  });
});

describe('logs and metrics', () => {
  test('a failed sign-in is a WARN log with a hashed user and no password', async () => {
    const b = new Browser(app);
    await b.get('/a/hr/login');
    await b.submit('/a/hr/login', { username: 'otel_nobody', password: 'wrong-pw-139' });
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    const rec = logs().find((l: any) => l.body.stringValue.startsWith('login_failed'));
    assert.ok(rec, 'the log record');
    assert.equal(rec.severityText, 'WARN');
    assert.ok(!JSON.stringify(rec).includes('otel_nobody') && !JSON.stringify(rec).includes('wrong-pw-139'));
  });

  test('OTLP metrics and /metrics', async () => {
    await saveInstanceTelemetry(settings({ prometheus: 'true' }));
    const b = await signedIn();
    await b.get('/a/hr/2');
    await exportMetrics();
    const m = received.find((r) => r.path === '/v1/metrics');
    assert.ok(m, 'metrics sent');
    const names = m.body.resourceMetrics[0].scopeMetrics[0].metrics.map((x: any) => x.name);
    for (const n of ['pgkiln.http.server.duration', 'pgkiln.mail.queue', 'pgkiln.db.pool.connections']) assert.ok(names.includes(n), n);
    // /metrics: an administrator's session, or the token
    assert.equal((await app.inject({ url: '/metrics' })).statusCode, 401);
    const admin = new Browser(app);
    await admin.get('/builder/login');
    await admin.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = await admin.get('/metrics');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /pgkiln_http_server_duration_milliseconds_bucket\{app="hr",method="GET",status_class="2xx",le="5"\}/);
    await admin.get('/builder/telemetry');
    await admin.submit('/builder/telemetry/token', { action: 'new' });
    const token = /pgkm_[\w-]+/.exec((await admin.get('/builder/telemetry')).body)?.[0];
    assert.ok(token, 'shown once');
    assert.doesNotMatch((await admin.get('/builder/telemetry')).body, /pgkm_[\w-]+/);
    assert.equal((await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer pgkm_wrong' } })).statusCode, 401);
    await saveInstanceTelemetry(settings({ prometheus: 'false' }));
    assert.equal((await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${token}` } })).statusCode, 404);
  });
});

describe('browser spans', () => {
  test('a page carries a signed token; its load and Ajax spans join the page\'s trace', async () => {
    await saveInstanceTelemetry(settings({ browser: 'true' }));
    const b = await signedIn();
    const page = await b.get('/a/hr/2');
    const token = /<meta name="pgkiln-trace" content="([^"]+)">/.exec(page.body)?.[1];
    assert.ok(token, 'the meta');
    const [traceId, spanId] = token.split('.');
    const now = Date.now();
    const post = (body: unknown, alias = 'hr') => app.inject({ method: 'POST', url: `/a/${alias}/telemetry`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await post({ t: token, spans: [
      { k: 'load', start: now - 900, dur: 800, t: { ttfb: 120, load: 800 } },
      { k: 'ajax', path: '/a/hr/2/lov/P2_X/search?q=secret', method: 'POST', status: 200, start: now - 50, dur: 40 },
      { k: 'ajax', path: '/a/other/1', method: 'GET', status: 200, start: now - 50, dur: 40 },
      { k: 'nonsense', start: now, dur: 1 },
    ] });
    assert.equal(res.statusCode, 204);
    await flush();
    const mine = spans().filter((s) => s.traceId === traceId && attr(s, 'pgkiln.browser') === true);
    assert.deepEqual(mine.map((s) => s.name).sort(), ['browser POST', 'browser page load']);
    assert.ok(mine.every((s) => s.parentSpanId === spanId));
    assert.equal(attr(mine.find((s) => s.name === 'browser POST')!, 'url.query'), undefined, 'no query without values');
    // a changed token, another application, too late
    assert.equal((await post({ t: token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), spans: [] })).statusCode, 403);
    assert.equal((await post({ t: token, spans: [] }, 'other')).statusCode, 403);
    assert.equal((await post({ t: `${traceId}.${spanId}.1.${token.split('.')[3]}`, spans: [] })).statusCode, 403);
    // off: no meta, and the route is gone
    await saveInstanceTelemetry(settings({ browser: 'false' }));
    assert.doesNotMatch((await b.get('/a/hr/2')).body, /pgkiln-trace/);
    assert.equal((await post({ t: token, spans: [] })).statusCode, 404);
  });
});

describe('the builder', () => {
  test('Workspace utilities → OpenTelemetry: settings, header names only, test span', async () => {
    const admin = new Browser(app);
    await admin.get('/builder/login');
    await admin.submit('/builder/login', { username: 'admin', password: 'admin' });
    assert.match((await admin.get('/builder/utilities')).body, /href="\/builder\/telemetry"/);
    const page = await admin.get('/builder/telemetry');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /x-api-key/);
    assert.doesNotMatch(page.body, /collector-secret-139/);
    assert.equal((await admin.submit('/builder/telemetry', { ...settings(), endpoint: 'javascript:alert(1)' })).statusCode, 303);
    assert.match((await admin.get('/builder/telemetry')).body, /Collector URL: only http and https/);
    received = [];
    await admin.submit('/builder/telemetry/test', {});
    assert.ok(spans().some((s) => s.name === 'pgkiln test span'));
    assert.match((await admin.get('/builder/telemetry')).body, /took the test span/);
    // a workspace's page
    const ws = await admin.get(`/builder/workspaces/${hrWs}/telemetry`);
    assert.equal(ws.statusCode, 200);
    await admin.submit(`/builder/workspaces/${hrWs}/telemetry`, { mode: 'own', endpoint: '' });
    assert.match((await admin.get(`/builder/workspaces/${hrWs}/telemetry`)).body, /own collector/);
    assert.equal((await owner.one('select telemetry from meta.workspace where id = $1', [hrWs])).telemetry, 'instance');
  });
});
