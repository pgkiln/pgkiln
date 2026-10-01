// pgapex command line: migrations, application export/import (JSON or one
// file per component), diff, and a few account helpers. See docs/guide/18-cli.md.
//
//   npx tsx src/cli/main.ts <command> …   or   npm run pgapex -- <command> …
//
// Exit codes: 0 ok, 1 differences found (diff), 2 usage error, 3 failure.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { root } from '../env.ts';
import { docToFiles, filesToDoc, stableJson, type Doc, type FileMap } from '../appfiles.ts';

export const EXIT = { ok: 0, differences: 1, usage: 2, failure: 3 } as const;

class UsageError extends Error {}

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

// ------------------------------------------------------------------ database

async function connect() {
  const { default: pg } = await import('pg');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (use --db, the environment or .env)');
  // dates as Postgres sends them, like the server (src/db.ts)
  for (const oid of [1082, 1114, 1184, 1083, 1266]) pg.types.setTypeParser(oid, (v: string) => v);
  const client = new pg.Client({ connectionString: url, application_name: 'pgapex-cli' });
  await client.connect();
  return client;
}

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof connect>>) => Promise<T>) {
  const db = await connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function exportDoc(db: Awaited<ReturnType<typeof connect>>, alias: string): Promise<Doc> {
  const r = await db.query('select meta.export_app($1) as doc', [alias]);
  if (!r.rows[0]?.doc) throw new Error(`application ${alias} not found (pgapex apps lists them)`);
  return r.rows[0].doc;
}

/** A JSON export, an application directory or a .zip of one. */
async function readSource(path: string): Promise<{ doc: Doc; files?: FileMap }> {
  if (!existsSync(path)) throw new UsageError(`${path} not found`);
  const { readDir, readZip } = await import('./files.ts');
  if (statSync(path).isDirectory()) {
    const files = readDir(path);
    return { doc: filesToDoc(files), files };
  }
  const buf = readFileSync(path);
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const files = readZip(buf);
    return { doc: filesToDoc(files), files };
  }
  try {
    return { doc: JSON.parse(buf.toString('utf8')) };
  } catch (e) {
    throw new Error(`${path}: not a JSON export, a directory or a .zip (${(e as Error).message})`);
  }
}

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

// ------------------------------------------------------------------ commands

