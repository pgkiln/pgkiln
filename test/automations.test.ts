// Automations: cron schedules, runs as the application's role, the
// scheduler and the builder.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { nextRun, parseCron, runAutomation, scheduleProblem, tick } from '../src/automations.ts';
import { applyBinds } from '../src/binds.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await owner.query(`delete from meta.automation where app_id = $1 and name like 'test%'`, [appId]);
  await owner.query(`drop table if exists public.pgapex_automation_test`);
  await app.close();
  await closePools();
});

async function automation(name: string, code: string, extra: Record<string, unknown> = {}) {
  const cols = { name, code, enabled: false, schedule: '* * * * *', ...extra };
  const keys = Object.keys(cols);
  return (
    await owner.one(
      `insert into meta.automation (app_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
      [appId, ...Object.values(cols)],
    )
  ).id as number;
}
const lastLog = async (id: number) => owner.one('select * from meta.automation_log where automation_id = $1 order by id desc limit 1', [id]);

describe('schedules', () => {
  const at = new Date('2026-09-30T10:07:30Z'); // Wednesday
  const next = (expr: string, tz = 'UTC') => nextRun(parseCron(expr), tz, at).toISOString();

  test('cron fields, steps, ranges, names and macros', () => {
    assert.equal(next('*/15 * * * *'), '2026-09-30T10:15:00.000Z');
    assert.equal(next('0 7 * * 1-5'), '2026-10-01T07:00:00.000Z');
    assert.equal(next('0 7 * * mon-fri'), '2026-10-01T07:00:00.000Z');
    assert.equal(next('30 6 1 jan,jul *'), '2027-01-01T06:30:00.000Z');
    assert.equal(next('@weekly'), '2026-10-04T00:00:00.000Z', 'Sunday');
    assert.equal(next('0 0 * * 7'), '2026-10-04T00:00:00.000Z', '7 is Sunday too');
    assert.equal(next('0 9 13 * 5'), '2026-10-02T09:00:00.000Z', 'day of month OR day of week');
    assert.equal(next('0 0 29 2 *'), '2028-02-29T00:00:00.000Z');
  });

  test('time zones, including half and quarter hours and daylight saving', () => {
    assert.equal(next('0 7 * * *', 'Europe/Amsterdam'), '2026-10-01T05:00:00.000Z', 'CEST');
    assert.equal(nextRun(parseCron('0 7 * * *'), 'Europe/Amsterdam', new Date('2026-11-02T12:00:00Z')).toISOString(), '2026-11-03T06:00:00.000Z', 'CET');
    assert.equal(next('30 0 * * *', 'Asia/Kolkata'), '2026-09-30T19:00:00.000Z');
    assert.equal(next('45 2 * * *', 'Asia/Kathmandu'), '2026-09-30T21:00:00.000Z');
  });

  test('bad schedules and time zones are explained', () => {
    assert.match(scheduleProblem('* * *', 'UTC')!, /five fields/);
    assert.match(scheduleProblem('60 * * * *', 'UTC')!, /minute: "60"/);
    assert.match(scheduleProblem('0 0 30 2 *', 'UTC')!, /never matches/);
    assert.match(scheduleProblem('0 * * * *', 'Mars/Olympus')!, /Unknown time zone/);
    assert.equal(scheduleProblem('0 8 * * 1-5', 'Europe/Amsterdam'), null);
  });
});

describe('running', () => {
  test('runs as the application: its role, user and the automation\'s roles', async () => {
    const id = await automation(
      'test identity',
      `do $$ begin
         if meta.app_user() <> 'automation:test identity' then raise exception 'user %', meta.app_user(); end if;
         if current_user <> 'hr_app' then raise exception 'role %', current_user; end if;
         if not meta.has_role('admin') or meta.has_role('manager') then raise exception 'roles'; end if;
       end $$;
       -- binds work in plain statements (not inside $$ blocks)
       select 1 / (meta.app_id() = :APP_ID::int and :AUTOMATION_NAME = 'test identity' and :APP_USER = meta.app_user())::int;`,
      { roles: ['admin'] },
    );
    const r = await runAutomation(id);
    assert.deepEqual([r.status, r.rows, r.failed], ['ok', 0, 0], r.message ?? '');
    const log = await lastLog(id);
    assert.equal(log.status, 'ok');
    assert.equal(log.trigger, 'manual');
    assert.ok(log.finished_at);
    assert.equal((await owner.one('select last_status from meta.automation where id = $1', [id])).last_status, 'ok');
  });

  test('grants apply, and an error rolls the whole run back', async () => {
    const denied = await automation('test denied', 'select password_hash from meta.account');
    const r = await runAutomation(denied);
    assert.equal(r.status, 'error');
    assert.match(r.message!, /permission denied/);
    assert.equal((await lastLog(denied)).status, 'error');

    const req = (await owner.one(`insert into hr.leave_request (empno, start_date, end_date, days, created_at) values (7499, current_date + 30, current_date + 31, 2, now() - interval '5 days') returning id`)).id;
    try {
      const rollback = await automation('test rollback', `select hr.remind_pending_leave(${req}); do $$ begin raise exception 'stop'; end $$;`, { roles: ['admin'] });
      assert.equal((await runAutomation(rollback)).status, 'error');
      assert.equal((await owner.one(`select count(*)::int as n from hr.notification where message like 'Reminder: ALLEN%'`)).n, 0, 'nothing kept');
    } finally {
      await owner.query('delete from hr.leave_request where id = $1', [req]);
    }
  });

  test('the HR sample reminds managers once per pending request', async () => {
    const id = (await owner.one(`select id from meta.automation where app_id = $1 and name = 'Remind managers'`, [appId])).id;
    const req = (await owner.one(`insert into hr.leave_request (empno, start_date, end_date, days, created_at) values (7499, current_date + 40, current_date + 41, 2, now() - interval '3 days') returning id`)).id;
    try {
      const first = await runAutomation(id);
      assert.equal(first.status, 'ok', first.message ?? '');
      assert.ok(first.rows! >= 1, 'for each pending request');
      const reminders = () => owner.one(`select count(*)::int as n from hr.notification where username = 'blake' and message like 'Reminder: ALLEN%'`);
      assert.equal((await reminders()).n, 1, "to Allen's manager");
      await runAutomation(id);
      assert.equal((await reminders()).n, 1, 'not twice a day');
    } finally {
      await owner.query(`delete from hr.notification where message like 'Reminder: ALLEN%'`);
      await owner.query('delete from hr.leave_request where id = $1', [req]);
      await owner.query('delete from meta.automation_log where automation_id = $1', [id]);
    }
  });
});

describe('scheduler', () => {
  test('schedules new automations, runs due ones once and moves them forward', async () => {
    const id = await automation('test tick', 'select 1', { enabled: true, schedule: '*/5 * * * *' });
    const now = new Date('2030-01-01T10:02:00Z');
    assert.deepEqual((await tick(now)).filter((x) => x === id), [], 'first pass only schedules it');
    assert.equal(new Date((await owner.one('select next_run_at from meta.automation where id = $1', [id])).next_run_at).toISOString(), '2030-01-01T10:05:00.000Z');
    const later = new Date('2030-01-01T10:05:30Z');
    // two servers at the same moment: one run
    const [a, b] = await Promise.all([tick(later), tick(later)]);
    assert.equal([...a, ...b].filter((x) => x === id).length, 1);
    assert.equal((await owner.one('select count(*)::int as n from meta.automation_log where automation_id = $1', [id])).n, 1);
    assert.equal((await lastLog(id)).trigger, 'schedule');
    assert.equal(new Date((await owner.one('select next_run_at from meta.automation where id = $1', [id])).next_run_at).toISOString(), '2030-01-01T10:10:00.000Z');
  });

  test('disabled automations and changed schedules', async () => {
    const id = await automation('test disabled', 'select 1', { enabled: false, next_run_at: new Date('2000-01-01') });
    assert.ok(!(await tick(new Date('2030-01-01T00:00:00Z'))).includes(id));
    assert.equal((await owner.one('select next_run_at from meta.automation where id = $1', [id])).next_run_at, null, 'insert resets the next run');
    await owner.query(`update meta.automation set enabled = true, schedule = '0 3 * * *' where id = $1`, [id]);
    await tick(new Date('2030-01-01T00:00:00Z'));
    await owner.query(`update meta.automation set schedule = '0 4 * * *' where id = $1`, [id]);
    assert.equal((await owner.one('select next_run_at from meta.automation where id = $1', [id])).next_run_at, null, 'a new schedule is recomputed');
  });

  test('a run in progress is not started again', async () => {
    const id = await automation('test busy', 'select pg_sleep(0.5)');
    const [a, b] = await Promise.all([runAutomation(id), new Promise((r) => setTimeout(r, 100)).then(() => runAutomation(id))]);
    assert.deepEqual([a.status, b.status].sort(), ['busy', 'ok']);
  });
});

describe('builder', () => {
  async function developer() {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    return b;
  }

  test('create validates the schedule; Run now shows the result', async () => {
    const b = await developer();
    await b.get(`/builder/apps/${appId}/shared?new=automation`);
    const form = { name: 'test builder', description: '', enabled: 'true', schedule: '0 25 * * *', time_zone: 'UTC', query: '', error_handling: 'stop', roles: 'admin, admin , manager', timeout_s: '60' };
    await b.submit(`/builder/apps/${appId}/shared/automation`, form);
    assert.equal(await owner.one(`select 1 from meta.automation where app_id = $1 and name = 'test builder'`, [appId]), undefined, 'bad schedule refused');
    assert.match((await b.get(`/builder/apps/${appId}/shared?new=automation`)).body, /hour: &quot;25&quot;|hour: "25"/);
    const ok = await b.submit(`/builder/apps/${appId}/shared/automation`, { ...form, schedule: '0 7 * * 1-5', time_zone: 'Europe/Amsterdam' });
    assert.equal(ok.statusCode, 303);
    const row = await owner.one(`select * from meta.automation where app_id = $1 and name = 'test builder'`, [appId]);
    assert.deepEqual(row.roles, ['admin', 'manager']);
    const page = (await b.get(`/builder/apps/${appId}/shared?c=automation-${row.id}`)).body;
    assert.match(page, /Next run: <b>20\d\d-\d\d-\d\d 0[56]:00:00 UTC<\/b>/, '07:00 Amsterdam');
    assert.match(page, /Run now/);
    assert.match(page, /No actions yet/);
    // add an action from the automation's page
    assert.match((await b.get(`/builder/apps/${appId}/shared?new=automation_action&automation=${encodeURIComponent('test builder')}`)).body, /<option value="test builder" selected>/);
    await b.submit(`/builder/apps/${appId}/shared/automation_action`, { automation_name: 'test builder', name: 'Action', seq: '10', code: 'select 1', condition: '' });
    assert.equal((await owner.one(`select count(*)::int as n from meta.automation_action where app_id = $1 and automation_name = 'test builder'`, [appId])).n, 1);
    await b.submit(`/builder/apps/${appId}/shared/automation/${row.id}/run`, {});
    assert.match((await b.get(`/builder/apps/${appId}/shared?c=automation-${row.id}`)).body, /Ran successfully[\s\S]*<span class="tag tag-ok">ok<\/span>/);

    // Run now needs a developer, the CSRF token and an automation of this app
    const anon = await new Browser(app).post(`/builder/apps/${appId}/shared/automation/${row.id}/run`, {});
    assert.equal(anon.statusCode, 302);
    b.lastCsrf = 'forged';
    assert.equal((await b.submit(`/builder/apps/${appId}/shared/automation/${row.id}/run`, {})).statusCode, 403);
    await b.get('/builder');
    assert.equal((await b.submit(`/builder/apps/${appId + 100000}/shared/automation/${row.id}/run`, {})).statusCode, 404);
  });

  test('applications cannot read or change automations', async () => {
    for (const sql of ['select * from meta.automation', 'select * from meta.automation_log', `update meta.automation set code = 'x'`])
      await assert.rejects(runtime.query(sql), /permission denied/, sql);
  });

  test('exported automations are imported switched off', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const exported = doc.automations.find((a: any) => a.name === 'Remind managers');
    assert.equal(exported.enabled, true);
    assert.ok(!('next_run_at' in exported) && !('last_status' in exported), 'no run state');
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_copy_automations') as id`, [JSON.stringify(doc)])).id;
    try {
      assert.equal((await owner.one(`select enabled from meta.automation where app_id = $1 and name = 'Remind managers'`, [id])).enabled, false);
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });
});

