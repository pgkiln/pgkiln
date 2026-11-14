// (sprint 138, AP-5) Change history per component (APEX: Application Utilities ›
// Change History) and application checksums (APEX: Application Checksum).
//
// meta.app_snapshot keeps an application's export after its last recorded
// change. After a builder change (app-updates.ts, onSend) and inside an import
// --replace (cli/replace.ts: restores, merges, the command line and the MCP
// server), recordHistory() exports the application again, splits both exports
// into components the way working copies compare them (workingcopy.ts
// components(): a region with its SQL, a page's settings, a list of values, …)
// and stores each added, changed or deleted component with its files before and
// after in meta.component_change (migration 138). The first change of an
// application without a snapshot has nothing to compare with: ensureSnapshot()
// takes one before a builder POST runs (a preHandler hook).
//
// appChecksum(): a SHA-256 over the export's files (the text layout, without the
// format marker and with the alias blanked), so two installations, or an
// application and its working copy, compare at a glance; pageChecksums() per page.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { docToFiles, MARKER, type Doc, type FileMap } from './appfiles.ts';
import { owner } from './db.ts';
import { components, describe } from './workingcopy.ts';

type Db = { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult<any>> };

/** Days a change stays in the history (CHANGE_HISTORY_DAYS, default 365; 0 keeps everything). */
export const historyDays = () => {
  const n = Number(process.env.CHANGE_HISTORY_DAYS ?? 365);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 365;
};

/** The export as files of the text layout (SQL inline in YAML: readable diffs), the alias blanked. */
export function appFiles(doc: Doc): FileMap {
  const d = { ...doc, app: { ...(doc.app ?? {}), alias: '' } };
  const files = docToFiles(d, 'text');
  files.delete(MARKER);
  return files;
}

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);
const asText = (files: Map<string, Buffer> | undefined) =>
  files ? Object.fromEntries([...files].map(([p, b]) => [p, isText(b) ? b.toString('utf8') : `(binary, ${b.length} bytes, sha256 ${createHash('sha256').update(b).digest('hex').slice(0, 16)})`])) : null;

const sameFiles = (a?: Map<string, Buffer>, b?: Map<string, Buffer>) => {
  if (!a || !b) return !a && !b;
  if (a.size !== b.size) return false;
  for (const [p, buf] of a) if (!b.get(p)?.equals(buf)) return false;
  return true;
};

export interface ComponentDiff {
  component: string;
  label: string;
  page: number | null;
  op: 'added' | 'changed' | 'deleted';
  before: Record<string, string> | null;
  after: Record<string, string> | null;
}

/** The components that differ between two exports. */
export function diffDocs(before: Doc, after: Doc): ComponentDiff[] {
  const a = components(appFiles(before)), b = components(appFiles(after));
  const out: ComponentDiff[] = [];
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(id), y = b.get(id);
    if (sameFiles(x, y)) continue;
    const { label, page } = describe(id);
    out.push({ component: id, label, page, op: !x ? 'added' : !y ? 'deleted' : 'changed', before: asText(x), after: asText(y) });
  }
  return out;
}

const exportDoc = async (db: Db, appId: number): Promise<Doc | null> =>
  (await db.query('select meta.export_app(alias) as d from meta.app where id = $1', [appId])).rows[0]?.d ?? null;

/** Take a first snapshot of an application that has none (before its first recorded change); with `db`, inside its transaction. */
export async function ensureSnapshot(appId: number, db?: pg.ClientBase) {
  const sql = `insert into meta.app_snapshot (app_id, doc) select id, meta.export_app(alias) from meta.app
                where id = $1 and not exists (select 1 from meta.app_snapshot where app_id = $1)
               on conflict (app_id) do nothing`;
  if (!db) return void (await owner.query(sql, [appId]));
  await db.query('savepoint history_snapshot');
  try {
    await db.query(sql, [appId]);
    await db.query('release savepoint history_snapshot');
  } catch {
    await db.query('rollback to savepoint history_snapshot');
  }
}

/**
 * Compare the application with its snapshot, record what changed and keep the new snapshot.
 * With `db` a client in the caller's transaction (an import --replace), else a transaction of its own.
 */
