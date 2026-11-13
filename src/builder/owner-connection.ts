import pg from 'pg';
import { owner, type Db } from '../db.ts';
import { logActivity, type Session } from '../session.ts';
import { isAdmin } from './locks.ts';

// (sprint 185, NX-S1) The Owner connection in the SQL Workshop. Every tool of the SQL Workshop runs as the
// workspace's developer login (migration 166, workshopDb in workspaces.ts). An administrator may choose the
// owner connection instead (the worksheet's Run as), with a reason: the choice lasts for the session until
// they choose another Run as, shows a red chip on every SQL Workshop page, and goes to meta.owner_sql_audit
// with every statement run on it: the statements typed in the worksheet and SQL Scripts (auditRun), and the
// statements that change something which the other tools send (auditedOwner).

/** The session's reason for the Owner connection (state __OWNER), when one was given. */
export const ownerReasonOf = (s: Pick<Session, 'state'>) => (typeof s.state.__OWNER === 'string' && s.state.__OWNER ? s.state.__OWNER : null);

/** The reason, when this session uses the Owner connection and is (still) an administrator's. */
export async function ownerChosen(s: Session): Promise<string | null> {
  const reason = ownerReasonOf(s);
  if (!reason) return null;
  if (await isAdmin(s.username)) return reason;
  delete s.state.__OWNER; // no longer an administrator
  return null;
}

export const REASON_MAX = 500;

/** Choose the Owner connection (the caller checks that the session is an administrator's). */
export async function chooseOwner(s: Session, reason: string, ip: string) {
  s.state.__OWNER = reason;
  await owner.query(`insert into meta.owner_sql_audit (username, workspace_id, tool, reason, status) values ($1, $2, 'worksheet', $3, 'chosen')`,
    [s.username, s.workspace?.id ?? null, reason]);
  await logActivity({ username: s.username, event: 'owner_connection', ip, detail: `chose the Owner connection: ${reason}` });
}

/** Back to the developer login. */
export async function endOwner(s: Session, ip?: string) {
  const reason = ownerReasonOf(s);
  if (!reason) return;
  delete s.state.__OWNER;
  await owner.query(`insert into meta.owner_sql_audit (username, workspace_id, tool, reason, status) values ($1, $2, 'worksheet', $3, 'ended')`,
    [s.username, s.workspace?.id ?? null, reason]);
  if (ip) await logActivity({ username: s.username, event: 'owner_connection', ip, detail: 'back to the developer login' });
}

export interface AuditedStatement {
  sql: string;
  status: string;
  rows?: number | null;
  error?: string;
  ms?: number;
}

/** Record statements run on the Owner connection (a worksheet run, a script). */
export async function auditRun(s: Session, tool: string, statements: AuditedStatement[]) {
  const reason = ownerReasonOf(s);
  if (!reason || !statements.length) return;
  const run = statements.filter((x) => x.status === 'ok' || x.status === 'error');
  if (!run.length) return;
  await owner.query(
    `insert into meta.owner_sql_audit (username, workspace_id, tool, reason, statement, rows, status, error, ms)
     select $1, $2, $3, $4, x.sql, x.rows, x.status, x.error, x.ms
       from jsonb_to_recordset($5::jsonb) as x(sql text, rows bigint, status text, error text, ms numeric)`,
    [s.username, s.workspace?.id ?? null, tool, reason,
      JSON.stringify(run.map((x) => ({ sql: x.sql.slice(0, 100_000), rows: x.rows ?? null, status: x.status, error: x.error?.slice(0, 2000) ?? null, ms: x.ms ?? null })))],
  );
}

// statements that change something (what the tools other than the worksheet and scripts send is recorded when it does)
const CHANGES = /^\s*(?:create|alter|drop|insert|update|delete|truncate|grant|revoke|comment|copy|do|call|merge|refresh|reindex|vacuum|cluster|lock|security|import|reassign|set\s+role|reset|select\s+(?:set_config|pg_terminate|pg_cancel|setval))\b/i;

/**
 * The owner pool for the tools of an administrator who chose the Owner connection: the same pool, with the
 * statements that change something recorded in meta.owner_sql_audit (catalogue reads are not).
 */
export function auditedOwner(s: Session, reason: string, tool = 'workshop'): Db {
  const record = (sql: unknown, res: pg.QueryResult | null, error: unknown, t0: number) => {
    const text = typeof sql === 'string' ? sql : (sql as { text?: string } | null)?.text;
    if (!text || !CHANGES.test(text)) return;
    void owner.query(
      `insert into meta.owner_sql_audit (username, workspace_id, tool, reason, statement, rows, status, error, ms) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [s.username, s.workspace?.id ?? null, tool, reason, text.slice(0, 100_000), res?.rowCount ?? null, error ? 'error' : 'ok',
        error ? String((error as Error).message ?? error).slice(0, 2000) : null, Math.round(performance.now() - t0)],
    ).catch((e) => console.error('owner_sql_audit:', (e as Error).message));
  };
  const watch = <C extends { query: (...a: any[]) => any }>(c: C): C => {
    const orig = c.query;
    const patched = function (this: unknown, ...args: any[]) {
      const t0 = performance.now();
      const p = orig.apply(c, args);
      if (p && typeof p.then === 'function') p.then((r: pg.QueryResult) => record(args[0], r, null, t0), (e: unknown) => record(args[0], null, e, t0));
      return p;
    };
    (c as any).query = patched;
    return c;
  };
  const unwatch = (c: pg.PoolClient, orig: pg.PoolClient['query']) => {
    if (Object.getPrototypeOf(c).query === orig) delete (c as any).query;
    else (c as any).query = orig;
  };
  // the pool's connect() and query(), what the SQL Workshop's tools use of it
  const pool = {
    async connect() {
      const c = await owner.pool.connect();
      const orig = c.query;
      const release = c.release;
      watch(c);
      c.release = ((err?: Error | boolean) => {
        unwatch(c, orig);
        c.release = release;
        return release.call(c, err);
      }) as typeof c.release;
      return c;
    },
    query(config: any, values?: any) {
      const t0 = performance.now();
      const p = owner.pool.query(config, values);
      p.then((r) => record(config, r, null, t0), (e) => record(config, null, e, t0));
      return p;
    },
  } as unknown as pg.Pool;
  return {
    ...owner,
    pool,
    async query(sql: string, params: unknown[] = []) {
      const t0 = performance.now();
      try {
        const r = await owner.query(sql, params);
        record(sql, r, null, t0);
        return r;
      } catch (e) {
        record(sql, null, e, t0);
        throw e;
      }
    },
    async one(sql: string, params: unknown[] = []) {
      const t0 = performance.now();
      try {
        const r = await owner.query(sql, params);
        record(sql, r, null, t0);
        return r.rows[0];
      } catch (e) {
        record(sql, null, e, t0);
        throw e;
      }
    },
    tx(fn) {
      return owner.tx(async (c) => {
        const orig = c.query;
        watch(c);
        try {
          return await fn(c);
        } finally {
          unwatch(c, orig);
        }
      });
    },
  } as Db;
}

