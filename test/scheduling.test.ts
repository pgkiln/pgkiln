// Sprint 101 (Database Actions DA-12): SQL Workshop › Scheduling for pg_cron. The SQL generation (src/pgcron.ts)
// and the pages (src/builder/scheduling.ts): without pg_cron the install note and pgkiln's own scheduled work; with
// it (the real extension when the test database has it, else the stand-in of test/pgcron-mock.ts) the job list
// with next runs, create / edit with a review of the SQL, disable, run now, unschedule, the run history and purge.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { activeSql, checkJob, dollar, jobSql, purgeSql, unscheduleSql, type JobSpec } from '../src/pgcron.ts';
import { Browser } from './helpers.ts';
import { addRun, dropMockPgCron, mockPgCron, realPgCron } from './pgcron-mock.ts';

let app: FastifyInstance;
const T = 'sched101_t';
const URL = '/builder/sql/scheduling';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop table if exists public.${T}; create table public.${T} (n int)`);
});
after(async () => {
  if (await realPgCron()) await owner.query(`select cron.unschedule(jobid) from cron.job where jobname like 'sched101%'`);
  await dropMockPgCron();
  await owner.query(`drop table if exists public.${T}`);
  await owner.query(`delete from meta.activity_log where event in ('cron_job', 'cron_run_now') and detail like '%sched101%'`);
  await app.close();
  await closePools();
});

const admin = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};
/** The hidden fields of the last post form on a page (to post them back, like a browser). */
const hidden = (body: string, action: string) => {
  const f = body.slice(body.lastIndexOf(`<form method="post" action="${action}"`));
  const out: Record<string, string> = {};
  for (const m of f.slice(0, f.indexOf('</form>')).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g))
    out[m[1]] = m[2].replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return out;
};
const jobId = async (name: string) => (await owner.one<{ id: string }>('select jobid::text as id from cron.job where jobname = $1', [name]))?.id ?? null;

describe('SQL generation', () => {
  const spec: JobSpec = { name: 'nightly vacuum', schedule: '0 2 * * *', command: 'vacuum analyze', database: 'pgkiln', username: 'pgkiln', active: true };
  test('create, change, enable, unschedule and purge', () => {
    assert.deepEqual(jobSql(null, spec), [`select cron.schedule_in_database(\n  job_name := 'nightly vacuum',\n  schedule := '0 2 * * *',\n  command := $cmd$vacuum analyze$cmd$,\n  database := 'pgkiln',\n  username := 'pgkiln',\n  active := true\n);`]);
    assert.deepEqual(jobSql({ ...spec, jobid: '7' }, spec), [], 'nothing changed');
    assert.deepEqual(jobSql({ ...spec, jobid: '7' }, { ...spec, schedule: '0 3 * * *', active: false }), [`select cron.alter_job(\n  job_id := 7,\n  schedule := '0 3 * * *',\n  active := false\n);`]);
    assert.deepEqual(jobSql({ ...spec, jobid: '7' }, { ...spec, name: "it's renamed" }), [`update cron.job set jobname = 'it''s renamed' where jobid = 7;`]);
    assert.deepEqual(activeSql('7', false), ['select cron.alter_job(job_id := 7, active := false);']);
    assert.deepEqual(unscheduleSql('7'), ['select cron.unschedule(job_id := 7);']);
    assert.deepEqual(purgeSql(30, null), [`delete from cron.job_run_details where end_time < now() - interval '30 days';`]);
    assert.deepEqual(purgeSql(null, '7'), ['delete from cron.job_run_details where jobid = 7;']);
    assert.deepEqual(purgeSql(null, null), ['delete from cron.job_run_details;']);
    assert.throws(() => unscheduleSql('7; drop table x'));
  });
  test('the command is dollar-quoted with a tag it does not contain', () => {
    assert.equal(dollar(`select 'a'`), `$cmd$select 'a'$cmd$`);
    assert.equal(dollar('select $cmd$x$cmd$'), '$cmd1$select $cmd$x$cmd$$cmd1$');
    assert.equal(dollar('select 1 -- $cmd'), '$cmd1$select 1 -- $cmd$cmd1$', 'a command ending in the tag without its last $');
  });
  test('checks', () => {
    const o = { databases: ['pgkiln'], users: ['pgkiln'] };
    assert.deepEqual(checkJob(spec, o), []);
    assert.match(checkJob({ ...spec, name: '' }, o).join(), /name/);
    assert.match(checkJob({ ...spec, schedule: '61 * * * *' }, o).join(), /Schedule: Minute/);
    assert.match(checkJob({ ...spec, command: '  ' }, o).join(), /SQL/);
    assert.match(checkJob({ ...spec, database: 'other' }, o).join(), /database/);
    assert.match(checkJob({ ...spec, username: 'postgres' }, o).join(), /role/);
  });
});

describe('without pg_cron', { skip: false }, () => {
  test('the page explains how to install it and lists pgkiln\'s own automations and process jobs', async (t) => {
    if (await realPgCron()) return t.skip('pg_cron is installed in this database');
    await owner.query('drop schema if exists cron cascade');
    const a = await admin();
    const res = await a.get(URL);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /shared_preload_libraries = 'pg_cron'/);
    assert.match(res.body, /create extension pg_cron;/);
    assert.match(res.body, /<h2>Automations<\/h2>/);
    assert.match(res.body, /<h2>Process jobs<\/h2>/);
    // the tool is on the Launchpad and in the search for administrators
    assert.match((await a.get('/builder/sql')).body, /href="\/builder\/sql\/scheduling"/);
    assert.equal((await a.get(`${URL}/new`)).statusCode, 409, 'pages that need pg_cron explain instead');
  });
});

describe('with pg_cron', () => {
  let real = false;
  before(async () => {
    real = await realPgCron();
    await mockPgCron();
  });

  test('the schedule preview in words with five runs', async () => {
    const a = await admin();
    const res = await a.get(`${URL}/preview?schedule=${encodeURIComponent('0 2 * * *')}`);
    assert.match(res.body, /At 02:00, every day/);
    assert.equal(res.body.match(/<li><time>/g)?.length, 5);
    assert.match((await a.get(`${URL}/preview?schedule=${encodeURIComponent('0 25 * * *')}`)).body, /Hour: &quot;25&quot; is not between 0 and 23/);
  });

  test('create "nightly vacuum" at 02:00: review, apply, in the list with its next run; a run is in the history', async () => {
    const a = await admin();
    const form = await a.get(`${URL}/new`);
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /data-cron-preview/);
    const body = { jobid: '', name: 'sched101 nightly vacuum', schedule: '0 2 * * *', command: `vacuum analyze public.${T}`, database: (await owner.one('select current_database() as d')).d, username: (await owner.one('select current_user as u')).u, active: '1' };
    const review = await a.submit(`${URL}/save`, { ...body, mode: 'review' });
    assert.equal(review.statusCode, 200);
    assert.match(review.body, /cron\.schedule_in_database\(/);
    assert.match(review.body, /\$cmd\$vacuum analyze public\.sched101_t\$cmd\$/);
    assert.equal(await jobId(body.name), null, 'nothing applied yet');
    const h = hidden(review.body, `${URL}/save`);
    const done = await a.submit(`${URL}/save`, { ...h, mode: 'apply' });
    assert.equal(done.statusCode, 303, done.body.slice(0, 2000));
    const id = await jobId(body.name);
    assert.ok(id);
    assert.equal(done.headers.location, `${URL}/job/${id}`);
    const list = await a.get(URL);
    assert.match(list.body, /sched101 nightly vacuum/);
    assert.match(list.body, /At 02:00, every day/);
    assert.match(list.body, /data-label="Next run">\d{4}-\d\d-\d\d 02:00</);
    // a run (real pg_cron: run it every second for a moment; the stand-in: recorded)
    if (real) {
      await owner.query(`select cron.alter_job(job_id := $1::bigint, schedule := '1 seconds')`, [id]);
      for (let i = 0; i < 40 && !(await owner.one('select 1 as ok from cron.job_run_details where jobid = $1::bigint and status = \'succeeded\'', [id])); i++) await new Promise((r) => setTimeout(r, 250));
      await owner.query(`select cron.alter_job(job_id := $1::bigint, schedule := '0 2 * * *')`, [id]);
    } else await addRun(id!, 'succeeded', 'VACUUM');
    const hist = await a.get(`${URL}/history?job=${id}`);
    assert.match(hist.body, /tag-ok">succeeded/);
    assert.match(hist.body, /VACUUM/);
    assert.match((await a.get(`${URL}/job/${id}`)).body, /Recent runs[\s\S]*succeeded/);
  });

  test('a name a user already has is refused; a bad schedule is explained', async () => {
    const a = await admin();
    await a.get(`${URL}/new`);
    const base = { jobid: '', name: 'sched101 nightly vacuum', schedule: '0 2 * * *', command: 'select 1', database: (await owner.one('select current_database() as d')).d, username: (await owner.one('select current_user as u')).u, active: '1', mode: 'review' };
    assert.match((await a.submit(`${URL}/save`, base)).body, /has a job named sched101 nightly vacuum already/);
    assert.match((await a.submit(`${URL}/save`, { ...base, name: 'sched101 other', schedule: '0 0 30 2 *' })).body, /never matches/);
  });

  test('the builder without JavaScript: preset and fields fill the schedule', async () => {
    const a = await admin();
    await a.get(`${URL}/new`);
    const base = { jobid: '', name: 'sched101 x', schedule: '', command: 'select 1', database: 'x', username: 'x' };
    assert.match((await a.submit(`${URL}/save`, { ...base, mode: 'preset', preset: '0 7 * * 1-5' })).body, /name="schedule" value="0 7 \* \* 1-5"[\s\S]*At 07:00, on weekdays/);
    assert.match((await a.submit(`${URL}/save`, { ...base, mode: 'build', cf_minute: '*/15', cf_hour: '', cf_day: '', cf_month: '', cf_weekday: '' })).body, /name="schedule" value="\*\/15 \* \* \* \*"[\s\S]*Every 15 minutes/);
  });

  test('edit, disable, run now, unschedule; history purge', async () => {
    const a = await admin();
    const id = (await jobId('sched101 nightly vacuum'))!;
    const edit = await a.get(`${URL}/job/${id}/edit`);
    assert.match(edit.body, /value="sched101 nightly vacuum"/);
    const job = (await owner.one('select * from cron.job where jobid = $1::bigint', [id]));
    const review = await a.submit(`${URL}/save`, { jobid: id, name: job.jobname, schedule: '30 3 * * 0', command: `insert into public.${T} values (1)`, database: job.database, username: job.username, active: '1', mode: 'review' });
    assert.match(review.body, /cron\.alter_job\(\n {2}job_id := \d+,\n {2}schedule := &#39;30 3 \* \* 0&#39;,\n {2}command := \$cmd\$insert/);
    // Apply runs only what was reviewed
    const h = hidden(review.body, `${URL}/save`);
    assert.match((await a.submit(`${URL}/save`, { ...h, schedule: '0 4 * * *', mode: 'apply' })).body, /changed since you reviewed/);
    assert.equal((await a.submit(`${URL}/save`, { ...h, mode: 'apply' })).statusCode, 303);
    assert.equal((await owner.one('select schedule from cron.job where jobid = $1::bigint', [id])).schedule, '30 3 * * 0');

    await a.get(`${URL}/job/${id}`);
    assert.equal((await a.submit(`${URL}/job/${id}/active`, { active: '' })).statusCode, 303);
    assert.equal((await owner.one('select active from cron.job where jobid = $1::bigint', [id])).active, false);
    assert.match((await a.get(URL)).body, /data-label="Next run"><span class="muted">inactive/);

    await a.get(`${URL}/job/${id}`);
    const run = await a.submit(`${URL}/job/${id}/run`, {});
    assert.equal(run.statusCode, 200, run.body.slice(0, 3000));
    assert.match(run.body, /Ran<\/strong>[\s\S]*INSERT 1/);
    assert.equal((await owner.one(`select count(*)::int as n from public.${T}`)).n, 1);
    assert.ok(await owner.one(`select 1 as ok from meta.activity_log where event = 'cron_run_now' and detail like $1`, [`job ${id} sched101%`]));

    await addRun(id, 'failed', 'ERROR: sched101 old failure', 40);
    const purge = await a.get(`${URL}/history/purge?job=${id}&days=30`);
    assert.match(purge.body, /1 run would be deleted/);
    assert.match(purge.body, /delete from cron\.job_run_details where jobid = \d+ and end_time &lt; now\(\) - interval &#39;30 days&#39;;/);
    assert.equal((await a.submit(`${URL}/history/purge`, { ...hidden(purge.body, `${URL}/history/purge`), mode: 'apply' })).statusCode, 303);
    assert.equal((await owner.one(`select count(*)::int as n from cron.job_run_details where return_message like '%sched101 old%'`)).n, 0);

    const un = await a.get(`${URL}/job/${id}/unschedule`);
    assert.match(un.body, /cron\.unschedule\(job_id := \d+\)/);
    assert.equal((await a.submit(`${URL}/job/${id}/unschedule`, { ...hidden(un.body, `${URL}/job/${id}/unschedule`), mode: 'apply' })).statusCode, 303);
    assert.equal(await jobId('sched101 nightly vacuum'), null);
    assert.equal((await a.get(`${URL}/job/${id}`)).statusCode, 404);
  });

  test('run now reports a failing command', async () => {
    const a = await admin();
    await owner.query(`select cron.schedule_in_database('sched101 broken', '0 1 * * *', 'select * from sched101_missing', current_database())`);
    const id = (await jobId('sched101 broken'))!;
    await a.get(`${URL}/job/${id}`);
    const run = await a.submit(`${URL}/job/${id}/run`, {});
    assert.equal(run.statusCode, 422);
    assert.match(run.body, /Failed<\/strong>[\s\S]*sched101_missing/);
    await owner.query('select cron.unschedule($1::bigint)', [id]);
  });
});