// ---------------------------------------------------------------- 044: actions, error handling, runs from SQL

const T = 'public.pgapex_automation_test';
async function scratch() {
  await owner.query(`create table if not exists ${T} (n int, tag text)`);
  await owner.query(`grant select, insert, delete on ${T} to hr_app`);
  await owner.query(`truncate ${T}`);
}
const tags = async () => (await owner.query(`select n, tag from ${T} order by n, tag`)).rows.map((r) => `${r.n}${r.tag}`);
async function action(automation: string, name: string, seq: number, code: string, condition: string | null = null) {
  await owner.query(`insert into meta.automation_action (app_id, automation_name, name, seq, code, condition) values ($1, $2, $3, $4, $5, $6)`, [appId, automation, name, seq, code, condition]);
}

describe('actions', () => {
  test('code written to an automation becomes its single action', async () => {
    const id = await automation('test legacy', 'select 1');
    const acts = async () => (await owner.query(`select name, seq, code from meta.automation_action where app_id = $1 and automation_name = 'test legacy'`, [appId])).rows;
    assert.deepEqual(await acts(), [{ name: 'Action', seq: 10, code: 'select 1' }]);
    assert.equal((await owner.one('select code from meta.automation where id = $1', [id])).code, null, 'the column stays empty');
    await owner.query(`update meta.automation set code = 'select 2' where id = $1`, [id]);
    assert.deepEqual(await acts(), [{ name: 'Action', seq: 10, code: 'select 2' }], 'replaced');
    await action('test legacy', 'Second', 20, 'select 3');
    await assert.rejects(owner.query(`update meta.automation set code = 'select 4' where id = $1`, [id]), /several actions/);
    // renaming the automation keeps its actions; deleting it deletes them
    await owner.query(`update meta.automation set name = 'test legacy 2' where id = $1`, [id]);
    assert.equal((await owner.one(`select count(*)::int as n from meta.automation_action where app_id = $1 and automation_name = 'test legacy 2'`, [appId])).n, 2);
    await owner.query('delete from meta.automation where id = $1', [id]);
    assert.equal((await owner.one(`select count(*)::int as n from meta.automation_action where app_id = $1 and automation_name like 'test legacy%'`, [appId])).n, 0);
  });

  test('actions run in order, per row, each with its condition', async () => {
    await scratch();
    const id = await automation('test actions', '', { query: 'select g as n, g % 2 = 0 as even from generate_series(1, 4) g;' });
    await action('test actions', 'second', 20, `insert into ${T} values (:N::int, 'b' || (select count(*) from ${T} where n = :N::int))`, ':EVEN::boolean');
    await action('test actions', 'first', 10, `insert into ${T} values (:N::int, 'a')`);
    await action('test actions', 'never', 30, `insert into ${T} values (:N::int, 'x')`, 'false -- a comment does not break it');
    const r = await runAutomation(id);
    assert.deepEqual([r.status, r.rows, r.failed], ['ok', 4, 0], r.message ?? '');
    // "b1": the second action saw the first one's row
    assert.deepEqual(await tags(), ['1a', '2a', '2b1', '3a', '4a', '4b1']);
  });

  test('an automation without a query runs its actions once; conditions see the binds', async () => {
    await scratch();
    const id = await automation('test once', '');
    await action('test once', 'one', 10, `insert into ${T} values (1, :AUTOMATION_NAME)`);
    await action('test once', 'two', 20, `insert into ${T} values (2, 'no')`, `:APP_USER <> 'automation:test once'`);
    assert.equal((await runAutomation(id)).status, 'ok');
    assert.deepEqual(await tags(), ['1test once']);
  });

  test('the bind scanner matches src/binds.ts', async () => {
    const binds = { ID: '7', NAME: "O'Brien", EMPTY: '', SLASH: 'a\\b' };
    for (const sql of [
      'select :ID, :id::int, :Name, :EMPTY, :MISSING, :SLASH',
      "select ':ID', E'\\' :ID', \"col:ID\", $$ :ID $$, $tag$ :ID $tag$, $1",
      'select 1 -- :ID\n, :ID /* :ID /* :ID */ :ID */ , a[1:2], x := :ID',
      "select :ID::text || :NAME, 'it''s :ID', $a$ $b$ :ID $a$ :ID",
      'select €:ID, :ID€, ::int, :_X, :1',
      "select 'unterminated :ID",
      '',
    ])
      assert.equal(
        (await owner.one('select meta.automation_apply_binds(meta.automation_bind_parts($1), $2) as s', [sql, binds])).s,
        applyBinds(sql, binds),
        sql,
      );
  });
});

