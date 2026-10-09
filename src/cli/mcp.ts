// `pgkiln mcp`: a Model Context Protocol server on standard input/output, so
// an AI coding agent (Claude Code, Cursor, …) can find an application, read
// its pages and shared components, look at the database it runs on, search
// the user guide, and export, compare and import the application as files.
// See docs/guide/20-ai-agents.md.
//
// The protocol is JSON-RPC 2.0, one message per line. Standard output carries
// only protocol messages; diagnostics go to standard error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { root } from '../env.ts';
import { docToFiles, stableJson, type FileMap } from '../appfiles.ts';
import { exportDoc, importDoc, readSource, withDb, type Db } from './apps.ts';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** Cap on the text one tool call returns, so a large application does not flood the agent's context. */
const MAX_TEXT = 200_000;
const QUERY_TIMEOUT = '10s';

const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

const INSTRUCTIONS = `pgkiln is a low-code application builder for PostgreSQL (like Oracle APEX): an application is data,
rows in the meta schema (pages, regions, items, buttons, dynamic actions, validations, processes, shared components).
To understand an application: list_apps, then app_overview, then get_page or read_app_files.
Files are shown in the "text" style: one YAML file per component, SQL and templates inline.
To change an application: export_app writes it to a directory (default apps/<alias>), edit the files there,
diff_app shows what an import would change, and import_app with replace=true applies it in one transaction.
The application's tables, views and functions are ordinary PostgreSQL objects (describe_schema, run_query);
schema changes belong in the user's own migration scripts, not in the application files.
search_docs searches the pgkiln user guide; read it before guessing a property name or a region type.`;

// ------------------------------------------------------------------ helpers

type Args = Record<string, unknown>;
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: Args): Promise<string>;
};

class ToolError extends Error {}

const str = (a: Args, name: string, required = false): string | undefined => {
  const v = a[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`${name} must be a string`);
  return v;
};
const int = (a: Args, name: string, dflt: number, max: number) => {
  const v = a[name] ?? dflt;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new ToolError(`${name} must be a positive whole number`);
  return Math.min(n, max);
};

function cap(s: string, max = MAX_TEXT) {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (cut off at ${max} characters: ask for less, e.g. one page or a prefix)`;
}

/** The application's files in the text style (YAML, code inline). */
const appFiles = async (db: Db, alias: string) => docToFiles(await exportDoc(db, alias), 'text');

const isBinary = (b: Buffer) => b.includes(0);

function showFiles(files: FileMap, paths: string[]) {
  return cap(
    paths
      .map((p) => {
        const b = files.get(p)!;
        return `=== ${p}\n${isBinary(b) ? `(binary file, ${b.length} bytes)\n` : b.toString('utf8')}`;
      })
      .join('\n'),
  );
}

const table = (rows: Record<string, unknown>[]) => (rows.length ? stableJson(rows) : '(none)\n');

// ------------------------------------------------------------------ docs search

type Section = { file: string; heading: string; text: string };
let sections: Section[] | undefined;

function docSections(): Section[] {
  if (sections) return sections;
  const files = [
    ...readdirSync(join(root, 'docs', 'guide')).filter((f) => f.endsWith('.md')).map((f) => `docs/guide/${f}`),
    'docs/apex-feature-parity.md',
    'SECURITY.md',
  ].filter((f) => existsSync(join(root, f)));
  sections = [];
  for (const file of files) {
    let current: Section = { file, heading: '', text: '' };
    let fence = false;
    for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
      if (line.startsWith('```')) fence = !fence;
      const m = !fence && /^#{1,4}\s+(.*)$/.exec(line);
      if (m) {
        if (current.text.trim()) sections.push(current);
        current = { file, heading: m[1].trim(), text: '' };
      }
      current.text += line + '\n';
    }
    if (current.text.trim()) sections.push(current);
  }
  return sections;
}

