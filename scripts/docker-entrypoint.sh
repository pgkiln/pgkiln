#!/bin/sh
# The image's entry point (Dockerfile CMD): prepare the database (scripts/docker-start.ts --prepare: settings,
# owner, migrations, passwords), then start the server in its place, without the superuser's URL and password
# (sprint 232: SUPERUSER_DATABASE_URL, POSTGRES_PASSWORD), so neither the server nor a program it runs
# (pg_dump for Schema Export) can see them.
set -e
node --import tsx scripts/docker-start.ts --prepare
exec env -u SUPERUSER_DATABASE_URL -u POSTGRES_PASSWORD node --import tsx src/server.ts
