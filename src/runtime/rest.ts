import { availabilityRefusal } from './availability.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import pg from 'pg';
import { jwtSecret } from '../api.ts';
import { applyBinds, RESERVED_BINDS, splitStatements, type BindValues } from '../binds.ts';
import { owner, runtime } from '../db.ts';
import { english } from '../i18n.ts';
import { loadApp, type App } from '../metadata.ts';
import { clientIp } from '../session.ts';
import { PassThrough } from 'node:stream';
import { publicError, writeOut } from './context.ts';
import { DO_TAG, HandlerInputError, mediaResponse, runPlpgsql, setBinds } from './rest-handlers.ts';

// REST modules (APEX: RESTful Services): handlers defined in the builder,
// served under /a/<alias>/rest/<module>/<path>.
//
//   {"method": "GET", "path": "employees", "type": "collection", "source": "select … order by empno"}
//   {"method": "GET", "path": "employees/:empno", "type": "item", "source": "select … where empno = :EMPNO::int"}
//   {"method": "POST", "path": "leave", "type": "sql", "source": "select hr.request_leave(:START_DATE::date, …) as id", "status": 201}
//   optional: "roles": ["manager"], "auth": "public", "description": "…", "page_size": 25
//
// Callers send a bearer token: a pgkiln API token (an account) or an OAuth
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
  /** (117) plpgsql: a PL/pgSQL block (rest-handlers.ts); media: a row's content_type and content */
  type: 'collection' | 'item' | 'sql' | 'plpgsql' | 'media';
  source: string;
  roles?: string[];
  auth?: 'token' | 'public';
  description?: string;
  page_size?: number;
  status?: number;
  /** (117) documented parameters: in the OpenAPI document and the Try it form; a required one missing is a 400 */
  params?: HandlerParam[];
}

export interface HandlerParam {
  name: string;
  in: 'query' | 'body';
  type?: 'string' | 'integer' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
}

/** (117) A template of a module: its URI and description (handlers name it in "path"). */
export interface Template {
  uri: string;
  description?: string;
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const TYPES = ['collection', 'item', 'sql', 'plpgsql', 'media'];
export const PARAM_TYPES = ['string', 'integer', 'number', 'boolean'];
const PARAM_NAME = /^[a-z_][a-z0-9_]{0,62}$/i;
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
    else if (h.path.split('/').some((s: string) => s.startsWith(':') && RESERVED_BINDS.has(s.slice(1).toUpperCase())))
      problems.push(`${at}: ${[...RESERVED_BINDS].join(', ')} are set by the server and can't be path parameters.`);
    if (!TYPES.includes(h.type)) problems.push(`${at}: "type" is one of ${TYPES.join(', ')}.`);
    if (typeof h.source !== 'string' || !h.source.trim()) problems.push(`${at}: "source" is the SQL.`);
    if ((h.type === 'collection' || h.type === 'item' || h.type === 'media') && h.method !== 'GET') problems.push(`${at}: collection, item and media handlers answer GET; use "sql" or "plpgsql" for ${h.method}.`);
    if (h.type === 'plpgsql' && typeof h.source === 'string' && h.source.includes(DO_TAG)) problems.push(`${at}: a PL/pgSQL block may not contain ${DO_TAG}.`);
    if (h.params !== undefined) {
      if (!Array.isArray(h.params)) problems.push(`${at}: "params" is a list of {"name", "in": "query" or "body", "type", "required"}.`);
      else h.params.forEach((p: any) => {
        if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !PARAM_NAME.test(p.name)) problems.push(`${at}: a parameter's name is letters, digits and _.`);
        else if (RESERVED_BINDS.has(p.name.toUpperCase())) problems.push(`${at}: ${p.name} is set by the server and can't be a parameter.`);
        if (p && p.in !== 'query' && p.in !== 'body') problems.push(`${at}: a parameter is "in" query or body.`);
        if (p?.type !== undefined && !PARAM_TYPES.includes(p.type)) problems.push(`${at}: a parameter's type is one of ${PARAM_TYPES.join(', ')}.`);
      });
    }
    if (h.roles !== undefined && !(Array.isArray(h.roles) && h.roles.every((r: unknown) => typeof r === 'string'))) problems.push(`${at}: "roles" is a list of role names.`);
    if (h.auth !== undefined && h.auth !== 'token' && h.auth !== 'public') problems.push(`${at}: "auth" is token (default) or public.`);
    if (h.status !== undefined && !(Number.isInteger(h.status) && h.status >= 200 && h.status < 300)) problems.push(`${at}: "status" is a 2xx status.`);
    const key = `${h.method} ${String(h.path).replace(/:[^/]+/g, ':')}`;
    if (seen.has(key)) problems.push(`${at}: ${h.method} ${h.path} is defined twice.`);
    seen.add(key);
  });
  return problems;
}

