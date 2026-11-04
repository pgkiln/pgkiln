// (sprint 144, AP-10; APEX 26.2: the Application and Working Copy APIs for CI / CD) Working copies and builder
// locks from the command line (`pgkiln working-copy …`, `pgkiln lock` / `unlock`) and the MCP server, with the same
// rules as the builder (src/builder/workingcopies.ts, locks.ts): a copy is made, compared per component with its
// main application (three ways), merged back or refreshed; a merge is refused while another developer has locked the
// target or a page it changes; conflicts need a choice (prefer the copy's or the main version). Every change is in
// the activity log under the developer named (--as, PGKILN_DEVELOPER or the operating system user). The functions
// return text and throw WorkingCopyError for what the user must fix.
import { owner } from '../db.ts';
import { logActivity } from '../session.ts';
import { compare, copiesOf, copyOf, createCopy, deleteCopy, fingerprint, mergeCopy, WorkingCopyError, type Change } from '../workingcopy.ts';
import { lockText, type Lock } from '../builder/locks.ts';

export { WorkingCopyError };

const IP = 'cli';

async function appByAlias(alias: string) {
  const a = await owner.one<{ id: number; alias: string; name: string }>('select id, alias, name from meta.app where alias = $1', [alias]);
  if (!a) throw new WorkingCopyError(`Application ${alias} not found.`);
  return a;
}

/** Another developer's lock on an application or one of the pages a merge changes (as the builder's merge). */
export const lockedFor = (username: string) => async (appId: number, pages: Set<number>) => {
  const l = await owner.one<Lock>(
    `select app_id, page_no, locked_by, locked_at::text, note from meta.builder_lock
      where app_id = $1 and locked_by <> $2 and (page_no = 0 or page_no = any($3::int[])) order by page_no limit 1`,
    [appId, username, [...pages]],
  );
  return l ? `${lockText(l)} The change is refused until it is unlocked.` : null;
};

/** The working copies of an application (alias of the main application or of a copy). */
export async function listCopies(alias: string) {
  const a = await appByAlias(alias);
  const wc = await copyOf(a.id);
  const mainId = wc ? wc.main_app_id : a.id;
  const copies = await copiesOf(mainId);
  if (!copies.length) return `${alias} has no working copies.\n`;
  return copies.map((c) => `${c.alias}\t${c.name}\tby ${c.created_by} ${c.created_at.slice(0, 16)}${c.merged_at ? `\tmerged ${c.merged_at.slice(0, 16)}` : ''}${c.refreshed_at ? `\trefreshed ${c.refreshed_at.slice(0, 16)}` : ''}\n`).join('');
}

export async function createWorkingCopy(alias: string, name: string, by: string) {
  const a = await appByAlias(alias);
  if (await copyOf(a.id)) throw new WorkingCopyError(`${alias} is itself a working copy: make the copy from its main application.`);
  const id = await createCopy(a.id, name, by);
  const copy = await owner.one<{ alias: string }>('select alias from meta.app where id = $1', [id]);
  await logActivity({ appId: a.id, username: by, event: 'working_copy', ip: IP, detail: `created ${name} (application ${id})` });
  return { id, alias: copy!.alias, text: `Working copy ${name} of ${alias}: application ${copy!.alias} (${id}).\n` };
}

const STATUS: Record<Change['status'], string> = { copy: 'copy', main: 'main', conflict: 'CONFLICT' };

/** The comparison of a working copy with its main application, one component per line. */
export async function compareCopy(alias: string) {
  const a = await appByAlias(alias);
  const l = await compare(a.id);
  if (!l) throw new WorkingCopyError(`${alias} is not a working copy.`);
  const conflicts = l.changes.filter((c) => c.status === 'conflict');
  const text = l.changes.length
    ? l.changes.map((c) => `${STATUS[c.status].padEnd(8)} ${c.label}  [${c.id}]\n`).join('') +
      `${l.changes.length} component(s) differ from ${l.mainAlias}: ${l.changes.filter((c) => c.status === 'copy').length} changed in the copy, ` +
      `${l.changes.filter((c) => c.status === 'main').length} in the main application, ${conflicts.length} conflict(s).\n`
    : `${alias} and ${l.mainAlias} are the same: nothing to merge.\n`;
  return { changes: l.changes, conflicts: conflicts.length, mainAlias: l.mainAlias, text };
}

