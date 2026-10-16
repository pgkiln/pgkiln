import pg from 'pg';
import { createHash } from 'node:crypto';
import { owner, ownerUrl } from './db.ts';
import { parseSchedule, ScheduleError } from './cron-schedule.ts';

// (sprint 101, Database Actions DA-12) pg_cron for SQL Workshop › Scheduling (src/builder/scheduling.ts): whether it
// can be used here, its jobs and runs, the SQL that changes them (shown to the administrator before it runs) and
// Run now. Schedules are parsed and explained by src/cron-schedule.ts; pg_cron itself decides what it accepts.

export type CronState =
  | { ok: true; version: string; timeZone: string; user: string; database: string; seesAll: boolean }
  | { ok: false; reason: 'not_available' | 'not_loaded' | 'other_database' | 'not_created' | 'no_access' | 'old'; database: string; cronDatabase: string | null; message?: string };

const FUNCTIONS = ['cron.schedule_in_database(text,text,text,text,text,boolean)', 'cron.alter_job(bigint,text,text,text,text,boolean)', 'cron.unschedule(bigint)'];

/** Can pg_cron be used from pgkiln's owner connection, and if not, why. */
export async function cronState(): Promise<CronState> {
  const info = (await owner.one<{ version: string | null; available: boolean; preload: string; cron_db: string | null; database: string; user: string; tz: string | null; job: boolean; funcs: boolean; sees_all: boolean }>(
    `select (select extversion from pg_extension where extname = 'pg_cron') as version,
            exists (select 1 from pg_available_extensions where name = 'pg_cron') as available,
            current_setting('shared_preload_libraries') as preload,
            current_setting('cron.database_name', true) as cron_db,
            current_database() as database, current_user as "user",
            current_setting('cron.timezone', true) as tz,
            to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null as job,
            (select bool_and(to_regprocedure(f) is not null) from unnest($1::text[]) f) as funcs,
            (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as sees_all`, [FUNCTIONS]))!;
  const base = { database: info.database, cronDatabase: info.cron_db };
  // a cron schema with pg_cron's tables and functions counts as installed (tests stand in for pg_cron with one)
  if (!info.version && !info.job) {
    if (!info.available) return { ok: false, reason: 'not_available', ...base };
    if (!/(^|[\s,])"?pg_cron"?($|[\s,])/.test(info.preload)) return { ok: false, reason: 'not_loaded', ...base };
    if ((info.cron_db ?? 'postgres') !== info.database) return { ok: false, reason: 'other_database', ...base, cronDatabase: info.cron_db ?? 'postgres' };
    return { ok: false, reason: 'not_created', ...base };
  }
  if (!info.funcs) return { ok: false, reason: 'old', ...base, message: info.version ?? undefined };
  try {
    await owner.query('select 1 from cron.job limit 1');
    await owner.query('select 1 from cron.job_run_details limit 1');
  } catch (e) {
    return { ok: false, reason: 'no_access', ...base, message: (e as Error).message };
  }
  return { ok: true, version: info.version ?? '(no extension)', timeZone: info.tz || 'GMT', user: info.user, database: info.database, seesAll: info.sees_all };
}

export interface Job {
  jobid: string;
  jobname: string | null;
  schedule: string;
  command: string;
  database: string;
  username: string;
  active: boolean;
  last_status: string | null;
  last_start: string | null;
  last_secs: number | null;
  last_message: string | null;
  failures: number;
}

const JOBS_SQL = `
  select j.jobid::text as jobid, j.jobname, j.schedule, j.command, j.database, j.username, j.active,
         r.status as last_status, to_char(r.start_time at time zone $1, 'YYYY-MM-DD HH24:MI:SS') as last_start,
         round(extract(epoch from r.end_time - r.start_time)::numeric, 3)::float8 as last_secs, r.return_message as last_message,
         (select count(*)::int from (select status from cron.job_run_details f where f.jobid = j.jobid order by f.runid desc limit 10) x where x.status = 'failed') as failures
    from cron.job j
    left join lateral (select d.status, d.start_time, d.end_time, d.return_message from cron.job_run_details d
                        where d.jobid = j.jobid order by d.runid desc limit 1) r on true`;

