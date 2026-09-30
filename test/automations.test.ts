// Automations: cron schedules, runs as the application's role, the
// scheduler and the builder.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { nextRun, parseCron, runAutomation, scheduleProblem, tick } from '../src/automations.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await owner.query(`delete from meta.automation where app_id = $1 and name like 'test%'`, [appId]);
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
    assert.deepEqual(r, { status: 'ok', rows: 0 }, r.message ?? '');
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
    const form = { name: 'test builder', description: '', enabled: 'true', schedule: '0 25 * * *', time_zone: 'UTC', query: '', code: 'select 1', roles: 'admin, admin , manager', timeout_s: '60' };
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
    await b.submit(`/builder/apps/${appId}/shared/automation/${row.id}/run`, {});
    assert.match((await b.get(`/builder/apps/${appId}/shared?c=automation-${row.id}`)).body, /Ran successfully[\s\S]*<span class="tag">ok<\/span>/);

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