export async function recordHistory(appId: number, changedBy: string | null, source: 'builder' | 'import' | 'upgrade' = 'builder', db?: pg.ClientBase): Promise<number> {
  const run = async (c: Db) => {
    // one change at a time per application: the snapshot row is the lock
    const snap = (await c.query('select doc from meta.app_snapshot where app_id = $1 for update', [appId])).rows[0];
    const now = await exportDoc(c, appId);
    if (!now) return 0;
    if (!snap) {
      // a first snapshot: what changed is not known (app-updates.ts notes every page of an application a Create or an
      // Import made with notePageChanges)
      await c.query('insert into meta.app_snapshot (app_id, doc) values ($1, $2) on conflict (app_id) do update set doc = excluded.doc, taken_at = now()', [appId, now]);
      return 0;
    }
    const changes = diffDocs(snap.doc, now);
    if (!changes.length) return 0;
    await notePageChanges(c, appId, [...new Set(changes.map((x) => x.page).filter((n): n is number => typeof n === 'number' && n > 0))], changedBy, source);
    await c.query(
      `insert into meta.component_change (app_id, component, label, page_no, op, before, after, changed_by, source)
       select $1, x.component, x.label, x.page, x.op, x.before, x.after, $2, $3
         from jsonb_to_recordset($4::jsonb) as x(component text, label text, page int, op text, before jsonb, after jsonb)`,
      [appId, changedBy?.slice(0, 200) ?? null, source, JSON.stringify(changes)],
    );
    await c.query('update meta.app_snapshot set doc = $2, taken_at = now() where app_id = $1', [appId, now]);
    const days = historyDays();
    if (days) await c.query(`delete from meta.component_change where app_id = $1 and changed_at < now() - make_interval(days => $2)`, [appId, days]);
    return changes.length;
  };
  if (db) {
    await db.query('savepoint history');
    try {
      const n = await run(db);
      await db.query('release savepoint history');
      return n;
    } catch (e) {
      await db.query('rollback to savepoint history');
      throw e;
    }
  }
  return owner.tx(run);
}

/**
 * (sprint 193, migration 170) Who changed a page last: meta.page_change for the pages a recorded change touched (null:
 * every page of the application), and no row for a page number the application no longer has.
 */
export async function notePageChanges(c: Db, appId: number, pages: number[] | null, changedBy: string | null, source: string) {
  if (pages && !pages.length) return;
  await c.query(
    `insert into meta.page_change (app_id, page_no, updated_by, updated_at, source)
     select p.app_id, p.page_no, $3, now(), $4 from meta.page p where p.app_id = $1 and ($2::int[] is null or p.page_no = any ($2))
     on conflict (app_id, page_no) do update set updated_by = excluded.updated_by, updated_at = excluded.updated_at, source = excluded.source`,
    [appId, pages, changedBy?.slice(0, 200) || null, source],
  );
  await c.query('delete from meta.page_change x where x.app_id = $1 and not exists (select 1 from meta.page p where p.app_id = x.app_id and p.page_no = x.page_no)', [appId]);
}

/** SHA-256 of a set of files (paths and contents, in path order). */
function hashFiles(files: [string, Buffer][]) {
  const h = createHash('sha256');
  for (const [p, b] of files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) h.update(p).update('\0').update(b).update('\0');
  return h.digest('hex');
}

/** The application checksum of an export (the same definition gives the same checksum on any installation). */
export const appChecksum = (doc: Doc) => hashFiles([...appFiles(doc)]);

/** A checksum per page: page number → the hash of the page's files. */
export function pageChecksums(doc: Doc): Map<number, string> {
  const byPage = new Map<number, [string, Buffer][]>();
  for (const [id, files] of components(appFiles(doc))) {
    const page = id.startsWith('pages/') ? describe(id).page : null;
    if (page === null) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(...files);
  }
  return new Map([...byPage].sort(([a], [b]) => a - b).map(([p, f]) => [p, hashFiles(f)]));
}

/** A short form for display (the first 16 hex digits). */
export const shortSum = (sum: string) => sum.slice(0, 16);
