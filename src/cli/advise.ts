// (sprint 144, AP-10; APEX 26.2: APEXlang static analysis with SQLcl CodeScan) `pgkiln advise`: the builder's
// Advisor from the command line, for CI. An export (directory, .zip or JSON) is imported into a transaction that is
// always rolled back and checked there, like `pgkiln import --dry-run`; an application already in the database is
// checked in place (also rolled back). Every SQL fragment is planned as the application's role, references are
// followed, and the security defaults are checked (src/builder/advisor.ts). The findings come out as text, JSON or
// SARIF 2.1.0 (GitHub code scanning annotates pull requests with it); each one points at the export's file of its
// page or component when there is one.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { docToFiles, slug, type FileMap } from '../appfiles.ts';
import { exportDoc, importDoc, readSource, UsageError, type Db } from './apps.ts';
import type { Finding } from '../builder/advisor.ts';

export type Severity = 'error' | 'warning' | 'info';
export const SEVERITIES: Severity[] = ['error', 'warning', 'info'];

export interface AdviseFinding {
  severity: Severity;
  /** e.g. "page 3, region Employees", or "application" */
  where: string;
  field: string;
  message: string;
  /** the component's kind (region, item, lov …), for the SARIF rule, and its name */
  kind: string | null;
  label: string;
  pageNo: number | null;
  /** the export's file of the component (relative to the export's directory), when it has one */
  file: string | null;
}

export interface AdviseResult {
  alias: string;
  /** where the files are, for the paths in the output: the export's directory (or null for an application) */
  dir: string | null;
  checked: number;
  findings: AdviseFinding[];
  /** (sprint 147) checked from the files alone, without a database */
  offline?: boolean;
}

const pad = (n: number) => String(n).padStart(4, '0');
const stem = (path: string) => (path.split('/').pop() ?? '').replace(/\.[a-z]+$/, '').replace(/^\d{4}-/, '');

/** The export's file of a component: its page's folder and its slug, a shared component by its slug, else the page or app file. */
export function fileOf(files: string[], f: { pageNo: number | null; kind: string | null; label: string }): string | null {
  const yaml = files.filter((p) => /\.(ya?ml|json)$/.test(p));
  const name = slug(f.kind === 'page' ? '' : f.label);
  if (f.pageNo !== null) {
    const dir = yaml.filter((p) => p.startsWith(`pages/${pad(f.pageNo!)}-`));
    if (!dir.length) return null;
    const own = name ? dir.find((p) => !/\/page\.(ya?ml|json)$/.test(p) && stem(p) === name) : undefined;
    return own ?? dir.find((p) => /\/page\.(ya?ml|json)$/.test(p)) ?? dir[0];
  }
  const shared = name ? yaml.find((p) => p.startsWith('shared/') && stem(p) === name) : undefined;
  return shared ?? yaml.find((p) => /^app\.(ya?ml|json)$/.test(p)) ?? null;
}

/** An Advisor finding as the report's: where, the component's kind and page. */
function toAdvise(f: Finding): AdviseFinding {
  const kind = f.entry?.kind ?? null;
  const pageNo = f.entry?.pageNo ?? (/^Page (\d+)\b/.exec(f.field) ? Number(/^Page (\d+)\b/.exec(f.field)![1]) : null);
  return {
    severity: f.severity,
    where: f.entry ? (kind === 'page' ? f.entry.label : `${f.entry.pageNo !== null ? `page ${f.entry.pageNo}, ` : ''}${f.entry.kindLabel.toLowerCase()} ${f.entry.label}`) : pageNo !== null ? `page ${pageNo}` : 'application',
    field: f.field,
    message: f.message,
    kind,
    label: f.entry?.label ?? '',
    pageNo,
    file: null,
  };
}

/**
 * (sprint 147) Check an export's files alone, with no database: references, the login page and page groups, the
 * pages' security defaults, workflow steps, process settings and JSON source profiles (adviseDoc). SQL is not
 * planned and nothing is read from a catalog; the report says so.
 */
export async function adviseOffline(target: string): Promise<AdviseResult> {
  if (!existsSync(target)) throw new UsageError(`${target} not found (--offline checks an export: a directory, a .zip or a JSON file)`);
  const { adviseDoc } = await import('../builder/advisor.ts');
  const source = await readSource(target);
  const files = source.files ?? docToFiles(source.doc);
  const r = await adviseDoc(source.doc);
  const findings = r.findings.map(toAdvise);
  const paths = [...files.keys()];
  for (const f of findings) f.file = fileOf(paths, f);
  return { alias: String(source.doc?.app?.alias ?? 'app'), dir: source.files ? target : null, checked: 0, findings, offline: true };
}

/**
 * Check an export (path) or an application in the database (alias). Nothing is ever committed: an export is
 * imported under a temporary alias in a transaction that is rolled back.
 */
