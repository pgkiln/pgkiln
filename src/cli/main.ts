// pgkiln command line: migrations, application export/import (JSON or one
// file per component), diff, and a few account helpers. See docs/guide/18-cli.md.
//
//   npx tsx src/cli/main.ts <command> …   or   npm run pgkiln -- <command> …
//
// Exit codes: 0 ok, 1 differences found (diff), 2 usage error, 3 failure.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { root } from '../env.ts';
import { docToFiles, stableJson } from '../appfiles.ts';
import { exportDoc, formatFindings, importDoc, readSource, UsageError, withDb } from './apps.ts';

export const EXIT = { ok: 0, differences: 1, usage: 2, failure: 3 } as const;


type Values = Record<string, string | boolean | undefined>;
interface Command {
  usage: string;
  summary: string;
  details?: string;
  options: NonNullable<ParseArgsConfig['options']>;
  /** option → description, in --help */
  optionHelp: [string, string][];
  positionals: [min: number, max: number];
  run(values: Values, args: string[]): Promise<number>;
}

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

// ------------------------------------------------------------------ password input

async function readPassword(confirm: boolean): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.split(/\r?\n/)[0];
  }
  const ask = (q: string) =>
    new Promise<string>((resolveP) => {
      err(q);
      let s = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            err('\n');
            return resolveP(s);
          }
          if (ch === '\u0003') {
            stdin.setRawMode(false);
            err('\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
          else s += ch;
        }
      };
      stdin.on('data', onData);
    });
  const pw = await ask('Password: ');
  if (confirm && (await ask('Repeat password: ')) !== pw) throw new Error('the passwords do not match');
  return pw;
}

/** The instance's password policy (meta.setting), as in the builder. */
async function checkPassword(password: string, username: string) {
  process.env.RUNTIME_DATABASE_URL ??= process.env.DATABASE_URL; // the CLI runs as the owner
  const { passwordProblem } = await import('../accounts.ts');
  const { closePools } = await import('../db.ts');
  try {
    const problem = await passwordProblem(password, { username });
    if (problem) throw new Error(problem);
  } finally {
    await closePools();
  }
}

/** (sprint 144) pgkiln lock / unlock */
async function lockCommand(v: Values, alias: string, what: 'lock' | 'unlock') {
  const by = (v.as as string) ?? process.env.PGKILN_DEVELOPER ?? userInfo().username;
  const page = v.page === undefined ? null : Number(v.page);
  if (page !== null && !(Number.isInteger(page) && page > 0)) throw new UsageError('--page: a page number');
  process.env.RUNTIME_DATABASE_URL ??= process.env.DATABASE_URL;
  const wc = await import('./working-copy.ts');
  const { closePools } = await import('../db.ts');
  try {
    out(what === 'lock' ? await wc.lockApp(alias, page, by, (v.note as string) ?? null) : await wc.unlockApp(alias, page, by, !!v.force));
    return EXIT.ok;
  } catch (e) {
    if (e instanceof wc.WorkingCopyError) {
      err(`pgkiln ${what}: ${e.message}\n`);
      return EXIT.differences;
    }
    throw e;
  } finally {
    await closePools();
  }
}

// ------------------------------------------------------------------ commands