/** (117) Problems in a module's templates, or []. */
export function templateProblems(templates: unknown): string[] {
  if (!Array.isArray(templates)) return ['The templates must be a JSON array.'];
  const problems: string[] = [];
  const seen = new Set<string>();
  templates.forEach((t: any, i) => {
    const uri = t?.uri;
    if (typeof uri !== 'string' || !uri || !uri.split('/').every((s: string) => SEGMENT.test(s)))
      problems.push(`Template ${i + 1}: the URI is like emp or emp/:id (letters, digits, - _ . and :parameters).`);
    else if (uri === 'openapi.json') problems.push(`Template ${i + 1}: openapi.json is reserved for the module's description.`);
    else if (uri.split('/').some((s: string) => s.startsWith(':') && RESERVED_BINDS.has(s.slice(1).toUpperCase())))
      problems.push(`Template ${i + 1}: ${[...RESERVED_BINDS].join(', ')} can't be URI parameters.`);
    else {
      const key = uri.replace(/:[^/]+/g, ':');
      if (seen.has(key)) problems.push(`Template ${i + 1}: ${uri} is there twice.`);
      seen.add(key);
    }
    if (t?.description !== undefined && typeof t.description !== 'string') problems.push(`Template ${i + 1}: the description is text.`);
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

export class RestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Caller {
  user: string;
  claims: Record<string, unknown> | null;
}

/** The caller of a request: the bearer token checked like meta.api_check does. */
export async function caller(req: FastifyRequest, a: App, publicHandler: boolean): Promise<Caller> {
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

/** (093) The workspace preference "RESTful services": off, the workspace's REST modules don't exist. */
export async function restServicesOn(appId: number) {
  const r = await owner.one<{ on: boolean }>('select coalesce((select w.rest_services from meta.workspace w where w.id = meta.app_workspace($1)), true) as on', [appId]);
  return r?.on !== false;
}

async function handle(req: FastifyRequest, reply: FastifyReply) {
  const { alias, module: name } = req.params as { alias: string; module: string };
  const sub = ((req.params as Record<string, string>)['*'] ?? '').replace(/\/+$/, '');
  const a = await loadApp(alias);
  const mod = a ? await runtime.one<{ handlers: Handler[]; enabled: boolean; roles: string[] | null }>('select handlers, enabled, roles from meta.rest_module where app_id = $1 and name = $2', [a.id, name]) : undefined;
  if (!a || !mod?.enabled || !(await restServicesOn(a.id))) return reply.code(404).send({ error: 'Not found' });
  const m = matchHandler(mod.handlers ?? [], req.method, sub);
  if (m === 'method') return reply.code(405).send({ error: `${req.method} is not allowed here.` });
  if (!m) return reply.code(404).send({ error: 'Not found' });
  const { handler: h, params } = m;
  const query = req.query as Record<string, string | string[]>;
  try {
    const who = await caller(req, a, h.auth === 'public');
    // (083) the application's availability (no builder session here: developers only means nobody)
    const refusal = availabilityRefusal(a, { username: who.user === 'nobody' ? null : who.user, developer: false });
    if (refusal) throw new RestError(refusal.status, refusal.message ?? english(refusal.key));
    const binds: BindValues = {};
    for (const [k, v] of Object.entries(query)) binds[k.toUpperCase()] = Array.isArray(v) ? v[0] : v;
    const body = req.body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) binds[k.toUpperCase()] = bindValue(v);
      binds.BODY = JSON.stringify(body);
    }
    Object.assign(binds, params);
    // (117) documented parameters marked required
    const missing = (h.params ?? []).filter((p) => p.required && (binds[p.name.toUpperCase()] ?? '') === '').map((p) => p.name);
    if (missing.length) throw new RestError(400, `Missing parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
    // the built-in names are the server's, never the caller's (?app_user=… must not set :APP_USER)
    for (const k of Object.keys(binds)) if (RESERVED_BINDS.has(k)) delete binds[k];
    Object.assign(binds, { APP_USER: who.user, APP_ID: String(a.id), APP_ALIAS: a.alias, APP_SESSION: null, APP_PAGE_ID: null, REQUEST: null });
    const result = await runtime.tx(async (c) => {
      await c.query(
        `select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true), set_config('pgkiln.session_id', '', true),
                set_config('request.jwt.claims', $3, true), set_config('statement_timeout', '30s', true)`,
        [String(a.id), who.user, who.claims ? JSON.stringify(who.claims) : ''],
      );
      // (117) the module's privilege, then the handler's own roles
      for (const roles of [mod.roles, h.roles]) if (roles?.length) {
        const ok = (await c.query('select bool_or(meta.has_role(r)) as ok from unnest($1::text[]) r', [roles])).rows[0].ok;
        if (!ok) throw new RestError(403, 'You do not have a role this endpoint needs.');
      }
      if (h.type === 'plpgsql') await setBinds(c, binds);
      if (a.db_role) await c.query(`set local role ${pg.escapeIdentifier(a.db_role)}`);
      // (117) handlers run as a constrained role: never a superuser, a role that bypasses row level security, or
      // pgkiln's owner (a runtime connection without RUNTIME_DATABASE_URL is the owner's)
      const role = (await c.query(
        `select r.rolsuper or r.rolbypassrls or pg_has_role(current_user, n.nspowner, 'MEMBER') as bad
           from pg_roles r, pg_namespace n where r.rolname = current_user and n.nspname = 'meta'`)).rows[0];
      if (!role || role.bad) throw new RestError(403, 'This endpoint would run as a role that bypasses row level security or owns pgkiln: refused. Give the application its own database role.');
      if (h.type === 'plpgsql') {
        const out = await runPlpgsql(c, h.source);
        const status = out.status ?? (out.body === undefined ? 204 : h.status ?? (req.method === 'POST' ? 201 : 200));
        return { status, body: out.body };
      }
      const sql = applyBinds(h.source.trim().replace(/;+\s*$/, ''), binds);
      if (h.type === 'collection') {
        const size = Math.max(1, Math.min(MAX_PAGE, Number(binds.LIMIT) || h.page_size || 25));
        const offset = Math.max(0, Math.floor(Number(binds.OFFSET) || 0));
        // streamed: a cursor in the transaction, each batch written as part of the JSON array;
        // the query and the first batch run first, so a failing query is still an error status
        const cursor = 'pgkiln_rest';
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
      if (h.type === 'item' || h.type === 'media') {
        const rows = (await c.query(`select * from (\n${sql}\n) "__r" limit 2`)).rows;
        if (!rows.length) throw new RestError(404, 'Not found');
        if (h.type === 'media') return { status: 200, body: undefined, media: mediaResponse(rows[0]) };
        return { status: 200, body: rows[0] };
      }
      let last: pg.QueryResult | undefined;
      for (const stmt of splitStatements(sql)) last = await c.query(stmt);
      const row = last?.rows?.[0];
      return row ? { status: h.status ?? (req.method === 'POST' ? 201 : 200), body: row } : { status: 204, body: undefined };
    });
    if ('streamed' in result) return reply;
    if ('media' in result && result.media) return reply.code(200).headers(result.media.headers).send(result.media.body);
    return result.body === undefined ? reply.code(result.status === 204 || result.status < 200 ? 204 : result.status).send() : reply.code(result.status).send(result.body);
  } catch (e) {
    if (e instanceof RestError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof HandlerInputError) return reply.code(400).send({ error: e.message });
    const err = e as pg.DatabaseError;
    const message = await publicError({ app: a, page: { page_no: 0 } as never, user: 'api', ip: clientIp(req) }, e, `REST ${req.method} ${name}/${sub}`);
    const status = err.code === '42501' ? 403 : err.code && /^(P0001|22|23)/.test(err.code) ? 400 : 500;
    return reply.code(status).send({ error: status === 403 ? 'Not allowed.' : message });
  }
}

/** The OpenAPI 3 description of a module. */
export function openApi(
  a: Pick<App, 'alias' | 'name'>,
  mod: { name: string; title: string; description: string | null; handlers: Handler[]; roles?: string[] | null; templates?: Template[] | null },
) {
  const paths: Record<string, Record<string, unknown>> = {};
  const toPath = (uri: string) => `/${uri.replace(/:([a-z][a-z0-9_]*)/gi, '{$1}')}`;
  const modRoles = mod.roles ?? [];
  for (const t of Array.isArray(mod.templates) ? mod.templates : []) if (t?.uri && t.description) (paths[toPath(t.uri)] ??= {}).description = t.description;
  for (const h of mod.handlers) {
    const p = toPath(h.path);
    const params: Record<string, unknown>[] = [...h.path.matchAll(/:([a-z][a-z0-9_]*)/gi)].map((x) => ({ name: x[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (h.type === 'collection')
      params.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }, { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } });
    const documented = Array.isArray(h.params) ? h.params : [];
    for (const q of documented.filter((x) => x.in === 'query'))
      params.push({ name: q.name, in: 'query', required: !!q.required, schema: { type: q.type ?? 'string' }, ...(q.description ? { description: q.description } : {}) });
    const bodyParams = documented.filter((x) => x.in === 'body');
    const bodySchema = bodyParams.length
      ? { type: 'object', properties: Object.fromEntries(bodyParams.map((q) => [q.name, { type: q.type ?? 'string', ...(q.description ? { description: q.description } : {}) }])),
          ...(bodyParams.some((q) => q.required) ? { required: bodyParams.filter((q) => q.required).map((q) => q.name) } : {}) }
      : { type: 'object' };
    const roles = [modRoles.length ? `one of the roles ${modRoles.join(', ')}` : '', h.roles?.length ? `one of the roles ${h.roles.join(', ')}` : ''].filter(Boolean);
    const ok = h.type === 'sql' || h.type === 'plpgsql' ? String(h.status ?? (h.method === 'POST' ? 201 : 200)) : '200';
    paths[p] ??= {};
    paths[p][h.method.toLowerCase()] = {
      summary: h.description ?? `${h.method} ${h.path || '/'}`,
      ...(roles.length ? { description: `The caller needs ${roles.join(' and ')}.`, 'x-pgkiln-roles': [modRoles, h.roles ?? []].filter((r) => r.length) } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(h.method !== 'GET' ? { requestBody: { required: bodyParams.some((q) => q.required), content: { 'application/json': { schema: bodySchema } } } } : {}),
      ...(h.auth === 'public' ? { security: [] } : {}),
      responses: {
        [ok]: h.type === 'media'
          ? { description: 'The content (content type from the row)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
          : {
            description: h.type === 'collection' ? '{items, offset, limit, has_more}' : h.type === 'plpgsql' ? 'The body of meta.rest_reply' : 'The row as an object',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        ...(h.type === 'sql' || h.type === 'plpgsql' ? { 204: { description: 'No content' } } : {}),
        ...(documented.some((q) => q.required) || h.type === 'plpgsql' || h.type === 'sql' ? { 400: { description: 'Missing or invalid input' } } : {}),
        ...(h.type === 'item' || h.type === 'media' ? { 404: { description: 'Not found' } } : {}),
        ...(h.auth === 'public' && !roles.length ? {} : { 401: { description: 'No valid token' }, 403: { description: 'Not allowed' } }),
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
    const mod = a ? await runtime.one<{ name: string; title: string; description: string | null; handlers: Handler[]; enabled: boolean; roles: string[]; templates: Template[] }>('select * from meta.rest_module where app_id = $1 and name = $2', [a.id, req.params.module]) : undefined;
    if (!a || !mod?.enabled || !(await restServicesOn(a.id))) return reply.code(404).send({ error: english('error.not_found') });
    return reply.send(openApi(a, mod));
  });
  app.route({ method: METHODS as never, url: '/a/:alias/rest/:module/*', handler: handle });
}
