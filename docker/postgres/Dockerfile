# The development database (docker-compose.yml, `npm run setup`): PostgreSQL 17 with pg_cron (SQL Workshop ›
# Scheduling) and pgvector (vector search), as CI's test database has them. deploy/compose.yaml builds its own,
# smaller one (pg_cron only) inline.
FROM postgres:17
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-cron postgresql-17-pgvector \
 && rm -rf /var/lib/apt/lists/*
