import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import pg from 'pg';
import { jwtSecret } from '../api.ts';
import { applyBinds, splitStatements, type BindValues } from '../binds.ts';
import { owner, runtime } from '../db.ts';
import { english } from '../i18n.ts';
import { loadApp, type App } from '../metadata.ts';
import { clientIp } from '../session.ts';
import { PassThrough } from 'node:stream';
import { publicError, writeOut } from './context.ts';

// REST modules (APEX: RESTful Services): handlers defined in the builder,
// served under /a/<alias>/rest/<module>/<path>.
//
//   {"method": "GET", "path": "employees", "type": "collection", "source": "select … order by empno"}
//   {"method": "GET", "path": "employees/:empno", "type": "item", "source": "select … where empno = :EMPNO::int"}
//   {"method": "POST", "path": "leave", "type": "sql", "source": "select hr.request_leave(:START_DATE::date, …) as id", "status": 201}
//   optional: "roles": ["manager"], "auth": "public", "description": "…", "page_size": 25
//
// Callers send a bearer token: a pgapex API token (an account) or an OAuth
// client token (App → REST API). The account must be active with access to
// the app, a client must not be revoked: checked on every request, as
// PostgREST's meta.api_check does. The SQL runs as the application's
// database role with meta.app_user() = the caller and meta.has_role()
// reading the token's roles, so the application's row level security
// applies. Binds: path parameters, query parameters and the fields of a
// JSON (or form) body, upper case; :BODY is the raw JSON body.
// Responses: collection {items, offset, limit, has_more}; item an object
// or 404; sql the first row of the last statement (or 204).

export interface Handler {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  type: 'collection' | 'item' | 'sql';
  source: string;
  roles?: string[];
  auth?: 'token' | 'public';
  description?: string;
  page_size?: number;
  status?: number;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const TYPES = ['collection', 'item', 'sql'];
const SEGMENT = /^(:[a-z][a-z0-9_]*|[a-z0-9][a-z0-9._-]*)$/i;
const MAX_PAGE = 500;
/** Rows fetched from a collection's cursor at a time. */
const REST_BATCH = 100;

/** Problems in a module's handlers (for the builder), or []. */
export function handlerProblems(handlers: unknown): string[] {
  if (!Array.isArray(handlers)) return ['The handlers must be a JSON array.'];
  const problems: string[] = [];
  const seen = new Set<string>();
  handlers.forEach((h: any, i) => {
    const at = `Handler ${i + 1}`;
    if (!h || typeof h !== 'object') return void problems.push(`${at} is not an object.`);
    if (!METHODS.includes(h.method)) problems.push(`${at}: "method" is one of ${METHODS.join(', ')}.`);
    if (typeof h.path !== 'string' || (h.path !== '' && !h.path.split('/').every((s: string) => SEGMENT.test(s))))
      problems.push(`${at}: "path" is like employees or employees/:empno (letters, digits, - _ . and :parameters).`);
    else if (h.path === 'openapi.json') problems.push(`${at}: openapi.json is reserved for the module's description.`);
    if (!TYPES.includes(h.type)) problems.push(`${at}: "type" is one of ${TYPES.join(', ')}.`);
    if (typeof h.source !== 'string' || !h.source.trim()) problems.push(`${at}: "source" is the SQL.`);
    if (h.type !== 'sql' && h.method !== 'GET') problems.push(`${at}: collection and item handlers answer GET; use "sql" for ${h.method}.`);
    if (h.roles !== undefined && !(Array.isArray(h.roles) && h.roles.every((r: unknown) => typeof r === 'string'))) problems.push(`${at}: "roles" is a list of role names.`);
    if (h.auth !== undefined && h.auth !== 'token' && h.auth !== 'public') problems.push(`${at}: "auth" is token (default) or public.`);
    if (h.status !== undefined && !(Number.isInteger(h.status) && h.status >= 200 && h.status < 300)) problems.push(`${at}: "status" is a 2xx status.`);
    const key = `${h.method} ${String(h.path).replace(/:[^/]+/g, ':')}`;
    if (seen.has(key)) problems.push(`${at}: ${h.method} ${h.path} is defined twice.`);
    seen.add(key);
  });
  return problems;
}

/** The handler for a method and path, with its path parameters. */
export function matchHandler(handlers: Handler[], method: string, path: string) {
  const parts = path.split('/').filter(Boolean);
  let methodMismatch = false;
  for (const h of handlers) {
    const tpl = h.path.split('/').filter(Boolean);
    if (tpl.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (!tpl.every((t, i) => (t.startsWith(':') ? ((params[t.slice(1).toUpperCase()] = decodeURIComponent(parts[i])), true) : t === parts[i]))) continue;
    if (h.method !== method) {
      methodMismatch = true;
      continue;
    }
    return { handler: h, params };
  }
  return methodMismatch ? 'method' : null;
}

class RestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Caller {
  user: string;
  claims: Record<string, unknown> | null;
}

/** The caller of a request: the bearer token checked like meta.api_check does. */
async function caller(req: FastifyRequest, a: App, publicHandler: boolean): Promise<Caller> {
  const auth = String(req.headers.authorization ?? '');
  if (!/^bearer /i.test(auth)) {
    if (publicHandler) return { user: 'nobody', claims: null };
    throw new RestError(401, 'This endpoint needs a bearer token.');
  }
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(auth.slice(7).trim(), jwtSecret(), { algorithms: ['HS256'] }));
  } catch {
    throw new RestError(401, 'The token is not valid or has expired.');
  }
  if (claims.app !== a.alias) throw new RestError(401, 'The token is for another application.');
  if (typeof claims.client_id === 'string') {
    const c = await owner.one('select 1 from meta.api_client where client_id = $1 and app_id = $2 and active', [claims.client_id, a.id]);
    if (!c) throw new RestError(401, 'The OAuth client of this token does not exist or was revoked.');
    return { user: String(claims.app_user ?? `client:${claims.client_id}`), claims };
  }
  const acc = await owner.one(
    `select ac.username, ac.active, a.access_control = 'any_user' or exists (select 1 from meta.app_access aa where aa.app_id = a.id and aa.account_id = ac.id) as allowed
       from meta.account ac, meta.app a where lower(ac.username) = lower($1) and a.id = $2`,
    [String(claims.app_user ?? ''), a.id],
  );
  if (!acc?.active || !acc.allowed) throw new RestError(403, 'The account of this token is inactive or has no access to the application.');
  return { user: acc.username, claims };
}

