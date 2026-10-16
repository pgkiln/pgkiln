// (sprint 101) A stand-in for pg_cron in test databases without it (CI's postgres:17): schema cron with pg_cron's
// two tables and the functions SQL Workshop › Scheduling calls, with pg_cron's signatures and behaviour (a job name
// is unique per user; scheduling an existing name changes that job). Nothing runs the jobs: tests add runs.
// With the real pg_cron installed (pg_extension), the mock isn't created and tests run against pg_cron itself.
import { owner } from '../src/db.ts';

export const realPgCron = async () => !!(await owner.one(`select 1 as ok from pg_extension where extname = 'pg_cron'`));

const MOCK = `
create schema cron;
create table cron.job (
  jobid bigserial primary key, schedule text not null, command text not null, nodename text not null default 'localhost',
  nodeport int not null default inet_server_port(), database text not null default current_database(),
  username text not null default current_user, active boolean not null default true, jobname text,
  constraint jobname_username_uniq unique (jobname, username));
create table cron.job_run_details (
  jobid bigint, runid bigserial primary key, job_pid int, database text, username text, command text, status text,
  return_message text, start_time timestamptz, end_time timestamptz);
create function cron.schedule_in_database(job_name text, schedule text, command text, database text, username text default null, active boolean default true)
returns bigint language plpgsql as $$
declare v bigint;
begin
  if schedule !~ '^(\\S+\\s+){4}\\S+$|^\\d+ seconds?$|^@' then raise exception 'invalid schedule: %', schedule; end if;
  insert into cron.job (jobname, schedule, command, database, username, active)
  values (job_name, schedule, command, database, coalesce(username, current_user), active)
  on conflict on constraint jobname_username_uniq do update set schedule = excluded.schedule, command = excluded.command,
    database = excluded.database, active = excluded.active
  returning jobid into v;
  return v;
end $$;
create function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null)
returns void language plpgsql as $$
begin
  update cron.job j set schedule = coalesce(alter_job.schedule, j.schedule), command = coalesce(alter_job.command, j.command),
    database = coalesce(alter_job.database, j.database), username = coalesce(alter_job.username, j.username),
    active = coalesce(alter_job.active, j.active)
   where j.jobid = job_id;
  if not found then raise exception 'Job % does not exist', job_id; end if;
end $$;
create function cron.unschedule(job_id bigint) returns boolean language plpgsql as $$
begin
  delete from cron.job where jobid = job_id;
  if not found then raise exception 'could not find valid entry for job %', job_id; end if;
  return true;
end $$;`;

/** Create the stand-in unless pg_cron is installed; returns whether it did. */
export async function mockPgCron() {
  if (await realPgCron()) return false;
  await owner.query('drop schema if exists cron cascade');
  await owner.query(MOCK);
  return true;
}

export async function dropMockPgCron() {
  if (!(await realPgCron())) await owner.query('drop schema if exists cron cascade');
}

/** A finished run of a job, as pg_cron records one. */
export async function addRun(jobid: string, status: 'succeeded' | 'failed', message: string, daysAgo = 0) {
  await owner.query(
    `insert into cron.job_run_details (jobid, job_pid, database, username, command, status, return_message, start_time, end_time)
     select jobid, 1, database, username, command, $2, $3, now() - make_interval(days => $4) - interval '2 seconds', now() - make_interval(days => $4)
       from cron.job where jobid = $1::bigint`, [jobid, status, message, daysAgo]);
}
