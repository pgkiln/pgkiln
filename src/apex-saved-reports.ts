import type { ApexSavedReport } from './apeximport.ts';

// (sprint 211, NX-F5) An APEX export's saved interactive reports (public and private, other than the default report)
// become pgkiln saved reports. Saved reports are user data (meta.saved_report, migration 014), not part of the
// application document, so they are written after meta.import_app(), in the import's transaction, once the regions
// have their ids: a region is found by its page and static id. The parameters are the report's r<id>_* URL
// parameters, which the runtime reads exactly as it reads a URL (src/runtime/report.ts): values become literals,
// columns must exist, operators and colours come from fixed lists, so an export cannot put SQL into them.

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** At most this many saved reports per import. */
export const MAX_SAVED_REPORTS = 1000;

/**
 * Writes the saved reports of an imported application. `owner` owns the public reports that belong to no user in the
 * export (APEX's alternative default reports); without one those are left out. Returns how many were written.
 */
export async function apexSavedReports(c: Queryable, list: ApexSavedReport[], o: { appId: number; owner: string | null }): Promise<number> {
  let n = 0;
  const owner = o.owner?.trim().toLowerCase().slice(0, 100) || null;
  for (const s of list.slice(0, MAX_SAVED_REPORTS)) {
    const username = s.username ?? owner;
    if (!username) continue;
    const region = (await c.query(
      `select r.id from meta.region r join meta.page p on p.id = r.page_id
        where p.app_id = $1 and p.page_no = $2 and r.static_id = $3 and r.type = 'report'`,
      [o.appId, s.page, s.region],
    )).rows[0]?.id as number | undefined;
    if (!region) continue;
    const params = new URLSearchParams();
    for (const [k, v] of s.params) if (/^[a-z]{1,4}$/.test(k)) params.append(`r${region}_${k}`, v);
    const text = params.toString();
    if (text.length > 8000) continue;
    const name = s.name.trim().slice(0, 80);
    if (!name) continue;
    const made = await c.query(
      `insert into meta.saved_report (app_id, region_id, username, name, public, params, kind)
       values ($1, $2, $3, $4, $5, $6, 'report') on conflict (region_id, username, kind, name) do nothing returning id`,
      [o.appId, region, username, name, s.public, text],
    );
    n += made.rows.length;
  }
  return n;
}