export async function adviseTarget(db: Db, target: string): Promise<AdviseResult> {
  const { advise } = await import('../builder/advisor.ts');
  let files: FileMap;
  let dir: string | null = null;
  let alias: string;
  let id: number;
  let checked = 0;
  const findings: AdviseFinding[] = [];
  const collect = async (appId: number) => {
    const r = await advise(appId, db);
    checked = r.checked;
    for (const f of r.findings) findings.push(toAdvise(f));
  };
  if (existsSync(target)) {
    const source = await readSource(target);
    files = source.files ?? docToFiles(source.doc);
    dir = source.files ? target : null;
    alias = String(source.doc?.app?.alias ?? 'app');
    // a free alias for the check: the export's own may be taken by the application it came from
    const temp = `advise-${process.pid}-${Date.now().toString(36)}`.slice(0, 40);
    await db.query('begin');
    try {
      // (sprint 186) a file without a role checks as app_<alias> (made in this transaction, which is rolled back)
      const { importRole } = await import('../app-role.ts');
      await importRole(db, source.doc, { alias: temp });
      id = (await db.query('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(source.doc), temp])).rows[0].id;
      await collect(id);
    } finally {
      await db.query('rollback');
    }
  } else {
    if (/[/\\]|\.(json|zip)$/i.test(target)) throw new UsageError(`${target} not found`);
    alias = target;
    const row = (await db.query('select id from meta.app where alias = $1', [alias])).rows[0];
    if (!row) throw new UsageError(`application ${alias} not found (pgkiln apps lists them), and no file or directory ${alias} exists`);
    id = row.id;
    files = docToFiles(await exportDoc(db, alias), 'text');
    await db.query('begin');
    try {
      await collect(id);
    } finally {
      await db.query('rollback');
    }
  }
  const paths = [...files.keys()];
  for (const f of findings) f.file = fileOf(paths, f);
  return { alias, dir, checked, findings };
}

// ------------------------------------------------------------------ output

const order = (s: Severity) => SEVERITIES.indexOf(s);

/** Whether the findings fail the run: any at or above the level ("never": no). */
export function fails(findings: AdviseFinding[], failOn: Severity | 'never') {
  return failOn !== 'never' && findings.some((f) => order(f.severity) <= order(failOn));
}

/** A finding's path for the output: inside the export's directory, relative to the current directory. */
const pathOf = (r: AdviseResult, f: AdviseFinding, base: string | null) =>
  f.file === null ? null : base !== null ? join(base, f.file).replace(/\\/g, '/') : r.dir ? relative(process.cwd(), join(r.dir, f.file)).replace(/\\/g, '/') : f.file;

export function formatText(r: AdviseResult, base: string | null = null) {
  const count = (s: Severity) => r.findings.filter((f) => f.severity === s).length;
  return r.findings.map((f) => {
    const path = pathOf(r, f, base);
    return `${f.severity.toUpperCase().padEnd(7)} ${f.where}${f.field ? ` (${f.field})` : ''}: ${f.message}${path ? `\n        ${path}` : ''}\n`;
  }).join('') + `${r.alias}: ${r.offline ? 'checked offline (references and security; SQL not planned without a database)' : `${r.checked} SQL fragment(s) checked`}; ${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} note(s).\n`;
}

export function formatJson(r: AdviseResult, base: string | null = null) {
  return JSON.stringify({
    alias: r.alias,
    checked: r.checked,
    offline: !!r.offline,
    counts: Object.fromEntries(SEVERITIES.map((s) => [s, r.findings.filter((f) => f.severity === s).length])),
    findings: r.findings.map((f) => ({ severity: f.severity, where: f.where, field: f.field, message: f.message, page: f.pageNo, kind: f.kind, file: pathOf(r, f, base) })),
  }, null, 2) + '\n';
}

/** A finding's rule: the component kind and the field (stable across runs, so code scanning can track it). */
const ruleOf = (f: AdviseFinding) => `pgkiln/${f.kind ?? (f.pageNo !== null ? 'page' : 'application')}/${slug(f.field.replace(/^Page \d+ → /, '')) || 'check'}`;

/** SARIF 2.1.0 (GitHub code scanning, other CI tools): one result per finding, at its file when it has one. */
export function formatSarif(r: AdviseResult, version: string, base: string | null = null) {
  const level = { error: 'error', warning: 'warning', info: 'note' } as const;
  const rules = new Map<string, { id: string; shortDescription: { text: string } }>();
  const results = r.findings.map((f) => {
    const ruleId = ruleOf(f);
    if (!rules.has(ruleId)) rules.set(ruleId, { id: ruleId, shortDescription: { text: `${f.kind ?? 'application'}: ${f.field || 'check'}` } });
    const path = pathOf(r, f, base);
    return {
      ruleId,
      level: level[f.severity],
      message: { text: `${f.where}${f.field ? ` (${f.field})` : ''}: ${f.message}` },
      locations: [{
        ...(path ? { physicalLocation: { artifactLocation: { uri: path }, region: { startLine: 1 } } } : {}),
        logicalLocations: [{ name: f.where, kind: 'object' }],
      }],
    };
  });
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'pgkiln advise', version, informationUri: 'https://github.com/pgkiln/pgkiln', rules: [...rules.values()] } },
      results,
    }],
  }, null, 2) + '\n';
}
