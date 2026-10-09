import pg from 'pg';
import { nextRun, parseCron } from './automations.ts';
import { owner, runtime, type Client } from './db.ts';
import { fetchSource, sourceParamValues, toRows, type RestSource } from './websources.ts';

// REST data source synchronisation (APEX: REST Source Synchronization):
// the source's rows are copied into a local table, so reports, searches and
// joins work on a local copy and the service is called once per run.
//
//   merge    rows are matched on the source's key columns: changed ones are
//            updated, new ones inserted, and (sync_delete) local rows the
//            service no longer returns are deleted
//   replace  every local row is deleted, then the rows are inserted
//   append   the rows are inserted
//
// Only the columns of the source that are columns of the table (by name)
// are written; the values are cast to the table's column types by
// jsonb_populate_recordset. The table is written in one transaction as the
// application's database role (grants and row level security apply), with
// meta.app_user() = rest_sync:<SOURCE>. The service is called through
// fetchSource(): the allow-list, address checks and the source's credential.
//
// Runs: "Synchronise now" in the builder (manual), the cron schedule of the
// source (the automations scheduler calls syncTick() on every pass) and
// meta.request_rest_sync(name) from SQL (queued, run by the next pass).
// Every run is logged in meta.rest_sync_log (the last 100 per source); an
// advisory lock keeps two runs of one source from overlapping.

export interface SyncSource extends RestSource {
  sync_table: string | null;
  sync_mode: 'merge' | 'replace' | 'append';
  sync_delete: boolean;
  sync_schedule: string | null;
  sync_time_zone: string;
  sync_enabled: boolean;
  db_role: string | null;
}

export interface SyncResult {
  status: 'ok' | 'error' | 'busy';
  log?: number;
  rows?: number;
  inserted?: number;
  updated?: number;
  deleted?: number;
  message?: string;
}

/** Advisory lock namespace of synchronisation runs ("pgrs"). */
const LOCK_CLASS = 0x70677273;
const ident = pg.escapeIdentifier;

/** Problems with a synchronisation's settings (builder); empty: fine. */
export function syncProblems(v: { sync_table?: unknown; sync_mode?: unknown; key_columns?: unknown; sync_schedule?: unknown; sync_time_zone?: unknown; sync_enabled?: unknown }): string[] {
  const out: string[] = [];
  const table = typeof v.sync_table === 'string' ? v.sync_table.trim() : '';
  if (table && !/^([a-z_][a-z0-9_$]*\.)?[a-z_][a-z0-9_$]*$/i.test(table)) out.push('The local table is a table name, e.g. app.country_copy.');
  const keys = Array.isArray(v.key_columns) ? v.key_columns : [];
  if (table && (v.sync_mode ?? 'merge') === 'merge' && !keys.length) out.push('A merge needs the key columns (the columns that identify a row).');
  if (v.sync_enabled && !table) out.push('A scheduled synchronisation needs the local table.');
  if (v.sync_enabled && !(typeof v.sync_schedule === 'string' && v.sync_schedule.trim())) out.push('A scheduled synchronisation needs a schedule, e.g. @hourly.');
  if (typeof v.sync_schedule === 'string' && v.sync_schedule.trim()) {
    try {
      nextRun(parseCron(v.sync_schedule), String(v.sync_time_zone ?? 'UTC'), new Date());
    } catch (e) {
      out.push(`Schedule: ${(e as Error).message}`);
    }
  }
  return out;
}

async function loadSyncSource(id: number) {
  return owner.one<SyncSource>(
    `select s.id, s.app_id, s.name, s.url, s.method, s.credential, s.headers, s.params, s.body, s.row_selector, s.columns, s.cache_seconds,
            s.timeout_s, s.max_rows, s.key_columns, s.operations, s.sync_table, s.sync_mode, s.sync_delete, s.sync_schedule, s.sync_time_zone,
            s.sync_enabled, a.db_role
       from meta.rest_source s join meta.app a on a.id = s.app_id where s.id = $1`,
    [id],
  );
}

/**
 * Write the rows into the table (in the caller's transaction, as its role).
 * Returns the counts; the rows' keys are the source's column names.
 */