export const listJobs = async (timeZone: string) => (await owner.query<Job>(`${JOBS_SQL} order by lower(coalesce(j.jobname, '')), j.jobid`, [timeZone])).rows;
export const oneJob = async (timeZone: string, id: string) =>
  /^\d{1,18}$/.test(id) ? ((await owner.one<Job>(`${JOBS_SQL} where j.jobid = $2::bigint`, [timeZone, id])) ?? null) : null;

export interface Run {
  runid: string;
  jobid: string | null;
  jobname: string | null;
  database: string | null;
  username: string | null;
  command: string | null;
  status: string | null;
  return_message: string | null;
  start: string | null;
  secs: number | null;
}

export const RUN_STATUSES = ['starting', 'running', 'sending', 'connecting', 'succeeded', 'failed'];

/** Runs, newest first: of one job, with a status, or whose message or command contains a text. */
export async function listRuns(timeZone: string, f: { job?: string; status?: string; q?: string; limit?: number }) {
  const where: string[] = [];
  const params: unknown[] = [timeZone];
  if (f.job && /^\d{1,18}$/.test(f.job)) where.push(`d.jobid = $${params.push(f.job)}::bigint`);
  if (f.status && RUN_STATUSES.includes(f.status)) where.push(`d.status = $${params.push(f.status)}`);
  if (f.q) where.push(`(strpos(lower(d.return_message), lower($${params.push(f.q)})) > 0 or strpos(lower(d.command), lower($${params.length})) > 0)`);
  return (await owner.query<Run>(
    `select d.runid::text as runid, d.jobid::text as jobid, j.jobname, d.database, d.username, d.command, d.status, d.return_message,
            to_char(d.start_time at time zone $1, 'YYYY-MM-DD HH24:MI:SS') as start,
            round(extract(epoch from d.end_time - d.start_time)::numeric, 3)::float8 as secs
       from cron.job_run_details d left join cron.job j on j.jobid = d.jobid
      ${where.length ? `where ${where.join(' and ')}` : ''} order by d.runid desc limit ${Math.min(Math.max(f.limit ?? 200, 1), 1000)}`, params)).rows;
}

/** Runs older than a number of days (or all of one job's), as the purge would delete them. */
export async function countPurge(days: number | null, job: string | null) {
  const p = purgeWhere(days, job);
  return (await owner.one<{ n: number }>(`select count(*)::int as n from cron.job_run_details ${p}`))!.n;
}

// ------------------------------------------------------------------ SQL

export interface JobSpec {
  name: string;
  schedule: string;
  command: string;
  database: string;
  username: string;
  active: boolean;
}

export const lit = (v: string) => pg.escapeLiteral(v);

/** The command as a dollar-quoted string (readable when it has quotes and lines), with a tag it doesn't contain. */
export function dollar(v: string) {
  let tag = '$cmd$';
  for (let i = 1; v.includes(tag) || v.endsWith(tag.slice(0, -1)); i++) tag = `$cmd${i}$`;
  return `${tag}${v}${tag}`;
}

/** What is wrong with a job (empty: nothing). */
export function checkJob(spec: JobSpec, o: { databases: string[]; users: string[] }) {
  const errors: string[] = [];
  if (!spec.name) errors.push('Give the job a name.');
  else if (spec.name.length > 100) errors.push('A name is at most 100 characters.');
  else if (/[\x00-\x1f\x7f]/.test(spec.name)) errors.push('A name has no control characters.');
  try {
    parseSchedule(spec.schedule);
  } catch (e) {
    if (!(e instanceof ScheduleError)) throw e;
    errors.push(`Schedule: ${e.message}`);
  }
  if (!spec.command.trim()) errors.push('Enter the SQL the job runs.');
  else if (spec.command.length > 100_000) errors.push('The command is at most 100,000 characters.');
  else if (spec.command.includes('\0')) errors.push('The command has a NUL character.');
  if (!o.databases.includes(spec.database)) errors.push('Choose a database that accepts connections.');
  if (!o.users.includes(spec.username)) errors.push('Choose a role that can sign in to run the job as.');
  return errors;
}

