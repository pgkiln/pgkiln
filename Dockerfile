# pgkiln server image. deploy/compose.yaml runs it with a database; see
# docs/guide/01-installation.md, "Docker".
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    PGKILN_DUMP_DIR=/app/dumps

# (sprint 103) pg_dump and pg_restore for Schema Export / Import: PostgreSQL 17's client programs from the
# PostgreSQL apt repository (they dump and restore servers of version 17 and older)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# the arm64 half runs under QEMU and npm's downloads sometimes get a connection reset (v0.52.0's publish):
# npm retries each download, and the whole install runs up to three times
RUN for i in 1 2 3; do \
      npm ci --omit=dev --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000 \
        && break; \
      [ "$i" = 3 ] && exit 1; echo "npm ci failed, retry $i"; sleep 20; \
    done \
 && npm cache clean --force

COPY tsconfig.json LICENSE NOTICE ./
COPY bin ./bin
COPY db ./db
COPY examples ./examples
COPY public ./public
COPY scripts ./scripts
COPY src ./src

RUN mkdir -p /app/dumps && chown node:node /app/dumps
USER node
EXPOSE 3100
# start period: the start script waits up to 2 minutes for the database, then migrates
HEALTHCHECK --interval=15s --timeout=5s --start-period=5m --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3100) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "scripts/docker-start.ts"]
