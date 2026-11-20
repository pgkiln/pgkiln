import { owner } from '../db.ts';
import { logActivity } from '../session.ts';

// (sprint 233) The page and application locks of a developer who is removed, and locks held by names that are no
// developer. Removing a developer releases their locks (Developers → Remove; migration 190's trigger is the backstop
// for any other delete); each released lock is written to its application's activity log (event lock_released).
// Locks of names that are no developer (a developer removed before 0.112.0, or the command line's and the MCP
// server's --as / operating system user / 'MCP') are listed for an administrator to release.

export interface HeldLock {
  app_id: number;
  app_name: string;
  page_no: number;
  locked_by: string;
}

type Tx = (key: 'dev.lock_app' | 'dev.lock_pages', vars?: Record<string, string>) => string;

/** The locks a name holds, or (holder null) the locks of names that are no developer, by application and page. */
export async function heldLocks(holder: string | null): Promise<HeldLock[]> {
  return (
    await owner.query<HeldLock>(
      `select k.app_id, a.name as app_name, k.page_no, k.locked_by
         from meta.builder_lock k join meta.app a on a.id = k.app_id
        where ${holder === null ? 'not exists (select 1 from meta.developer d where d.username = k.locked_by)' : 'k.locked_by = $1'}
        order by k.locked_by, a.name, k.app_id, k.page_no`,
      holder === null ? [] : [holder],
    )
  ).rows;
}

/** "Sales: application; HR: pages 3, 5" */
export function describeLocks(locks: HeldLock[], tx: Tx): string {
  const byApp = new Map<number, { name: string; app: boolean; pages: number[] }>();
  for (const l of locks) {
    const a = byApp.get(l.app_id) ?? { name: l.app_name, app: false, pages: [] };
    if (l.page_no === 0) a.app = true;
    else a.pages.push(l.page_no);
    byApp.set(l.app_id, a);
  }
  return [...byApp.values()]
    .map((a) => `${a.name}: ${[a.app ? tx('dev.lock_app') : '', a.pages.length ? tx('dev.lock_pages', { pages: a.pages.join(', ') }) : ''].filter(Boolean).join(', ')}`)
    .join('; ');
}

/** Write a released lock to its application's activity log. */
export const logReleased = (locks: HeldLock[], by: string, ip: string | null, why: string) =>
  Promise.all(locks.map((l) => logActivity({ appId: l.app_id, pageNo: l.page_no || null, username: by, event: 'lock_released', ip: ip ?? undefined, detail: `builder: lock of ${l.locked_by} released: ${why}` })));

/**
 * Remove a developer: their row (meta.developer's delete trigger releases their locks), their builder sessions,
 * in one transaction; then the released locks are logged. Returns the released locks.
 */
export async function removeDeveloper(username: string, by: string, ip: string | null): Promise<HeldLock[]> {
  const released = await owner.tx(async (c) => {
    const locks = (
      await c.query<HeldLock>(
        `select k.app_id, a.name as app_name, k.page_no, k.locked_by from meta.builder_lock k join meta.app a on a.id = k.app_id
          where k.locked_by = $1 order by a.name, k.app_id, k.page_no for update of k`,
        [username],
      )
    ).rows;
    await c.query('delete from meta.developer where username = $1', [username]);
    await c.query('delete from meta.session where app_id is null and username = $1', [username]);
    return locks;
  });
  await logReleased(released, by, ip, `developer removed by ${by}`);
  return released;
}

/** Release the locks of a name that is no developer; refuses (returns null) a developer's name: those are broken one by one. */
export async function releaseLocksOf(holder: string, by: string, ip: string | null): Promise<HeldLock[] | null> {
  const released = await owner.tx(async (c) => {
    if ((await c.query('select 1 from meta.developer where username = $1', [holder])).rowCount) return null;
    return (
      await c.query<HeldLock>(
        `with d as (delete from meta.builder_lock where locked_by = $1 returning app_id, page_no, locked_by)
         select d.app_id, a.name as app_name, d.page_no, d.locked_by from d join meta.app a on a.id = d.app_id order by a.name, d.app_id, d.page_no`,
        [holder],
      )
    ).rows;
  });
  if (released) await logReleased(released, by, ip, `no developer of that name; released by ${by}`);
  return released;
}
