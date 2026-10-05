// Working copies (APEX 24.1+: working copies and merge). A working copy is a
// second application made from the main application's export; meta.working_copy
// links them and keeps the *base*, the main application's export when the copy
// was made, last refreshed or last merged (migration 055).
//
// Comparing works on the one-file-per-component layout of src/appfiles.ts: the
// three exports (base, main, copy) become file maps, files are grouped into
// components (a region with its SQL file, a page's settings, a list of values,
// the navigation menu, …) and each component is compared three ways:
//   unchanged in both         → left out
//   changed only in the copy  → the copy's version wins
//   changed only in the main  → the main version stays
//   changed in both, the same → left out
//   changed in both, apart    → a conflict: the developer picks main or copy
// The result is turned back into an export document and imported over the
// target application with replaceApp() (src/cli/replace.ts), which keeps the
// installation's data (access, sessions, saved reports, secrets, …).
//
// Merge:   main := result, copy := result, base := main's new export.
// Refresh: copy := result (main's changes brought into the copy), base := main.
import { createHash } from 'node:crypto';
import { docToFiles, filesToDoc, slug, type Doc, type FileMap } from './appfiles.ts';
import { replaceApp } from './cli/replace.ts';
import { owner } from './db.ts';

export const NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

export interface WorkingCopy {
  app_id: number;
  main_app_id: number;
  name: string;
  created_by: string;
  created_at: string;
  refreshed_at: string | null;
  merged_at: string | null;
  merged_by: string | null;
}

type Files = Map<string, Buffer>;
export type Status = 'copy' | 'main' | 'conflict';

export interface Change {
  /** component id: normalised path without sequence prefixes and extensions */
  id: string;
  label: string;
  /** page number of a page component, else null */
  page: number | null;
  status: Status;
  /** per side: added, deleted or changed compared with the base (null: unchanged) */
  inMain: 'added' | 'deleted' | 'changed' | null;
  inCopy: 'added' | 'deleted' | 'changed' | null;
  base?: Files;
  main?: Files;
  copy?: Files;
}

// ------------------------------------------------------------------ components

/** Directories whose file names start with a sequence prefix (0010-, m0005-, none-). */
const SEQ_DIR = /^(pages\/[^/]+\/[^/]+|shared\/app-processes|shared\/automation-actions\/[^/]+)$/;
const SEQ = /^(m?\d{4,}|none)-/;