describe('error handling per row', () => {
  const failing = async (name: string, handling: string) => {
    await scratch();
    const id = await automation(name, '', { query: 'select g as n from generate_series(1, 5) g', error_handling: handling, enabled: true, next_run_at: null });
    await action(name, 'insert', 10, `insert into ${T} values (:N::int, 'ok')`);
    await action(name, 'check', 20, 'select 1 / (:N::int - 3)');
    return id;
  };

  test('stop (the default): the first error rolls the whole run back', async () => {
    const id = await failing('test stop', 'stop');
    const r = await runAutomation(id);
    assert.equal(r.status, 'error');
    assert.match(r.message!, /^row 3, action "check": division by zero/);
    assert.deepEqual(await tags(), []);
    const log = await lastLog(id);
    assert.equal(log.status, 'error');
    assert.equal(log.rows, null);
  });

  test('skip: a failing row is rolled back and recorded, the others are kept', async () => {
    const id = await failing('test skip', 'skip');
    const r = await runAutomation(id);
    assert.deepEqual([r.status, r.rows, r.failed], ['warning', 5, 1]);
    assert.deepEqual(await tags(), ['1ok', '2ok', '4ok', '5ok'], "row 3's insert is undone");
    const log = await lastLog(id);
    assert.equal(log.status, 'warning');
    assert.equal(log.rows, 5);
    assert.equal(log.rows_failed, 1);
    assert.equal(log.errors.length, 1);
    assert.equal(log.errors[0].row, 3);
    assert.equal(log.errors[0].action, 'check');
    assert.match(log.errors[0].message, /division by zero/);
    assert.match(log.errors[0].values, /"n": 3/);
    assert.equal((await owner.one('select last_status from meta.automation where id = $1', [id])).last_status, 'warning');
    // every row failing is an error
    await owner.query(`update meta.automation_action set code = 'select 1 / 0' where app_id = $1 and automation_name = 'test skip' and name = 'check'`, [appId]);
    const all = await runAutomation(id);
    assert.deepEqual([all.status, all.rows, all.failed], ['error', 5, 5]);
    assert.deepEqual(await tags(), ['1ok', '2ok', '4ok', '5ok']);
  });

  test('disable: like stop, and the automation is switched off', async () => {
    const id = await failing('test disable', 'disable');
    const r = await runAutomation(id);
    assert.equal(r.status, 'error');
    assert.match(r.message!, /disabled/);
    assert.equal((await owner.one('select enabled from meta.automation where id = $1', [id])).enabled, false);
  });

  test('a timeout stops a run even with skip', async () => {
    await scratch();
    const id = await automation('test timeout', '', { query: 'select g as n from generate_series(1, 3) g', error_handling: 'skip', timeout_s: 1 });
    await action('test timeout', 'slow', 10, 'select pg_sleep(0.6)');
    const r = await runAutomation(id);
    assert.equal(r.status, 'error');
    assert.match(r.message!, /statement timeout/);
  });
});