export async function writeRows(c: Client, s: Pick<SyncSource, 'name' | 'sync_table' | 'sync_mode' | 'sync_delete' | 'key_columns'>, columns: string[], rows: Record<string, unknown>[], deleteMissing = true) {
  const t = (await c.query('select $1::regclass::oid as oid, $1::regclass::text as name', [s.sync_table])).rows[0];
  const table = t.name as string;
  const writable = new Set(
    (await c.query(`select attname from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped and attgenerated = '' and attidentity <> 'a'`, [t.oid])).rows.map(
      (r) => r.attname as string,
    ),
  );
  const cols = columns.filter((n) => writable.has(n));
  if (!cols.length) throw new Error(`No column of REST data source ${s.name} is a column of ${table} that can be written (columns are matched by name).`);
  const list = cols.map(ident).join(', ');
  const data = JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((n) => [n, r[n] ?? null]))));
  const from = `jsonb_populate_recordset(null::${table}, $1::jsonb)`;
  const count = async (sql: string) => Number((await c.query(sql, [data])).rows[0]?.n ?? 0);
  if (s.sync_mode === 'append') return { inserted: await count(`with ins as (insert into ${table} (${list}) select ${list} from ${from} returning 1) select count(*)::int as n from ins`), updated: 0, deleted: 0 };
  if (s.sync_mode === 'replace') {
    const deleted = Number((await c.query(`with del as (delete from ${table} returning 1) select count(*)::int as n from del`)).rows[0].n);
    const inserted = await count(`with ins as (insert into ${table} (${list}) select ${list} from ${from} returning 1) select count(*)::int as n from ins`);
    return { inserted, updated: 0, deleted };
  }
  const keys = s.key_columns ?? [];
  if (!keys.length) throw new Error(`REST data source ${s.name}: a merge needs the key columns.`);
  for (const k of keys) if (!cols.includes(k)) throw new Error(`REST data source ${s.name}: the key column ${k} is not a column of ${table}.`);
  const others = cols.filter((n) => !keys.includes(n));
  const match = (a: string, b: string) => keys.map((k) => `${a}.${ident(k)} = ${b}.${ident(k)}`).join(' and ');
  const parts = [
    `src as (select distinct on (${keys.map(ident).join(', ')}) ${list} from ${from} where ${keys.map((k) => `${ident(k)} is not null`).join(' and ')})`,
    others.length
      ? `upd as (update ${table} t set ${others.map((n) => `${ident(n)} = s.${ident(n)}`).join(', ')} from src s
                  where ${match('t', 's')} and (${others.map((n) => `t.${ident(n)}`).join(', ')}, null) is distinct from (${others.map((n) => `s.${ident(n)}`).join(', ')}, null) returning 1)`
      : `upd as (select 1 where false)`,
    `ins as (insert into ${table} (${list}) select ${list} from src s where not exists (select 1 from ${table} t where ${match('t', 's')}) returning 1)`,
    s.sync_delete && deleteMissing
      ? `del as (delete from ${table} t where not exists (select 1 from src s where ${match('t', 's')}) returning 1)`
      : `del as (select 1 where false)`,
  ];
  const r = (await c.query(`with ${parts.join(',\n')} select (select count(*) from ins)::int as inserted, (select count(*) from upd)::int as updated, (select count(*) from del)::int as deleted`, [data])).rows[0];
  return { inserted: Number(r.inserted), updated: Number(r.updated), deleted: Number(r.deleted) };
}

/**
 * Run a source's synchronisation now. `log`: a queued run (from SQL) to
 * take; it stays queued when another run of the source is busy.
 */
