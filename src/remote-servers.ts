import { owner } from './db.ts';
import { WebError } from './webclient.ts';

// (sprint 141, AP-7; APEX: Remote Servers) A named base URL per workspace
// (meta.remote_server, migration 141): REST data sources (rest_source.server),
// REST source catalogs (rest_catalog.server) and AI services
// (ai_service.server_id) name a server and a path instead of a full URL, so
// moving from development to production changes one value. The URL is this
// installation's (base_url), or the server's environment variable
// PGKILN_SERVER_<...> when it is set (env_var wins). Only the prefix
// PGKILN_SERVER_ may be named, so no other variable of the server's
// environment (DATABASE_URL, keys) can become a URL or show up in a message.
//
// Resolving happens here, with the owner pool (the runtime role can't read
// the table), always within the application's own workspace: another
// workspace's server is never found. The URL it gives goes through every
// check a full URL went through (src/webclient.ts: allow-list, the
// workspace's network access list, address checks at connect time).

export interface RemoteServer {
  id: number;
  workspace_id: number;
  static_id: string;
  name: string;
  description: string | null;
  base_url: string | null;
  env_var: string | null;
  credential: string | null;
}

export const STATIC_ID = /^[A-Z][A-Z0-9_]{0,59}$/;
export const ENV_PREFIX = 'PGKILN_SERVER_';
export const ENV_VAR = /^PGKILN_SERVER_[A-Z0-9_]{1,60}$/;
const BASE_URL = /^https?:\/\/[^\s<>"{}?#]+$/i;

/** Problems with a base URL (empty: fine): http(s), no trailing slash, query, fragment or user name. */
export function baseUrlProblem(url: string): string | null {
  if (!BASE_URL.test(url) || url.length > 2000) return 'The base URL starts with http:// or https://, without spaces, {parameters}, a query or a fragment, e.g. https://crm.example.com/api.';
  if (url.endsWith('/')) return 'The base URL ends without a slash: the paths after it start with one.';
  try {
    const u = new URL(url);
    if (u.username || u.password) return 'The base URL may not contain a user name or password: use a web credential.';
  } catch {
    return 'The base URL is not valid.';
  }
  return null;
}

/** Problems with a server's fields (empty: fine). */
export function serverProblems(v: { static_id?: unknown; name?: unknown; base_url?: unknown; env_var?: unknown; credential?: unknown; description?: unknown }): string[] {
  const out: string[] = [];
  if (typeof v.static_id !== 'string' || !STATIC_ID.test(v.static_id)) out.push('The static id is upper case letters, digits and _, starting with a letter (at most 60), e.g. CRM.');
  if (typeof v.name !== 'string' || !/^\S(.{0,98}\S)?$/.test(v.name)) out.push('The name is 1 to 100 characters, without spaces at the start or end.');
  if (v.base_url != null && v.base_url !== '') {
    const p = baseUrlProblem(String(v.base_url));
    if (p) out.push(p);
  }
  if (v.env_var != null && v.env_var !== '' && (typeof v.env_var !== 'string' || !ENV_VAR.test(v.env_var)))
    out.push(`The environment variable starts with ${ENV_PREFIX}, then upper case letters, digits and _, e.g. ${ENV_PREFIX}CRM.`);
  if (!v.base_url && !v.env_var) out.push('Give the base URL, an environment variable that holds it, or both.');
  if (v.credential != null && v.credential !== '' && (typeof v.credential !== 'string' || !STATIC_ID.test(v.credential))) out.push('The web credential is the name of one, e.g. CRM_API.');
  if (v.description != null && (typeof v.description !== 'string' || v.description.length > 2000)) out.push('The description is at most 2000 characters.');
  return out;
}

/**
 * The URL a server stands for now: its environment variable when that is set (and valid), else its
 * stored base URL. `problem` says why there is none (the variable's value is never repeated).
 */
export function serverUrl(s: Pick<RemoteServer, 'static_id' | 'base_url' | 'env_var'>): { url: string | null; from: 'env' | 'stored' | null; problem: string | null } {
  if (s.env_var && ENV_VAR.test(s.env_var)) {
    const v = (process.env[s.env_var] ?? '').trim().replace(/\/+$/, '');
    if (v) {
      if (baseUrlProblem(v)) return { url: null, from: 'env', problem: `Remote server ${s.static_id}: the server's ${s.env_var} is not a valid base URL (http:// or https://, no query).` };
      return { url: v, from: 'env', problem: null };
    }
  }
  if (s.base_url && !baseUrlProblem(s.base_url)) return { url: s.base_url, from: 'stored', problem: null };
  return { url: null, from: null, problem: `Remote server ${s.static_id} has no base URL${s.env_var ? ` (and ${s.env_var} is not set on the server)` : ''}.` };
}

/** "https://crm.example.com/api" + "/orders/{id}" (a path, a query, or nothing). */
export function joinUrl(base: string, path: string | null | undefined) {
  const p = (path ?? '').trim();
  if (!p) return base;
  return p.startsWith('/') || p.startsWith('?') ? `${base}${p}` : `${base}/${p}`;
}

/** A server of a workspace by static id (owner pool), or null. */
export async function workspaceServer(workspaceId: number, staticId: string): Promise<RemoteServer | null> {
  return (await owner.one<RemoteServer>('select * from meta.remote_server where workspace_id = $1 and static_id = $2', [workspaceId, staticId.toUpperCase()])) ?? null;
}

/** A server of the application's own workspace by static id, or null. */
export async function serverForApp(appId: number, staticId: string): Promise<RemoteServer | null> {
  return (await owner.one<RemoteServer>(
    'select * from meta.remote_server where workspace_id = meta.app_workspace($1) and static_id = $2', [appId, staticId.toUpperCase()])) ?? null;
}

/** The full URL of a path on a server of the application's workspace; throws a WebError when it can't be made. */
export async function appServerUrl(appId: number, staticId: string, path: string | null | undefined) {
  const s = await serverForApp(appId, staticId);
  if (!s) throw new WebError(`Remote server ${staticId.toUpperCase()} does not exist in this application's workspace (Workspace utilities → Remote servers).`);
  const u = serverUrl(s);
  if (!u.url) throw new WebError(u.problem!);
  return { url: joinUrl(u.url, path), server: s };
}

/**
 * A REST data source as the request code expects it: on a server, its URL becomes the server's base
 * URL plus the source's path, and a source without a credential of its own uses the server's.
 */
export async function resolveSource<T extends { app_id: number; url: string; credential: string | null; server?: string | null }>(src: T): Promise<T> {
  if (!src.server) return src;
  const { url, server } = await appServerUrl(src.app_id, src.server, src.url);
  // resolved once: server null, so resolving again changes nothing
  return { ...src, url, credential: src.credential || server.credential || null, server: null };
}

/** The base URL of a catalog on a server of its workspace (null: none, or the catalog has no server). */
export async function catalogServerUrl(workspaceId: number, staticId: string | null | undefined): Promise<string | null> {
  if (!staticId) return null;
  const s = await workspaceServer(workspaceId, staticId);
  return s ? serverUrl(s).url : null;
}

/** The base URL of an AI service on a server (any workspace: administrators chose it), or an error message. */
export async function aiServerUrl(serverId: number, path: string | null | undefined): Promise<{ url: string | null; problem: string | null }> {
  const s = await owner.one<RemoteServer>('select * from meta.remote_server where id = $1', [serverId]);
  if (!s) return { url: null, problem: 'Its remote server no longer exists.' };
  const u = serverUrl(s);
  return u.url ? { url: joinUrl(u.url, path), problem: null } : { url: null, problem: u.problem };
}