describe('runs from SQL: meta.run_automation()', () => {
  /** In a transaction as the HR application's role, signed in as blake. */
  const asApp = <T>(fn: (c: import('pg').PoolClient) => Promise<T>, user = 'blake', app = appId) =>
    runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true), set_config('pgapex.session_id', '', true)`, [String(app), user]);
      await c.query('set local role hr_app');
      return fn(c);
    });

  test('runs synchronously in the caller\'s transaction, with the automation\'s roles, and restores the caller\'s context', async () => {
    await scratch();
    const id = await automation('test sql', '', { query: 'select 1 as n union all select 2', roles: ['admin'] });
    await action('test sql', 'who', 10, `insert into ${T} values (:N::int, meta.app_user() || case when meta.has_role('admin') then '+admin' else '' end)`);
    const out = await asApp(async (c) => {
      const r = (await c.query(`select meta.run_automation('test sql') as r`)).rows[0].r;
      const seen = (await c.query(`select count(*)::int as n from ${T}`)).rows[0].n;
      const after = (await c.query(`select meta.app_user() as u, meta.has_role('admin') as admin, current_setting('pgapex.automation_id', true) as a`)).rows[0];
      return { r, seen, after };
    });
    assert.equal(out.r.status, 'ok');
    assert.equal(out.r.rows, 2);
    assert.equal(out.seen, 2, 'visible in the same transaction');
    assert.deepEqual(out.after, { u: 'blake', admin: false, a: '' }, 'the caller\'s user and roles again');
    assert.deepEqual(await tags(), ['1automation:test sql+admin', '2automation:test sql+admin']);
    const log = await lastLog(id);
    assert.deepEqual([log.trigger, log.status, log.rows, log.run_by], ['sql', 'ok', 2, 'blake']);
    // case-insensitive name
    assert.equal((await asApp((c) => c.query(`select meta.run_automation('TEST SQL') as r`))).rows[0].r.status, 'ok');
  });

  test('a rollback of the caller undoes the run (and its log entry)', async () => {
    await scratch();
    const id = await automation('test sql rollback', `insert into ${T} values (1, 'x')`);
    const c = await runtime.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'blake', true)`, [String(appId)]);
      await c.query('set local role hr_app');
      await c.query(`select meta.run_automation('test sql rollback')`);
      // the scheduler can't run it meanwhile: the caller holds the run's lock until its transaction ends
      assert.equal((await runAutomation(id)).status, 'busy');
      await c.query('rollback');
    } finally {
      c.release();
    }
    assert.deepEqual(await tags(), []);
    assert.equal((await owner.one(`select count(*)::int as n from meta.automation_log where automation_id = $1 and trigger = 'sql'`, [id])).n, 0);
  });

  test('errors: raised by default; with p_raise => false the run is undone and the result says why', async () => {
    await scratch();
    const id = await automation('test sql error', `insert into ${T} values (1, 'x'); select 1 / 0;`);
    await assert.rejects(asApp((c) => c.query(`select meta.run_automation('test sql error')`)), /action "Action": division by zero/);
    const r = (await asApp((c) => c.query(`select meta.run_automation('test sql error', p_raise => false) as r`))).rows[0].r;
    assert.equal(r.status, 'error');
    assert.match(r.message, /division by zero/);
    assert.deepEqual(await tags(), [], 'the run is undone');
    assert.equal((await lastLog(id)).status, 'error', 'the log entry is kept when the caller commits');
  });

  test('only automations of the current application; recursion is refused', async () => {
    await assert.rejects(asApp((c) => c.query(`select meta.run_automation('no such automation')`)), /does not exist in this application/);
    await assert.rejects(runtime.query(`select meta.run_automation('Remind managers')`), /no current application/);
    const other = (await owner.one(`insert into meta.app (alias, name) values ('test-automation-other', 'Other') returning id`)).id;
    try {
      await owner.query(`insert into meta.automation (app_id, name, code) values ($1, 'test other', 'select 1')`, [other]);
      await assert.rejects(asApp((c) => c.query(`select meta.run_automation('test other')`)), /does not exist in this application/);
    } finally {
      await owner.query('delete from meta.app where id = $1', [other]);
    }
    await automation('test self', `select meta.run_automation('test self')`);
    await assert.rejects(asApp((c) => c.query(`select meta.run_automation('test self')`)), /running already \(it calls itself\)/);
    const id = await automation('test self scheduled', `select meta.run_automation('test self scheduled')`);
    assert.match((await runAutomation(id)).message!, /running already/);
  });
});

