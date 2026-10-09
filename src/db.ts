import pg from 'pg';

// Keep dates/timestamps as the strings Postgres sends: no timezone surprises
// and they round-trip into <input type=date> unchanged.
for (const oid of [1082, 1114, 1184, 1083, 1266]) pg.types.setTypeParser(oid, (v) => v);

export type Client = pg.PoolClient;

function makePool(connectionString: string | undefined, name: string) {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_SIZE ?? 10), application_name: name });
  // An idle connection dying (DB restart, failover) must not crash the server;
  // the pool replaces it on the next checkout.
  pool.on('error', (err) => console.error(`${name}: idle database connection error:`, err.message));
  return {
    pool,
    query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
      return pool.query<T>(sql, params);
    },
    async one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
      return (await pool.query<T>(sql, params)).rows[0] as T | undefined;
    },
    async tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const result = await fn(c);
        await c.query('commit');
        return result;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
}

export const ownerUrl = process.env.DATABASE_URL ?? 'postgres://pgkiln:pgkiln@localhost:5434/pgkiln';
if (!process.env.RUNTIME_DATABASE_URL)
  console.warn('RUNTIME_DATABASE_URL is not set: applications run on the owner connection (not least privilege).');

/** Owner connection: builder, SQL Workshop, migrations. */
export const owner = makePool(ownerUrl, 'pgkiln-builder');
/** Least-privilege connection (pgkiln_runtime) that runs applications. */
export const runtime = makePool(process.env.RUNTIME_DATABASE_URL ?? ownerUrl, 'pgkiln-runtime');

export async function closePools() {
  await Promise.all([owner.pool.end(), runtime.pool.end()]);
}

export interface AppContext {
  appId: number;
  alias: string;
  dbRole: string | null;
  appUser: string;
  sessionId: string;
  /** language of the request (meta.app_language()) */
  lang?: string;
  /** time zone of the request (validated against pg_timezone_names); unset: the database's */
  timeZone?: string | null;
  /** the request's debug log (src/debug.ts): sets pgkiln.debug_level and collects NOTICEs (meta.debug) */
  debug?: { level: number; notice(msg: { message?: string; detail?: string; hint?: string; severity?: string }): void };
  /** run once the transaction committed (e.g. removing replaced files from object storage); errors are logged */
  afterCommit?: (() => Promise<void>)[];
  /** run when the transaction was rolled back (e.g. removing files stored for it) */
  afterRollback?: (() => Promise<void>)[];
}

async function runAll(tasks: (() => Promise<void>)[] | undefined, what: string) {
  for (const t of tasks?.splice(0) ?? [])
    await t().catch((e) => console.error(`${what}:`, (e as Error).message));
}

/**
 * Run developer SQL for an application: inside a transaction, as the app's
 * database role (so grants and RLS apply), with the app, user and session
 * exposed to SQL via meta.app_id(), meta.app_user() and meta.v().
 */
export async function appTx<T>(ctx: AppContext, fn: (c: Client) => Promise<T>): Promise<T> {
  if (!ctx.afterCommit && !ctx.afterRollback) return appTxInner(ctx, fn);
  try {
    const result = await appTxInner(ctx, fn);
    if (ctx.afterRollback) ctx.afterRollback.length = 0;
    await runAll(ctx.afterCommit, 'after commit');
    return result;
  } catch (e) {
    if (ctx.afterCommit) ctx.afterCommit.length = 0;
    await runAll(ctx.afterRollback, 'after rollback');
    throw e;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function appTxInner<T>(ctx: AppContext, fn: (c: Client) => Promise<T>): Promise<T> {
  return runtime.tx(async (c) => {
    await c.query(
      `select set_config('pgkiln.app_user', $1, true),
              set_config('pgkiln.session_id', $2, true),
              set_config('pgkiln.app_id', $3, true),
              set_config('statement_timeout', $4, true),
              set_config('pgkiln.lang', $5, true),
              set_config('pgkiln.public_url', $6, true),
              set_config('TimeZone', coalesce($7, current_setting('TimeZone')), true),
              set_config('pgkiln.debug_level', $8, true),
              -- (0.31) the session's tenant (meta.set_tenant), read here so a change applies at once
              set_config('pgkiln.tenant_id', coalesce((select tenant_id from meta.session where id = $9::uuid), ''), true)${ctx.debug ? `, set_config('client_min_messages', 'notice', true)` : ''}`,
      [ctx.appUser, ctx.sessionId, String(ctx.appId), process.env.STATEMENT_TIMEOUT ?? '30s', ctx.lang ?? '',
       (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3100}`).replace(/\/+$/, ''), ctx.timeZone ?? null,
       String(ctx.debug?.level ?? 0), UUID.test(ctx.sessionId) ? ctx.sessionId : null],
    );
    if (ctx.dbRole) await c.query(`set local role ${pg.escapeIdentifier(ctx.dbRole)}`);
    if (!ctx.debug) return fn(c);
    const debug = ctx.debug;
    const listener = (msg: { message?: string; detail?: string; hint?: string; severity?: string }) => debug.notice(msg);
    c.on('notice', listener);
    try {
      return await fn(c);
    } finally {
      c.off('notice', listener);
    }
  });
}

let savepoints = 0;

/** Run `fn` inside a savepoint so a failure doesn't abort the surrounding transaction. */
export async function savepoint<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  const name = `sp${++savepoints}`;
  await c.query(`savepoint ${name}`);
  try {
    const result = await fn();
    await c.query(`release savepoint ${name}`);
    return result;
  } catch (e) {
    await c.query(`rollback to savepoint ${name}`);
    throw e;
  }
}
