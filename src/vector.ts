import pg from 'pg';
import { embedsInDatabase, embedTexts, loadVectorProviders, vectorLiteral, vectorProviderProblems, DEFAULT_BATCH, DEFAULT_PER_MINUTE, type VectorProvider } from './ai/embeddings.ts';
import { isAiError } from './ai/types.ts';
import { owner } from './db.ts';
import { appIsolated, devDbForApp } from './workspace-db.ts';

// (sprint 136, AP-1) pgvector, and keeping vector columns current.
//
// pgvector is an extension that may be missing: stock postgres images don't have it. pgvectorStatus() says what
// there is (as the SQL Workshop does for pg_cron), vectorType() the schema-qualified type name to use; nothing in
// meta needs the extension.
//
// The embedding queue (migration 136): a vector column kept by a queue has an AFTER INSERT OR UPDATE OF … trigger
// (meta.embedding_enqueue) that puts the row's key in meta.embedding_queue; Backfill queues the rows without an
// embedding. embeddingTick() takes queued rows of one table and provider (FOR UPDATE SKIP LOCKED, so several
// servers share the queue), reads their source columns, embeds them in batches of the provider's batch_size
// within its requests per minute (and the application's daily AI limits), and writes the vectors. It reads and
// writes the table with the developer connection of the application's workspace (the owner, or an isolated
// workspace's developer login), as the SQL Workshop that created the column does. A failed batch is retried later
// (1, 2, 4 … minutes; at most 6 attempts), its message kept for the builder.

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface PgvectorStatus {
  /** the extension is created in this database */
  installed: boolean;
  version: string | null;
  schema: string | null;
  /** the server has the package (pg_available_extensions) */
  available: boolean;
  availableVersion: string | null;
  /** the connection may create it (a superuser; pgvector is not a trusted extension) */
  canCreate: boolean;
}

export async function pgvectorStatus(db: Queryable): Promise<PgvectorStatus> {
  const r = (await db.query(
    `select e.extversion as version, n.nspname as schema, a.default_version as available_version,
            (select rolsuper from pg_catalog.pg_roles where rolname = current_user) as superuser
       from (select 1) x
       left join pg_catalog.pg_extension e on e.extname = 'vector'
       left join pg_catalog.pg_namespace n on n.oid = e.extnamespace
       left join pg_catalog.pg_available_extensions a on a.name = 'vector'`,
  )).rows[0];
  return {
    installed: !!r.version, version: r.version ?? null, schema: r.schema ?? null,
    available: !!r.available_version, availableVersion: r.available_version ?? null, canCreate: !!r.superuser,
  };
}

/** The schema of pgvector when it is installed (its type and operators are used schema-qualified), else null. */
export async function vectorSchema(db: Queryable): Promise<string | null> {
  return (await db.query(`select n.nspname as s from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector'`)).rows[0]?.s ?? null;
}

/** What to say when pgvector is missing (builder and runtime messages). */
export const PGVECTOR_MISSING = 'The pgvector extension is not installed in this database: an administrator installs the package on the database server (e.g. apt install postgresql-17-pgvector, or the pgvector/pgvector Docker image) and creates it (Workspace utilities → Vector providers, or create extension vector as a superuser).';

/** The distances of pgvector: operator, HNSW operator class, and the similarity (higher is closer) as SQL of `d`. */
export const DISTANCES = {
  cosine: { op: '<=>', opclass: 'vector_cosine_ops', similarity: (d: string) => `(1 - ${d})` },
  l2: { op: '<->', opclass: 'vector_l2_ops', similarity: (d: string) => `(1 / (1 + ${d}))` },
  inner_product: { op: '<#>', opclass: 'vector_ip_ops', similarity: (d: string) => `(-${d})` },
} as const;
export type Distance = keyof typeof DISTANCES;
export const isDistance = (d: unknown): d is Distance => typeof d === 'string' && Object.hasOwn(DISTANCES, d);

