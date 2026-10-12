// Page behaviour (migration 085): Ajax callbacks, the download dynamic action, the error handling
// function and the session timeout warning. The browser side is in test/e2e/page-behaviour.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const made: { table: string; id: number }[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId])).id;
  const add = async (table: string, sql: string, params: unknown[]) => made.push({ table, id: (await owner.one(sql, params)).id });
  await add('item', `insert into meta.item (page_id, seq, name, type) values ($1, 990, 'P1_PB_IN', 'text') returning id`, [pageId]);
  await add('item', `insert into meta.item (page_id, seq, name, type) values ($1, 991, 'P1_PB_OUT', 'hidden') returning id`, [pageId]);
  await add('process', `insert into meta.process (page_id, seq, name, type, point, code) values ($1, 990, 'PB_GREET', 'sql', 'ajax',
    'select :X01 || '' '' || :APP_USER || '' '' || coalesce(:P1_PB_IN, ''-'') as greeting, upper(:X01) as p1_pb_out from generate_series(1, 3)') returning id`, [pageId]);
  await add('process', `insert into meta.process (page_id, seq, name, type, point, code) values ($1, 991, 'PB_FAIL', 'sql', 'ajax',
    'do $$ begin raise exception ''Not today''; end $$') returning id`, [pageId]);
  await add('process', `insert into meta.process (page_id, seq, name, type, point, code) values ($1, 992, 'PB_BROKEN', 'sql', 'ajax',
    'select * from hr.no_such_table') returning id`, [pageId]);
  await add('process', `insert into meta.process (page_id, seq, name, type, point, authz, code) values ($1, 993, 'PB_SECRET', 'sql', 'ajax', 'NO_SUCH_SCHEME', 'select 1 as one') returning id`, [pageId]);
  await add('process', `insert into meta.process (page_id, seq, name, type, point, code, config) values ($1, 994, 'PB_FILE', 'download', 'submit',
    'select convert_to(''hello '' || coalesce(:P1_PB_IN, ''?''), ''UTF8'') as content, ''hello.txt'' as filename, ''text/plain'' as mime_type', '{}') returning id`, [pageId]);
  await add('dynamic_action', `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, code, items_to_submit) values ($1, 990, 'PB download', 'click', 'X', 'download', 'PB_FILE', 'P1_PB_IN') returning id`, [pageId]);
  await add('app_process', `insert into meta.app_process (app_id, seq, name, point, code) values ($1, 990, 'PB_APP', 'ajax', 'select ''app '' || :APP_USER as who') returning id`, [appId]);
});

after(async () => {
  for (const m of made.reverse()) await owner.query(`delete from meta.${m.table} where id = $1`, [m.id]);
  await owner.query(`update meta.app set error_function = null, session_warning_seconds = 120 where id = $1`, [appId]);
  await owner.query('drop function if exists public.pb_errors(jsonb)');
  await app.close();
  await closePools();
});

const signedIn = async (user = 'king') => {
  const b = new Browser(app);
  await b.login(user);
  await b.get('/a/hr/1');
  return b;
};
const ajax = (b: Browser, name: string, form: Record<string, string> = {}, csrf = b.lastCsrf) =>
  app.inject({ method: 'POST', url: `/a/hr/1/ajax/${name}`, payload: new URLSearchParams({ __csrf: csrf, ...form }).toString(),
    headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });

describe('Ajax callbacks', () => {
  test('a page process with point ajax answers rows, data and the items it set; x01 is a bind', async () => {
    const b = await signedIn();
    const res = await ajax(b, 'PB_GREET', { x01: 'hello', P1_PB_IN: 'there', APP_USER: 'evil' });
    assert.equal(res.statusCode, 200, res.body);
    const j = JSON.parse(res.body);
    assert.equal(j.data.greeting, 'hello king there', 'APP_USER comes from the server, items from the post');
    assert.equal(j.rows.length, 3);
    assert.deepEqual(j.items, { P1_PB_OUT: 'HELLO' }, 'the items the process set (the posted one is in session state as sent)');
    assert.equal(res.headers['cache-control'], 'no-store');
    // the application's own ajax process, by name
    assert.equal(JSON.parse((await ajax(b, 'PB_APP')).body).data.who, 'app king');
  });

  test('unknown names, a missing token, authorization and errors', async () => {
    const b = await signedIn();
    assert.equal((await ajax(b, 'NOPE')).statusCode, 403);
    assert.equal((await ajax(b, 'PB_GREET', {}, 'forged')).statusCode, 403);
    assert.equal((await ajax(b, 'PB_SECRET')).statusCode, 403);
    let res = await ajax(b, 'PB_FAIL');
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'Not today');
    res = await ajax(b, 'PB_BROKEN');
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /reference/i, 'an internal error shows a reference, not SQL');
    // a page process of another point is not an Ajax callback
    const submit = (await owner.one(`select name from meta.process where page_id = $1 and point = 'submit' limit 1`, [pageId]))?.name;
    if (submit) assert.equal((await ajax(b, submit)).statusCode, 403);
  });
});

