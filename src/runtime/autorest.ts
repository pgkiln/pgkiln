import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import { owner, runtime, type Client } from '../db.ts';
import { english } from '../i18n.ts';
import { loadApp, type App } from '../metadata.ts';
import { clientIp } from '../session.ts';
import { availabilityRefusal } from './availability.ts';
import { publicError } from './context.ts';
import { caller, RestError, restServicesOn } from './rest.ts';

// (sprint 100, Database Actions DA-11 part 1) AutoREST: a table or view that SQL Workshop › RESTful Services
// enabled (meta.rest_object, migration 113), served through an application:
//
//   GET    /a/<alias>/autorest/<object>/           rows, paged: ?limit= (1–500) &offset= ; filters: ?<column>=<value>
//                                                  (equality), ?q= (text columns contain it), ?order=col,col.desc
//   POST   /a/<alias>/autorest/<object>/           a JSON object: the new row (201)
//   GET    /a/<alias>/autorest/<object>/<key>      one row by primary key (composite keys: 1,2), 404 when there is none
//   PUT    /a/<alias>/autorest/<object>/<key>      the JSON object's columns changed; the row (200) or 404
//   DELETE /a/<alias>/autorest/<object>/<key>      204 or 404
//   GET    /a/<alias>/autorest/openapi.json        OpenAPI 3 of the application's objects (public ones without a token)
//
// Authentication is the application's (as for its REST modules, rest.ts caller()): a bearer token of an account
// or an OAuth client of the application; "public" objects need none (meta.app_user() = nobody). The statement
// runs as the application's database role with meta.app_user() and meta.has_role() set, so grants (also column
// grants) and row level security apply. The role may not be the object's owner (or a member of it), a superuser
// or a role that bypasses row level security: checked at every request, after SET ROLE. Names come from the
// catalog and are quoted; every value is a query parameter.

export interface RestObject {
  id: number;
  app_id: number;
  schema_name: string;
  object_name: string;
  alias: string;
  methods: string[];
  auth: 'token' | 'public';
  roles: string[];
  page_size: number;
  enabled: boolean;
}

export interface Column {
  name: string;
  type: string;
  /** pg_type.typcategory: S string, N numeric, B boolean, D date/time, … */
  cat: string;
  readable: boolean;
  /** position in the primary key (1…), or null */
  pk: number | null;
}

export const AUTOREST_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export const MAX_PAGE = 500;
/** Query parameters that are not column filters. */
const RESERVED = new Set(['limit', 'offset', 'q', 'order']);
export const RELKINDS: Record<string, string> = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' };

const ident = pg.escapeIdentifier;
export const qualified = (o: Pick<RestObject, 'schema_name' | 'object_name'>) => `${ident(o.schema_name)}.${ident(o.object_name)}`;