/** `a <=> b` with pgvector's operator schema-qualified (an application role's search_path may not have it). */
export const distanceSql = (schema: string, d: Distance, a: string, b: string) => `${a} OPERATOR(${pg.escapeIdentifier(schema)}.${DISTANCES[d].op}) ${b}`;

/** The dimensions of a vector column (its typmod), or null when it is no vector(n) column. */
export async function vectorColumnDims(db: Queryable, table: string, column: string): Promise<number | null | undefined> {
  const r = (await db.query(
    `select t.typname = 'vector' as is_vector, a.atttypmod as dims
       from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid = a.atttypid
      where a.attrelid = $1::regclass and a.attname = $2 and a.attnum > 0 and not a.attisdropped`, [table, column])).rows[0];
  if (!r) return undefined;
  return r.is_vector && r.dims > 0 ? r.dims : null;
}

// ---------------------------------------------------------------- the queue

const COLUMN = /^[a-z_][a-z0-9_$]{0,62}$/;
const MAX_ATTEMPTS = 6;
/** Requests per provider in the last minute (this process). */
const sent = new Map<string, number[]>();

function mayRequest(key: string, perMinute: number) {
  const now = Date.now();
  const times = (sent.get(key) ?? []).filter((t) => now - t < 60_000);
  sent.set(key, times);
  if (times.length >= perMinute) return false;
  times.push(now);
  return true;
}

interface Group { app_id: number; provider: string; tbl: number; vector_column: string; key_column: string; source_columns: string[] }

/** Embed one batch of a group; returns the number of rows written (0: nothing to do or wait). */
async function runBatch(g: Group, p: VectorProvider): Promise<number> {
  const batch = p.type === 'ai_service' ? (p.batch_size ?? DEFAULT_BATCH) : 100;
  if (p.type === 'ai_service' && !mayRequest(`${g.app_id}:${p.name}`, p.per_minute ?? DEFAULT_PER_MINUTE)) return 0;
  return owner.tx(async (q) => {
    const rows = (await q.query<{ id: string; key_value: string; queued_at: string }>(
      `select id, key_value, queued_at::text from meta.embedding_queue
        where app_id = $1 and provider = $2 and tbl = $3 and vector_column = $4 and key_column = $5 and source_columns = $6 and next_at <= now()
        order by id limit $7 for update skip locked`,
      [g.app_id, g.provider, g.tbl, g.vector_column, g.key_column, g.source_columns, batch])).rows;
    if (!rows.length) return 0;
    const ids = rows.map((r) => r.id);
    const fail = async (message: string) => {
      await q.query(
        `update meta.embedding_queue set attempts = attempts + 1, last_error = left($2, 500),
                next_at = now() + make_interval(mins => power(2, least(attempts, 6))::int)
          where id = any($1::bigint[])`, [ids, message]);
      return 0;
    };
    // (sprint 185) a provider that embeds in the database runs the developer's function: the developer login (never the
    // owner); an AI service provider's statements are pgkiln's own (checked names) and read every row, past row level
    // security, as before: the owner for a shared workspace's application, the isolated workspace's login otherwise
    const db = embedsInDatabase(p) || (await appIsolated(g.app_id)) ? await devDbForApp(g.app_id) : owner;
    const table = (await db.query<{ t: string | null }>('select $1::oid::regclass::text as t from pg_catalog.pg_class where oid = $1', [g.tbl])).rows[0]?.t;
    if (!table) {
      // the table is gone
      await q.query('delete from meta.embedding_queue where id = any($1::bigint[])', [ids]);
      return 0;
    }
    if (![g.vector_column, g.key_column, ...g.source_columns].every((c) => COLUMN.test(c))) return fail('The trigger names a column that is not a plain name.');
    const id = pg.escapeIdentifier;
    const text = `meta.embedding_text(to_jsonb(t), $2::text[])`;
    try {
      let written = 0;
      if (embedsInDatabase(p)) {
        // a function or database model provider: embedded in the database, as the developer connection (the trigger's own function)
        await db.query(
          `update ${table} t set ${id(g.vector_column)} = translate(meta.embed(${text}, $3, $4)::text, '{}', '[]')::text::${await vectorTypeOf(db)}
            where t.${id(g.key_column)}::text = any($1::text[])`, [rows.map((r) => r.key_value), g.source_columns, p.name, g.app_id]);
        written = rows.length;
      } else {
        const found = (await db.query<{ k: string; t: string | null }>(
          `select t.${id(g.key_column)}::text as k, ${text} as t from ${table} t where t.${id(g.key_column)}::text = any($1::text[])`,
          [rows.map((r) => r.key_value), g.source_columns])).rows;
        const withText = found.filter((r) => r.t);
        const vectors = withText.length ? await embedTexts(p, withText.map((r) => r.t!), { appId: g.app_id, user: null, pageNo: null }) : [];
        const type = await vectorTypeOf(db);
        // rows without text get no embedding; rows deleted meanwhile are simply gone
        await db.query(
          `update ${table} t set ${id(g.vector_column)} = x.v::${type}
             from unnest($1::text[], $2::text[]) x(k, v) where t.${id(g.key_column)}::text = x.k`,
          [[...withText.map((r) => r.k), ...found.filter((r) => !r.t).map((r) => r.k)], [...vectors.map(vectorLiteral), ...found.filter((r) => !r.t).map(() => null)]]);
        written = found.length;
      }
      // done, unless the row was queued again meanwhile (the trigger moved queued_at)
      await q.query(
        `delete from meta.embedding_queue e using unnest($1::bigint[], $2::text[]) x(id, at) where e.id = x.id and e.queued_at::text = x.at`,
        [ids, rows.map((r) => r.queued_at)]);
      return Math.max(written, 1);
    } catch (e) {
      const message = isAiError(e) ? e.message : (e as Error).message;
      return fail(message);
    }
  });
}

