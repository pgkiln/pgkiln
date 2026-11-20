#!/bin/sh
# (sprint 232) CI's docker and docker-upgrade jobs, in deploy/ after `docker compose up`: pgkiln runs as pgkiln_owner,
# which is no superuser and owns pgkiln's schema and tables; the server's environment has neither the superuser's URL
# nor its password; the lockout checks no longer warn that DATABASE_URL is a superuser.
set -eu
fail() { echo "$1"; exit 1; }
psql() { docker compose exec -T db psql -U pgkiln_owner -d pgkiln -v ON_ERROR_STOP=1 -Atc "$1"; }
[ "$(psql "select rolsuper from pg_roles where rolname = 'pgkiln_owner'")" = f ] || fail "pgkiln_owner is a superuser"
[ "$(psql "select rolcreaterole from pg_roles where rolname = 'pgkiln_owner'")" = t ] || fail "pgkiln_owner can't create roles"
[ "$(psql "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'meta'")" = pgkiln_owner ] || fail "schema meta isn't pgkiln_owner's"
n=$(psql "select count(*) from pg_class where relnamespace = 'meta'::regnamespace and relowner <> 'pgkiln_owner'::regrole")
[ "$n" = 0 ] || fail "$n of meta's tables aren't pgkiln_owner's"
[ "$(psql "select pg_get_userbyid(datdba) from pg_database where datname = 'pgkiln'")" = pgkiln_owner ] || fail "the database isn't pgkiln_owner's"
echo "pgkiln_owner: no superuser, owns the database and meta"
# the server is process 1 (scripts/docker-entrypoint.sh execs it)
env=$(docker compose exec -T pgkiln sh -c 'tr "\0" "\n" < /proc/1/environ')
echo "$env" | grep -q '^DATABASE_URL=postgres://pgkiln_owner:' || fail "the server doesn't run as pgkiln_owner"
if echo "$env" | grep -qE '^(SUPERUSER_DATABASE_URL|POSTGRES_PASSWORD)='; then fail "the server's environment has the superuser's settings"; fi
echo "the server's environment has no superuser settings"
out=$(docker compose exec -T pgkiln node bin/pgkiln.js admin check || true)
if echo "$out" | grep -q "DATABASE_URL is a superuser"; then echo "$out"; fail "the lockout check still warns"; fi
echo "$out" | grep -q "Owner connection" || { echo "$out"; fail "no owner line in pgkiln admin check"; }
echo "pgkiln admin check: the owner connection is no superuser"