/** The statements that create (before null) or change a job. */
export function jobSql(before: (JobSpec & { jobid: string }) | null, spec: JobSpec): string[] {
  if (!before) {
    return [`select cron.schedule_in_database(\n  job_name := ${lit(spec.name)},\n  schedule := ${lit(spec.schedule)},\n  command := ${dollar(spec.command)},\n  database := ${lit(spec.database)},\n  username := ${lit(spec.username)},\n  active := ${spec.active}\n);`];
  }
  const set: string[] = [];
  if (spec.schedule !== before.schedule) set.push(`schedule := ${lit(spec.schedule)}`);
  if (spec.command !== before.command) set.push(`command := ${dollar(spec.command)}`);
  if (spec.database !== before.database) set.push(`database := ${lit(spec.database)}`);
  if (spec.username !== before.username) set.push(`username := ${lit(spec.username)}`);
  if (spec.active !== before.active) set.push(`active := ${spec.active}`);
  const out = set.length ? [`select cron.alter_job(\n  job_id := ${BigInt(before.jobid)},\n  ${set.join(',\n  ')}\n);`] : [];
  // pg_cron's alter_job has no name: the name is cron.job's own column (unique per user)
  if (spec.name !== before.name) out.push(`update cron.job set jobname = ${lit(spec.name)} where jobid = ${BigInt(before.jobid)};`);
  return out;
}

export const activeSql = (jobid: string, active: boolean) => [`select cron.alter_job(job_id := ${BigInt(jobid)}, active := ${active});`];
export const unscheduleSql = (jobid: string) => [`select cron.unschedule(job_id := ${BigInt(jobid)});`];

function purgeWhere(days: number | null, job: string | null) {
  const w: string[] = [];
  if (job !== null) w.push(`jobid = ${BigInt(job)}`);
  if (days !== null) w.push(`end_time < now() - interval '${Math.trunc(days)} days'`);
  return w.length ? `where ${w.join(' and ')}` : '';
}
export const purgeSql = (days: number | null, job: string | null) => [`delete from cron.job_run_details ${purgeWhere(days, job)}`.trim() + ';'];

/** A digest of reviewed statements: Apply runs only what the review showed. */
export const reviewDigest = (stmts: string[]) => createHash('sha256').update(stmts.join('\n')).digest('base64url');

/** Run reviewed statements in one transaction; the error message when they fail (nothing changed). */
export async function applySql(stmts: string[]): Promise<string> {
  try {
    await owner.tx(async (c) => {
      await c.query(`set local lock_timeout = '10s'`);
      for (const x of stmts) await c.query(x);
    });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

// ------------------------------------------------------------------ Run now

export interface RunNow { ok: boolean; ms: number; message: string; notices: string[] }

/**
 * Run a job's command once, now, as pg_cron would: in the job's database (a new connection with the owner's login
 * to it), as the job's user (SET ROLE when it isn't the owner), outside a transaction block so VACUUM works, each
 * statement in its own transaction unless the command says otherwise. pg_cron doesn't record the run (it has no
 * run-now): the caller logs it.
 */
export async function runNow(job: Pick<Job, 'command' | 'database' | 'username'>, timeoutMs = 600_000): Promise<RunNow> {
  const url = new URL(ownerUrl);
  url.pathname = `/${encodeURIComponent(job.database)}`;
  const client = new pg.Client({ connectionString: url.toString(), application_name: 'pgkiln-cron-run-now', statement_timeout: timeoutMs, connectionTimeoutMillis: 10_000 });
  const notices: string[] = [];
  client.on('notice', (n) => notices.length < 100 && notices.push(`${n.severity ?? 'NOTICE'}: ${n.message}`));
  const t0 = performance.now();
  try {
    await client.connect();
    const me = (await client.query<{ u: string }>('select current_user as u')).rows[0].u;
    if (job.username !== me) await client.query(`set role ${pg.escapeIdentifier(job.username)}`);
    // the simple query protocol: several statements, and no transaction block around them (as pg_cron runs them)
    const res = await client.query(job.command);
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    const tag = last ? `${last.command ?? ''}${last.rowCount !== null && last.rowCount !== undefined ? ` ${last.rowCount}` : ''}`.trim() : '';
    return { ok: true, ms: performance.now() - t0, message: tag || 'done', notices };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, message: (e as Error).message, notices };
  } finally {
    await client.end().catch(() => undefined);
  }
}
