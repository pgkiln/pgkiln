# 20. AI coding agents (MCP)

`pgapex mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. With it an AI
coding agent (Claude Code, Cursor, VS Code Copilot, Codex, …) can find an application, read and
understand its pages and shared components and the tables they run on, and change the application:
it exports the application as files, edits them with its own file tools, shows the difference,
and imports them again. Laravel developers know the idea from Laravel Boost.

This is separate from the AI features *inside* applications and the builder (AI assistant regions,
*Generate with AI*): those call a model from pgapex; here an agent on the developer's machine calls
pgapex.

## Setting it up

**Claude Code, in a pgapex checkout**: nothing to do. The repository's `.mcp.json` starts the server;
Claude Code asks once whether to trust it. Then ask, for example:

> Which applications are there? Explain page 3 of hr: what happens when I press Save?

> In hr, add a "Hire date" column to the employee report on page 2 and show me the diff before importing.

**Claude Code, in your own project** (where you keep your application files and migrations):

```sh
claude mcp add pgapex -- /path/to/pgapex/bin/pgapex.js mcp
# another database than the checkout's .env:
claude mcp add pgapex -e DATABASE_URL=postgres://owner@host/db -- /path/to/pgapex/bin/pgapex.js mcp
```

**Other agents** take the same command in their MCP configuration, e.g. for Cursor
(`.cursor/mcp.json`) or VS Code (`.vscode/mcp.json`, key `servers`):

```json
{ "mcpServers": { "pgapex": { "command": "node", "args": ["/path/to/pgapex/bin/pgapex.js", "mcp"] } } }
```

The server connects with `DATABASE_URL` (the owner role) from the environment or the checkout's
`.env`, like the [command line](18-cli.md). Relative paths in the tools are relative to the
directory the agent started the server in (the project).

## Tools

| Tool | What it does | Changes anything |
|---|---|---|
| `pgapex_info` | version, database, last migration, where the guide is | no |
| `list_apps` | the applications: id, alias, name, pages | no |
| `app_overview` | an application's settings, its pages (mode, authorization, number of regions, items, processes) and the paths of all its component files | no |
| `get_page` | every component of one page as YAML, SQL inline | no |
| `read_app_files` | component files by path or prefix (`shared/lovs/`, `navigation.yaml`, …) | no |
| `describe_schema` | schemas with tables, views and functions; or one table with columns, constraints, indexes, RLS policies and triggers | no |
| `run_query` | one SQL statement, read-only, rows as JSON | no |
| `search_docs` | searches this user guide, the parity matrix and SECURITY.md | no |
| `recent_errors` | the latest errors and refused requests from the activity log | no |
| `export_app` | writes an application to a directory (default `apps/<alias>`, format `text`) | files on disk |
| `diff_app` | what an import of a directory would change (A/D/M with unified diffs); also reports files it can't read | no |
| `import_app` | imports a directory, zip or JSON file; `replace: true` updates the application in place | the database |

The files are the [directory format](18-cli.md#the-directory-format) of the command line, in the
[text style](18-cli.md#text-files-apexlang): one YAML file per component, with SQL, PL/pgSQL and
templates inline, so a region and its query are one file an agent reads top to bottom. An import with
`replace` is [the same as the command line's](18-cli.md#updating-an-application-in-place): one transaction,
users, sessions and saved reports kept, supporting objects and plug-in install SQL never run.

### The workflow an agent follows

1. `list_apps`, `app_overview`, then `get_page` or `read_app_files` for the parts the task is about;
   `describe_schema` for the tables; `search_docs` before guessing a property or region type.
2. `export_app` to `apps/<alias>`, then edit the YAML files there.
3. `diff_app`, so you (and it) see exactly what will change.
4. `import_app` with `replace: true`. Open the page in the browser to check.

Tables, views and functions are ordinary PostgreSQL objects: an agent changes them in your
migration scripts, not in the application files (`run_query` can't change them anyway).

## Safety

- **Read-only queries.** `run_query` runs exactly one statement (the extended query protocol, so
  `commit; delete …` is refused) in a `READ ONLY` transaction that has already taken a snapshot (so
  `set transaction read write` is refused), with a 10-second timeout, and rolls it back. Values of
  columns whose names contain *password*, *secret*, *token*, *hash* or *api_key* are shown as
  `(hidden)`. That keeps credentials out of the agent's context by accident; it is not an access
  control: the server runs as the owner role, like the command line, and is meant for a
  developer's own machine. Don't point it at production; deploy with `pgapex import --replace`
  from git instead.
- **Writes** are only `export_app` (files; it refuses a non-empty directory that isn't an export,
  so it can't overwrite your project) and `import_app` (the database, in one transaction). Both are
  marked as such in the tool list (the others are `readOnlyHint`), which clients use to decide what
  to confirm with you; Claude Code asks before every MCP tool it hasn't been allowed. `import_app` without `replace`
  never touches an existing application.
- **Output is capped** at 200,000 characters per call; ask for one page or a prefix instead of a
  whole large application.
- Diagnostics go to standard error; standard output carries only protocol messages.

## Instructions for agents in your own project

Agents read `CLAUDE.md` (Claude Code) or `AGENTS.md` (most others). A few lines are enough:

```markdown
## pgapex applications
- The applications live in pgapex (the `pgapex` MCP server); their files are in `apps/<alias>/`.
- Read before changing: `app_overview`, `get_page`, `describe_schema`, `search_docs`.
- Change an application by editing `apps/<alias>/` (export_app first if it is missing or stale),
  then `diff_app`, then `import_app` with replace=true. Never edit the meta tables with SQL.
- Database objects (tables, views, functions, RLS) change in `db/` migrations, not in the app files.
```

## For pgapex developers

`src/cli/mcp.ts` holds the tools and the JSON-RPC loop (no SDK: newline-delimited JSON-RPC 2.0 on
stdio, protocol versions 2025-06-18, 2025-03-26 and 2024-11-05). The tools reuse `src/cli/apps.ts`
(export, read, import) and `src/appfiles.ts`, so they always match the command line. A new tool needs
a JSON schema, `readOnlyHint` (or `destructiveHint`), and a test in `test/mcp.test.ts`; anything
that takes SQL or paths also needs one in `test/security.test.ts`.
