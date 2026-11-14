// (sprint 194, NX-F4, SEC-1) The builder's API for the command line and the MCP server: /builder/api/v1/…,
// authenticated with a personal builder token (src/builder-tokens.ts) in the Authorization header and nothing else:
// cookies don't count here (so a browser's session can't be used against it, and CSRF doesn't apply), and every request
// is checked again (expiry, revocation, the developer's membership of the token's workspace).
//
//   GET  /builder/api/v1/me                       who the token is (any scope)
//   GET  /builder/api/v1/tools                    the tools and the scope each needs
//   POST /builder/api/v1/tools/<name>             an MCP tool (src/cli/mcp.ts) with its arguments as JSON → { text }
//   GET  /builder/api/v1/apps/<alias>/export      the application's export document → { doc }            (read)
//   POST /builder/api/v1/apps/<alias>/import      { doc, replace, check } → { result }                     (write)
//   POST /builder/api/v1/advise                   { alias } (read) or { doc } (write) → { result }
//
// The tools are the MCP server's own, run with a context (ToolContext) that confines them to the token's workspace:
// pgkiln's tables through the owner pool for that workspace's applications only, the database's own objects through
// the workspace's developer login (src/workspace-db.ts), never the owner, also for an administrator's token. Imports
// keep the builder's rules: another developer's lock on the application or a page the import changes refuses it, as
// does a Run only application. Every call is in the activity log (event builder_api, the developer, the token's name).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { docToFiles, type Doc } from '../appfiles.ts';
import { checkToken, TokenError, type TokenCaller, type TokenScope } from '../builder-tokens.ts';
import { exportDoc, importDoc, UsageError, type ImportCheck } from '../cli/apps.ts';
import { TOOLS, ToolError, type Args, type ToolContext } from '../cli/mcp.ts';
import { owner, type Db } from '../db.ts';
import { clientIp, logActivity } from '../session.ts';
import { devDbForApp, devDbForWorkspace } from '../workspace-db.ts';
import { WorkingCopyError } from '../workingcopy.ts';

export const API = '/builder/api/v1';
/** An export can be large: the JSON body of an import or a check. */
const BODY_LIMIT = 64 * 1024 * 1024;
type CliDb = Parameters<typeof exportDoc>[0];

/** The scope a tool call needs on the server; null: it runs on the developer's machine (files). */
export function toolScope(name: string, args: Args): TokenScope | null {
  switch (name) {
    case 'export_app':
    case 'diff_app':
    case 'import_app':
      return null;
    case 'run_query':
      return 'sql';
    case 'lock_app':
      return 'write';
    case 'working_copy':
      return args.action === 'list' || args.action === 'compare' ? 'read' : 'write';
    case 'advise_app':
      // an export on disk comes through POST /advise (write); the server never reads its own files for a caller
      return args.path || args.offline ? null : 'read';
    default:
      return TOOLS.some((t) => t.name === name) ? 'read' : null;
  }
}

/** A connection of a pool for the duration of fn, in the shape the command line's helpers take. */
async function withClient<T>(db: Db, fn: (c: CliDb) => Promise<T>): Promise<T> {
  const c = await db.pool.connect();
  try {
    return await fn(c as unknown as CliDb);
  } finally {
    c.release();
  }
}

/** The pages an import changes (their numbers), from the current export and the new one. */
export function changedPages(current: Doc, incoming: Doc): Set<number> {
  const a = docToFiles(current, 'json');
  const b = docToFiles(incoming, 'json');
  const pages = new Set<number>();
  const same = (x?: Buffer, y?: Buffer) => !!x && !!y && x.equals(y);
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    const m = /^pages\/(\d{1,9})-/.exec(p);
    if (m && !same(a.get(p), b.get(p))) pages.add(Number(m[1]));
  }
  return pages;
}