/** pages/0010-home/regions/… → pages/0010/regions/… (a renamed page keeps its components). */
const normalPath = (path: string) => path.replace(/^pages\/((?:m?\d{4,}|none))-[^/]*\//, 'pages/$1/');

/** The component a (normalised) file belongs to. */
export function componentOf(path: string) {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  let base = path.slice(slash + 1);
  base = base.slice(0, base.indexOf('.') < 0 ? base.length : base.indexOf('.'));
  if (SEQ_DIR.test(dir)) base = base.replace(SEQ, '');
  return dir ? `${dir}/${base}` : base;
}

const SECTION_LABELS: Record<string, string> = {
  'shared/authorizations': 'Authorization scheme',
  'shared/app-items': 'Application item',
  'shared/app-processes': 'Application process',
  'shared/lovs': 'List of values',
  'shared/report-layouts': 'Report layout',
  'shared/automations': 'Automation',
  'shared/document-templates': 'Document template',
  'shared/task-definitions': 'Task definition',
  'shared/workflow-definitions': 'Workflow',
  'shared/rest-modules': 'REST module',
  'shared/template-components': 'Template component',
  'shared/build-options': 'Build option',
  'shared/web-credentials': 'Web credential',
  'shared/rest-sources': 'REST data source',
  'shared/data-load-definitions': 'Data load definition',
  'shared/lists': 'List',
  'shared/supporting-objects': 'Supporting object',
  'globalization/translations': 'Translations',
  extra: 'Other section',
};
const PAGE_LABELS: Record<string, string> = {
  regions: 'region', items: 'item', buttons: 'button', 'dynamic-actions': 'dynamic action',
  validations: 'validation', processes: 'process', computations: 'computation', branches: 'branch',
};
const SINGLE_LABELS: Record<string, string> = {
  app: 'Application settings',
  pgapex: 'Export format',
  navigation: 'Navigation menu',
  'shared/group-roles': 'Group roles',
  'shared/list-entries': 'List entries',
  'globalization/text-messages': 'Text messages',
};

const pageNoOf = (seq: string) => (seq === 'none' ? null : seq.startsWith('m') ? -Number(seq.slice(1)) : Number(seq));

export function describe(id: string): { label: string; page: number | null } {
  const p = /^pages\/([^/]+)\/(?:page|([^/]+)\/(.+))$/.exec(id);
  if (p) {
    const page = pageNoOf(p[1]);
    return { page, label: p[2] ? `Page ${page} › ${PAGE_LABELS[p[2]] ?? p[2]} ${p[3]}` : `Page ${page}` };
  }
  if (SINGLE_LABELS[id]) return { label: SINGLE_LABELS[id], page: null };
  const a = /^shared\/automation-actions\/([^/]+)\/(.+)$/.exec(id);
  if (a) return { label: `Automation ${a[1]} › action ${a[2]}`, page: null };
  const slash = id.lastIndexOf('/');
  const section = SECTION_LABELS[id.slice(0, slash)];
  return { label: section ? `${section} ${id.slice(slash + 1)}` : id, page: null };
}

/** An export as components: id → (normalised path → contents). */
export function components(files: FileMap) {
  const out = new Map<string, Files>();
  for (const [path, buf] of files) {
    const p = normalPath(path);
    const id = componentOf(p);
    if (!out.has(id)) out.set(id, new Map());
    out.get(id)!.set(p, buf);
  }
  return out;
}

const same = (a: Files | undefined, b: Files | undefined) => {
  if (!a || !b) return !a && !b;
  if (a.size !== b.size) return false;
  for (const [p, buf] of a) if (!b.get(p)?.equals(buf)) return false;
  return true;
};
const how = (base: Files | undefined, side: Files | undefined) => (same(base, side) ? null : !base ? 'added' : !side ? 'deleted' : 'changed');

/**
 * What an application definition looks like for comparing: the main
 * application's alias, automations and synchronisations switched off (a copy
 * runs none; on merge the target keeps its own switches).
 */
export function normalDoc(doc: Doc, alias: string): Doc {
  const d = structuredClone(doc);
  d.app = { ...d.app, alias };
  for (const a of d.automations ?? []) a.enabled = false;
  for (const r of d.rest_sources ?? []) r.sync_enabled = false;
  return d;
}

/** The three-way comparison of base, main and copy (each already normalDoc'ed). */
export function compareDocs(base: Doc, main: Doc, copy: Doc): Change[] {
  const [b, m, c] = [base, main, copy].map((d) => components(docToFiles(d)));
  const changes: Change[] = [];
  for (const id of [...new Set([...b.keys(), ...m.keys(), ...c.keys()])].sort(byComponent)) {
    const B = b.get(id), M = m.get(id), C = c.get(id);
    if (same(M, C)) continue; // unchanged, or the same change on both sides
    const inMain = how(B, M), inCopy = how(B, C);
    const status: Status = !inMain ? 'copy' : !inCopy ? 'main' : 'conflict';
    changes.push({ id, ...describe(id), status, inMain, inCopy, base: B, main: M, copy: C });
  }
  return changes;
}

/** Application settings first, then shared components, then pages in order. */
function byComponent(a: string, b: string) {
  const rank = (id: string) => (id === 'pgapex' ? 0 : id === 'app' ? 1 : id.startsWith('pages/') ? 3 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) {
    const pa = describe(a).page ?? 0, pb = describe(b).page ?? 0;
    if (pa !== pb) return pa - pb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A fingerprint of a comparison: a merge form is refused when either side changed after it was shown. */
export function fingerprint(changes: Change[]) {
  const h = createHash('sha256');
  const add = (f?: Files) => {
    for (const p of [...(f?.keys() ?? [])].sort()) h.update(p).update('\0').update(f!.get(p)!).update('\0');
    h.update('\u0001');
  };
  for (const ch of changes) {
    h.update(ch.id).update('\0').update(ch.status).update('\0');
    add(ch.main);
    add(ch.copy);
  }
  return h.digest('hex').slice(0, 32);
}

/**
 * The merged definition: main's components, with the copy's version of
 * components changed only in the copy and of conflicts resolved for the copy.
 */
export function mergedDoc(main: Doc, changes: Change[], takeCopy: (ch: Change) => boolean): Doc {
  const files: FileMap = new Map([...docToFiles(main)].map(([p, b]) => [normalPath(p), b]));
  for (const ch of changes) {
    if (ch.status === 'main' || (ch.status === 'conflict' && !takeCopy(ch))) continue;
    for (const p of ch.main?.keys() ?? []) files.delete(p);
    for (const [p, buf] of ch.copy ?? []) files.set(p, buf);
  }
  return filesToDoc(files);
}

// ------------------------------------------------------------------ database

/** A client in a transaction, or the owner pool. */
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const exportApp = async (db: Db, alias: string): Promise<Doc> => (await db.query('select meta.export_app($1) as d', [alias])).rows[0].d;

export const copyOf = async (appId: number) =>
  owner.one<WorkingCopy>(
    `select app_id, main_app_id, name, created_by, created_at::text, refreshed_at::text, merged_at::text, merged_by
       from meta.working_copy where app_id = $1`,
    [appId],
  );

export const copiesOf = async (mainId: number) =>
  (
    await owner.query<WorkingCopy & { alias: string }>(
      `select w.app_id, w.main_app_id, w.name, w.created_by, w.created_at::text, w.refreshed_at::text, w.merged_at::text, w.merged_by, a.alias
         from meta.working_copy w join meta.app a on a.id = w.app_id where w.main_app_id = $1 order by w.name`,
      [mainId],
    )
  ).rows;

export class WorkingCopyError extends Error {}

/** Make a working copy of an application. Returns the copy's application id. */
export async function createCopy(mainId: number, name: string, username: string): Promise<number> {
  if (!NAME.test(name)) throw new WorkingCopyError('A name of 1–40 letters, digits, spaces, - or _ (starting with a letter or digit).');
  return owner.tx(async (c) => {
    const main = (await c.query<{ alias: string }>('select alias from meta.app where id = $1 for update', [mainId])).rows[0];
    if (!main) throw new WorkingCopyError('Application not found.');
    if ((await c.query('select 1 from meta.working_copy where app_id = $1', [mainId])).rowCount)
      throw new WorkingCopyError('This application is a working copy: make copies of its main application.');
    if ((await c.query('select 1 from meta.working_copy where main_app_id = $1 and lower(name) = lower($2)', [mainId, name])).rowCount)
      throw new WorkingCopyError(`There is already a working copy named ${name}.`);
    const alias = `${main.alias}-${slug(name).replace(/_/g, '-') || 'copy'}`.slice(0, 60);
    if ((await c.query('select 1 from meta.app where alias = $1', [alias])).rowCount)
      throw new WorkingCopyError(`The alias ${alias} is taken: choose another name.`);
    const doc = await exportApp(c, main.alias);
    const id = (await c.query<{ id: number }>('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), alias])).rows[0].id;
    // the copy lives in the main application's workspace
    await c.query('insert into meta.workspace_app (app_id, workspace_id) select $1, meta.app_workspace($2::int) where meta.app_workspace($2::int) <> 1', [id, mainId]);
    // the same people may run the copy, with the same roles
    await c.query('insert into meta.app_access (app_id, account_id, roles) select $1, account_id, roles from meta.app_access where app_id = $2', [id, mainId]);
    // web credentials work in the copy too (an export carries no secrets)
    await c.query(
      `update meta.web_credential n set secret_enc = o.secret_enc, password_enc = o.password_enc,
              refresh_token_enc = o.refresh_token_enc, token_refreshed_at = o.token_refreshed_at
         from meta.web_credential o where o.app_id = $2 and n.app_id = $1 and n.name = o.name`,
      [id, mainId],
    );
    // a copy runs no automations or synchronisations (the main application does)
    await c.query('update meta.automation set enabled = false where app_id = $1', [id]);
    await c.query('update meta.rest_source set sync_enabled = false where app_id = $1', [id]);
    await c.query('insert into meta.working_copy (app_id, main_app_id, name, base, created_by) values ($1, $2, $3, $4, $5)', [id, mainId, name, JSON.stringify(doc), username]);
    return id;
  });
}

interface Loaded {
  copy: WorkingCopy & { alias: string };
  mainAlias: string;
  base: Doc;
  main: Doc;
  copyDoc: Doc;
  changes: Change[];
}

/** The comparison of a working copy with its main application (inside c, rows locked when `lock`). */
async function load(c: Db, copyId: number, lock = false): Promise<Loaded | null> {
  const row = (
    await c.query(
      `select w.app_id, w.main_app_id, w.name, w.created_by, w.created_at::text, w.refreshed_at::text, w.merged_at::text, w.merged_by,
              w.base, a.alias, m.alias as main_alias
         from meta.working_copy w join meta.app a on a.id = w.app_id join meta.app m on m.id = w.main_app_id
        where w.app_id = $1 ${lock ? 'for update of w, a, m' : ''}`,
      [copyId],
    )
  ).rows[0];
  if (!row) return null;
  const { base: baseRaw, main_alias: mainAlias, ...copy } = row;
  const base = normalDoc(baseRaw, mainAlias);
  const main = normalDoc(await exportApp(c, mainAlias), mainAlias);
  const copyDoc = normalDoc(await exportApp(c, copy.alias), mainAlias);
  return { copy, mainAlias, base, main, copyDoc, changes: compareDocs(base, main, copyDoc) };
}

export const compare = (copyId: number) => load(owner, copyId);

/** Page numbers a merge or refresh changes in its target (0: application-level components). */
export function touchedPages(changes: Change[], target: 'main' | 'copy', takeCopy: (ch: Change) => boolean) {
  const pages = new Set<number>();
  for (const ch of changes) {
    const toMain = ch.status === 'copy' || (ch.status === 'conflict' && takeCopy(ch));
    const toCopy = ch.status === 'main' || (ch.status === 'conflict' && !takeCopy(ch));
    if (target === 'main' ? toMain : toCopy) pages.add(ch.page ?? 0);
  }
  return pages;
}

export interface MergeOptions {
  /** 'merge': into the main application; 'refresh': the main application's changes into the copy */
  direction: 'merge' | 'refresh';
  /** component ids of conflicts resolved with the copy's version (others keep the main version) */
  takeCopy: Set<string>;
  /** fingerprint() of the comparison the developer saw */
  state: string;
  username: string;
  /** refuse when another developer has locked something the change touches */
  lockedBy?: (appId: number, pages: Set<number>) => Promise<string | null>;
}

/** Merge a working copy into its main application, or refresh it from there. */
export async function mergeCopy(copyId: number, o: MergeOptions) {
  return owner.tx(async (c) => {
    const l = await load(c, copyId, true);
    if (!l) throw new WorkingCopyError('Working copy not found.');
    if (fingerprint(l.changes) !== o.state) throw new WorkingCopyError('The main application or the working copy changed in the meantime: review the comparison again.');
    const take = (ch: Change) => o.takeCopy.has(ch.id);
    const target = o.direction === 'merge' ? 'main' : 'copy';
    const targetId = target === 'main' ? l.copy.main_app_id : l.copy.app_id;
    const blocked = await o.lockedBy?.(targetId, touchedPages(l.changes, target, take));
    if (blocked) throw new WorkingCopyError(blocked);
    if (!l.changes.length) throw new WorkingCopyError('Nothing to do: the working copy and the main application are the same.');
    let doc: Doc;
    try {
      doc = mergedDoc(l.main, l.changes, take);
    } catch (e) {
      throw new WorkingCopyError(`The merged application is not consistent: ${(e as Error).message}. Resolve it in the working copy (or the main application) first.`);
    }
    if (o.direction === 'merge') await replaceApp(c, doc, l.mainAlias);
    await replaceApp(c, doc, l.copy.alias);
    // the copy keeps running nothing on its own
    await c.query('update meta.automation set enabled = false where app_id = $1', [copyId]);
    await c.query('update meta.rest_source set sync_enabled = false where app_id = $1', [copyId]);
    const base = await exportApp(c, l.mainAlias);
    if (o.direction === 'merge')
      await c.query('update meta.working_copy set base = $2, merged_at = now(), merged_by = $3 where app_id = $1', [copyId, JSON.stringify(base), o.username]);
    else await c.query('update meta.working_copy set base = $2, refreshed_at = now() where app_id = $1', [copyId, JSON.stringify(base)]);
    return { changes: l.changes.length, mainId: l.copy.main_app_id };
  });
}

/** Delete a working copy (the copy's application with it). */
export async function deleteCopy(copyId: number) {
  const r = await owner.query('delete from meta.app a using meta.working_copy w where w.app_id = a.id and a.id = $1', [copyId]);
  return (r.rowCount ?? 0) > 0;
}