/** The columns of a relation as `role` may use them (the catalog only; no privilege needed to read it). */
export async function describeColumns(db: { query: (sql: string, params: unknown[]) => Promise<pg.QueryResult> }, schema: string, name: string, role: string): Promise<Column[]> {
  return (await db.query(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typcategory as cat,
            has_column_privilege($3, c.oid, a.attnum, 'SELECT') as readable,
            (select array_position(i.indkey::int2[], a.attnum) from pg_index i where i.indrelid = c.oid and i.indisprimary) as pk
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       join pg_type t on t.oid = a.atttypid
      where n.nspname = $1 and c.relname = $2
      order by a.attnum`,
    [schema, name, role],
  )).rows as Column[];
}

/** The primary key's columns in key order. */
export const keyColumns = (cols: Column[]) => cols.filter((c) => c.pk !== null).sort((a, b) => a.pk! - b.pk!);

/** The object a request names, if the application published it and it is on. */
async function objectOf(a: App, alias: string) {
  const o = await runtime.one<RestObject>('select * from meta.rest_object where app_id = $1 and alias = $2', [a.id, alias]);
  return o?.enabled ? o : undefined;
}

/** Split a key segment "1" or "10,20" into its values (each part URL-decoded on its own). */
export function splitKey(raw: string, n: number): string[] | null {
  if (!raw || raw.includes('/')) return null;
  const parts = raw.split(',');
  if (parts.length !== n) return null;
  try {
    return parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
}

/** The ORDER BY of ?order=a,b.desc: only readable columns; null when it names something else. */
export function orderBy(spec: string | undefined, cols: Column[]): string | null {
  const readable = new Map(cols.filter((c) => c.readable).map((c) => [c.name, c]));
  if (spec === undefined || spec === '') {
    const key = keyColumns(cols).filter((c) => c.readable);
    return key.length ? key.map((c) => `t.${ident(c.name)}`).join(', ') : '1';
  }
  const out: string[] = [];
  for (const part of spec.split(',')) {
    const m = /^(.+?)(?:\.(asc|desc))?$/.exec(part);
    if (!m || !readable.has(m[1])) return null;
    out.push(`t.${ident(m[1])}${m[2] === 'desc' ? ' desc' : ''}`);
  }
  return out.join(', ');
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (x) => `\\${x}`);
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/** Checks run after SET ROLE: the role isn't the owner and doesn't bypass row level security. */
async function checkRole(c: Client, o: RestObject) {
  const r = (await c.query(
    `select c.relkind, pg_has_role(current_user, c.relowner, 'MEMBER') as owns, r.rolsuper or r.rolbypassrls as bypass
       from pg_class c join pg_namespace n on n.oid = c.relnamespace, pg_roles r
      where n.nspname = $1 and c.relname = $2 and r.rolname = current_user`,
    [o.schema_name, o.object_name],
  )).rows[0];
  if (!r || !RELKINDS[r.relkind]) throw new RestError(404, 'Not found');
  if (r.owns || r.bypass) throw new RestError(403, 'The application\'s database role owns this object or bypasses row level security: AutoREST refuses it.');
  return r.relkind as string;
}

/** A JSON body as an object of known columns; RestError otherwise. */
function bodyColumns(body: unknown, cols: Column[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) throw new RestError(400, 'The body is a JSON object of column values.');
  const names = new Set(cols.map((c) => c.name));
  const keys = Object.keys(body as object);
  const unknown = keys.filter((k) => !names.has(k));
  if (unknown.length) throw new RestError(400, `Unknown column(s): ${unknown.slice(0, 5).join(', ')}.`);
  return keys;
}

async function handle(req: FastifyRequest, reply: FastifyReply) {
  const p = req.params as { alias: string; object: string; '*'?: string };
  const keyRaw = (p['*'] ?? '').replace(/\/+$/, '');
  const a = await loadApp(p.alias);
  const o = a ? await objectOf(a, p.object) : undefined;
  if (!a || !o || !(await restServicesOn(a.id))) return reply.code(404).send({ error: 'Not found' });
  const method = req.method;
  const allowed = o.methods.filter((m) => (keyRaw ? m !== 'POST' : m === 'GET' || m === 'POST'));
  if (!o.methods.includes(method) || !allowed.includes(method)) return reply.code(405).header('allow', allowed.join(', ')).send({ error: `${method} is not allowed here.` });
  try {
    const who = await caller(req, a, o.auth === 'public');
    const refusal = availabilityRefusal(a, { username: who.user === 'nobody' ? null : who.user, developer: false });
    if (refusal) throw new RestError(refusal.status, refusal.message ?? english(refusal.key));
    if (!a.db_role) throw new RestError(403, 'The application has no database role: AutoREST needs one.');
    const result = await runtime.tx(async (c) => {
      await c.query(
        `select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true), set_config('pgkiln.session_id', '', true),
                set_config('request.jwt.claims', $3, true), set_config('statement_timeout', '30s', true)`,
        [String(a.id), who.user, who.claims ? JSON.stringify(who.claims) : ''],
      );
      if (o.roles.length) {
        const ok = (await c.query('select bool_or(meta.has_role(r)) as ok from unnest($1::text[]) r', [o.roles])).rows[0].ok;
        if (!ok) throw new RestError(403, 'You do not have a role this endpoint needs.');
      }
      await c.query(`set local role ${ident(a.db_role!)}`);
      await checkRole(c, o);
      const cols = await describeColumns(c, o.schema_name, o.object_name, a.db_role!);
      const readable = cols.filter((x) => x.readable);
      const list = readable.map((x) => `t.${ident(x.name)}`).join(', ');
      const returning = list ? ` returning ${list}` : '';
      const rel = qualified(o);
      const key = keyColumns(cols);
      const params: unknown[] = [];
      const param = (v: unknown) => `$${params.push(v)}`;
      let where = '';
      if (keyRaw) {
        const values = key.length ? splitKey(keyRaw, key.length) : null;
        if (!values) throw new RestError(404, 'Not found');
        where = key.map((k, i) => `t.${ident(k.name)} = ${param(values[i])}`).join(' and ');
      }

      if (method === 'GET' && !keyRaw) {
        if (!readable.length) throw new RestError(403, 'Not allowed.');
        const q = req.query as Record<string, string | string[]>;
        const conds: string[] = [];
        for (const [k, raw] of Object.entries(q)) {
          if (RESERVED.has(k)) continue;
          const col = readable.find((x) => x.name === k);
          if (!col) throw new RestError(400, `Unknown parameter ${k.slice(0, 63)}: filter on a column, or use limit, offset, q, order.`);
          conds.push(`t.${ident(col.name)} = ${param(String(one(raw)))}`);
        }
        const search = one(q.q);
        if (search) {
          const text = readable.filter((x) => x.cat === 'S');
          if (!text.length) throw new RestError(400, 'q= searches text columns, and this object has none you may read.');
          const v = param(`%${likeEscape(String(search))}%`);
          conds.push(`(${text.map((x) => `t.${ident(x.name)} ilike ${v}`).join(' or ')})`);
        }
        const order = orderBy(one(q.order) as string | undefined, cols);
        if (order === null) throw new RestError(400, 'order= is a list of readable columns, each optionally followed by .asc or .desc.');
        const limitRaw = one(q.limit);
        const offsetRaw = one(q.offset);
        if ((limitRaw !== undefined && !/^\d{1,9}$/.test(String(limitRaw))) || (offsetRaw !== undefined && !/^\d{1,12}$/.test(String(offsetRaw))))
          throw new RestError(400, 'limit and offset are whole numbers.');
        const limit = Math.max(1, Math.min(MAX_PAGE, limitRaw !== undefined ? Number(limitRaw) : o.page_size));
        const offset = offsetRaw !== undefined ? Number(offsetRaw) : 0;
        const rows = (await c.query(
          `select ${list} from ${rel} t${conds.length ? ` where ${conds.join(' and ')}` : ''} order by ${order} limit ${limit + 1} offset ${offset}`,
          params,
        )).rows;
        return { status: 200, body: { items: rows.slice(0, limit), offset, limit, has_more: rows.length > limit } };
      }
      if (method === 'GET') {
        if (!readable.length) throw new RestError(403, 'Not allowed.');
        const row = (await c.query(`select ${list} from ${rel} t where ${where} limit 1`, params)).rows[0];
        if (!row) throw new RestError(404, 'Not found');
        return { status: 200, body: row };
      }
      if (method === 'POST') {
        const names = bodyColumns(req.body, cols);
        const sql = names.length
          ? `insert into ${rel} as t (${names.map(ident).join(', ')}) select ${names.map((n) => `b.${ident(n)}`).join(', ')} from json_populate_record(null::${rel}, ${param(JSON.stringify(req.body))}::json) b${returning}`
          : `insert into ${rel} as t default values${returning}`;
        const row = (await c.query(sql, params)).rows[0];
        const keyOk = key.length && key.every((k) => k.readable) && row;
        return { status: 201, body: row ?? {}, location: keyOk ? key.map((k) => encodeURIComponent(String(row[k.name] instanceof Date ? row[k.name].toISOString() : row[k.name]))).join(',') : undefined };
      }
      if (method === 'PUT') {
        const names = bodyColumns(req.body, cols);
        if (!names.length) throw new RestError(400, 'The body names no columns to change.');
        const b = param(JSON.stringify(req.body));
        const res = await c.query(
          `update ${rel} as t set ${names.map((n) => `${ident(n)} = b.${ident(n)}`).join(', ')} from json_populate_record(null::${rel}, ${b}::json) b where ${where}${returning}`,
          params,
        );
        if (!res.rowCount) throw new RestError(404, 'Not found');
        return { status: 200, body: res.rows[0] ?? {} };
      }
      // DELETE
      const res = await c.query(`delete from ${rel} t where ${where}`, params);
      if (!res.rowCount) throw new RestError(404, 'Not found');
      return { status: 204, body: undefined };
    });
    reply.header('cache-control', 'no-store');
    if ('location' in result && result.location) reply.header('location', `/a/${encodeURIComponent(a.alias)}/autorest/${o.alias}/${result.location}`);
    return result.body === undefined ? reply.code(204).send() : reply.code(result.status).send(result.body);
  } catch (e) {
    if (e instanceof RestError) return reply.code(e.status).send({ error: e.message });
    const err = e as pg.DatabaseError;
    const message = await publicError({ app: a, page: { page_no: 0 } as never, user: 'api', ip: clientIp(req) }, e, `AutoREST ${method} ${o.alias}`);
    const status = err.code === '42501' ? 403 : err.code && /^(P0001|22|23|42804|428C9)/.test(err.code) ? 400 : 500;
    return reply.code(status).send({ error: status === 403 ? 'Not allowed.' : message });
  }
}

/** JSON Schema of a column type (for the OpenAPI description). */
function jsonType(c: Column): Record<string, unknown> {
  if (/^(smallint|integer|bigint)$/.test(c.type)) return { type: 'integer' };
  if (c.cat === 'N') return { type: 'number' };
  if (c.cat === 'B') return { type: 'boolean' };
  if (c.type === 'date') return { type: 'string', format: 'date' };
  if (c.cat === 'D') return { type: 'string', format: 'date-time' };
  if (c.cat === 'S') return { type: 'string' };
  if (c.cat === 'A') return { type: 'array', items: {} };
  return {};
}

/** The OpenAPI 3 description of an application's AutoREST objects. */
export function autoRestOpenApi(a: Pick<App, 'alias' | 'name'>, objects: { o: RestObject; cols: Column[] }[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  const errors = (o: RestObject) => (o.auth === 'public' ? {} : { 401: { description: 'No valid token' }, 403: { description: 'Not allowed' } });
  for (const { o, cols } of objects) {
    const readable = cols.filter((c) => c.readable);
    const name = o.alias.replace(/[^A-Za-z0-9_.-]/g, '_');
    schemas[name] = { type: 'object', properties: Object.fromEntries(readable.map((c) => [c.name, { ...jsonType(c), description: c.type }])) };
    const ref = { $ref: `#/components/schemas/${name}` };
    const sec = o.auth === 'public' ? { security: [] } : {};
    const body = { required: true, content: { 'application/json': { schema: ref } } };
    const coll: Record<string, unknown> = {};
    if (o.methods.includes('GET'))
      coll.get = {
        summary: `Rows of ${o.schema_name}.${o.object_name}`, ...sec,
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: o.page_size } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'q', in: 'query', description: 'Rows whose text columns contain this', schema: { type: 'string' } },
          { name: 'order', in: 'query', description: 'Columns, each optionally .asc or .desc, comma separated', schema: { type: 'string' } },
          ...readable.filter((c) => !RESERVED.has(c.name)).map((c) => ({ name: c.name, in: 'query', description: `${c.name} equals`, schema: { type: 'string' } })),
        ],
        responses: { 200: { description: '{items, offset, limit, has_more}', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: ref }, offset: { type: 'integer' }, limit: { type: 'integer' }, has_more: { type: 'boolean' } } } } } }, 400: { description: 'A filter is not valid' }, ...errors(o) },
      };
    if (o.methods.includes('POST'))
      coll.post = { summary: `New row in ${o.schema_name}.${o.object_name}`, ...sec, requestBody: body, responses: { 201: { description: 'The new row', content: { 'application/json': { schema: ref } } }, 400: { description: 'Invalid values' }, ...errors(o) } };
    if (Object.keys(coll).length) paths[`/${o.alias}/`] = coll;
    const key = keyColumns(cols);
    if (!key.length) continue;
    const item: Record<string, unknown> = { parameters: [{ name: 'key', in: 'path', required: true, description: `${key.map((k) => k.name).join(', ')}${key.length > 1 ? ' (comma separated)' : ''}`, schema: { type: 'string' } }] };
    const notFound = { 404: { description: 'Not found' } };
    if (o.methods.includes('GET')) item.get = { summary: 'One row by its key', ...sec, responses: { 200: { description: 'The row', content: { 'application/json': { schema: ref } } }, ...notFound, ...errors(o) } };
    if (o.methods.includes('PUT')) item.put = { summary: 'Change the columns the body names', ...sec, requestBody: body, responses: { 200: { description: 'The changed row', content: { 'application/json': { schema: ref } } }, ...notFound, ...errors(o) } };
    if (o.methods.includes('DELETE')) item.delete = { summary: 'Delete the row', ...sec, responses: { 204: { description: 'Deleted' }, ...notFound, ...errors(o) } };
    if (Object.keys(item).length > 1) paths[`/${o.alias}/{key}`] = item;
  }
  return {
    openapi: '3.0.3',
    info: { title: `${a.name} AutoREST`, description: 'Tables and views published with SQL Workshop › RESTful Services', version: '1' },
    servers: [{ url: `/a/${a.alias}/autorest` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas },
    security: [{ bearer: [] }],
    paths,
  };
}