/** The context of a token's tool calls: its workspace, its developer, never the owner for the database's objects. */
export function serverContext(caller: TokenCaller): ToolContext {
  const ws = caller.workspaceId;
  const by = `${caller.username} (builder token ${caller.name})`;
  const ctx: ToolContext = {
    meta: (fn) => withClient(owner, fn),
    sql: async (fn, appId) => withClient(appId ? await devDbForApp(appId) : await devDbForWorkspace(ws), fn),
    workspace: ws,
    developer: caller.username,
    admin: caller.admin,
    info: { developer: caller.username, administrator: caller.admin, token: caller.name, scopes: caller.scopes, expires_at: caller.expiresAt, workspace: caller.workspace },
    async app(db, alias) {
      const r = (await db.query('select id from meta.app where alias = $1 and meta.app_workspace(id) = $2', [alias, ws])).rows[0];
      // another workspace's application doesn't exist for the token (as in the builder)
      if (!r) throw new ToolError(`no application ${alias} in workspace ${caller.workspace} (list_apps lists them)`);
      return r.id;
    },
    async schema(db, name) {
      const ok = (await db.query(`select has_schema_privilege(oid, 'USAGE') as ok from pg_namespace where nspname = $1`, [name])).rows[0]?.ok;
      if (!ok || name === 'meta' || name.startsWith('pg_') || name === 'information_schema') throw new ToolError(`no schema ${name} that workspace ${caller.workspace}'s developer login may use`);
    },
    exportDoc: (alias) =>
      withClient(owner, async (db) => {
        await ctx.app(db, alias);
        return exportDoc(db, alias);
      }),
    async importDoc(doc, o) {
      const planDb = await devDbForWorkspace(ws);
      const { lockedFor } = await import('../cli/working-copy.ts');
      const r = await withClient(owner, (db) =>
        importDoc(db, doc, {
          ...o, by, workspace: ws, planDb,
          // the builder's rules for a change: a Run only application, another developer's lock on it or a page it changes
          guard: async (appId) => {
            const a = (await db.query(`select build_status = 'run_only' as run_only from meta.app where id = $1`, [appId])).rows[0];
            if (a?.run_only) throw new ToolError(`${o.alias} is Run only: set its build status to Run and build in the builder first`);
            const locked = await lockedFor(caller.username)(appId, changedPages(await exportDoc(db, o.alias), doc));
            if (locked) throw new ToolError(locked);
          },
        }));
      if (r.committed) {
        const { recordChange } = await import('./app-updates.ts');
        await recordChange(r.id, caller.username).catch(() => {});
      }
      return { ...r, roleNote: r.roleNote ?? null };
    },
    async advise(target) {
      const { adviseTarget } = await import('../cli/advise.ts');
      const planDb = await devDbForWorkspace(ws);
      return withClient(owner, async (db) => {
        if ('alias' in target) {
          await ctx.app(db, target.alias);
          return adviseTarget(db, target.alias, { alias: true, planDb });
        }
        return adviseTarget(db, 'export', { source: target.source, planDb });
      });
    },
  };
  return ctx;
}

/** A refusal or an error, as JSON; nothing of the API is cached. */
const answer = (reply: FastifyReply, status: number, body: object) => reply.code(status).header('cache-control', 'no-store').send(body);

/** The application a call names (for the activity log), when it is one of the workspace's. */
async function appIdOf(alias: unknown, ws: number): Promise<number | null> {
  if (typeof alias !== 'string' || !alias || alias.length > 100) return null;
  return (await owner.one<{ id: number }>('select id from meta.app where alias = $1 and meta.app_workspace(id) = $2', [alias, ws]))?.id ?? null;
}

/** What a tool error says to the caller: the tool's own message; anything else is the server's problem. */
function errorText(e: unknown) {
  if (e instanceof ToolError || e instanceof UsageError || e instanceof WorkingCopyError || e instanceof TokenError) return e.message;
  // a database error of the caller's SQL or files (a syntax error, a missing column): its message, as the SQL Workshop shows it
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') return (e as unknown as Error).message;
  return null;
}