export async function runSync(sourceId: number, trigger: 'manual' | 'schedule' | 'sql', opts: { log?: number; by?: string } = {}): Promise<SyncResult> {
  const lock = await owner.pool.connect();
  try {
    const got = (await lock.query('select pg_try_advisory_lock($1, $2) as ok', [LOCK_CLASS, sourceId])).rows[0].ok;
    if (!got) return { status: 'busy', message: 'This synchronisation is running already.' };
    try {
      const s = await loadSyncSource(sourceId);
      if (!s) return { status: 'error', message: 'REST data source not found.' };
      let log: number;
      if (opts.log) {
        const claimed = await lock.query(`update meta.rest_sync_log set status = 'running', started_at = now() where id = $1 and source_id = $2 and status = 'queued' returning id`, [opts.log, sourceId]);
        if (!claimed.rowCount) return { status: 'busy', message: 'This run was taken by another server.' };
        log = opts.log;
      } else
        log = (await lock.query(`insert into meta.rest_sync_log (source_id, trigger, status, requested_by, started_at) values ($1, $2, 'running', $3, now()) returning id`, [sourceId, trigger, opts.by ?? null])).rows[0].id;
      let result: SyncResult;
      try {
        if (!s.sync_table) throw new Error(`REST data source ${s.name} has no local table to synchronise into.`);
        // background: no page items; &NAME. substitutions in parameter defaults are empty
        const { json } = await fetchSource({ ...s, cache_seconds: 0 }, sourceParamValues(s, undefined, () => ''));
        const { columns, rows, truncated } = toRows(json, s);
        const counts = await runtime.tx(async (c) => {
          await c.query(
            `select set_config('pgkiln.app_user', $1, true), set_config('pgkiln.app_id', $2, true), set_config('pgkiln.session_id', '', true),
                    set_config('statement_timeout', '300s', true)`,
            [`rest_sync:${s.name}`, String(s.app_id)],
          );
          if (s.db_role) await c.query(`set local role ${ident(s.db_role)}`);
          // a cut-off response (maximum rows) must not delete the rows beyond the cut
          return writeRows(c, s, columns.map((x) => x.name), rows, !truncated);
        });
        const note = truncated ? ` Only the first ${s.max_rows} rows were read (maximum rows)${s.sync_mode === 'merge' && s.sync_delete ? '; nothing was deleted' : ''}.` : '';
        result = { status: 'ok', log, rows: rows.length, ...counts, ...(note ? { message: note.trim() } : {}) };
      } catch (e) {
        result = { status: 'error', log, message: (e as Error).message.slice(0, 2000) };
      }
      await lock.query(
        `update meta.rest_sync_log set status = $2, finished_at = now(), rows_fetched = $3, inserted = $4, updated = $5, deleted = $6, message = $7 where id = $1`,
        [log, result.status, result.rows ?? null, result.inserted ?? null, result.updated ?? null, result.deleted ?? null, result.message ?? null],
      );
      await lock.query('update meta.rest_source set sync_last_at = now(), sync_last_status = $2 where id = $1', [sourceId, result.status]);
      await lock.query(
        `delete from meta.rest_sync_log where source_id = $1 and status not in ('queued', 'running')
            and id not in (select id from meta.rest_sync_log where source_id = $1 order by requested_at desc, id desc limit 100)`,
        [sourceId],
      );
      return result;
    } finally {
      await lock.query('select pg_advisory_unlock($1, $2)', [LOCK_CLASS, sourceId]);
    }
  } finally {
    lock.release();
  }
}

/**
 * One scheduler pass (called by the automations scheduler): schedule and
 * run the synchronisations that are due, then the runs queued from SQL.
 * Returns the ids of the sources that ran.
 */
export async function syncTick(now = new Date()): Promise<number[]> {
  const due = await owner.tx(async (c) => {
    const rows = (
      await c.query<{ id: number; sync_schedule: string; sync_time_zone: string; sync_next_at: Date | null }>(
        `select id, sync_schedule, sync_time_zone, sync_next_at from meta.rest_source
          where sync_enabled and sync_table is not null and sync_schedule is not null and (sync_next_at is null or sync_next_at <= $1)
          order by sync_next_at nulls first
          for update skip locked
          limit 50`,
        [now],
      )
    ).rows;
    const run: number[] = [];
    for (const s of rows) {
      let next: Date | null = null;
      try {
        next = nextRun(parseCron(s.sync_schedule), s.sync_time_zone, now);
      } catch {
        // an invalid schedule (edited in SQL) never runs; the builder shows why
      }
      if (s.sync_next_at) run.push(s.id); // null: newly scheduled, first run at `next`
      await c.query('update meta.rest_source set sync_next_at = $2 where id = $1', [s.id, next ?? new Date('9999-12-31T00:00:00Z')]);
    }
    return run;
  });
  const ran: number[] = [];
  for (const id of due) if ((await runSync(id, 'schedule')).status !== 'busy') ran.push(id);
  const queued = (await owner.query<{ id: string; source_id: number }>(`select id, source_id from meta.rest_sync_log where status = 'queued' order by id limit 20`)).rows;
  for (const q of queued) if ((await runSync(q.source_id, 'sql', { log: Number(q.id) })).status !== 'busy') ran.push(q.source_id);
  return ran;
}

/** The last runs of a source (builder). */
export async function syncLog(sourceId: number, limit = 10) {
  return (
    await owner.query(
      `select id, trigger, status, requested_by, requested_at, started_at, finished_at, rows_fetched, inserted, updated, deleted, message
         from meta.rest_sync_log where source_id = $1 order by requested_at desc, id desc limit $2`,
      [sourceId, limit],
    )
  ).rows;
}
