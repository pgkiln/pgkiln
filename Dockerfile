# pgapex server image. deploy/compose.yaml runs it with a database; see
# docs/guide/01-installation.md, "Docker".
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json LICENSE NOTICE ./
COPY bin ./bin
COPY db ./db
COPY examples ./examples
COPY public ./public
COPY scripts ./scripts
COPY src ./src

USER node
EXPOSE 3100
# start period: the start script waits up to 2 minutes for the database, then migrates
HEALTHCHECK --interval=15s --timeout=5s --start-period=5m --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3100) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "scripts/docker-start.ts"]
