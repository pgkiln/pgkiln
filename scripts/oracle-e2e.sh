#!/usr/bin/env bash
# (sprint 192, NX-F5) From Oracle to pgkiln, end to end (docs/guide/11-from-apex.md, "From Oracle to pgkiln"):
#
#   1. Oracle Database Free in Docker (gvenzl/oracle-free) with the OEHR tables of APEX's sample application
#      "Demonstration - HR" and a few rows (test/fixtures/apex/oehr-oracle.sql);
#   2. ora2pg in Docker (georgmoser/ora2pg, with DBD::Oracle and the Instant Client) moves the tables, the sequence and
#      the view into schema oehr of pgkiln's database, then the data (COPY, straight into PostgreSQL), then the
#      foreign keys;
#   3. pgkiln import-apex --check: nothing of the application's own may be missing (APEX's views may);
#   4. pgkiln import-apex --schema oehr imports test/fixtures/apex/f77536.sql;
#   5. scripts/apex-e2e-pages.ts opens every page as a user: the OEHR pages must show the rows from Oracle.
#
# Too heavy for every CI run (an Oracle image of 1.5 GB, a minute to start): run it by hand or with the workflow
# .github/workflows/oracle-e2e.yml (manual and weekly). Needs docker, psql and pgkiln's database (DATABASE_URL in
# .env, migrated). Usage:  scripts/oracle-e2e.sh [--keep]   (--keep: leave the Oracle container, the schema and the app)
# Environment: ORA_CONTAINER (pgkiln-oracle-e2e), ORA_PORT (1521), ORA_IMAGE, ORA2PG_IMAGE, ALIAS (oracle-e2e).
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP=${1:-}
ORA_CONTAINER=${ORA_CONTAINER:-pgkiln-oracle-e2e}
ORA_PORT=${ORA_PORT:-1521}
ORA_IMAGE=${ORA_IMAGE:-gvenzl/oracle-free:23-slim-faststart}
ORA2PG_IMAGE=${ORA2PG_IMAGE:-georgmoser/ora2pg:latest}
ALIAS=${ALIAS:-oracle-e2e}
SCHEMA=oehr