describe('export and import of actions', () => {
  test('actions travel with the application; an older file\'s code becomes an action', async () => {
    const id = await automation('test export', '', { query: 'select 1 as n', error_handling: 'skip' });
    await action('test export', 'b', 20, 'select 2', ':N::int > 0');
    await action('test export', 'a', 10, 'select 1');
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const mine = doc.automation_actions.filter((x: any) => x.automation_name === 'test export');
    assert.deepEqual(mine.map((x: any) => [x.name, x.seq, x.condition]), [['a', 10, null], ['b', 20, ':N::int > 0']]);
    assert.ok(!doc.automations.some((a: any) => 'code' in a), 'no code column');
    const copy = (await owner.one(`select meta.import_app($1::jsonb, 'test_automation_copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const rows = (await owner.query(`select name, seq, condition from meta.automation_action where app_id = $1 and automation_name = 'test export' order by seq`, [copy])).rows;
      assert.deepEqual(rows.map((r) => r.name), ['a', 'b']);
      assert.equal((await owner.one(`select error_handling from meta.automation where app_id = $1 and name = 'test export'`, [copy])).error_handling, 'skip');
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy]);
    }
    // a file of 0.23: automations with code, no actions, no error handling
    const old = { ...doc, automations: doc.automations.map((a: any) => { const { error_handling, ...rest } = a; return { ...rest, code: `select '${a.name}'` }; }) };
    delete old.automation_actions;
    const copy2 = (await owner.one(`select meta.import_app($1::jsonb, 'test_automation_copy2') as id`, [JSON.stringify(old)])).id;
    try {
      const rows = (await owner.query(`select automation_name, name, code from meta.automation_action where app_id = $1 and automation_name = 'test export'`, [copy2])).rows;
      assert.deepEqual(rows, [{ automation_name: 'test export', name: 'Action', code: "select 'test export'" }]);
      assert.equal((await owner.one(`select error_handling from meta.automation where app_id = $1 and name = 'test export'`, [copy2])).error_handling, 'stop');
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy2]);
    }
    await owner.query('delete from meta.automation where id = $1', [id]);
  });
});