const COMMANDS: Record<string, Command> = {
  migrate: {
    usage: 'pgkiln migrate [--example <name>]',
    summary: 'apply the database migrations (and install an example application)',
    details: 'Applies db/migrations/*.sql that were not applied yet, each in its own transaction (like npm run db:migrate).',
    options: { example: { type: 'string' }, seed: { type: 'boolean' }, root: { type: 'string' } },
    optionHelp: [
      ['--example <name>', 'then install examples/<name>/ (e.g. hr, the sample the tests use)'],
      ['--root <dir>', 'read db/ and examples/ from another directory (upgrade tests)'],
      ['--seed', 'install db/seed/ of an old release (with --root), else the HR example'],
    ],
    positionals: [0, 0],
    async run(v) {
      const { migrate } = await import('../migrate.ts');
      const applied = await migrate({ root: (v.root as string) ?? root, example: (v.example as string) ?? null, seed: !!v.seed, waitSeconds: 1 });
      out(applied.length ? `${applied.length} file(s) applied.\n` : 'Up to date.\n');
      return EXIT.ok;
    },
  },

  apps: {
    usage: 'pgkiln apps [--json]',
    summary: 'list the applications',
    options: { json: { type: 'boolean' } },
    optionHelp: [['--json', 'as JSON']],
    positionals: [0, 0],
    async run(v) {
      const rows = await withDb(
        async (db) =>
          (
            await db.query(
              `select a.alias, a.name, (select count(*)::int from meta.page p where p.app_id = a.id) as pages
                 from meta.app a order by a.alias`,
            )
          ).rows,
      );
      if (v.json) out(stableJson(rows));
      else if (!rows.length) out('No applications.\n');
      else {
        const w = Math.max(5, ...rows.map((r) => r.alias.length));
        out(`${'ALIAS'.padEnd(w)}  PAGES  NAME\n`);
        for (const r of rows) out(`${r.alias.padEnd(w)}  ${String(r.pages).padStart(5)}  ${r.name}\n`);
      }
      return EXIT.ok;
    },
  },

  ddl: {
    usage: 'pgkiln ddl <schema> [--no-comments] [--no-grants] [--out <file>]',
    summary: 'write the DDL of a schema\'s objects (SQL Workshop → Generate DDL)',
    details:
      'Types, sequences, tables, functions, views, constraints, indexes, triggers, row level security,\n' +
      'comments and grants, in an order that runs, with the schema in search_path at the top (so the\n' +
      'script also creates the objects in another schema). Objects of extensions are left out.',
    options: { 'no-comments': { type: 'boolean' }, 'no-grants': { type: 'boolean' }, out: { type: 'string', short: 'o' } },
    optionHelp: [['--no-comments', 'leave out comments'], ['--no-grants', 'leave out grants'], ['-o, --out <file>', 'write to a file instead of standard output']],
    positionals: [1, 1],
    async run(v, [schema]) {
      const { ddlScript, OBJECT_TYPES, pick, readSchema } = await import('../ddl.ts');
      const objects = await withDb((db) => readSchema(db, schema));
      const script = ddlScript(schema, pick(objects, new Set(OBJECT_TYPES), { comments: !v['no-comments'], grants: !v['no-grants'] }));
      if (v.out) {
        writeFileSync(v.out as string, script);
        err(`Wrote the DDL of ${schema} to ${v.out}.\n`);
      } else out(script);
      return EXIT.ok;
    },
  },

  compare: {
    usage: 'pgkiln compare <source> <target> [--script]',
    summary: 'compare two schemas (SQL Workshop → Schema Comparison); exit code 1 when they differ',
    details:
      'Lists what only the source has (+), what only the target has (-) and what differs (~), by their DDL;\n' +
      'the order of a table\'s columns is not compared. --script writes the script that makes the target\n' +
      'like the source instead (drops of what only the target has are commented out). Nothing is run.',
    options: { script: { type: 'boolean' } },
    optionHelp: [['--script', 'write the change script']],
    positionals: [2, 2],
    async run(v, [source, target]) {
      const { changeScript, compare, readSchema } = await import('../ddl.ts');
      const [a, b] = await withDb(async (db) => [await readSchema(db, source), await readSchema(db, target)]);
      const { differences, same } = compare(a, b);
      if (v.script) out(changeScript(source, target, a, b));
      else {
        for (const d of differences) out(`${d.state === 'source' ? '+' : d.state === 'target' ? '-' : '~'} ${d.kind} ${d.name}\n`);
        err(differences.length ? `${differences.length} difference(s), ${same} object(s) the same.\n` : `The schemas are the same (${same} objects).\n`);
      }
      return differences.length ? EXIT.differences : EXIT.ok;
    },
  },

  export: {
    usage: 'pgkiln export <alias> [--format json|dir|text] [--out <path>]',
    summary: 'export an application as one JSON file or as a directory with a file per component',
    details:
      'json (default) writes the pgkiln/2 document (sorted keys) to --out or standard output.\n' +
      'dir writes a directory (default ./<alias>): files that are no longer part of the application\n' +
      'are removed, dot files (.git) are left alone; a non-empty directory without pgkiln.json is refused.\n' +
      'text writes the same directory with YAML instead of JSON and the code inline (APEXlang-like).',
    options: { format: { type: 'string', short: 'f', default: 'json' }, out: { type: 'string', short: 'o' } },
    optionHelp: [
      ['-f, --format json|dir|text', 'output format (default json)'],
      ['-o, --out <path>', 'file (json) or directory (dir)'],
    ],
    positionals: [1, 1],
    async run(v, [alias]) {
      if (v.format !== 'json' && v.format !== 'dir' && v.format !== 'text') throw new UsageError(`unknown format ${v.format}: use json, dir or text`);
      const doc = await withDb((db) => exportDoc(db, alias));
      if (v.format === 'json') {
        if (v.out) {
          writeFileSync(v.out as string, stableJson(doc));
          err(`Exported ${alias} to ${v.out}.\n`);
        } else out(stableJson(doc));
        return EXIT.ok;
      }
      const { writeDir } = await import('./files.ts');
      const dir = (v.out as string) ?? alias;
      const files = docToFiles(doc, v.format === 'text' ? 'text' : 'json');
      const r = writeDir(dir, files);
      err(`Exported ${alias} to ${dir}/ (${files.size} files; ${r.written} written, ${r.removed} removed).\n`);
      return EXIT.ok;
    },
  },

  import: {
    usage: 'pgkiln import <path> [--alias <alias>] [--replace [--only <file>]…] [--check [--force] | --dry-run]',
    summary: 'import a JSON export, an application directory or a .zip of one',
    details:
      'Without --replace the alias must be free. With --replace an existing application with that\n' +
      'alias is updated in place: it keeps its id, users and access, API clients, sessions, saved\n' +
      'reports, running tasks and workflows, and the on/off switch of its automations; its pages,\n' +
      'shared components and settings become those of the file. Without an existing application\n' +
      '--replace simply imports.\n\n' +
      'With --replace, --only imports just the named files of a directory export (or .zip): a page\n' +
      '(--only pages/12) or a shared component file or folder (--only shared/lovs/jobs.yaml); the rest\n' +
      'of the application stays as it is in the database. Repeat --only for several.\n\n' +
      'With --check the Advisor checks the imported application before anything is committed: every\n' +
      'SQL fragment is planned as the application\'s role (unknown tables, columns, functions, types and\n' +
      'grants), and references to pages, items, lists of values and schemes are checked. Errors refuse\n' +
      'the import (exit code 1, nothing changes); --force imports anyway. --dry-run checks and never commits.',
    options: { alias: { type: 'string', short: 'a' }, replace: { type: 'boolean' }, check: { type: 'boolean' }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, only: { type: 'string', multiple: true } },
    optionHelp: [
      ['-a, --alias <alias>', 'alias of the application (default: the one in the export)'],
      ['--replace', 'update the application with that alias in place'],
      ['--check', 'check the application\'s SQL and references first; errors refuse the import'],
      ['--force', 'with --check: import even when the check finds errors'],
      ['--dry-run', 'import, check and roll back: nothing changes'],
      ['--only <file>', 'with --replace: import only this page (pages/12) or component file or folder'],
    ],
    positionals: [1, 1],
    async run(v, [path]) {
      const source = await readSource(path);
      let { doc } = source;
      const only = (v.only as string[] | undefined) ?? [];
      if (only.length) {
        // (116) a file-level import: the named files over the application's current files
        if (!v.replace) throw new UsageError('--only needs --replace');
        if (!source.files) throw new UsageError('--only needs a directory export or a .zip of one');
        const target = (v.alias as string) ?? doc?.app?.alias;
        const { mergeOnly } = await import('./only.ts');
        const style = JSON.parse(source.files.get('pgkiln.json')?.toString('utf8') ?? '{}').style === 'text' ? 'text' : 'json';
        const current = await withDb(async (db) => {
          if (!(await db.query('select 1 from meta.app where alias = $1', [target])).rowCount) throw new UsageError(`--only: application ${target} not found`);
          return docToFiles(await exportDoc(db, target), style);
        });
        const m = mergeOnly(current, source.files, only);
        err(m.changed.length ? `Only ${m.labels.join(', ')}: ${m.changed.length} file(s) differ.\n` : `Only ${m.labels.join(', ')}: no file differs.\n`);
        const { filesToDoc } = await import('../appfiles.ts');
        doc = filesToDoc(m.files);
      }
      const alias = (v.alias as string) ?? doc?.app?.alias;
      if (!alias) throw new Error('the export has no alias: use --alias');
      const check = v['dry-run'] ? 'dry-run' : v.check ? (v.force ? 'force' : 'check') : 'off';
      const r = await withDb((db) => importDoc(db, doc, { alias, replace: !!v.replace, check, by: `pgkiln import (${userInfo().username})` }));
      if (check !== 'off') out(formatFindings(r.findings));
      if (!r.committed) {
        out(check === 'dry-run'
          ? `Dry run: nothing was imported.\n`
          : `Not imported: the check found ${r.findings.filter((f) => f.severity === 'error').length} error(s). Fix them, or use --force.\n`);
        return check === 'dry-run' && !r.findings.some((f) => f.severity === 'error') ? EXIT.ok : EXIT.differences;
      }
      out(r.replaced
        ? `Replaced ${alias} (application ${r.id}).\n`
        : `Imported ${alias} (application ${r.id}). Check its database role and grant access in the builder.\n`);
      if (r.roleNote) out(`${r.roleNote}\n`);
      // supporting objects never run on import: the developer reviews and runs them in the builder
      if (r.scripts) out(`It has ${r.scripts} supporting object script(s); they were not run. Review and run them in the builder: Shared Components → Supporting objects.\n`);
      return EXIT.ok;
    },
  },

  // (sprint 182, CD-1/CD-4 leftover) an Oracle APEX export, translated to a pgkiln/2 document, then the import above
  'import-apex': {
    usage: 'pgkiln import-apex <f100.sql | dir | zip> [--alias <alias>] [--schema <schema>] [--db-role <role>] [--check | --dry-run | --out <dir>] [--json] [--all]',
    summary: 'import an Oracle APEX application export (SQL format) and report what was mapped',
    details:
      'Reads an APEX application export in the SQL format (f100.sql, or a split export as a directory or\n' +
      '.zip) as text (nothing in it runs) and translates it to a pgkiln application: pages, regions,\n' +
      'items, buttons, validations, processes, computations, branches, simple dynamic actions, lists of\n' +
      'values, authorization schemes and the navigation menu (docs/guide/11-from-apex.md). PL/SQL is\n' +
      'carried over as it is and marked "needs porting". The report lists every component as mapped,\n' +
      'mapped with notes or not mapped. Unqualified tables are taken to be in --schema (default: the\n' +
      'export\'s parsing schema in lower case). --dry-run only prints the report; --out writes the\n' +
      'application files (text style) to a directory to edit, then pgkiln import <dir>. The alias must be free.\n' +
      '--check (sprint 192) also lists the tables, views, columns, sequences and PL/SQL routines the application\n' +
      'uses that the database doesn\'t have (it reads only the catalogue), imports nothing and exits with 1 when\n' +
      'something is missing: run it after ora2pg moved the schema (chapter 11, From Oracle to pgkiln).',
    options: {
      alias: { type: 'string', short: 'a' }, schema: { type: 'string' }, 'db-role': { type: 'string' },
      'dry-run': { type: 'boolean' }, out: { type: 'string', short: 'o' }, json: { type: 'boolean' }, all: { type: 'boolean' },
      'no-issues': { type: 'boolean' }, check: { type: 'boolean' },
    },
    optionHelp: [
      ['-a, --alias <alias>', 'alias of the new application (default: from the APEX alias or name)'],
      ['--schema <schema>', 'schema of unqualified tables (default: the parsing schema, lower case; "" for none)'],
      ['--db-role <role>', 'the application\'s database role (default: none, set it in Settings)'],
      ['--check', 'the report and the database objects the target schema lacks; import nothing; exit 1 when one is missing'],
      ['--dry-run', 'print the report, import nothing'],
      ['-o, --out <dir>', 'write the application files there instead of importing'],
      ['--json', 'the report as JSON'],
      ['--all', 'also list the components that were mapped without notes'],
      ['--no-issues', 'no Team Development issue per component that needs hand work (made by default)'],
    ],
    positionals: [1, 1],
    async run(v, [path]) {
      const { apexSource, apexSourceFromDir, apexToDoc, NotAnApexExport, reportText, MAX_APEX_BYTES } = await import('../apeximport.ts');
      const { ApexParseError } = await import('../apexparse.ts');
      if (!existsSync(path)) throw new UsageError(`${path} not found`);
      const alias = v.alias as string | undefined;
      if (alias !== undefined && !/^[a-z][a-z0-9_-]*$/.test(alias)) throw new UsageError('--alias: lower case letters, digits, - and _, starting with a letter');
      let result;
      try {
        let source: string;
        if (statSync(path).isDirectory()) source = await apexSourceFromDir(path);
        else {
          if (statSync(path).size > MAX_APEX_BYTES) throw new NotAnApexExport(`${path} is larger than ${MAX_APEX_BYTES / 1024 / 1024} MB`);
          source = await apexSource(readFileSync(path));
        }
        result = apexToDoc(source, { alias, schema: v.schema as string | undefined, dbRole: (v['db-role'] as string) ?? null });
      } catch (e) {
        if (e instanceof NotAnApexExport || e instanceof ApexParseError) {
          err(`pgkiln import-apex: ${e.message}\n`);
          return EXIT.failure;
        }
        throw e;
      }
      const { doc, report } = result;
      // (sprint 192, NX-F5) the database objects the application uses, looked up in the target database's catalogue
      if (v.check) {
        if (v['dry-run'] || v.out) throw new UsageError('--check imports nothing: leave out --dry-run and --out');
        const { apexCheck, checkText } = await import('../apex-check.ts');
        const check = await withDb((db) => apexCheck(db, report, { schema: report.application.schema }));
        out(v.json ? stableJson({ ...report, check }) : reportText(report, { all: !!v.all }) + checkText(check));
        if (!v.json) out(`\nCheck only: nothing was imported.${check.missing.length ? ' Create what is missing (ora2pg, chapter 11), then check again.' : ''}\n`);
        return check.missing.length ? EXIT.differences : EXIT.ok;
      }
      if (v['dry-run'] || v.out) out(v.json ? stableJson(report) : reportText(report, { all: !!v.all }));
      if (v['dry-run']) {
        if (!v.json) out('\nDry run: nothing was imported.\n');
        return EXIT.ok;
      }
      if (v.out) {
        const { writeDir } = await import('./files.ts');
        const w = writeDir(v.out as string, docToFiles(doc, 'text'));
        err(`Wrote ${w.written} file(s) to ${v.out}. Edit them, then: pgkiln import ${v.out}\n`);
        return EXIT.ok;
      }
      let missing = 0;
      const r = await withDb(async (db) => {
        if ((await db.query('select 1 from meta.app where alias = $1', [report.application.alias])).rowCount) throw new UsageError(`application ${report.application.alias} exists: choose another --alias`);
        // (sprint 192) what the database lacks goes into the report (and the issues) before the import
        const { apexCheck, checkText } = await import('../apex-check.ts');
        const check = await apexCheck(db, report, { schema: report.application.schema });
        missing = check.missing.length;
        out(v.json ? stableJson({ ...report, check }) : reportText(report, { all: !!v.all }) + checkText(check));
        // (sprint 186) without --db-role: app_<alias> with rights on the parsing schema, when it exists here
        const schema = (v.schema as string | undefined)?.trim().toLowerCase() || null;
        const there = schema && (await db.query('select 1 from pg_namespace where nspname = $1', [schema])).rowCount ? schema : null;
        const made = await importDoc(db, doc, { alias: report.application.alias, replace: false, by: `pgkiln import-apex (${userInfo().username})`, schema: there });
        // (sprint 187) a Team Development issue per component that needs hand work, in the application's workspace
        let issues = 0;
        if (!v['no-issues'] && made.committed) {
          const { apexIssues } = await import('../apex-issues.ts');
          await db.query('begin');
          try {
            issues = await apexIssues(db, report, { appId: made.id, alias: report.application.alias, by: `pgkiln import-apex (${userInfo().username})` });
            await db.query('commit');
          } catch (e) {
            await db.query('rollback');
            throw e;
          }
        }
        return { ...made, issues };
      });
      if (!v.json) out(`\nImported ${report.application.alias} (application ${r.id}).${r.roleNote ? ` ${r.roleNote}` : ''}${r.issues ? ` ${r.issues} Team Development issue(s) list what needs hand work (label "APEX import").` : ''}${missing ? ` ${missing} database object(s) are missing: their pages show errors until you create them.` : ''} Finish what the report lists.\n`);
      return EXIT.ok;
    },
  },

  diff: {
    usage: 'pgkiln diff <alias> <path> [--name-only | --quiet]',
    summary: 'show how a directory export (or JSON file) differs from the application in the database',
    details:
      'Compares the files the application would export now with the files at <path>.\n' +
      'A: only in the directory (import would add it), D: only in the database (import would\n' +
      'remove it), M: different. JSON compares by content. Exit code 0: no differences, 1: differences.',
    options: { 'name-only': { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' } },
    optionHelp: [
      ['--name-only', 'only list the files that differ'],
      ['-q, --quiet', 'no output, only the exit code'],
    ],
    positionals: [2, 2],
    async run(v, [alias, path]) {
      const { compareFiles, unifiedDiff } = await import('./diff.ts');
      const source = await readSource(path);
      const theirs = source.files ?? docToFiles(source.doc);
      // in the directory's style: a text-style directory compares with YAML files
      const style = theirs && [...theirs.keys()].some((p) => p.endsWith('.yaml')) ? 'text' : 'json';
      const ours = docToFiles(await withDb((db) => exportDoc(db, alias)), style);
      const changes = compareFiles(ours, theirs);
      if (!v.quiet) {
        for (const c of changes) {
          out(`${c.status} ${c.path}\n`);
          if (!v['name-only'] && c.status === 'M') out(unifiedDiff(c.path, ours.get(c.path), theirs.get(c.path)));
        }
        if (!v['name-only']) err(changes.length ? `${changes.length} file(s) differ.\n` : 'No differences.\n');
      }
      return changes.length ? EXIT.differences : EXIT.ok;
    },
  },

  advise: {
    usage: 'pgkiln advise <path | alias> [--offline] [--format text|json|sarif] [--fail-on error|warning|info|never] [-o <file>]',
    summary: 'check an export or an application with the Advisor (for CI: text, JSON or SARIF)',
    details:
      'Runs the builder\'s Advisor: every SQL fragment is planned as the application\'s database role (unknown\n' +
      'tables, columns, functions, types and missing grants), references to pages, items, lists of values and\n' +
      'schemes are followed, and security defaults are checked (pages that write data without sign-in or an\n' +
      'authorization scheme, unrestricted page protection, long sessions, administrators without a second factor).\n\n' +
      'A path (an export directory, a .zip or a JSON export) is imported into a transaction that is rolled back:\n' +
      'nothing changes. It needs a database with pgkiln\'s migrations and the application\'s own tables (in CI, a\n' +
      'PostgreSQL service, pgkiln migrate and your migrations). An alias checks the application in the database.\n\n' +
      'With --offline a path is checked from its files alone, without a database: references, the login page, page\n' +
      'groups, security defaults, workflow steps and JSON source profiles; SQL is not planned.\n\n' +
      'SARIF points every finding at the file of its page or component in the export, so GitHub code scanning\n' +
      'annotates the pull request. Exit code 1 when a finding is at or above --fail-on (default: error).',
    options: { format: { type: 'string', short: 'f' }, 'fail-on': { type: 'string' }, output: { type: 'string', short: 'o' }, base: { type: 'string' }, offline: { type: 'boolean' } },
    optionHelp: [
      ['--offline', 'check an export\'s files without a database (no SQL planning)'],
      ['-f, --format <format>', 'text (default), json or sarif'],
      ['--fail-on <level>', 'exit code 1 from this level: error (default), warning, info or never'],
      ['-o, --output <file>', 'write the report to a file (the summary still goes to standard error)'],
      ['--base <dir>', 'with an alias: the folder its export lives in, for the paths in the report (e.g. apps/hr)'],
    ],
    positionals: [1, 1],
    async run(v, [target]) {
      const format = (v.format as string) ?? 'text';
      const failOn = (v['fail-on'] as string) ?? 'error';
      if (!['text', 'json', 'sarif'].includes(format)) throw new UsageError(`--format: text, json or sarif, not ${format}`);
      if (!['error', 'warning', 'info', 'never'].includes(failOn)) throw new UsageError(`--fail-on: error, warning, info or never, not ${failOn}`);
      process.env.RUNTIME_DATABASE_URL ??= process.env.DATABASE_URL;
      const { adviseOffline, adviseTarget, fails, formatJson, formatSarif, formatText } = await import('./advise.ts');
      const { closePools } = await import('../db.ts');
      try {
        const r = v.offline ? await adviseOffline(target) : await withDb((db) => adviseTarget(db, target));
        const base = (v.base as string) ?? null;
        const report = format === 'sarif' ? formatSarif(r, version(), base) : format === 'json' ? formatJson(r, base) : formatText(r, base);
        if (v.output) {
          writeFileSync(v.output as string, report);
          const count = (s: string) => r.findings.filter((f) => f.severity === s).length;
          err(`${r.alias}: ${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} note(s); report in ${v.output}.\n`);
        } else out(report);
        return fails(r.findings, failOn as 'error') ? EXIT.differences : EXIT.ok;
      } finally {
        await closePools();
      }
    },
  },

  'working-copy': {
    usage: 'pgkiln working-copy <list|create|compare|merge|refresh|delete> <alias> [<name>] [--prefer copy|main] [--take <component>]… [--as <developer>]',
    summary: 'make, compare, merge and delete working copies of an application',
    details:
      'list <alias>             the working copies of an application\n' +
      'create <alias> <name>    a working copy of the application (a new application, alias printed)\n' +
      'compare <copy>           the components that differ from the main application (exit 1 with conflicts)\n' +
      'merge <copy>             the copy\'s changes into the main application\n' +
      'refresh <copy>           the main application\'s changes into the copy\n' +
      'delete <copy>            delete the working copy\n\n' +
      'Conflicts (a component changed on both sides) need a choice: --prefer copy or --prefer main for all, or\n' +
      '--take <component> (as compare lists them) for each one that keeps the copy\'s version. A merge is refused\n' +
      'while another developer has locked the target application or a page it changes. Changes are logged under\n' +
      '--as, else PGKILN_DEVELOPER, else the operating system user.',
    options: { prefer: { type: 'string' }, take: { type: 'string', multiple: true }, as: { type: 'string' } },
    optionHelp: [
      ['--prefer copy|main', 'merge, refresh: resolve every conflict this way'],
      ['--take <component>', 'merge, refresh: this conflict keeps the copy\'s version (repeat)'],
      ['--as <developer>', 'who does it (activity log, locks)'],
    ],
    positionals: [2, 3],
    async run(v, [action, alias, name]) {
      const by = (v.as as string) ?? process.env.PGKILN_DEVELOPER ?? userInfo().username;
      const prefer = v.prefer as string | undefined;
      if (prefer !== undefined && prefer !== 'copy' && prefer !== 'main') throw new UsageError('--prefer: copy or main');
      process.env.RUNTIME_DATABASE_URL ??= process.env.DATABASE_URL;
      const wc = await import('./working-copy.ts');
      const { closePools } = await import('../db.ts');
      try {
        switch (action) {
          case 'list': out(await wc.listCopies(alias)); return EXIT.ok;
          case 'create':
            if (!name) throw new UsageError('create needs a name: pgkiln working-copy create <alias> <name>');
            out((await wc.createWorkingCopy(alias, name, by)).text);
            return EXIT.ok;
          case 'compare': {
            const c = await wc.compareCopy(alias);
            out(c.text);
            return c.conflicts ? EXIT.differences : EXIT.ok;
          }
          case 'merge':
          case 'refresh':
            out(await wc.mergeWorkingCopy(alias, { direction: action, prefer: (prefer as 'copy' | 'main') ?? null, take: (v.take as unknown as string[] | undefined) ?? [], by }));
            return EXIT.ok;
          case 'delete': out(await wc.deleteWorkingCopy(alias, by)); return EXIT.ok;
          default: throw new UsageError(`unknown action ${action}: list, create, compare, merge, refresh or delete`);
        }
      } catch (e) {
        if (e instanceof wc.WorkingCopyError) {
          err(`pgkiln working-copy: ${e.message}\n`);
          return EXIT.differences;
        }
        throw e;
      } finally {
        await closePools();
      }
    },
  },

  lock: {
    usage: 'pgkiln lock <alias> [--page <n>] [--note <text>] [--as <developer>]',
    summary: 'lock an application or one of its pages, as the builder\'s Lock does',
    details: 'Other developers can\'t change it in the builder, import over it or merge into it until it is unlocked.',
    options: { page: { type: 'string', short: 'p' }, note: { type: 'string' }, as: { type: 'string' } },
    optionHelp: [['-p, --page <n>', 'lock this page only'], ['--note <text>', 'why (shown to the others)'], ['--as <developer>', 'whose lock (default PGKILN_DEVELOPER or the operating system user)']],
    positionals: [1, 1],
    async run(v, [alias]) {
      return lockCommand(v, alias, 'lock');
    },
  },

  unlock: {
    usage: 'pgkiln unlock <alias> [--page <n>] [--force] [--as <developer>]',
    summary: 'unlock an application or a page (another developer\'s lock only with --force, logged)',
    options: { page: { type: 'string', short: 'p' }, force: { type: 'boolean' }, as: { type: 'string' } },
    optionHelp: [['-p, --page <n>', 'unlock this page'], ['--force', 'break another developer\'s lock (logged)'], ['--as <developer>', 'who unlocks']],
    positionals: [1, 1],
    async run(v, [alias]) {
      return lockCommand(v, alias, 'unlock');
    },
  },

  mcp: {
    usage: 'pgkiln mcp [--url <builder address> [--token-env <variable>]]',
    summary: 'run an MCP server on standard input/output for AI coding agents (Claude Code, Cursor, …)',
    details:
      'Lets an agent list applications, read pages and shared components, describe tables, run read-only\n' +
      'queries, search the user guide, and export, diff and import applications as files.\n' +
      'The repository\'s .mcp.json starts it for Claude Code; elsewhere:\n' +
      '  claude mcp add pgkiln -- /path/to/pgkiln/bin/pgkiln.js mcp\n' +
      'Without --url it connects to DATABASE_URL (the owner) on this machine. With --url it acts as the developer\n' +
      'whose builder token is in the environment variable (default PGKILN_TOKEN; make one on the builder\'s\n' +
      'Security page), through the builder\'s API, with the token\'s scopes and workspace; no database connection:\n' +
      '  claude mcp add pgkiln -e PGKILN_TOKEN=pgkb_… -- npx -y pgkiln mcp --url https://pgkiln.example.com\n' +
      'See docs/guide/20-ai-agents.md.',
    options: { url: { type: 'string' }, 'token-env': { type: 'string' } },
    optionHelp: [
      ['--url <address>', 'the builder\'s address (https; http only to localhost): act through its API'],
      ['--token-env <name>', 'the environment variable with the builder token (default PGKILN_TOKEN); never the token itself'],
    ],
    positionals: [0, 0],
    async run(v) {
      const { RemoteClient, serve } = await import('./mcp.ts');
      if (v['token-env'] && !v.url) throw new UsageError('--token-env needs --url');
      if (!v.url) {
        await serve();
        return EXIT.ok;
      }
      const name = String(v['token-env'] ?? 'PGKILN_TOKEN');
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)) throw new UsageError(`--token-env takes the name of an environment variable, not a token: ${name.slice(0, 8)}…`);
      const token = process.env[name];
      if (!token) throw new UsageError(`${name} is not set: make a builder token on the builder's Security page and put it in ${name}`);
      let remote;
      try {
        remote = new RemoteClient(String(v.url), token.trim());
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      await serve(process.stdin, process.stdout, remote);
      return EXIT.ok;
    },
  },

  plugin: {
    usage: 'pgkiln plugin build <dir> [-o <file>] | pgkiln plugin install <file|dir> --app <alias> [--replace]',
    summary: 'build a plug-in file from its sources, or install one into an application',
    details:
      'A plug-in source directory holds plugin.json (format pgkiln-plugin/2 without file contents),\n' +
      'the files it lists (JavaScript, CSS, …), template.html (and wrapper.html) for a region plug-in\'s\n' +
      'template component, and install.sql. build writes <name>.plugin.json (or -o); install adds the\n' +
      'plug-in, its files and template to an application. Install SQL never runs: review it and run\n' +
      'it from the builder (Shared Components → Plug-ins).',
    options: { output: { type: 'string', short: 'o' }, app: { type: 'string' }, replace: { type: 'boolean' } },
    optionHelp: [
      ['-o, --output <file>', 'build: where to write the plug-in file'],
      ['--app <alias>', 'install: the application'],
      ['--replace', 'install: replace a plug-in, files and template with the same names'],
    ],
    positionals: [2, 2],
    async run(v, [action, path]) {
      const { pluginFromSources } = await import('../runtime/plugins.ts');
      if (!existsSync(path)) throw new UsageError(`${path} not found`);
      const load = () =>
        statSync(path).isDirectory()
          ? pluginFromSources((name) => (existsSync(join(path, name)) ? readFileSync(join(path, name)) : undefined))
          : JSON.parse(readFileSync(path, 'utf8'));
      if (action === 'build') {
        if (!statSync(path).isDirectory()) throw new UsageError('build takes a plug-in source directory');
        const doc = load();
        const file = resolve(String(v.output ?? `${doc.name}.plugin.json`));
        writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
        out(`Wrote ${file} (${doc.type} plug-in ${doc.name}, ${doc.files.length} file(s)).\n`);
        return EXIT.ok;
      }
      if (action === 'install') {
        if (!v.app) throw new UsageError('install needs --app <alias>');
        const doc = load();
        const { parsePluginDocument } = await import('../runtime/plugins.ts');
        const parsed = parsePluginDocument(doc);
        if (typeof parsed === 'string') throw new Error(parsed);
        await withDb(async (db) => {
          const a = await db.query('select id from meta.app where alias = $1', [v.app]);
          if (!a.rows[0]) throw new Error(`application ${v.app} not found (pgkiln apps lists them)`);
          await db.query('select meta.import_plugin($1, $2::jsonb, $3)', [a.rows[0].id, JSON.stringify({ ...doc, files: parsed.files }), !!v.replace]);
        });
        out(`Installed ${parsed.plugin.type} plug-in ${parsed.plugin.name} into ${v.app}.${parsed.plugin.install_sql ? ' It has install SQL: review and run it in the builder.' : ''}\n`);
        return EXIT.ok;
      }
      throw new UsageError('pgkiln plugin build <dir> | pgkiln plugin install <file|dir> --app <alias>');
    },
  },

  users: {
    usage: 'pgkiln users list|add|password [<username>] [options]',
    summary: 'list accounts and builder developers, add one, set a password',
    details:
      'pgkiln users list [--developers]\n' +
      'pgkiln users add <username> [--developer] [--app <alias> --roles a,b] [--name <display name>] [--email <address>]\n' +
      'pgkiln users password <username> [--developer]\n\n' +
      'Passwords are read from standard input (first line) or asked for on a terminal, never\n' +
      'taken from the command line, and must meet the password policy. Setting a password ends\n' +
      "the user's sessions (a developer's builder tokens are revoked too).",
    options: {
      developer: { type: 'boolean' },
      developers: { type: 'boolean' },
      app: { type: 'string' },
      roles: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
    },
    optionHelp: [
      ['--developer(s)', 'builder developers (meta.developer) instead of accounts'],
      ['--app <alias>', 'add: give the account access to this application'],
      ['--roles a,b', 'add: with these roles'],
      ['--name, --email', 'add: display name and e-mail of an account'],
    ],
    positionals: [1, 2],
    async run(v, [action, username]) {
      const developer = !!(v.developer || v.developers);
      if (action === 'list') {
        if (username) throw new UsageError('users list takes no username');
        const rows = await withDb(async (db) =>
          developer
            ? (await db.query('select username from meta.developer order by lower(username)')).rows
            : (
                await db.query(
                  `select a.username, a.display_name, a.active,
                          coalesce(string_agg(p.alias || coalesce('(' || nullif(array_to_string(x.roles, ','), '') || ')', ''), ' ' order by p.alias), '') as apps
                     from meta.account a
                     left join meta.app_access x on x.account_id = a.id
                     left join meta.app p on p.id = x.app_id
                    group by a.id order by lower(a.username)`,
                )
              ).rows,
        );
        for (const r of rows) out(developer ? `${r.username}\n` : `${r.username}${r.active ? '' : ' (inactive)'}\t${r.display_name ?? ''}\t${r.apps}\n`);
        return EXIT.ok;
      }
      if (action !== 'add' && action !== 'password') throw new UsageError(`unknown action ${action}: use list, add or password`);
      if (!username) throw new UsageError(`users ${action} needs a username`);
      if ((v.app || v.roles || v.name || v.email) && (developer || action !== 'add')) throw new UsageError('--app, --roles, --name and --email are for adding an account');
      if (v.roles && !v.app) throw new UsageError('--roles needs --app');
      const password = await readPassword(true);
      await checkPassword(password, username);
      return withDb(async (db) => {
        await db.query('begin');
        try {
          if (developer && action === 'add') {
            await db.query('insert into meta.developer (username, password_hash) values ($1, meta.hash_password($2))', [username, password]);
          } else if (developer) {
            const r = await db.query('update meta.developer set password_hash = meta.hash_password($2) where username = $1', [username, password]);
            if (r.rowCount !== 1) throw new Error(`no developer ${username}`);
            await db.query('delete from meta.session where app_id is null and username = $1', [username]);
            // (sprint 194, SEC-1) and their builder tokens: a password set for someone may mean their account was taken
            await db.query(`update meta.builder_token set revoked_at = now(), revoked_by = 'pgkiln users password', revoked_reason = 'password set by an administrator' where username = $1 and revoked_at is null`, [username]);
          } else if (action === 'add') {
            const id = (
              await db.query(
                'insert into meta.account (username, display_name, email, password_hash) values ($1, $2, $3, meta.hash_password($4)) returning id',
                [username, (v.name as string) ?? null, (v.email as string) ?? null, password],
              )
            ).rows[0].id;
            if (v.app) {
              const roles = String(v.roles ?? '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
              const r = await db.query('insert into meta.app_access (app_id, account_id, roles) select id, $2, $3 from meta.app where alias = $1', [v.app, id, roles]);
              if (r.rowCount !== 1) throw new Error(`application ${v.app} not found`);
            }
          } else {
            const r = await db.query(
              'update meta.account set password_hash = meta.hash_password($2), password_changed_at = now() where lower(username) = lower($1) returning id',
              [username, password],
            );
            if (r.rowCount !== 1) throw new Error(`no account ${username}`);
            await db.query('delete from meta.session where app_id is not null and lower(username) = lower($1)', [username]);
            await db.query('delete from meta.persistent_login where account_id = $1', [r.rows[0].id]);
          }
          await db.query('commit');
        } catch (e) {
          await db.query('rollback').catch(() => {});
          throw e;
        }
        out(`${action === 'add' ? 'Added' : 'Password set for'} ${developer ? 'developer' : 'account'} ${username}.\n`);
        return EXIT.ok;
      });
    },
  },
  // (sprint 126, SEC-6) lockout recovery on the server, when nobody can sign in to the builder
  admin: {
    usage: 'pgkiln admin reset-2fa <developer> | set-2fa-policy off|admins|all | builder-sign-in password | rotate-key | key-backed-up | check [options]',
    summary: 'lockout recovery and checks: two-factor reset and policy, the builder password, the instance key',
    details:
      'pgkiln admin reset-2fa <developer> [--reason <text>]\n' +
      'pgkiln admin set-2fa-policy off|admins|all [--grace <days>]\n' +
      'pgkiln admin builder-sign-in password\n' +
      'pgkiln admin rotate-key [--dry-run]\n' +
      'pgkiln admin key-backed-up\n' +
      'pgkiln admin check [--url <public url>] [--production]\n\n' +
      "reset-2fa removes the developer's authenticator apps and recovery codes and ends their builder\n" +
      'sessions; they sign in with the password and set up an app again. set-2fa-policy off always works\n' +
      "(and clears the workspaces' own two-factor rules); admins and all need at least two administrators\n" +
      'with two-factor sign-in (or every one, when there are fewer). builder-sign-in password turns off the\n' +
      "workspaces' single sign-on rule, for when the identity provider fails and no break-glass administrator\n" +
      'can sign in. All are written to the activity log and mailed to the administrators.\n\n' +
      'rotate-key re-encrypts every stored secret (authenticator apps, web credentials, mail and AI keys)\n' +
      'from PGKILN_OLD_SECRET_KEY to PGKILN_SECRET_KEY in one transaction; stop the servers first and start\n' +
      'them with the new key. key-backed-up records that the current key is kept outside the server.\n' +
      'check prints the lockout checks of Instance settings (instance key, clock, passkey domain,\n' +
      'break-glass administrators); --url shows which passkeys a move to that address would break.\n' +
      'Exit code 1 when a check needs attention.',
    options: { reason: { type: 'string' }, grace: { type: 'string' }, 'dry-run': { type: 'boolean' }, url: { type: 'string' }, production: { type: 'boolean' } },
    optionHelp: [
      ['--reason <text>', 'reset-2fa: why (in the activity log and the mail)'],
      ['--grace <days>', 'set-2fa-policy: days developers have to set up an app (0 to 90, default 7)'],
      ['--dry-run', 'rotate-key: count what would be re-encrypted, change nothing'],
      ['--url <url>', 'check: the public address to check passkeys against (default PUBLIC_URL)'],
    ],
    positionals: [1, 2],
    async run(v, [action, arg]) {
      process.env.RUNTIME_DATABASE_URL ??= process.env.DATABASE_URL; // the CLI runs as the owner
      const mfa = await import('../mfa.ts');
      const { logActivity } = await import('../session.ts');
      const { closePools } = await import('../db.ts');
      const by = `pgkiln admin (${userInfo().username})`;
      try {
        if (action === 'reset-2fa') {
          if (!arg) throw new UsageError('reset-2fa takes a developer');
          const reason = String(v.reason ?? 'command line').slice(0, 200);
          if (!(await mfa.resetFactors(arg))) throw new Error(`no developer ${arg}`);
          await logActivity({ username: arg, event: '2fa_reset', ip: 'cli', detail: `${arg}: ${reason} (${by})` });
          const sent = await mfa.notifyMfa(await mfa.adminEmails(), `pgkiln: two-factor sign-in of ${arg} reset`,
            `${by} removed the second factors of developer ${arg} on the server (reason: ${reason}).`);
          out(`Two-factor sign-in of ${arg} reset; their builder sessions ended.${sent ? ` ${sent} administrator(s) told by mail.` : ''}\n`);
          return EXIT.ok;
        }
        if (action === 'set-2fa-policy') {
          if (!mfa.MFA_POLICIES.includes(arg as never)) throw new UsageError('set-2fa-policy takes off, admins or all');
          const grace = v.grace === undefined ? (await mfa.mfaPolicy()).graceDays : Number(v.grace);
          if (!Number.isInteger(grace) || grace < 0 || grace > 90) throw new UsageError('--grace takes 0 to 90 days');
          const policy = arg as 'off' | 'admins' | 'all';
          if (await mfa.policyProblem(policy)) throw new Error('at least two administrators (or every one, when there are fewer) need two-factor sign-in first');
          await mfa.setPolicy(policy, grace);
          // (sprint 128) off means off: no workspace requires a second factor either
          const cleared = policy === 'off' ? await mfa.clearWorkspaceRequirements() : 0;
          await logActivity({ event: '2fa_policy', ip: 'cli', detail: `${policy}, grace ${grace} days${cleared ? `, ${cleared} workspace rule(s) cleared` : ''} (${by})` });
          const sent = await mfa.notifyMfa(await mfa.adminEmails(), `pgkiln: two-factor sign-in policy is now ${policy}`, `${by} set the two-factor policy to ${policy} on the server.`);
          out(`Two-factor policy: ${policy}${policy === 'off' ? '' : `, grace ${grace} days`}.${cleared ? ` ${cleared} workspace(s) no longer require it.` : ''}${sent ? ` ${sent} administrator(s) told by mail.` : ''}\n`);
          return EXIT.ok;
        }
        // (sprint 129, SEC-1) every workspace allows the pgkiln password again
        if (action === 'builder-sign-in') {
          if (arg !== 'password') throw new UsageError('builder-sign-in takes password');
          const { clearSsoOnly } = await import('../devsso.ts');
          const cleared = await clearSsoOnly();
          await logActivity({ event: 'sso_policy', ip: 'cli', detail: `password sign-in allowed again, ${cleared} workspace rule(s) cleared (${by})` });
          const sent = await mfa.notifyMfa(await mfa.adminEmails(), 'pgkiln: the builder password works again',
            `${by} turned off the single sign-on rule of ${cleared} workspace(s) on the server: developers may sign in with the pgkiln password.`);
          out(`Developers may sign in with the pgkiln password again; ${cleared} workspace(s) no longer require single sign-on.${sent ? ` ${sent} administrator(s) told by mail.` : ''}\n`);
          return EXIT.ok;
        }
        // (sprint 133, SEC-6) the instance key and the lockout checks
        if (action === 'rotate-key' || action === 'key-backed-up' || action === 'check') {
          if (arg !== undefined) throw new UsageError(`${action} takes no argument`);
          const checks = await import('../instance-checks.ts');
          if (action === 'rotate-key') {
            const oldKey = process.env.PGKILN_OLD_SECRET_KEY ?? '';
            const newKey = process.env.PGKILN_SECRET_KEY ?? '';
            if (!oldKey) throw new UsageError('set PGKILN_OLD_SECRET_KEY to the key the secrets are stored with, and PGKILN_SECRET_KEY to the new one');
            const dry = !!v['dry-run'];
            const counts = await checks.rotateKey(oldKey, newKey, { dryRun: dry });
            const rotated = counts.reduce((n, c) => n + c.rotated, 0);
            for (const c of counts) out(`  ${c.schema}.${c.table}.${c.column}: ${c.rotated} ${dry ? 'to re-encrypt' : 're-encrypted'}${c.already ? `, ${c.already} already with the new key` : ''}\n`);
            if (dry) {
              out(`Dry run: ${rotated} secret(s) would be re-encrypted; nothing changed.\n`);
              return EXIT.ok;
            }
            await logActivity({ event: 'secret_key', ip: 'cli', detail: `rotated, ${rotated} secret(s) re-encrypted (${by})` });
            const sent = await mfa.notifyMfa(await mfa.adminEmails(), 'pgkiln: the instance key was rotated',
              `${by} re-encrypted ${rotated} stored secret(s) with a new PGKILN_SECRET_KEY on the server. Keep a copy of the new key and confirm it on Instance settings.`);
            out(`${rotated} secret(s) re-encrypted with the new key. Start the servers with it, keep a copy, then run 'pgkiln admin key-backed-up'.${sent ? ` ${sent} administrator(s) told by mail.` : ''}\n`);
            return EXIT.ok;
          }
          if (action === 'key-backed-up') {
            if (!(await checks.confirmKeyBackup(by))) throw new Error('PGKILN_SECRET_KEY is not set (at least 32 characters)');
            await logActivity({ event: 'secret_key', ip: 'cli', detail: `backup confirmed (${by})` });
            out('Backup of the instance key confirmed.\n');
            return EXIT.ok;
          }
          let rpId: string | null = null;
          const url = (v.url as string | undefined) ?? process.env.PUBLIC_URL;
          if (url) {
            if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new UsageError('--url takes an http(s) address');
            rpId = (await import('../webauthn.ts')).rpIdOf(new URL(url).origin);
          }
          // (sprint 191, NX-S6) --production: the production readiness group even without an https PUBLIC_URL; any line
          // that isn't ok makes the exit code 1, so a deploy pipeline stops
          const production = !!v.production || checks.productionInstance(url);
          const list = await checks.instanceChecks(rpId, { production });
          const prod = list.filter((c) => c.group === 'production');
          if (prod.length) {
            out(`Production readiness (${prod.filter((c) => c.level === 'ok').length} of ${prod.length} ready)\n`);
            for (const c of prod) out(`${c.level.toUpperCase().padEnd(7)}  ${c.title}\n         ${c.detail}\n`);
            out('\nLockout checks\n');
          }
          for (const c of list.filter((x) => x.group !== 'production')) out(`${c.level.toUpperCase().padEnd(7)}  ${c.title}\n         ${c.detail}\n`);
          if (!rpId) out('(passkey domain not checked: set PUBLIC_URL or pass --url)\n');
          return checks.attention(list) ? EXIT.differences : EXIT.ok;
        }
        throw new UsageError(`unknown action ${action}: use reset-2fa, set-2fa-policy, builder-sign-in, rotate-key, key-backed-up or check`);
      } finally {
        await closePools();
      }
    },
  },
};

// ------------------------------------------------------------------ help and dispatch

const GLOBAL_HELP = [
  ['--db <url>', 'database connection of the owner role (default: DATABASE_URL, from the environment or .env)'],
  ['-h, --help', 'help (also after a command)'],
  ['-v, --version', 'the pgkiln version'],
];

const table = (rows: string[][]) => {
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map((r) => `  ${r[0].padEnd(w)}  ${r[1]}`).join('\n') + '\n';
};

function mainHelp() {
  return (
    'pgkiln: command line for pgkiln, a low-code application builder for PostgreSQL\n\n' +
    'Usage: pgkiln <command> [options]\n\nCommands:\n' +
    table(Object.entries(COMMANDS).map(([name, c]) => [name, c.summary])) +
    '\nOptions:\n' +
    table(GLOBAL_HELP) +
    '\nExit codes: 0 ok, 1 differences found (diff), 2 usage error, 3 failure.\n' +
    "Run 'pgkiln <command> --help' for a command's options.\n"
  );
}

function commandHelp(c: Command) {
  return `Usage: ${c.usage}\n\n${c.summary[0].toUpperCase()}${c.summary.slice(1)}.\n${c.details ? `\n${c.details}\n` : ''}` +
    (c.optionHelp.length ? `\nOptions:\n${table(c.optionHelp)}` : '') + `\nGlobal options:\n${table(GLOBAL_HELP)}`;
}

const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    if (name === 'help' && rest[0] && COMMANDS[rest[0]]) out(commandHelp(COMMANDS[rest[0]]));
    else (name ? out : err)(mainHelp());
    return name ? EXIT.ok : EXIT.usage;
  }
  if (name === '-v' || name === '--version') {
    out(`pgkiln ${version()}\n`);
    return EXIT.ok;
  }
  const cmd = COMMANDS[name];
  try {
    if (!cmd) throw new UsageError(`unknown command ${name}`);
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...cmd.options, db: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      out(commandHelp(cmd));
      return EXIT.ok;
    }
    const [min, max] = cmd.positionals;
    if (positionals.length < min || positionals.length > max) throw new UsageError(`wrong number of arguments\nUsage: ${cmd.usage}`);
    if (values.db) process.env.DATABASE_URL = values.db as string;
    return await cmd.run(values as Values, positionals);
  } catch (e) {
    const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    err(`pgkiln${cmd ? ' ' + name : ''}: ${(e as Error).message}\n`);
    if (usage) err(`Run 'pgkiln ${cmd ? name + ' ' : ''}--help' for usage.\n`);
    return usage ? EXIT.usage : EXIT.failure;
  }
}

// run when executed directly (not when imported by a test)
const invoked = process.argv[1] && resolve(process.argv[1]);
if (invoked?.endsWith(join('src', 'cli', 'main.ts'))) {
  process.exitCode = await main(process.argv.slice(2));
}