DATABASE_URL=${DATABASE_URL:-$(sed -n 's/^DATABASE_URL=//p' .env 2>/dev/null | head -1)}
[[ $DATABASE_URL =~ ^postgres(ql)?://([^:]+):([^@]+)@([^:/]+):?([0-9]*)/([^?]+) ]] || { echo "DATABASE_URL not set (postgres://user:password@host:port/db)"; exit 2; }
PG_USER=${BASH_REMATCH[2]} PG_PWD=${BASH_REMATCH[3]} PG_HOST=${BASH_REMATCH[4]} PG_PORT=${BASH_REMATCH[5]:-5432} PG_DB=${BASH_REMATCH[6]}
[[ $PG_HOST == localhost ]] && PG_HOST=127.0.0.1
WORK=$(mktemp -d)
chmod 777 "$WORK"   # ora2pg's container writes its files there
step() { printf '\n== %s\n' "$*"; }
cleanup() {
  if [[ $KEEP != --keep ]]; then
    docker rm -f "$ORA_CONTAINER" >/dev/null 2>&1 || true
    local role="app_${ALIAS//-/_}"
    psql "$DATABASE_URL" -qc "delete from meta.app where alias = '$ALIAS'; drop schema if exists $SCHEMA cascade" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -qc "do \$\$ begin if exists (select from pg_roles where rolname = '$role') then execute 'drop owned by $role cascade'; execute 'drop role $role'; end if; end \$\$" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step "Oracle Database Free ($ORA_IMAGE) on port $ORA_PORT"
if ! docker ps --format '{{.Names}}' | grep -qx "$ORA_CONTAINER"; then
  docker rm -f "$ORA_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$ORA_CONTAINER" -p "$ORA_PORT:1521" -e ORACLE_PASSWORD=oracle -e APP_USER=oehr -e APP_USER_PASSWORD=oehr "$ORA_IMAGE" >/dev/null
fi
for i in $(seq 1 120); do
  docker logs "$ORA_CONTAINER" 2>&1 | grep -q 'DATABASE IS READY TO USE' && break
  [[ $i == 120 ]] && { echo "Oracle did not start"; docker logs "$ORA_CONTAINER" | tail -20; exit 1; }
  sleep 5
done

step "OEHR tables and rows in Oracle (test/fixtures/apex/oehr-oracle.sql)"
docker cp test/fixtures/apex/oehr-oracle.sql "$ORA_CONTAINER:/tmp/oehr-oracle.sql"
# ora2pg's data export reads v$database (the SCN): the user needs to see it
docker exec -i "$ORA_CONTAINER" sqlplus -s / as sysdba <<'SQL' >/dev/null
alter session set container = FREEPDB1;
grant select on v_$database to oehr;
exit
SQL
docker exec -i "$ORA_CONTAINER" sqlplus -s oehr/oehr@//localhost/FREEPDB1 <<'SQL' | grep -E 'ORA-|rows? ' || true
begin for t in (select table_name from user_tables) loop execute immediate 'drop table ' || t.table_name || ' cascade constraints purge'; end loop; end;
/
begin for v in (select view_name from user_views) loop execute immediate 'drop view ' || v.view_name; end loop; for s in (select sequence_name from user_sequences) loop execute immediate 'drop sequence ' || s.sequence_name; end loop; end;
/
whenever sqlerror exit failure
@/tmp/oehr-oracle.sql
select count(*) || ' rows in oehr_orders' from oehr_orders;
exit
SQL

step "ora2pg: schema, data and foreign keys into $SCHEMA"
cat > "$WORK/ora2pg.conf" <<CONF
ORACLE_HOME	/usr/lib/oracle/19.26/client64
ORACLE_DSN	dbi:Oracle:host=127.0.0.1;service_name=FREEPDB1;port=$ORA_PORT
ORACLE_USER	oehr
ORACLE_PWD	oehr
USER_GRANTS	1
SCHEMA	OEHR
EXPORT_SCHEMA	1
PG_SCHEMA	$SCHEMA
CREATE_SCHEMA	1
FORCE_OWNER	$PG_USER
PRESERVE_CASE	0
PACKAGE_AS_SCHEMA	1
FILE_PER_FKEYS	1
PG_VERSION	17
PG_DSN	dbi:Pg:dbname=$PG_DB;host=$PG_HOST;port=$PG_PORT
PG_USER	$PG_USER
PG_PWD	$PG_PWD
OUTPUT_DIR	/data
CONF
ora2pg() { docker run --rm --network host -v "$WORK:/data" --entrypoint ora2pg "$ORA2PG_IMAGE" -c /data/ora2pg.conf "$@" 2>&1 | tr '\r' '\n' | grep -E 'FATAL|ERROR|end of' | tail -1; }
psql "$DATABASE_URL" -qc "drop schema if exists $SCHEMA cascade"
for t in TABLE SEQUENCE VIEW; do
  ora2pg -t "$t" -o "${t,,}.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$WORK/${t,,}.sql"
done
ora2pg -t COPY   # with PG_DSN: straight into PostgreSQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$WORK/FKEYS_table.sql"
psql "$DATABASE_URL" -Atc "select 'oehr.oehr_orders: ' || count(*) || ' rows' from $SCHEMA.oehr_orders"

step "pgkiln import-apex --check --schema $SCHEMA"
node bin/pgkiln.js import-apex test/fixtures/apex/f77536.sql --check --schema "$SCHEMA" > "$WORK/check.txt" || true
sed -n '/^Database objects/,$p' "$WORK/check.txt"
if grep -qE '^  (table|column|sequence|routine) ' "$WORK/check.txt"; then echo "FAIL: the check finds OEHR objects missing"; exit 1; fi

step "pgkiln import-apex --schema $SCHEMA --alias $ALIAS"
psql "$DATABASE_URL" -qc "delete from meta.app where alias = '$ALIAS'"
node bin/pgkiln.js import-apex test/fixtures/apex/f77536.sql --schema "$SCHEMA" --alias "$ALIAS" --no-issues | tail -2

step "every page as a user"
npx tsx scripts/apex-e2e-pages.ts "$ALIAS" --expect 2:direct,3:Welles,5:direct,6:direct,8:King,10:Europe,12:Netherlands,14:Southlake,16:"HD 8GB",18:President,20:Executive
echo
echo "Oracle → ora2pg → pgkiln: ok"