const COMMANDS: Record<string, Command> = {
  migrate: {
    usage: 'pgapex migrate [--example <name>]',
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
    usage: 'pgapex apps [--json]',
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

  export: {
    usage: 'pgapex export <alias> [--format json|dir] [--out <path>]',
    summary: 'export an application as one JSON file or as a directory with a file per component',
    details:
      'json (default) writes the pgapex/2 document (sorted keys) to --out or standard output.\n' +
      'dir writes a directory (default ./<alias>): files that are no longer part of the application\n' +
      'are removed, dot files (.git) are left alone; a non-empty directory without pgapex.json is refused.',
    options: { format: { type: 'string', short: 'f', default: 'json' }, out: { type: 'string', short: 'o' } },
    optionHelp: [
      ['-f, --format json|dir', 'output format (default json)'],
      ['-o, --out <path>', 'file (json) or directory (dir)'],
    ],
    positionals: [1, 1],
    async run(v, [alias]) {
      if (v.format !== 'json' && v.format !== 'dir') throw new UsageError(`unknown format ${v.format}: use json or dir`);
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
      const files = docToFiles(doc);
      const r = writeDir(dir, files);
      err(`Exported ${alias} to ${dir}/ (${files.size} files; ${r.written} written, ${r.removed} removed).\n`);
      return EXIT.ok;
    },
  },

  import: {
    usage: 'pgapex import <path> [--alias <alias>] [--replace]',
    summary: 'import a JSON export, an application directory or a .zip of one',
    details:
      'Without --replace the alias must be free. With --replace an existing application with that\n' +
      'alias is updated in place: it keeps its id, users and access, API clients, sessions, saved\n' +
      'reports, running tasks and workflows, and the on/off switch of its automations; its pages,\n' +
      'shared components and settings become those of the file. Without an existing application\n' +
      '--replace simply imports.',
    options: { alias: { type: 'string', short: 'a' }, replace: { type: 'boolean' } },
    optionHelp: [
      ['-a, --alias <alias>', 'alias of the application (default: the one in the export)'],
      ['--replace', 'update the application with that alias in place'],
    ],
    positionals: [1, 1],
    async run(v, [path]) {
      const { doc } = await readSource(path);
      const alias = (v.alias as string) ?? doc?.app?.alias;
      if (!alias) throw new Error('the export has no alias: use --alias');
      return withDb(async (db) => {
        await db.query('begin');
        try {
          const exists = (await db.query('select id from meta.app where alias = $1', [alias])).rows[0];
          let id: number;
          if (exists && !v.replace) throw new UsageError(`application ${alias} exists: use --replace to update it, or --alias for a copy`);
          if (exists) {
            const { replaceApp } = await import('./replace.ts');
            id = await replaceApp(db, doc, alias);
          } else id = (await db.query('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), alias])).rows[0].id;
          await db.query('commit');
          out(exists
            ? `Replaced ${alias} (application ${id}).\n`
            : `Imported ${alias} (application ${id}). Check its database role and grant access in the builder.\n`);
          return EXIT.ok;
        } catch (e) {
          await db.query('rollback').catch(() => {});
          throw e;
        }
      });
    },
  },

  diff: {
    usage: 'pgapex diff <alias> <path> [--name-only | --quiet]',
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
      const ours = docToFiles(await withDb((db) => exportDoc(db, alias)));
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

  users: {
    usage: 'pgapex users list|add|password [<username>] [options]',
    summary: 'list accounts and builder developers, add one, set a password',
    details:
      'pgapex users list [--developers]\n' +
      'pgapex users add <username> [--developer] [--app <alias> --roles a,b] [--name <display name>] [--email <address>]\n' +
      'pgapex users password <username> [--developer]\n\n' +
      'Passwords are read from standard input (first line) or asked for on a terminal, never\n' +
      'taken from the command line, and must meet the password policy. Setting a password ends\n' +
      "the user's sessions.",
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
};

// ------------------------------------------------------------------ help and dispatch

const GLOBAL_HELP = [
  ['--db <url>', 'database connection of the owner role (default: DATABASE_URL, from the environment or .env)'],
  ['-h, --help', 'help (also after a command)'],
  ['-v, --version', 'the pgapex version'],
];

const table = (rows: string[][]) => {
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map((r) => `  ${r[0].padEnd(w)}  ${r[1]}`).join('\n') + '\n';
};

function mainHelp() {
  return (
    'pgapex: command line for pgapex, a low-code application builder for PostgreSQL\n\n' +
    'Usage: pgapex <command> [options]\n\nCommands:\n' +
    table(Object.entries(COMMANDS).map(([name, c]) => [name, c.summary])) +
    '\nOptions:\n' +
    table(GLOBAL_HELP) +
    '\nExit codes: 0 ok, 1 differences found (diff), 2 usage error, 3 failure.\n' +
    "Run 'pgapex <command> --help' for a command's options.\n"
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
    out(`pgapex ${version()}\n`);
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
    err(`pgapex${cmd ? ' ' + name : ''}: ${(e as Error).message}\n`);
    if (usage) err(`Run 'pgapex ${cmd ? name + ' ' : ''}--help' for usage.\n`);
    return usage ? EXIT.usage : EXIT.failure;
  }
}

// run when executed directly (not when imported by a test)
const invoked = process.argv[1] && resolve(process.argv[1]);
if (invoked?.endsWith(join('src', 'cli', 'main.ts'))) {
  process.exitCode = await main(process.argv.slice(2));
}
