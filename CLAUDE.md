# pgkiln

A low-code application builder for PostgreSQL, modeled on Oracle APEX. Applications are data: rows
in the `meta` schema, rendered by a Node/TypeScript (Fastify) server; the builder is at `/builder`.

## Working on an application (not on pgkiln itself)

Use the `pgkiln` MCP server (`.mcp.json`; `node bin/pgkiln.js mcp`, see docs/guide/20-ai-agents.md):

- Understand first: `list_apps` → `app_overview` → `get_page` / `read_app_files`; `describe_schema`
  for tables and RLS policies; `search_docs` before guessing a region type, property or `meta.*` function.
- Change by files: `export_app` (writes `apps/<alias>/`, YAML with the SQL inline) → edit the files →
  `diff_app` → `import_app` with `replace: true`. Never change `meta.*` rows with SQL; `run_query` is read-only.
- Tables, views, functions and policies are the application's own database objects: they change in
  migration scripts, not in the application files.
- `apps/` is git-ignored here: applications belong in their own repository.

## Developing pgkiln

- Read `docs/guide/12-development.md` (code map) and `ROADMAP.md`. Maintainers keep their sprint notes outside
  the repository (`../pgkiln-internal/HANDOFF.md`, if present).
- pgkiln is a framework: the HR application in `examples/hr/` is only an example. Nothing in `src/` or
  `db/migrations/` may depend on it; defaults and help texts use neutral names (`sales.orders`, `P3_ID`).
- Schema changes go in a new `db/migrations/NNN_*.sql`; never edit a released migration.
- Input or authorization changes need a test in `test/security.test.ts`; UI changes must pass `npm run test:e2e`.
- `npm test` needs the dev database (Docker container `pgkiln-db`, port 5434); the app runs on port 3100.
- Docs are part of done: update the `docs/guide/*` chapter, `CHANGELOG.md` and `docs/apex-feature-parity.md`.