const bindValue = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

async function handle(req: FastifyRequest, reply: FastifyReply) {
  const { alias, module: name } = req.params as { alias: string; module: string };
  const sub = ((req.params as Record<string, string>)['*'] ?? '').replace(/\/+$/, '');
  const a = await loadApp(alias);
  const mod = a ? await runtime.one<{ handlers: Handler[]; enabled: boolean }>('select handlers, enabled from meta.rest_module where app_id = $1 and name = $2', [a.id, name]) : undefined;
  if (!a || !mod?.enabled) return reply.code(404).send({ error: 'Not found' });
  const m = matchHandler(mod.handlers ?? [], req.method, sub);
  if (m === 'method') return reply.code(405).send({ error: `${req.method} is not allowed here.` });
  if (!m) return reply.code(404).send({ error: 'Not found' });
  const { handler: h, params } = m;
  const query = req.query as Record<string, string | string[]>;
  try {
    const who = await caller(req, a, h.auth === 'public');
    const binds: BindValues = {};
    for (const [k, v] of Object.entries(query)) binds[k.toUpperCase()] = Array.isArray(v) ? v[0] : v;
    const body = req.body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) binds[k.toUpperCase()] = bindValue(v);
      binds.BODY = JSON.stringify(body);
    }
    Object.assign(binds, params);
    const result = await runtime.tx(async (c) => {
      await c.query(
        `select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true), set_config('pgapex.session_id', '', true),
                set_config('request.jwt.claims', $3, true), set_config('statement_timeout', '30s', true)`,
        [String(a.id), who.user, who.claims ? JSON.stringify(who.claims) : ''],
      );
      if (h.roles?.length) {
        const ok = (await c.query('select bool_or(meta.has_role(r)) as ok from unnest($1::text[]) r', [h.roles])).rows[0].ok;
        if (!ok) throw new RestError(403, 'You do not have a role this endpoint needs.');
      }
      if (a.db_role) await c.query(`set local role ${pg.escapeIdentifier(a.db_role)}`);
      const sql = applyBinds(h.source.trim().replace(/;+\s*$/, ''), binds);
      if (h.type === 'collection') {
        const size = Math.max(1, Math.min(MAX_PAGE, Number(binds.LIMIT) || h.page_size || 25));
        const offset = Math.max(0, Math.floor(Number(binds.OFFSET) || 0));
        // streamed: a cursor in the transaction, each batch written as part of the JSON array;
        // the query and the first batch run first, so a failing query is still an error status
        const cursor = 'pgapex_rest';
        await c.query(`declare ${cursor} no scroll cursor for select * from (\n${sql}\n) "__r" limit ${size + 1} offset ${offset}`);
        const next = async () => (await c.query(`fetch ${REST_BATCH} from ${cursor}`)).rows;
        let batch = await next();
        const out = new PassThrough();
        reply.code(200).header('cache-control', 'no-store').type('application/json; charset=utf-8').send(out);
        try {
          let fetched = 0;
          await writeOut(out, '{"items":[');
          for (;;) {
            const take = batch.slice(0, Math.max(0, size - fetched));
            if (take.length) await writeOut(out, take.map((row, i) => (fetched + i ? ',' : '') + JSON.stringify(row)).join(''));
            fetched += batch.length;
            if (batch.length < REST_BATCH || fetched > size) break;
            batch = await next();
          }
          await c.query(`close ${cursor}`);
          await writeOut(out, `],"offset":${offset},"limit":${size},"has_more":${fetched > size}}`);
          out.end();
        } catch (e) {
          // the client went away, or the query failed after the first rows: the response ends short
          req.log.warn({ err: e }, 'REST collection stopped');
          out.destroy();
        }
        return { status: 200, body: undefined, streamed: true };
      }
      if (h.type === 'item') {
        const rows = (await c.query(`select * from (\n${sql}\n) "__r" limit 2`)).rows;
        if (!rows.length) throw new RestError(404, 'Not found');
        return { status: 200, body: rows[0] };
      }
      let last: pg.QueryResult | undefined;
      for (const stmt of splitStatements(sql)) last = await c.query(stmt);
      const row = last?.rows?.[0];
      return row ? { status: h.status ?? (req.method === 'POST' ? 201 : 200), body: row } : { status: 204, body: undefined };
    });
    if ('streamed' in result) return reply;
    return result.body === undefined ? reply.code(204).send() : reply.code(result.status).send(result.body);
  } catch (e) {
    if (e instanceof RestError) return reply.code(e.status).send({ error: e.message });
    const err = e as pg.DatabaseError;
    const message = await publicError({ app: a, page: { page_no: 0 } as never, user: 'api', ip: clientIp(req) }, e, `REST ${req.method} ${name}/${sub}`);
    const status = err.code === '42501' ? 403 : err.code && /^(P0001|22|23)/.test(err.code) ? 400 : 500;
    return reply.code(status).send({ error: status === 403 ? 'Not allowed.' : message });
  }
}