/** pgvector's type, schema-qualified, for casts. */
async function vectorTypeOf(db: Queryable) {
  const s = await vectorSchema(db);
  if (!s) throw new Error(PGVECTOR_MISSING);
  return `${pg.escapeIdentifier(s)}.vector`;
}

let lastPurge = 0;

/** One round of the queue: a batch of each group with work (call again until it returns 0). */
export async function embeddingTick(): Promise<number> {
  if (Date.now() - lastPurge > 3_600_000) {
    lastPurge = Date.now();
    await owner.query(`delete from meta.embedding_queue where attempts >= $1 and next_at < now() - interval '7 days'`, [MAX_ATTEMPTS]);
  }
  const groups = (await owner.query<Group>(
    `select distinct app_id, provider, tbl, vector_column, key_column, source_columns from meta.embedding_queue
      where next_at <= now() and attempts < $1 limit 20`, [MAX_ATTEMPTS])).rows;
  let done = 0;
  const providers = new Map<number, VectorProvider[]>();
  for (const g of groups) {
    if (!providers.has(g.app_id)) providers.set(g.app_id, await loadVectorProviders(g.app_id));
    const p = providers.get(g.app_id)!.find((x) => x.name === g.provider);
    if (!p || vectorProviderProblems(p).length) {
      await owner.query(
        `update meta.embedding_queue set attempts = $5, last_error = $6, next_at = now() + interval '10 minutes'
          where app_id = $1 and provider = $2 and tbl = $3 and vector_column = $4`,
        [g.app_id, g.provider, g.tbl, g.vector_column, MAX_ATTEMPTS, `There is no valid vector provider ${g.provider} in application ${g.app_id}.`]);
      continue;
    }
    try {
      done += await runBatch(g, p);
    } catch (e) {
      console.error('embeddings:', (e as Error).message);
    }
  }
  return done;
}

/** Work the queue until it is empty or waiting (tests, Backfill); at most `rounds` rounds. */
export async function drainEmbeddings(rounds = 50) {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const n = await embeddingTick();
    if (!n) break;
    total += n;
  }
  return total;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

/** Kick the queue now (after a Backfill), without waiting for it (not with EMBEDDINGS=off). */
export function kickEmbeddings() {
  if (busy || process.env.EMBEDDINGS === 'off') return;
  busy = true;
  drainEmbeddings(20).catch((e) => console.error('embeddings:', (e as Error).message)).finally(() => (busy = false));
}