/**
 * Merge a working copy into its main application ('merge') or bring the main application's changes into the copy
 * ('refresh'). Conflicts need prefer ('copy' or 'main' for all of them) or take (component ids that keep the copy's
 * version; the others keep the main's).
 */
export async function mergeWorkingCopy(alias: string, o: { direction: 'merge' | 'refresh'; prefer?: 'copy' | 'main' | null; take?: string[]; by: string }) {
  const a = await appByAlias(alias);
  const l = await compare(a.id);
  if (!l) throw new WorkingCopyError(`${alias} is not a working copy.`);
  const conflicts = l.changes.filter((c) => c.status === 'conflict');
  const take = new Set(o.take ?? []);
  for (const id of take) if (!conflicts.some((c) => c.id === id)) throw new WorkingCopyError(`${id} is not one of the conflicts.`);
  if (o.prefer === 'copy') conflicts.forEach((c) => take.add(c.id));
  const open = conflicts.filter((c) => !take.has(c.id) && o.prefer !== 'main' && !(o.take?.length));
  if (open.length)
    throw new WorkingCopyError(`${open.length} conflict(s): choose the copy's or the main version (prefer copy|main, or take <component> for those that keep the copy's):\n` +
      open.map((c) => `  ${c.label}  [${c.id}]`).join('\n'));
  const r = await mergeCopy(a.id, { direction: o.direction, takeCopy: take, state: fingerprint(l.changes), username: o.by, lockedBy: lockedFor(o.by) });
  await logActivity({ appId: o.direction === 'merge' ? r.mainId : a.id, username: o.by, event: 'working_copy', ip: IP, detail: `${o.direction === 'merge' ? 'merged' : 'refreshed'} ${l.copy.name} (${r.changes} components)` });
  return o.direction === 'merge' ? `Merged ${alias} into ${l.mainAlias} (${r.changes} component(s)).\n` : `Refreshed ${alias} from ${l.mainAlias} (${r.changes} component(s)).\n`;
}

export async function deleteWorkingCopy(alias: string, by: string) {
  const a = await appByAlias(alias);
  const wc = await copyOf(a.id);
  if (!wc) throw new WorkingCopyError(`${alias} is not a working copy: only working copies are deleted here.`);
  await deleteCopy(a.id);
  await logActivity({ appId: wc.main_app_id, username: by, event: 'working_copy', ip: IP, detail: `deleted ${wc.name}` });
  return `Deleted working copy ${wc.name} (${alias}).\n`;
}

/** Lock an application (page null) or one of its pages for the developer, as the builder's Lock does. */
export async function lockApp(alias: string, page: number | null, by: string, note: string | null) {
  const a = await appByAlias(alias);
  if (page !== null && !(await owner.one('select 1 as ok from meta.page where app_id = $1 and page_no = $2', [a.id, page]))) throw new WorkingCopyError(`${alias} has no page ${page}.`);
  const r = await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by, note) values ($1, $2, $3, $4) on conflict (app_id, page_no) do nothing`,
    [a.id, page ?? 0, by, note?.slice(0, 500) || null]);
  if (!r.rowCount) {
    const l = await owner.one<Lock>('select app_id, page_no, locked_by, locked_at::text, note from meta.builder_lock where app_id = $1 and page_no = $2', [a.id, page ?? 0]);
    throw new WorkingCopyError(l ? lockText(l) : 'It is already locked.');
  }
  return `${page ? `Page ${page} of ${alias}` : alias} is locked by ${by}.\n`;
}

/** Unlock; another developer's lock only with force (logged as a broken lock, as an administrator does in the builder). */
export async function unlockApp(alias: string, page: number | null, by: string, force: boolean) {
  const a = await appByAlias(alias);
  const l = await owner.one<Lock>('select app_id, page_no, locked_by, locked_at::text, note from meta.builder_lock where app_id = $1 and page_no = $2', [a.id, page ?? 0]);
  if (!l) return 'It is not locked.\n';
  if (l.locked_by !== by && !force) throw new WorkingCopyError(`${lockText(l)} Only ${l.locked_by} unlocks it (or use --force).`);
  await owner.query('delete from meta.builder_lock where app_id = $1 and page_no = $2', [a.id, page ?? 0]);
  if (l.locked_by !== by) await logActivity({ appId: a.id, pageNo: page, username: by, event: 'lock_broken', ip: IP, detail: `command line: lock of ${l.locked_by}` });
  return l.locked_by === by ? 'Unlocked.\n' : `${l.locked_by}'s lock was broken.\n`;
}