describe('the download dynamic action', () => {
  test('sends the file of the download process it names, with the items it submits', async () => {
    const b = await signedIn();
    const da = made.find((m) => m.table === 'dynamic_action')!.id;
    const res = await app.inject({ method: 'POST', url: `/a/hr/1/da/${da}/download`, payload: new URLSearchParams({ __csrf: b.lastCsrf, P1_PB_IN: 'world' }).toString(),
      headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, 'hello world');
    assert.match(String(res.headers['content-disposition']), /attachment; filename="hello\.txt"/);
    // another dynamic action can't be used to download
    const other = (await owner.one(`select id from meta.dynamic_action where page_id = $1 and action <> 'download' limit 1`, [pageId]))?.id;
    if (other) {
      const r = await app.inject({ method: 'POST', url: `/a/hr/1/da/${other}/download`, payload: new URLSearchParams({ __csrf: b.lastCsrf }).toString(),
        headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(r.statusCode, 403);
    }
  });

  test('the new events and actions reach the page', async () => {
    const id = (await owner.one(`insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, message) values ($1, 995, 'PB ask', 'custom', 'PB_EVENT', 'confirm', 'Sure?') returning id`, [pageId])).id;
    try {
      const page = (await (await signedIn()).get('/a/hr/1')).body;
      const das = JSON.parse(/<script type="application\/json" id="pgkiln-meta">([\s\S]*?)<\/script>/.exec(page)![1]).das;
      assert.deepEqual(das.find((d: any) => d.id === id), { id, event: 'custom', trigger: ['PB_EVENT'], cond: null, action: 'confirm', items: [], region: null, submit: [], message: 'Sure?', classes: [], fn: null });
    } finally {
      await owner.query('delete from meta.dynamic_action where id = $1', [id]);
    }
  });
});

describe('the error handling function', () => {
  test('rewrites the messages users see; a failing function leaves them as they were', async () => {
    await owner.query(`create or replace function public.pb_errors(e jsonb) returns jsonb language sql as $$
      select case when e->>'internal' = 'true' then jsonb_build_object('message', 'Something went wrong (ref ' || (e->>'reference') || ') in ' || (e->>'component'))
                  when e->>'message' = 'boom' then (1 / 0)::text::jsonb
                  else jsonb_build_object('message', 'Sorry: ' || (e->>'message') || ' [' || coalesce(e->>'code', '-') || ', page ' || (e->>'page') || ', ' || (e->>'user') || ']') end $$`);
    await owner.query('grant execute on function public.pb_errors(jsonb) to public');
    await owner.query(`update meta.app set error_function = 'public.pb_errors' where id = $1`, [appId]);
    const b = await signedIn();
    assert.equal(JSON.parse((await ajax(b, 'PB_FAIL')).body).error, 'Sorry: Not today [P0001, page 1, king]');
    assert.match(JSON.parse((await ajax(b, 'PB_BROKEN')).body).error, /^Something went wrong \(ref \d+\) in Ajax callback "PB_BROKEN"$/);
    // the function itself fails: the message stays
    await owner.query(`update meta.process set code = 'do $$ begin raise exception ''boom''; end $$' where page_id = $1 and name = 'PB_FAIL'`, [pageId]);
    try {
      assert.equal(JSON.parse((await ajax(b, 'PB_FAIL')).body).error, 'boom');
    } finally {
      await owner.query(`update meta.process set code = 'do $$ begin raise exception ''Not today''; end $$' where page_id = $1 and name = 'PB_FAIL'`, [pageId]);
    }
  });

  test('the builder accepts only an existing schema.function(jsonb) returning jsonb', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get(`/builder/apps/${appId}/settings`);
    await dev.submit(`/builder/apps/${appId}/settings/behaviour`, { error_function: 'public.no_such_fn', session_warning_seconds: '120' });
    assert.match((await dev.get(`/builder/apps/${appId}/settings`)).body, /There is no function public\.no_such_fn\(jsonb\) returning jsonb/);
    await dev.submit(`/builder/apps/${appId}/settings/behaviour`, { error_function: 'x; drop table y', session_warning_seconds: '120' });
    assert.match((await dev.get(`/builder/apps/${appId}/settings`)).body, /schema\.function/);
    await dev.submit(`/builder/apps/${appId}/settings/behaviour`, { error_function: 'public.pb_errors', session_warning_seconds: '300' });
    assert.deepEqual(await owner.one('select error_function, session_warning_seconds from meta.app where id = $1', [appId]), { error_function: 'public.pb_errors', session_warning_seconds: 300 });
  });
});

describe('the session timeout warning', () => {
  test('a signed-in page knows when its session ends; Stay signed in needs the session and its token', async () => {
    await owner.query('update meta.app set session_warning_seconds = 120 where id = $1', [appId]);
    const b = await signedIn();
    const page = (await b.get('/a/hr/1')).body;
    const meta = JSON.parse(/<script type="application\/json" id="pgkiln-meta">([\s\S]*?)<\/script>/.exec(page)![1]);
    assert.equal(meta.session.warn, 120);
    assert.ok(meta.session.idle >= 60);
    assert.ok(meta.session.maxEnd > Date.now());
    assert.equal(meta.session.extend, '/a/hr/session/extend');
    let res = await b.post('/a/hr/session/extend', { __csrf: 'forged' });
    assert.equal(res.statusCode, 401);
    res = await b.post('/a/hr/session/extend', { __csrf: b.lastCsrf });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    // off: no warning
    await owner.query('update meta.app set session_warning_seconds = 0 where id = $1', [appId]);
    const off = (await b.get('/a/hr/1')).body;
    assert.equal(JSON.parse(/<script type="application\/json" id="pgkiln-meta">([\s\S]*?)<\/script>/.exec(off)![1]).session, null);
    await owner.query('update meta.app set session_warning_seconds = 120 where id = $1', [appId]);
  });
});