/** Started by server.ts; EMBEDDINGS=off on servers that should not embed, EMBEDDING_INTERVAL_S (default 5). */
export function startEmbeddingRunner() {
  if (process.env.EMBEDDINGS === 'off' || timer) return;
  const every = Math.max(1, Number(process.env.EMBEDDING_INTERVAL_S ?? 5)) * 1000;
  timer = setInterval(() => kickEmbeddings(), every);
  timer.unref();
}

/** The queue of a vector column: waiting rows, failing rows and the last message. */
export async function queueState(tbl: number, column: string) {
  return (await owner.one<{ queued: number; failing: number; message: string | null }>(
    `select count(*)::int as queued, count(*) filter (where attempts > 0)::int as failing,
            (select last_error from meta.embedding_queue where tbl = $1 and vector_column = $2 and last_error is not null order by id desc limit 1) as message
       from meta.embedding_queue where tbl = $1 and vector_column = $2`, [tbl, column]))!;
}

// ---------------------------------------------------------------- the triggers that keep vector columns

export interface VectorTrigger {
  table: string;
  tbl: number;
  trigger: string;
  /** set: a function provider's embedding at once (BEFORE); queue: queued for the server (AFTER) */
  mode: 'set' | 'queue';
  appId: number;
  provider: string;
  vectorColumn: string;
  keyColumn: string;
  sourceColumns: string[];
}

/** The meta.embedding_set / meta.embedding_enqueue triggers (of one table, or of every table), with their arguments. */
export async function vectorTriggers(db: Queryable, table?: string): Promise<VectorTrigger[]> {
  const rows = (await db.query(
    `select t.tgrelid::regclass::text as tbl_name, t.tgrelid::int as tbl, t.tgname as trigger, p.proname as fn, pg_catalog.pg_get_triggerdef(t.oid) as def
       from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'meta' and p.proname in ('embedding_set', 'embedding_enqueue') and not t.tgisinternal
        and ($1::text is null or t.tgrelid = $1::regclass)
      order by 1, 3`, [table ?? null])).rows;
  const out: VectorTrigger[] = [];
  for (const r of rows) {
    const args = [...String(/EXECUTE FUNCTION [^(]+\((.*)\)\s*$/i.exec(r.def)?.[1] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    if (args.length < 5 || !/^\d+$/.test(args[0])) continue;
    out.push({
      table: r.tbl_name, tbl: r.tbl, trigger: r.trigger, mode: r.fn === 'embedding_set' ? 'set' : 'queue', appId: Number(args[0]),
      provider: args[1].toUpperCase(), vectorColumn: args[2], keyColumn: args[3], sourceColumns: args.slice(4),
    });
  }
  return out;
}

/** Queue rows of a vector column for the server: those without an embedding, or all of them. Returns how many. */
export async function backfill(db: Queryable, t: VectorTrigger, all: boolean, max = 100_000): Promise<number> {
  const id = pg.escapeIdentifier;
  const keys = (await db.query(
    `select t.${id(t.keyColumn)}::text as k from ${t.table} t ${all ? '' : `where t.${id(t.vectorColumn)} is null`} order by 1 limit ${max}`)).rows.map((r: { k: string }) => r.k);
  for (let i = 0; i < keys.length; i += 5000) {
    await owner.query(
      `insert into meta.embedding_queue (app_id, provider, tbl, vector_column, key_column, source_columns, key_value)
       select $1, $2, $3, $4, $5, $6, k from unnest($7::text[]) k
       on conflict (tbl, vector_column, key_value) do update
          set app_id = excluded.app_id, provider = excluded.provider, key_column = excluded.key_column, source_columns = excluded.source_columns,
              queued_at = now(), next_at = now(), attempts = 0, last_error = null`,
      [t.appId, t.provider, t.tbl, t.vectorColumn, t.keyColumn, t.sourceColumns, keys.slice(i, i + 5000)]);
  }
  return keys.length;
}