export async function autoRestRoutes(app: FastifyInstance) {
  // without a token: the public objects only; with a valid token of the application: all of them
  app.get<{ Params: { alias: string } }>('/a/:alias/autorest/openapi.json', async (req, reply) => {
    const a = await loadApp(req.params.alias);
    if (!a || !(await restServicesOn(a.id))) return reply.code(404).send({ error: english('error.not_found') });
    let all = false;
    if (req.headers.authorization) {
      try {
        all = (await caller(req, a, false)).user !== 'nobody';
      } catch (e) {
        if (e instanceof RestError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    }
    const rows = (await runtime.query<RestObject>('select * from meta.rest_object where app_id = $1 and enabled order by alias', [a.id])).rows.filter((o) => all || o.auth === 'public');
    const objects = a.db_role
      ? await Promise.all(rows.map(async (o) => ({ o, cols: await describeColumns(owner, o.schema_name, o.object_name, a.db_role!) })))
      : [];
    return reply.header('cache-control', 'no-store').send(autoRestOpenApi(a, objects.filter((x) => x.cols.length)));
  });
  const methods = [...AUTOREST_METHODS] as never;
  app.route({ method: methods, url: '/a/:alias/autorest/:object', handler: handle });
  app.route({ method: methods, url: '/a/:alias/autorest/:object/*', handler: handle });
}
