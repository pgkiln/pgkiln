import { createHmac } from 'node:crypto';
import { makePool, onClosePools, owner, runtimeScope, runtimeUrl, setAppRuntime, sharedRuntime, type Db } from './db.ts';
import { secretKeyConfigured, SecretKeyMissing } from './secrets.ts';

// Isolated workspaces (090). An isolated workspace's applications run on its
// own login role (run_role) and its developers' SQL on another (dev_role), so
// SQL that resets its role falls back to that login, never to the shared
// runtime role or the owner. Row-level security on meta keys on the login
// (session_user). This module keeps a pool per login, opened on first use,
// and picks the runtime pool for an application:
//
//   - a request under /a/:alias runs in runtimeScope (app.ts), so every
//     runtime.query/one/tx of the request uses the workspace's pool;
//   - background work for one application wraps itself in withAppDb(appId).
//
// The logins' passwords are derived from PGKILN_SECRET_KEY (every server
// process derives the same one) and set with ALTER ROLE when a pool opens.

interface Isolated {
  ws: number;
  runRole: string;
  devRole: string;
}

let byApp = new Map<number, Isolated>();
let byAlias = new Map<string, Isolated>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
/** How long the list of isolated applications is trusted (other server processes' changes). */
const TTL_MS = Number(process.env.PGKILN_WORKSPACE_CACHE_MS ?? 5000);

async function load() {
  const rows = (
    await owner.query<{ app_id: number; alias: string; ws: number; run_role: string; dev_role: string }>(
      `select a.id as app_id, a.alias, w.id as ws, w.run_role, w.dev_role
         from meta.app a join meta.workspace w on w.id = meta.app_workspace(a.id)
        where w.isolated`,
    )
  ).rows;
  const apps = new Map<number, Isolated>();
  const aliases = new Map<string, Isolated>();
  for (const r of rows) {
    const iso = { ws: r.ws, runRole: r.run_role, devRole: r.dev_role };
    apps.set(r.app_id, iso);
    aliases.set(r.alias.toLowerCase(), iso);
  }
  byApp = apps;
  byAlias = aliases;
  loadedAt = Date.now();
}

async function fresh() {
  if (Date.now() - loadedAt < TTL_MS) return;
  loading ??= load().finally(() => (loading = null));
  await loading;
}

/** Forget the cached list (after this process isolated a workspace or moved an application). */
export async function workspacesChanged() {
  loadedAt = 0;
  await fresh();
  // logins of workspaces that are no longer isolated: close their pools
  const live = new Set([...byApp.values()].flatMap((i) => [i.runRole, i.devRole]));
  for (const [role, db] of pools) {
    if (live.has(role)) continue;
    pools.delete(role);
    await (await db).end().catch(() => {});
  }
}

/** The password of a workspace login: the same in every server process, never stored. */
export function loginPassword(role: string) {
  if (!secretKeyConfigured()) throw new SecretKeyMissing();
  return createHmac('sha256', `pgkiln-workspace-login\0${process.env.PGKILN_SECRET_KEY}`).update(role).digest('base64url');
}

function urlFor(role: string) {
  const u = new URL(runtimeUrl);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(loginPassword(role));
  return u.toString();
}

const pools = new Map<string, Promise<Db>>();
const POOL_SIZE = Number(process.env.PGKILN_WORKSPACE_POOL_SIZE ?? 5);

/** The pool of a workspace login role, opened (and its password set) on first use. */
function poolFor(role: string): Promise<Db> {
  let p = pools.get(role);
  if (!p) {
    p = (async () => {
      // the role is pgkiln's own (named by meta.workspace_isolate): set the password it expects
      if (!LOGIN.test(role)) throw new Error(`Not a workspace login role: ${role}`);
      const password = loginPassword(role);
      await owner.query(`alter role ${quoteIdent(role)} password ${quoteLiteral(password)}`);
      return makePool(urlFor(role), `pgkiln-${role}`, POOL_SIZE);
    })();
    p.catch(() => pools.delete(role));
    pools.set(role, p);
  }
  return p;
}
onClosePools(async () => {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map(async (p) => (await p.catch(() => null))?.end()));
});

const LOGIN = /^pgkiln_ws\d{1,9}_(run|dev)_[0-9a-f]{8}$/;
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The runtime pool of an application: its isolated workspace's login, or the shared one. */
export async function runtimeForApp(appId: number | string): Promise<Db> {
  await fresh();
  const iso = byApp.get(Number(appId));
  return iso ? poolFor(iso.runRole) : sharedRuntime;
}

setAppRuntime(runtimeForApp);

/** The runtime pool for an application alias (a request under /a/:alias). */
export async function runtimeForAlias(alias: string): Promise<Db> {
  await fresh();
  const iso = byAlias.get(alias.toLowerCase());
  return iso ? poolFor(iso.runRole) : sharedRuntime;
}

/** Run fn with runtime.* on the application's own connection (background work for one application). */
export async function withAppDb<T>(appId: number | string, fn: () => Promise<T>): Promise<T> {
  const db = await runtimeForApp(appId);
  return runtimeScope.run(db, fn);
}

/** Is the application in an isolated workspace? */
export async function appIsolated(appId: number | string) {
  await fresh();
  return byApp.has(Number(appId));
}

/**
 * The connection for a developer's SQL about an application (the Advisor, the
 * code editor, region settings, supporting objects, plug-in install SQL): the
 * owner, or an isolated workspace's developer login. Callers SET LOCAL ROLE to
 * the application's role as before; RESET ROLE then only reaches the login.
 */
export async function devDbForApp(appId: number | string | null | undefined): Promise<Db> {
  if (appId == null || appId === '') return owner;
  await fresh();
  const iso = byApp.get(Number(appId));
  return iso ? poolFor(iso.devRole) : owner;
}

/** The developer login of an isolated workspace (the SQL Workshop of its developers), or null. */
export async function devDbForWorkspace(ws: number): Promise<Db | null> {
  const r = await owner.one<{ dev_role: string }>('select dev_role from meta.workspace where id = $1 and isolated', [ws]);
  return r ? poolFor(r.dev_role) : null;
}
