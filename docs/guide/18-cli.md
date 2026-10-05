# 18. The command line and application files

The `pgapex` command line runs migrations, exports and imports applications, and compares an
application with files in git (APEX: SQLcl `apex export` and the APEXlang application files). An
application can be exported as **one JSON file** or as **a directory with one file per component**
that reads well in pull requests, and imported again, as a copy or over the existing application.

## Running it

From a pgapex checkout (it runs TypeScript with tsx, like the server):

```sh
npm run pgapex -- apps               # through npm
npx tsx src/cli/main.ts apps         # directly
./bin/pgapex.js apps                 # the package's bin entry (also after npm link)
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
| `pgapex migrate [--example <name>]` | Applies the migrations that were not applied yet, then optionally `examples/<name>/` (same as `npm run db:migrate` / `npm run example:hr`; `--root` and `--seed` as in `scripts/migrate.ts`) |
| `pgapex apps [--json]` | Lists the applications: alias, number of pages, name |
| `pgapex export <alias> [--format json\|dir] [--out <path>]` | `json` (default): the `pgapex/2` document with sorted keys, to `--out` or standard output. `dir`: a directory (default `./<alias>`), see below |
| `pgapex import <path> [--alias <alias>] [--replace]` | Imports a JSON export, an application directory or a `.zip` of one. `--alias` gives the copy another alias. `--replace` updates the application with that alias in place |
| `pgapex diff <alias> <path> [--name-only \| --quiet]` | What differs between the application in the database and a directory (or JSON file, or zip) |
| `pgapex users list [--developers]` | Accounts with their applications and roles, or builder developers |
| `pgapex users add <username> [--developer] [--app <alias> --roles a,b] [--name …] [--email …]` | Adds an account (optionally with access to an application) or a builder developer |
| `pgapex users password <username> [--developer]` | Sets a password and ends that user's sessions |

`users` reads the password from standard input (the first line, e.g. from a secret store:
`printf '%s\n' "$PW" | pgapex users add ops --developer`) or asks for it twice on a terminal. It is
never an argument, so it doesn't end up in the shell history, and it must meet the
[password policy](08-security.md).

## The directory format

`pgapex export hr --format dir` writes:

```
hr/
  pgapex.json                       {"format": "pgapex/2", "layout": 1}
  app.json                          the application's settings (app.pwa_icon.png next to it)
  navigation.json                   the navigation menu as a tree
  shared/
    authorizations/manager.json
    app-items/ai_ename.json
    app-processes/0010-link-user-to-employee.json
    app-processes/0010-link-user-to-employee.code.sql
    lovs/jobs.json
    lovs/jobs.query.sql
    report-layouts/hr_directory.json   (a logo as hr_directory.logo.png)
    template-components/status_badge.json   (named by static id; the template in status_badge.template.html)
    automations/ document-templates/ task-definitions/ workflow-definitions/ rest-modules/
    web-credentials/ rest-sources/      (web credentials never contain their secret)
    group-roles.json
  globalization/
    text-messages.json
    translations/nl.json
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
  extra/                            sections of newer pgapex versions this one does not know
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
- **Binary values** (a report layout's logo, the PWA icon) are written as image files.

Edit the files with any editor and import them again; the directory is the source of truth for the
application, the database objects (tables, views, functions) stay in your own migration scripts.

### Static ids

APEX 26.1 gives components a static id so that application files diff cleanly and can be applied
to another installation. pgapex derives them without a schema change, from what already identifies
a component:

| Component | Static id |
|---|---|
| page | its page number |
| region | its title as a key (`Who's out this week` → `who-s-out-this-week`), its type when it has no title; `-2`, `-3` for duplicates on a page |
| item, button, dynamic action, validation, process | its name as a key (`P3_ENAME` → `p3_ename`), else its label, event and action, item or type |
| shared components | their name |

A key is lower case `a-z`, `0-9`, `_` and `-`. The static id is the part of the file name after the
sequence number; renaming a region in the builder renames its file in the next export. When you
edit the files by hand, keep a reference and the file name of the region it points at in step:
`import` and `diff` report a reference to a region that doesn't exist on the page.

### Updating an application in place

`pgapex import hr/ --replace` makes the application with alias `hr` look like the directory:
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

It all happens in one transaction; any error leaves the application unchanged. Without an
application with that alias, `--replace` simply imports, so the same command deploys the first
time and every time after.

A typical flow with git:

```sh
pgapex export hr --format dir --out apps/hr     # in development, after changes in the builder
git diff apps/hr                                 # review, commit, open a pull request
pgapex diff hr apps/hr                           # on the target: what would change (exit code 1)
pgapex import apps/hr --replace                  # deploy
```

`export --format dir` into an existing directory removes the files of deleted components and
leaves dot files (`.git`, `.gitattributes`) alone; it refuses a non-empty directory without a
`pgapex.json`, so a typo can't empty the wrong folder.

### diff

`pgapex diff hr apps/hr` exports the application in memory and compares file by file:

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
downloads the directory format as a `.zip` (one folder named after the alias, fixed timestamps,
so the same application gives the same zip). `pgapex import hr.pgapex.zip` and `pgapex diff` read
the zip directly.

## For pgapex developers

- `src/appfiles.ts` turns a `pgapex/2` document into files and back (pure functions, used by the
  CLI and the builder); `meta.export_app()` and `meta.import_app()` stay the only exporter and
  importer. A new section or column needs nothing here: unknown sections go to `extra/`, unknown
  columns stay in the component's JSON, unknown arrays of a page in `page.json`.
- `src/cli/replace.ts` (`--replace`) lists which tables of an application are its definition
  (replaced) and which belong to the installation (kept). A new table that references `meta.app`
  or a component must be added there; `test/cli.test.ts` fails until it is, like the export test.
- `test/cli.test.ts` covers help and exit codes, the round trip directory → import → export,
  diff and replace.
