# 18. The command line and application files

The `pgkiln` command line runs migrations, exports and imports applications, and compares an
application with files in git (APEX: SQLcl `apex export` and the APEXlang application files). An
application can be exported as **one JSON file** or as **a directory with one file per component**
that reads well in pull requests, and imported again, as a copy or over the existing application.

## Running it

From a pgkiln checkout (it runs TypeScript with tsx, like the server):

```sh
npm run pgkiln -- apps               # through npm
npx tsx src/cli/main.ts apps         # directly
./bin/pgkiln.js apps                 # the package's bin entry (also after npm link)
```

It connects with `DATABASE_URL` (the owner role) from the environment or `.env`, the same as
the server and `npm run db:migrate`; `--db <url>` overrides it. Every command has `--help`.

| Exit code | Meaning |
|---|---|
| 0 | done; for `diff`: no differences |
| 1 | `diff` found differences |
| 2 | usage error (unknown command or option, missing argument, alias already taken) |
| 3 | failure (application not found, database error, invalid files) |

Errors go to standard error. The CLI never prints passwords or hashes; the exports don't contain
any (see [what is not exported](03-builder.md#export-format)).

## Commands

| Command | What it does |
|---|---|
| `pgkiln migrate [--example <name>]` | Applies the migrations that were not applied yet, then optionally `examples/<name>/` (same as `npm run db:migrate` / `npm run example:hr`; `--root` and `--seed` as in `scripts/migrate.ts`) |
| `pgkiln apps [--json]` | Lists the applications: alias, number of pages, name |
| `pgkiln export <alias> [--format json\|dir\|text] [--out <path>]` | `json` (default): the `pgkiln/2` document with sorted keys, to `--out` or standard output. `dir`: a directory (default `./<alias>`), see below. `text`: the same directory in YAML with the code inline ([text files](#text-files-apexlang)) |
| `pgkiln import <path> [--alias <alias>] [--replace [--only <file>]…] [--check [--force] \| --dry-run]` | Imports a JSON export, an application directory or a `.zip` of one. `--alias` gives the copy another alias. `--replace` updates the application with that alias in place (after a [backup](03-builder.md#backups)); with `--only pages/12` (repeatable) only that page or component file ([below](#importing-one-page-or-component)). `--check` checks the application before it commits, `--dry-run` only checks ([below](#checking-before-an-import)) |
| `pgkiln diff <alias> <path> [--name-only \| --quiet]` | What differs between the application in the database and a directory (or JSON file, or zip) |
| `pgkiln ddl <schema> [--no-comments] [--no-grants] [--out <file>]` | The DDL of a schema's objects, in an order that runs (as SQL Workshop → DDL, [chapter 3](03-builder.md#sql-workshop)) |
| `pgkiln compare <source> <target> [--script]` | Compares two schemas: `+` only in the source, `-` only in the target, `~` different; exit code 1 when they differ. `--script` writes the script that makes the target like the source (drops commented out); nothing is run |
| `pgkiln mcp` | An MCP server on standard input/output for AI coding agents, see [chapter 20](20-ai-agents.md) |
| `pgkiln plugin build <dir> [-o <file>]` | Builds a plug-in file (`pgkiln-plugin/2`) from a source directory, see [plug-ins](04-pages-and-regions.md#plug-ins-with-their-own-code) |
| `pgkiln plugin install <file\|dir> --app <alias> [--replace]` | Adds a plug-in (file or source directory) to an application; its install SQL is not run |
| `pgkiln users list [--developers]` | Accounts with their applications and roles, or builder developers |
| `pgkiln users add <username> [--developer] [--app <alias> --roles a,b] [--name …] [--email …]` | Adds an account (optionally with access to an application) or a builder developer |
| `pgkiln users password <username> [--developer]` | Sets a password and ends that user's sessions |
| `pgkiln admin reset-2fa <developer> [--reason <text>]` | (0.60) Removes a developer's authenticator apps and recovery codes and ends their builder sessions: [locked out?](03-builder.md#locked-out) |
| `pgkiln admin set-2fa-policy off\|admins\|all [--grace <days>]` | (0.60) Sets the builder's [two-factor policy](03-builder.md#two-factor-sign-in); `off` always works, the others need two administrators with an app |

`users` reads the password from standard input (the first line, e.g. from a secret store:
`printf '%s\n' "$PW" | pgkiln users add ops --developer`) or asks for it twice on a terminal. It is
never an argument, so it doesn't end up in the shell history, and it must meet the
[password policy](08-security.md).

## The directory format

`pgkiln export hr --format dir` writes:

```
hr/
  pgkiln.json                       {"format": "pgkiln/2", "layout": 1}
  app.json                          the application's settings (app.pwa_icon.png next to it)
  navigation.json                   the navigation menu as a tree
  shared/
    authorizations/manager.json
    app-items/ai_ename.json
    app-processes/0010-link-user-to-employee.json
    app-processes/0010-link-user-to-employee.code.sql
    app-computations/0010-ai_region-after_authentication.json   (by sequence, item and point)
    component-groups/sales_lookups.json
    report-queries/orders_by_region.json   (the query in .query.sql)
    shortcuts/delete_confirm_msg.json   (a long value in .value.txt, .html or .sql by its type)
    lovs/jobs.json
    lovs/jobs.query.sql
    report-layouts/hr_directory.json   (a logo as hr_directory.logo.png)
    template-components/status_badge.json   (named by static id; the template in status_badge.template.html)
    automations/ document-templates/ task-definitions/ workflow-definitions/ rest-modules/
    web-credentials/ rest-sources/      (web credentials never contain their secret)
    lists/hr_shortcuts.json           (a query list's query in hr_departments.query.sql)
    list-entries.json                 the entries of every list, per list as a tree
    automation-actions/remind-managers/0010-remind-the-manager.json   (per automation; code in .code.sql, condition in .condition.sql)
    supporting-objects/check-the-sample-data.json   (the script in .script.sql; never run on import)
    plugins/log_event.json            (install SQL in log_event.install_sql.sql; never run on import)
    group-roles.json
  globalization/
    text-messages.json
    translations/nl.json
  static/
    files.json                      the static application files and their types
    hr.js  hr.css                   each file as itself
  pages/
    0003-employees-form/
      page.json
      regions/0010-employees.json
      items/0020-p3_ename.json
      buttons/0030-save.json
      dynamic-actions/0020-suggest-a-salary-for-the-job.json
      dynamic-actions/0020-suggest-a-salary-for-the-job.code.sql
      validations/0010-commission-only-for-sales.json
      validations/0010-commission-only-for-sales.expression.sql
      processes/0010-process-form-employees.json
  extra/                            sections of newer pgkiln versions this one does not know
```

- **One file per component**, named `<sequence>-<static id>.json` (pages: `<page number>-<name>`;
  shared components: their name). The JSON holds the component's row as in the `meta` table, with
  sorted keys, two-space indentation, LF line ends and a final newline, so diffs show only real
  changes and a re-export of an unchanged application rewrites nothing.
- **Code in its own file**: SQL, PL/pgSQL and templates that are longer than 60 characters or span
  lines move to `<base>.<column>.sql` (`.html` for static content and document templates) next to
  the JSON; the column is then left out of the JSON. Short values stay inline. Either way imports.
- **No database ids.** Components refer to each other by **static id**: an item, button or process
  says `"region": "employees"`, a dynamic action `"affected_region": "…"`, a facet or map region
  `"report": "employees"` in its settings. Navigation entries are nested instead of pointing at
  parent ids. A directory exported from two installations of the same application is identical.
- **Binary values** (a report layout's logo, the PWA icon) are written as image files, and
  static application files as themselves under `static/` (listed in `static/files.json`).

Edit the files with any editor and import them again; the directory is the source of truth for the
application, the database objects (tables, views, functions) stay in your own migration scripts.

### Text files (APEXlang)

APEX 26.1 writes applications in APEXlang, a human-readable text format. `pgkiln export hr
--format text` writes the same directory with every component as **YAML** instead of JSON, and the
SQL, PL/pgSQL and templates **inline** as literal blocks, so a region with its query, or a process
with its code, is one file you read top to bottom:

```yaml
config:
  link:
    column: empno
    items:
      P3_EMPNO: "#empno#"
    page: 3
seq: 10
source: |2-
  select e.empno, e.ename, e.job, d.dname as department
    from hr.emp e
    left join hr.dept d on d.deptno = e.deptno
static_id: null
title: Employees
type: report
```

The files are a strict subset of YAML 1.2 that any YAML tool reads: block mappings and lists,
plain or double-quoted strings (JSON escapes), numbers, `true`/`false`/`null`, and literal blocks
(`|2-`) for text over several lines; keys are sorted. pgkiln reads exactly that subset back, so
anchors, tags, flow collections (`[a, b]`, `{a: 1}`) and folded blocks are refused with the file
and line; `#` comment lines are allowed (they are not kept by the next export). Text that could be
read as something else (`yes`, `10`, `2026-01-01`, `a: b`) is written in double quotes.
`pgkiln.json` stays JSON and says `"style": "text"`.

`import`, `diff` and the builder's zip read JSON and YAML files alike, file by file, so a
directory may mix them (the same component as both `.json` and `.yaml` is refused). `diff`
exports the application in the directory's style, and compares YAML and JSON files by content.
Switching an existing directory from `dir` to `text` (or back) rewrites every file once.

### Static ids

APEX 26.1 gives components a static id so that application files diff cleanly and can be applied
to another installation. pgkiln derives them without a schema change, from what already identifies
a component:

| Component | Static id |
|---|---|
| page | its page number |
| region | its **Static ID** when it has one (0.31: an optional region attribute, unique on the page), else its title as a key (`Who's out this week` → `who-s-out-this-week`), its type when it has no title; `-2`, `-3` for duplicates on a page |
| item, button, dynamic action, validation, process | its name as a key (`P3_ENAME` → `p3_ename`), else its label, event and action, item or type |
| shared components | their name |

A key is lower case `a-z`, `0-9`, `_` and `-`. The static id is the part of the file name after the
sequence number; renaming a region without a stored Static ID renames its file in the next export
(give regions that others refer to a Static ID to keep their files, references and, with
`import --replace`, the users' saved reports stable). When you
edit the files by hand, keep a reference and the file name of the region it points at in step:
`import` and `diff` report a reference to a region that doesn't exist on the page.

### Updating an application in place

`pgkiln import hr/ --replace` makes the application with alias `hr` look like the directory:
its settings, pages and shared components are those of the files, and components that are not in
the files any more are removed. What belongs to this installation stays:

- the application's **id and alias** (links, API URLs and bookmarks keep working),
- **who may sign in** and with which roles (accounts are never exported; identity-provider group
  mappings do come from the file), OAuth clients, sessions and "keep me signed in" tokens,
- **saved reports** of users (and their grid column layouts), which move to the new version of their region (same page number and
  static id),
- **running tasks and workflows**, which keep their definition (by name),
- for **automations**: whether each one is switched on, its next and last run, and its log. New
  automations arrive switched off, as with every import.
- the **secrets of web credentials** with the same name (exports never contain them; see
  [chapter 19](19-rest-data-sources.md#web-credentials)).
- the **style variant each user chose** ([chapter 14](14-globalization.md#style-variants-theme-roller));
  a style that the file no longer has falls back to the default.
- its **availability and build status** ([chapter 3](03-builder.md#availability-and-build-status)): exports
  leave them out, so a deployment doesn't open an application you closed, or close one;
- its **backups**: the version the import replaces is the newest one ([chapter 3](03-builder.md#backups)).

It all happens in one transaction; any error leaves the application unchanged. Without an
application with that alias, `--replace` simply imports, so the same command deploys the first
time and every time after.

A typical flow with git:

```sh
pgkiln export hr --format dir --out apps/hr     # in development, after changes in the builder
git diff apps/hr                                 # review, commit, open a pull request
pgkiln diff hr apps/hr                           # on the target: what would change (exit code 1)
pgkiln import apps/hr --replace                  # deploy
```

### Importing one page or component

(sprint 116; APEX 26.2: APEXlang file-level import) With `--replace`, `--only` imports just the named files of a
directory export (or a .zip of one) and leaves the rest of the application as it is in the database:

```sh
pgkiln import apps/hr --replace --only pages/12                 # page 12 with its regions, items, buttons …
pgkiln import apps/hr --replace --only shared/lovs/jobs.yaml    # one shared component
pgkiln import apps/hr --replace --only pages/12 --only shared/lovs   # several: repeat --only
```

`pages/12` (or just `12`) is page 12's folder whatever its name, so a renamed page still matches; any other value is
a file or folder path inside the export. A page or file that the directory no longer has is removed from the
application. How it works: pgkiln exports the application in the directory's style, takes the named files from the
directory, and imports the result with `--replace` as usual: one transaction, a backup first, `--check` and
`--dry-run` work the same, and what belongs to the installation is kept. It says how many of the named files differ
(on standard error). `--only` refuses without `--replace`, for a JSON file, for a path outside the export and for a
selection that matches nothing in the directory or the application (exit code 2). A component that another file
refers to by name (a list of values used on a page, say) has to exist after the import, as with any import.

### Checking before an import

An import doesn't need the application's tables, columns and functions to exist (neither does APEX's):
a page whose SQL names a missing table imports fine and fails when it runs. `--check` asks the
[Advisor](03-builder.md#advisor) first, inside the import's transaction, before anything is committed:
every SQL fragment is planned as the application's database role (unknown tables, columns,
functions and types, missing grants), PL/pgSQL blocks are compiled, and references to pages,
items, lists of values, schemes and search configurations are checked.

```sh
pgkiln import apps/hr --replace --check      # errors: nothing changes, exit code 1
pgkiln import apps/hr --replace --dry-run    # only check (exit code 0 without errors)
pgkiln import apps/hr --replace --check --force   # report, import anyway
```

```text
ERROR  page 2, region Employees (Source): relation "hr.employee" does not exist
WARNING  page 3, item P3_SAL (Default value): …
Check: 1 error(s), 1 warning(s), 0 note(s).
Not imported: the check found 1 error(s). Fix them, or use --force.
```

Deploy the database changes (your migration scripts) before the application, so the check sees
the tables the new version needs. The MCP server's `import_app` checks by default; the builder's
Import page has the check ticked.

`export --format dir` into an existing directory removes the files of deleted components and
leaves dot files (`.git`, `.gitattributes`) alone; it refuses a non-empty directory without a
`pgkiln.json`, so a typo can't empty the wrong folder.

### diff

`pgkiln diff hr apps/hr` exports the application in memory and compares file by file:

```
M pages/0002-employees/regions/0010-employees.source.sql
--- database/pages/0002-employees/regions/0010-employees.source.sql
+++ directory/pages/0002-employees/regions/0010-employees.source.sql
@@ -1,3 +1,4 @@
 select empno, ename, job
   from hr.emp
+ where active
A shared/lovs/locations.json
D pages/0009-audit-trail/page.json
```

`A`: only in the directory (an import adds it), `D`: only in the database (an import with
`--replace` removes it), `M`: different. JSON files compare by content, so key order and spacing
don't count. `--name-only` lists the files, `--quiet` only sets the exit code (for CI). An
imported copy differs from its source in `app.json` (the alias) and in automations' `enabled`.

### In the builder

**Export** in the builder downloads the JSON file. `/builder/apps/<id>/export?format=dir`
(or `?format=text`) downloads the directory format as a `.zip` (one folder named after the alias, fixed timestamps,
so the same application gives the same zip). `pgkiln import hr.pgkiln.zip` and `pgkiln diff` read
the zip directly.

## For pgkiln developers

- `src/appfiles.ts` turns a `pgkiln/2` document into files and back (pure functions, used by the
  CLI and the builder); `meta.export_app()` and `meta.import_app()` stay the only exporter and
  importer. A new section or column needs nothing here: unknown sections go to `extra/`, unknown
  columns stay in the component's JSON, unknown arrays of a page in `page.json`.
- `src/cli/replace.ts` (`--replace`) lists which tables of an application are its definition
  (replaced) and which belong to the installation (kept). A new table that references `meta.app`
  or a component must be added there; `test/cli.test.ts` fails until it is, like the export test.
- `test/cli.test.ts` covers help and exit codes, the round trip directory → import → export,
  diff and replace.
