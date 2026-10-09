# Agent rules

Rules for an agent (a Claude session or a developer) that builds one item of a sprint. The coordinator
gives each agent a sprint number, an item number or workstream name, and the mode (A or B). The current
sprint's table (reserved migration numbers, HR ids, status) is in `docs/development/HANDOFF.md`.

## Before you start

- pgkiln = open source Oracle APEX alternative on PostgreSQL (Node/TS Fastify, server-rendered HTML,
  builder at `/builder`). Read `docs/development/HANDOFF.md` (sections "Conventions", "Environment notes"
  and the current sprint), the relevant rows of `docs/apex-feature-parity.md`, `docs/guide/02-concepts.md`
  and `docs/guide/12-development.md` (code map).
- Do only your item. Use only its reserved migration number and HR example id/page (next free HR page:
  check `examples/hr/` and the navigation). Never edit released migrations (the released range is at the
  top of the handoff).
- Check `git log` on your branch: a previous session may have left `wip:` commits for your item. Continue
  from them instead of starting over.

## Mode A: one agent at a time, in the main checkout

- Work in `/home/nickquispel/projects/postgres_apex` on branch `sprint-<n>` (no worktree).
- Run tests against the throwaway container `pgapex-ci` on port 5446, not the dev DB (a dev server's
  scheduler may share it):
  `docker rm -f pgapex-ci; docker run -d --name pgapex-ci -e POSTGRES_USER=pgkiln -e POSTGRES_PASSWORD=pgkiln -e POSTGRES_DB=pgkiln -p 5446:5432 postgres:17`,
  then prefix commands with
  `DATABASE_URL=postgres://pgapex:pgapex@localhost:5446/pgapex RUNTIME_DATABASE_URL=postgres://pgapex_runtime:pgapex_runtime@localhost:5446/pgapex API_JWT_SECRET=ci-only-api-secret-not-for-production-0123456789 API_URL=http://127.0.0.1:1`
  (`npx tsx scripts/migrate.ts --example hr` installs; `npm test` does it too). This also matches CI,
  which has no `.env` and no PostgREST.
- You may redefine `meta.export_app` / `meta.import_app`: start from the latest definitions
  (`grep -l "function meta.export_app" db/migrations/*` and take the highest number).

## Mode B: several agents in parallel, each in its own git worktree

- Work ONLY in your worktree `/home/nickquispel/projects/pgapex-wt/<name>` on branch `sprint-<n>-<name>`.
  Never touch the main checkout or other worktrees.
- Your `.env` points at your own database container `pgapex-<name>` and your own app port (both in the
  sprint table). `npx tsx scripts/migrate.ts --example hr` re-applies; to start over:
  `docker rm -f pgapex-<name>` and `docker run -d --name pgapex-<name> -e POSTGRES_USER=pgkiln -e POSTGRES_PASSWORD=pgkiln -e POSTGRES_DB=pgkiln -p <port>:5432 postgres:17`.
  Don't use `npm run db:reset` / `npm run setup` (they use docker compose: the shared dev DB).
- `node_modules` is a symlink: no `npm install`, never `rm -r` it.
- Do NOT redefine `meta.export_app` / `meta.import_app`. New definition tables are either installation
  data (add them to `KEPT` in `src/cli/replace.ts` and `NOT_EXPORTED` in `test/export.test.ts` with a
  reason) or travel inside existing jsonb columns; say in your report if export support is needed later.
- To keep merges easy: put new code in new files; in shared files (`src/app.ts` route registration,
  `src/builder/ui.ts`, `src/cli/replace.ts`, `test/export.test.ts`, `test/e2e/responsive.test.ts`,
  `public/*.css`) make small, appended changes.

## Both modes

- Stop a dev server with `kill $(lsof -t -iTCP:<port> -sTCP:LISTEN)`, never `pkill -f` (it matches the
  calling shell).
- pgkiln is a framework: nothing in `src/` or `db/migrations/` may depend on the HR example; HR examples
  go in `examples/hr/`. No e-mail features. No new npm dependencies unless the sprint section allows them.
- New NOT NULL columns on existing tables need a before-insert trigger that fills the default for older
  exports (see migrations 054/056).
- CSP is strict: no inline scripts or `style` attributes (follow existing patterns). Pages work without
  JavaScript where feasible (progressive enhancement) and fit phones (390 px): no `sr-only` text inside
  scrolling tables, long unbroken words must wrap.
- Everything that takes input or touches authorization needs tests in `test/security.test.ts`: append
  ONE describe block at the end labelled "sprint <n> <item>". Add functional tests in a new test file.
  UI changes must pass `npm run test:e2e` (390/768/1024/1440); add new builder and HR pages to
  `test/e2e/responsive.test.ts`.
- Docs are part of done: update the relevant `docs/guide/*` chapters and the code map in chapter 12.
  Do NOT edit `CHANGELOG.md`, `docs/apex-feature-parity.md`, `SECURITY.md` or `docs/development/HANDOFF.md`:
  the coordinator writes them from your report.
- Before finishing: `npx tsc --noEmit`, `npm test` (all green; LDAP/PostgREST-dependent tests may skip),
  `npm run test:e2e`. Commit in logical commits with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and push your branch. Don't merge. Leave the
  checkout clean.
- Commit `wip:` checkpoints often and push them: a session can end without warning.
- If the item is much larger than expected, finish a coherent, tested part and report what is left rather
  than leaving half-done work.
- Final report (concise): what was built, migration/HR ids used, tables added (and whether they are
  exported; whether export_app/import_app were redefined), security notes, suggested parity-matrix row
  text, env vars added, test results (counts).

## Sprint 36: AI (mode A)

- Allowed dependencies: the official SDKs `@anthropic-ai/sdk` (Claude) and `openai` (OpenAI), already
  installed.
- Providers are **Claude** (Anthropic) and **OpenAI**, behind one provider interface (`src/ai/`).
- Claude: always the official SDK, never raw fetch. Load the `claude-api` skill (Skill tool) before
  writing Claude code. Default model `claude-opus-5-5`: thinking can't be disabled, so control depth with
  `output_config: {effort}` (default `medium`); no assistant prefill; forced `tool_choice` any/tool returns
  400, so use `auto` + `strict: true` tools or structured outputs
  (`output_config: {format: {type: "json_schema", schema}}`); check `stop_reason` (incl. `refusal`) before
  reading content; use server-side refusal fallbacks by default (beta `server-side-fallback-2026-07-01`,
  `fallbacks: "default"`, via `client.beta.messages.create`); handle typed SDK errors
  (`Anthropic.RateLimitError`, …), not string matching.
- OpenAI: the official `openai` SDK, model configurable (a sensible documented default only).
- Developers pick provider and model; never silently downgrade a model.
- Keys: stored encrypted (reuse `src/secrets.ts` like web credentials), write-only, never exported, logged
  or shown, not readable by the runtime role; optional env vars `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` as
  instance defaults. Base URLs configurable only by administrators.
- Tests point the SDKs at the local mock server (`test/ai-mock.ts`): **no real API calls in tests**.
- Prompts may contain user data: document that it goes to the chosen provider. Log usage (tokens, model,
  app, user, duration), never prompt or response text unless the app's debug level asks for it.
- Model output is untrusted: escape it; never run it as SQL or HTML except through an explicit,
  constrained design (e.g. a SELECT checked and run as the app role, read-only, with a timeout).