export async function builderApiRoutes(app: FastifyInstance) {
  /**
   * The caller of a request, or null after answering 401 / 403 / 429. Failed attempts are logged as failed sign-ins
   * of the address (no user name: a guessed token must not lock a developer out), and count towards its limit.
   */
  async function caller(req: FastifyRequest, reply: FastifyReply, scope: TokenScope | null, what: string): Promise<TokenCaller | null> {
    const ip = clientIp(req);
    const r = await checkToken(req.headers.authorization, ip);
    if (!r.ok) {
      if (r.log) await logActivity({ event: 'login_failed', ip, detail: `builder API: ${r.log}` });
      if (r.status === 401) reply.header('www-authenticate', 'Bearer realm="pgkiln builder"');
      answer(reply, r.status, { error: r.error });
      return null;
    }
    if (scope && !r.caller.scopes.includes(scope)) {
      await logActivity({ appId: await appIdOf((req.params as Record<string, string>)?.alias ?? (req.body as Args | undefined)?.alias, r.caller.workspaceId), username: r.caller.username, event: 'forbidden', ip,
        detail: `builder token ${r.caller.name}: ${what} needs the ${scope} scope` });
      answer(reply, 403, { error: `this token has no ${scope} scope (it has ${r.caller.scopes.join(', ')}): ${what} needs it` });
      return null;
    }
    return r.caller;
  }

  const logCall = async (req: FastifyRequest, c: TokenCaller, what: string, alias: unknown, outcome: string) =>
    logActivity({ appId: await appIdOf(alias, c.workspaceId), username: c.username, event: 'builder_api', ip: clientIp(req), detail: `token ${c.name}: ${what}${typeof alias === 'string' && alias ? ` ${alias.slice(0, 100)}` : ''}${outcome}` });

  app.get(`${API}/me`, async (req, reply) => {
    const c = await caller(req, reply, null, 'me');
    if (!c) return;
    await logCall(req, c, 'me', null, '');
    return answer(reply, 200, { developer: c.username, administrator: c.admin, token: c.name, scopes: c.scopes, expires_at: c.expiresAt, workspace: c.workspace });
  });

  app.get(`${API}/tools`, async (req, reply) => {
    const c = await caller(req, reply, null, 'tools');
    if (!c) return;
    return answer(reply, 200, { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, scope: toolScope(t.name, {}), server: toolScope(t.name, {}) !== null })) });
  });

  app.post<{ Params: { name: string }; Body: Args }>(`${API}/tools/:name`, { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const name = String(req.params.name);
    const tool = TOOLS.find((t) => t.name === name);
    const args: Args = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const scope = tool ? toolScope(name, args) : null;
    const c = await caller(req, reply, scope, name);
    if (!c) return;
    if (!tool) return answer(reply, 404, { error: `unknown tool ${name}` });
    if (!scope) return answer(reply, 400, { error: `${name} works with files on your machine: pgkiln mcp --url runs it there (export: GET ${API}/apps/<alias>/export, import: POST ${API}/apps/<alias>/import)` });
    try {
      const text = await tool.run(args, serverContext(c));
      await logCall(req, c, name, args.alias, '');
      return answer(reply, 200, { text });
    } catch (e) {
      const message = errorText(e);
      if (message === null) req.log.error({ err: e }, `builder API ${name}`);
      await logCall(req, c, name, args.alias, `: refused (${(message ?? 'server error').slice(0, 200)})`);
      return answer(reply, message === null ? 500 : 422, { error: message ?? 'The server could not do that: see its log.' });
    }
  });

  app.get<{ Params: { alias: string } }>(`${API}/apps/:alias/export`, async (req, reply) => {
    const c = await caller(req, reply, 'read', 'export');
    if (!c) return;
    try {
      const doc = await serverContext(c).exportDoc(req.params.alias);
      await logCall(req, c, 'export', req.params.alias, '');
      return answer(reply, 200, { doc });
    } catch (e) {
      return answer(reply, errorText(e) === null ? 500 : 404, { error: errorText(e) ?? 'The server could not do that: see its log.' });
    }
  });

  app.post<{ Params: { alias: string }; Body: { doc?: Doc; replace?: boolean; check?: string } }>(`${API}/apps/:alias/import`, { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const c = await caller(req, reply, 'write', 'import');
    if (!c) return;
    const b = req.body ?? {};
    const check = (['off', 'check', 'force', 'dry-run'] as const).find((x) => x === b.check) ?? 'check';
    if (!b.doc || typeof b.doc !== 'object' || Array.isArray(b.doc)) return answer(reply, 400, { error: 'doc: an export document (JSON)' });
    try {
      const result = await serverContext(c).importDoc(b.doc, { alias: req.params.alias, replace: b.replace === true, check: check as ImportCheck });
      await logCall(req, c, b.replace === true ? 'import --replace' : 'import', req.params.alias,
        result.committed ? `: ${result.replaced ? 'replaced' : 'imported'} (${result.findings.filter((f) => f.severity === 'error').length} error(s) found)` : ': not committed');
      return answer(reply, 200, { result });
    } catch (e) {
      const message = errorText(e);
      if (message === null) req.log.error({ err: e }, 'builder API import');
      await logCall(req, c, 'import', req.params.alias, `: refused (${(message ?? 'server error').slice(0, 200)})`);
      return answer(reply, message === null ? 500 : 409, { error: message ?? 'The server could not do that: see its log.' });
    }
  });

  app.post<{ Body: { alias?: string; doc?: Doc } }>(`${API}/advise`, { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const b = req.body ?? {};
    const withDoc = !!b.doc;
    // an export is imported into a transaction that is rolled back: an import's scope
    const c = await caller(req, reply, withDoc ? 'write' : 'read', 'advise');
    if (!c) return;
    if (withDoc ? typeof b.doc !== 'object' || Array.isArray(b.doc) : typeof b.alias !== 'string' || !b.alias) return answer(reply, 400, { error: 'alias, or doc: an export document' });
    try {
      const result = await serverContext(c).advise(withDoc ? { source: { doc: b.doc! }, path: 'export' } : { alias: b.alias! });
      await logCall(req, c, 'advise', withDoc ? null : b.alias, '');
      return answer(reply, 200, { result });
    } catch (e) {
      const message = errorText(e);
      if (message === null) req.log.error({ err: e }, 'builder API advise');
      return answer(reply, message === null ? 500 : 422, { error: message ?? 'The server could not do that: see its log.' });
    }
  });
}