export function searchDocs(query: string, max: number) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) throw new ToolError('query needs at least one word');
  const scored = docSections()
    .map((s) => {
      const body = s.text.toLowerCase();
      const head = s.heading.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const n = body.split(t).length - 1;
        if (!n) return { s, score: 0 };
        score += Math.min(n, 10) + (head.includes(t) ? 10 : 0);
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  if (!scored.length) return `No section of the user guide mentions all of: ${terms.join(', ')}.\n`;
  return cap(scored.map(({ s }) => `=== ${s.file} → ${s.heading || '(top)'}\n${cap(s.text.trim(), 4000)}\n`).join('\n'));
}

// ------------------------------------------------------------------ read-only SQL

/** Column names whose values run_query never shows (password hashes, tokens, secrets). */
const SENSITIVE = /password|secret|token|hash|private_key|api_key|client_secret/i;

export async function readOnlyQuery(db: Db, sql: string, maxRows: number) {
  // the select takes a snapshot, after which "set transaction read write" is refused
  await db.query(`begin transaction read only; set local statement_timeout = '${QUERY_TIMEOUT}'; select 1`);
  try {
    // the extended protocol runs exactly one statement, so a "commit; delete …"
    // cannot end the read-only transaction and go on (pg would use the simple
    // protocol, which runs them all, for a query without parameters)
    const r = await db.query({ text: sql, rowMode: 'array', queryMode: 'extended' } as any);
    const columns: string[] = (r.fields ?? []).map((f: { name: string }) => f.name);
    const rows = (r.rows ?? []).slice(0, maxRows).map((row: unknown[]) =>
      Object.fromEntries(
        columns.map((c, i) => {
          let v = row[i];
          if (v !== null && SENSITIVE.test(c)) v = '(hidden)';
          else if (Buffer.isBuffer(v)) v = `(binary, ${v.length} bytes)`;
          else if (typeof v === 'string' && v.length > 2000) v = v.slice(0, 2000) + '…';
          return [c, v];
        }),
      ),
    );
    return { command: r.command, rowCount: r.rowCount, shown: rows.length, columns, rows };
  } finally {
    await db.query('rollback').catch(() => {});
  }
}

// ------------------------------------------------------------------ tools

const aliasProp = { alias: { type: 'string', description: 'the application alias (list_apps shows them)' } };

export const TOOLS: Tool[] = [
  {
    name: 'pgkiln_info',
    title: 'pgkiln installation',
    description: 'The pgkiln version, the database, the applied migrations, and where the user guide is. Call this first to check the connection.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () =>
      withDb(async (db) => {
        const r = (
          await db.query(
            `select current_database() as database, current_user as role, split_part(version(), ' ', 2) as postgres,
                    (select count(*)::int from meta.app) as applications,
                    (select max(name) from public.pgkiln_migration) as last_migration`,
          )
        ).rows[0];
        return stableJson({
          pgkiln: version(),
          ...r,
          checkout: root,
          user_guide: join(root, 'docs', 'README.md'),
          builder: `http://127.0.0.1:${process.env.PORT ?? 3100}/builder`,
        });
      }),
  },
  {
    name: 'list_apps',
    title: 'List applications',
    description: 'The applications in this pgkiln database: id, alias, name, number of pages.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () =>
      withDb(async (db) =>
        table(
          (
            await db.query(
              `select a.id, a.alias, a.name, (select count(*)::int from meta.page p where p.app_id = a.id) as pages
                 from meta.app a order by a.alias`,
            )
          ).rows,
        ),
      ),
  },
  {
    name: 'app_overview',
    title: 'Application overview',
    description:
      "An application's settings (app.yaml), its pages (number, name, mode, number of components) and the paths of all its component files, " +
      'to pick what to read next with get_page or read_app_files.',
    inputSchema: { type: 'object', properties: aliasProp, required: ['alias'] },
    annotations: { readOnlyHint: true },
    async run(a) {
      const alias = str(a, 'alias', true)!;
      return withDb(async (db) => {
        const files = await appFiles(db, alias);
        const pages = (
          await db.query(
            `select p.page_no, p.name, p.mode, p.authz as authorization,
                    (select count(*)::int from meta.region r where r.page_id = p.id) as regions,
                    (select count(*)::int from meta.item i where i.page_id = p.id) as items,
                    (select count(*)::int from meta.process x where x.page_id = p.id) as processes
               from meta.page p join meta.app a on a.id = p.app_id where a.alias = $1 order by p.page_no`,
            [alias],
          )
        ).rows;
        return cap(
          `=== app.yaml\n${files.get('app.yaml')?.toString('utf8') ?? ''}\n=== pages\n${table(pages)}\n=== files (${files.size})\n${[...files.keys()].sort().join('\n')}\n`,
        );
      });
    },
  },
  {
    name: 'get_page',
    title: 'Read a page',
    description: 'Every component of one page (page settings, regions with their SQL, items, buttons, dynamic actions, validations, processes, computations, branches) as YAML files.',
    inputSchema: {
      type: 'object',
      properties: { ...aliasProp, page: { type: 'integer', description: 'the page number' } },
      required: ['alias', 'page'],
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const alias = str(a, 'alias', true)!;
      const page = int(a, 'page', 0, 1e9);
      return withDb(async (db) => {
        const files = await appFiles(db, alias);
        const re = new RegExp(`^pages/0*${page}-[^/]*/`);
        const paths = [...files.keys()].filter((p) => re.test(p)).sort((x, y) => (x.endsWith('/page.yaml') ? -1 : y.endsWith('/page.yaml') ? 1 : x < y ? -1 : 1));
        if (!paths.length) throw new ToolError(`application ${alias} has no page ${page}`);
        return showFiles(files, paths);
      });
    },
  },
  {
    name: 'read_app_files',
    title: 'Read application files',
    description:
      'Component files of an application as YAML (the paths app_overview lists), by exact paths and/or a path prefix ' +
      '(e.g. "shared/lovs/", "shared/", "navigation.yaml", "globalization/").',
    inputSchema: {
      type: 'object',
      properties: {
        ...aliasProp,
        paths: { type: 'array', items: { type: 'string' }, description: 'exact file paths' },
        prefix: { type: 'string', description: 'every file whose path starts with this' },
      },
      required: ['alias'],
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const alias = str(a, 'alias', true)!;
      const prefix = str(a, 'prefix');
      const wanted = Array.isArray(a.paths) ? a.paths.map(String) : [];
      if (!prefix && !wanted.length) throw new ToolError('give paths or a prefix');
      return withDb(async (db) => {
        const files = await appFiles(db, alias);
        const missing = wanted.filter((p) => !files.has(p));
        if (missing.length) throw new ToolError(`no such file(s): ${missing.join(', ')} (app_overview lists the paths)`);
        const paths = [...new Set([...wanted, ...(prefix ? [...files.keys()].filter((p) => p.startsWith(prefix)).sort() : [])])];
        if (!paths.length) throw new ToolError(`no file starts with ${prefix}`);
        return showFiles(files, paths);
      });
    },
  },
  {
    name: 'export_app',
    title: 'Export an application to files',
    description:
      'Writes the application to a directory on disk, one file per component, so you can edit it with your file tools. ' +
      'format "text" (default) writes YAML with the code inline, "dir" JSON with code in .sql files, "json" one JSON file. ' +
      'An existing export directory is updated (files of deleted components are removed); any other non-empty directory is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        ...aliasProp,
        path: { type: 'string', description: 'target directory (or file for json), relative to the working directory; default apps/<alias>' },
        format: { type: 'string', enum: ['text', 'dir', 'json'] },
      },
      required: ['alias'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(a) {
      const alias = str(a, 'alias', true)!;
      const format = str(a, 'format') ?? 'text';
      if (!['text', 'dir', 'json'].includes(format)) throw new ToolError('format is text, dir or json');
      const doc = await withDb((db) => exportDoc(db, alias));
      if (format === 'json') {
        const file = resolve(str(a, 'path') ?? `${alias}.pgkiln.json`);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, stableJson(doc));
        return `Exported ${alias} to ${file}.\n`;
      }
      const dir = resolve(str(a, 'path') ?? join('apps', alias));
      const { writeDir } = await import('./files.ts');
      const files = docToFiles(doc, format === 'text' ? 'text' : 'json');
      const r = writeDir(dir, files);
      return `Exported ${alias} to ${dir}/ (${files.size} files; ${r.written} written, ${r.removed} removed).\nEdit the files, then diff_app and import_app with replace=true.\n`;
    },
  },
  {
    name: 'diff_app',
    title: 'Compare files with the database',
    description:
      'What differs between the application in the database and an export directory, zip or JSON file: ' +
      'A = only in the files (an import adds it), D = only in the database (an import with replace removes it), M = changed, with a unified diff. ' +
      'It also checks that the files can be read (a broken YAML file or a reference to a missing region is reported).',
    inputSchema: {
      type: 'object',
      properties: { ...aliasProp, path: { type: 'string', description: 'the export directory, .zip or .json; default apps/<alias>' } },
      required: ['alias'],
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const alias = str(a, 'alias', true)!;
      const path = resolve(str(a, 'path') ?? join('apps', alias));
      const { compareFiles, unifiedDiff } = await import('./diff.ts');
      const source = await readSource(path);
      const theirs = source.files ?? docToFiles(source.doc);
      const style = [...theirs.keys()].some((p) => p.endsWith('.yaml')) ? 'text' : 'json';
      const ours = docToFiles(await withDb((db) => exportDoc(db, alias)), style);
      const changes = compareFiles(ours, theirs);
      if (!changes.length) return 'No differences.\n';
      return cap(
        changes.map((c) => `${c.status} ${c.path}\n${c.status === 'M' ? unifiedDiff(c.path, ours.get(c.path), theirs.get(c.path)) : ''}`).join('') +
          `${changes.length} file(s) differ.\n`,
      );
    },
  },
  {
    name: 'import_app',
    title: 'Import an application',
    description:
      'Imports an export directory, zip or JSON file. Without replace the alias must be free (a new application). ' +
      'With replace=true the application with that alias is updated in place in one transaction: its pages, shared components and settings ' +
      'become those of the files; its id, users and access, sessions, saved reports and running workflows are kept. ' +
      'Supporting object scripts and plug-in install SQL are never run. Run diff_app first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the export directory, .zip or .json; default apps/<alias>' },
        alias: { type: 'string', description: 'the alias to import as (default: the one in the files)' },
        replace: { type: 'boolean', description: 'update the existing application with this alias' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(a) {
      const given = str(a, 'path');
      const aliasArg = str(a, 'alias');
      if (!given && !aliasArg) throw new ToolError('give a path (or an alias to read apps/<alias>)');
      const path = resolve(given ?? join('apps', aliasArg!));
      const { doc } = await readSource(path);
      const alias = aliasArg ?? doc?.app?.alias;
      if (!alias) throw new ToolError('the export has no alias: give one');
      const r = await withDb((db) => importDoc(db, doc, { alias, replace: a.replace === true }));
      return (
        (r.replaced ? `Replaced ${alias} (application ${r.id}).\n` : `Imported ${alias} (application ${r.id}). Its database role and who may sign in are set in the builder.\n`) +
        (r.scripts ? `It has ${r.scripts} supporting object script(s); they were not run.\n` : '')
      );
    },
  },
  {
    name: 'describe_schema',
    title: 'Describe database objects',
    description:
      'Without a table: the schemas with their tables, views and functions (pgkiln\'s own meta schema is left out unless you ask for it). ' +
      'With a table or view: its columns, constraints, indexes, row level security policies and triggers.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'only this schema' },
        table: { type: 'string', description: 'a table or view, e.g. sales.orders' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const schema = str(a, 'schema');
      const tbl = str(a, 'table');
      return withDb(async (db) => {
        if (tbl) {
          const rel = (await db.query(`select to_regclass($1)::oid as oid`, [tbl])).rows[0]?.oid;
          if (!rel) throw new ToolError(`no table or view ${tbl}`);
          const q = async (sql: string) => (await db.query(sql, [rel])).rows;
          const [info] = await q(
            `select c.oid::regclass::text as name, case c.relkind when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view' when 'm' then 'materialized view' else c.relkind::text end as kind,
                    c.relrowsecurity as rls, obj_description(c.oid, 'pg_class') as comment,
                    case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end as definition
               from pg_class c where c.oid = $1`,
          );
          const columns = await q(
            `select a.attname as column, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
                    pg_get_expr(d.adbin, d.adrelid) as "default", col_description(a.attrelid, a.attnum) as comment
               from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
          );
          const constraints = await q(`select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = $1 order by contype, conname`);
          const indexes = await q(`select indexrelid::regclass::text as name, pg_get_indexdef(indexrelid) as definition from pg_index where indrelid = $1 order by 1`);
          const policies = await q(
            `select polname as name, case polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end as command,
                    pg_get_expr(polqual, polrelid) as using, pg_get_expr(polwithcheck, polrelid) as with_check
               from pg_policy where polrelid = $1 order by polname`,
          );
          const triggers = await q(`select tgname as name, pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid = $1 and not tgisinternal order by tgname`);
          return cap(stableJson({ ...info, columns, constraints, indexes, policies, triggers }));
        }
        const rows = (
          await db.query(
            `select n.nspname as schema, c.relname as name,
                    case c.relkind when 'v' then 'view' when 'm' then 'view' else 'table' end as kind, c.relrowsecurity as rls
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
                and (n.nspname = $1 or ($1 is null and n.nspname <> 'meta'))
             union all
             select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', case p.prokind when 'p' then 'procedure' else 'function' end, false
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where p.prokind in ('f', 'p') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
                and (n.nspname = $1 or ($1 is null and n.nspname <> 'meta'))
                and not exists (select from pg_depend d where d.objid = p.oid and d.deptype = 'e')
              order by 1, 3 desc, 2`,
            [schema ?? null],
          )
        ).rows;
        if (!rows.length) return schema ? `Schema ${schema} has no tables, views or functions.\n` : 'No tables, views or functions outside pgkiln.\n';
        const out: string[] = [];
        let last = '';
        for (const r of rows) {
          if (r.schema !== last) out.push(`\n${(last = r.schema)}`);
          out.push(`  ${r.kind.padEnd(9)} ${r.name}${r.rls ? '  (RLS)' : ''}`);
        }
        return cap(out.join('\n').trimStart() + '\n');
      });
    },
  },
  {
    name: 'run_query',
    title: 'Run a read-only query',
    description:
      `Runs one SQL statement in a read-only transaction (rolled back, ${QUERY_TIMEOUT} timeout) and returns the rows as JSON. ` +
      'Use it to look at data and at the meta schema; it cannot change anything. Values of columns named like password, secret, token or hash are hidden. ' +
      'Bind variables (:P1_X) are not replaced: use literals.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' }, max_rows: { type: 'integer', description: 'default 50, at most 500' } },
      required: ['sql'],
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const sql = str(a, 'sql', true)!;
      const max = int(a, 'max_rows', 50, 500);
      return withDb(async (db) => cap(stableJson(await readOnlyQuery(db, sql, max))));
    },
  },
  {
    name: 'search_docs',
    title: 'Search the user guide',
    description: 'Searches the pgkiln user guide (docs/guide), the APEX parity matrix and SECURITY.md; returns the best matching sections.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'words that must all occur, e.g. "cascading lov"' }, max_results: { type: 'integer', description: 'default 5' } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
    run: async (a) => searchDocs(str(a, 'query', true)!, int(a, 'max_results', 5, 20)),
  },
  {
    name: 'recent_errors',
    title: 'Recent runtime errors',
    description: 'The latest errors and refused requests from the activity log (what a user saw go wrong), optionally of one application.',
    inputSchema: {
      type: 'object',
      properties: { alias: { type: 'string' }, limit: { type: 'integer', description: 'default 20, at most 200' } },
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const alias = str(a, 'alias');
      const limit = int(a, 'limit', 20, 200);
      return withDb(async (db) =>
        table(
          (
            await db.query(
              `select l.at, a.alias, l.page_no as page, l.username, l.event, l.detail
                 from meta.activity_log l left join meta.app a on a.id = l.app_id
                where l.event in ('error', 'forbidden') and ($1::text is null or a.alias = $1)
                order by l.at desc limit $2`,
              [alias ?? null, limit],
            )
          ).rows,
        ),
      );
    },
  },
];

// ------------------------------------------------------------------ protocol

type Message = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any };

export async function handle(msg: Message): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  const notification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'pgkiln', title: 'pgkiln', version: version() },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ run: _run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${msg.params?.name}`);
      try {
        const text = await tool.run((msg.params?.arguments ?? {}) as Args);
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        // a tool error goes back to the agent as a result, so it can correct itself
        return reply({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return notification ? undefined : fail(-32601, `method ${msg.method} not supported`);
  }
}

export async function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  process.stderr.write(`pgkiln ${version()} MCP server on standard input/output\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<unknown>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Message;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      continue;
    }
    // requests run concurrently; each answer is one line
    const p: Promise<unknown> = handle(msg)
      .then((r) => {
        if (r) output.write(JSON.stringify(r) + '\n');
      })
      .catch((e) => process.stderr.write(`pgkiln mcp: ${(e as Error).message}\n`))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}
