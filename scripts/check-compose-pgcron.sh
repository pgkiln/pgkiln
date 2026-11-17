#!/bin/sh
# (sprint 213) CI's docker job, in deploy/ after `docker compose up`: the bundled PostgreSQL has pg_cron, pgkiln
# created the extension at start-up, and pg_cron really runs a job (a seconds schedule, pg_cron 1.5 or later).
set -eu
psql() { docker compose exec -T db psql -U pgkiln -d pgkiln -v ON_ERROR_STOP=1 -Atc "$1"; }
version=$(psql "select extversion from pg_extension where extname = 'pg_cron'")
[ -n "$version" ] || { echo "pg_cron is not created in the database pgkiln"; exit 1; }
echo "pg_cron $version"
psql "select cron.schedule('ci pg_cron check', '1 seconds', 'select 1')" > /dev/null
n=0
for i in $(seq 1 30); do
  n=$(psql "select count(*) from cron.job_run_details d join cron.job j using (jobid) where j.jobname = 'ci pg_cron check' and d.status = 'succeeded'")
  [ "$n" -gt 0 ] && break
  sleep 1
done
psql "select cron.unschedule('ci pg_cron check')" > /dev/null
[ "$n" -gt 0 ] || { echo "pg_cron did not run the job in 30 s:"; psql "select status, return_message from cron.job_run_details order by runid desc limit 5"; exit 1; }
echo "pg_cron ran the job $n time(s)"