/** The OpenAPI 3 description of a module. */
export function openApi(a: Pick<App, 'alias' | 'name'>, mod: { name: string; title: string; description: string | null; handlers: Handler[] }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const h of mod.handlers) {
    const p = `/${h.path.replace(/:([a-z][a-z0-9_]*)/gi, '{$1}')}`;
    const params = [...h.path.matchAll(/:([a-z][a-z0-9_]*)/gi)].map((x) => ({ name: x[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (h.type === 'collection')
      params.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } } as never, { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } } as never);
    paths[p] ??= {};
    paths[p][h.method.toLowerCase()] = {
      summary: h.description ?? `${h.method} ${h.path || '/'}`,
      ...(params.length ? { parameters: params } : {}),
      ...(h.method !== 'GET' ? { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      ...(h.auth === 'public' ? { security: [] } : {}),
      responses: {
        [h.type === 'sql' ? String(h.status ?? (h.method === 'POST' ? 201 : 200)) : '200']: {
          description: h.type === 'collection' ? '{items, offset, limit, has_more}' : 'The row as an object',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        ...(h.type === 'item' ? { 404: { description: 'Not found' } } : {}),
        ...(h.auth === 'public' ? {} : { 401: { description: 'No valid token' }, 403: { description: 'Not allowed' } }),
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: mod.title, description: mod.description ?? `${a.name}: ${mod.name}`, version: '1' },
    servers: [{ url: `/a/${a.alias}/rest/${mod.name}` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    security: [{ bearer: [] }],
    paths,
  };
}

export async function restRoutes(app: FastifyInstance) {
  app.get<{ Params: { alias: string; module: string } }>('/a/:alias/rest/:module/openapi.json', async (req, reply) => {
    const a = await loadApp(req.params.alias);
    const mod = a ? await runtime.one<{ name: string; title: string; description: string | null; handlers: Handler[]; enabled: boolean }>('select * from meta.rest_module where app_id = $1 and name = $2', [a.id, req.params.module]) : undefined;
    if (!a || !mod?.enabled) return reply.code(404).send({ error: english('error.not_found') });
    return reply.send(openApi(a, mod));
  });
  app.route({ method: METHODS as never, url: '/a/:alias/rest/:module/*', handler: handle });
}
