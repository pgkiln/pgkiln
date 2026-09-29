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

const ownerUrl = process.env.DATABASE_URL ?? 'postgres://pgapex:pgapex@localhost:5434/pgapex';
if (!process.env.RUNTIME_DATABASE_URL)
  console.warn('RUNTIME_DATABASE_URL is not set: applications run on the owner connection (not least privilege).');

/** Owner connection: builder, SQL Workshop, migrations. */
export const owner = makePool(ownerUrl, 'pgapex-builder');
/** Least-privilege connection (pgapex_runtime) that runs applications. */
export const runtime = makePool(process.env.RUNTIME_DATABASE_URL ?? ownerUrl, 'pgapex-runtime');

export async function closePools() {
  await Promise.all([owner.pool.end(), runtime.pool.end()]);
}

export interface AppContext {
  appId: number;
  alias: string;
  dbRole: string | null;
  appUser: string;
  sessionId: string;
}

/**
 * Run developer SQL for an application: inside a transaction, as the app's
 * database role (so grants and RLS apply), with the app, user and session
 * exposed to SQL via meta.app_id(), meta.app_user() and meta.v().
 */
export async function appTx<T>(ctx: AppContext, fn: (c: Client) => Promise<T>): Promise<T> {
  return runtime.tx(async (c) => {
    await c.query(
      `select set_config('pgapex.app_user', $1, true),
              set_config('pgapex.session_id', $2, true),
              set_config('pgapex.app_id', $3, true),
              set_config('statement_timeout', $4, true)`,
      [ctx.appUser, ctx.sessionId, String(ctx.appId), process.env.STATEMENT_TIMEOUT ?? '30s'],
    );
    if (ctx.dbRole) await c.query(`set local role ${pg.escapeIdentifier(ctx.dbRole)}`);
    return fn(c);
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
