import { createHash } from 'node:crypto';
import pg from 'pg';
import { owner, runtime } from './db.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';
import { WebError, webRequest, type WebResponse } from './webclient.ts';

// Web credentials and REST data sources (meta.web_credential,
// meta.rest_source): building the request (parameters, credential), OAuth2
// tokens (client credentials, password or refresh token grant; cached until
// shortly before they expire, renewed with the refresh token, which is kept
// encrypted in the database when the endpoint sends one, fetched again
// after a 401), response caching, turning a JSON response into typed rows,
// and the write-back operations of a source (insert, update, delete, fetch
// one row). The
// runtime side (regions, lists of values, the invoke_api process) is in
// src/runtime/rest-sources.ts. Secrets are decrypted only here, only for
// the request, and never put into an error message or a log line.

export interface WebCredential {
  id: number;
  app_id: number;
  name: string;
  type: 'basic' | 'header' | 'bearer' | 'oauth2';
  username: string | null;
  header_name: string | null;
  token_url: string | null;
  scope: string | null;
  valid_for: string[];
  secret_enc: string | null;
  /** oauth2 (050): client_credentials (default), password or refresh_token */
  grant_type?: 'client_credentials' | 'password' | 'refresh_token';
  oauth_username?: string | null;
  password_enc?: string | null;
  refresh_token_enc?: string | null;
}

export type ParamLocation = 'query' | 'path' | 'header' | 'body';
export interface RestParam {
  name: string;
  in: ParamLocation;
  default?: string;
  required?: boolean;
}
export type ColumnType = 'text' | 'number' | 'integer' | 'boolean' | 'date' | 'timestamp' | 'json';
export interface RestColumn {
  name: string;
  path?: string;
  type?: ColumnType;
}

export interface RestSource {
  id: number;
  app_id: number;
  name: string;
  url: string;
  method: string;
  credential: string | null;
  headers: Record<string, string>;
  params: RestParam[];
  body: string | null;
  row_selector: string | null;
  columns: RestColumn[];
  cache_seconds: number;
  timeout_s: number;
  max_rows: number;
  /** (050) the columns that identify a row (write-back, merge synchronisation) */
  key_columns?: string[];
  /** (050) write-back operations */
  operations?: Operations;
}

export type OperationName = 'insert' | 'update' | 'delete' | 'fetch';
export interface Operation {
  method?: string;
  /** after the source's URL (without its query): "/{id}", "?id={id}"; {column} takes the row's value */
  path?: string;
  /** a JSON template: {column} becomes the value as JSON; empty: the row's columns as a JSON object */
  body?: string;
  /** fetch / insert: where the row is in the response (default: the response itself) */
  row_selector?: string;
}
export type Operations = Partial<Record<OperationName, Operation>>;
export const OPERATIONS: OperationName[] = ['insert', 'update', 'delete', 'fetch'];
const OPERATION_METHOD: Record<OperationName, string> = { insert: 'POST', update: 'PUT', delete: 'DELETE', fetch: 'GET' };

export const COLUMN_TYPES: Record<ColumnType, string> = {
  text: 'text', number: 'numeric', integer: 'bigint', boolean: 'boolean', date: 'date', timestamp: 'timestamptz', json: 'jsonb',
};
const PARAM_IN = ['query', 'path', 'header', 'body'];
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** headers a source may not set itself (the credential and the transport own them) */
const RESERVED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'transfer-encoding', 'connection']);

// ---------------------------------------------------------------- checks (builder, import)

/** Problems with a REST data source definition (empty: fine). */
export function sourceProblems(s: { url?: unknown; params?: unknown; columns?: unknown; headers?: unknown; row_selector?: unknown; key_columns?: unknown; operations?: unknown }): string[] {
  const out: string[] = [];
  if (typeof s.url !== 'string' || !/^https?:\/\/[^/\s]+/i.test(s.url)) out.push('The URL must start with http:// or https://.');
  else if (/[{&]/.test(/^https?:\/\/[^/?#]*/i.exec(s.url)![0])) out.push('The URL\'s host is fixed: parameters can only follow it.');
  else {
    try {
      const u = new URL(s.url.replace(/\{[a-z_][a-z0-9_]*\}/gi, 'x'));
      if (u.username || u.password) out.push('The URL may not contain a user name or password: use a web credential.');
    } catch {
      out.push('The URL is not valid.');
    }
  }
  const params = Array.isArray(s.params) ? s.params : null;
  if (!params) out.push('Parameters must be a JSON array.');
  else {
    const seen = new Set<string>();
    for (const p of params as RestParam[]) {
      if (!p || typeof p.name !== 'string' || !NAME.test(p.name)) out.push(`Parameter ${JSON.stringify(p?.name ?? p)}: "name" is lowercase letters, digits and _.`);
      else if (seen.has(p.name)) out.push(`Parameter ${p.name} is defined twice.`);
      else seen.add(p.name);
      if (p && !PARAM_IN.includes(p.in)) out.push(`Parameter ${p?.name}: "in" is one of ${PARAM_IN.join(', ')}.`);
      if (p?.in === 'header' && !HEADER.test(p.name.replace(/_/g, '-'))) out.push(`Parameter ${p.name}: not a valid header name.`);
      if (p?.default !== undefined && typeof p.default !== 'string') out.push(`Parameter ${p.name}: "default" is a string.`);
    }
    if (typeof s.url === 'string')
      for (const m of s.url.matchAll(/\{([a-z_][a-z0-9_]*)\}/gi))
        if (!(params as RestParam[]).some((p) => p?.name === m[1] && p.in === 'path')) out.push(`The URL uses {${m[1]}}: add a path parameter "${m[1]}".`);
  }
  const cols = Array.isArray(s.columns) ? s.columns : null;
  if (!cols) out.push('Columns must be a JSON array.');
  else {
    const seen = new Set<string>();
    for (const c of cols as RestColumn[]) {
      if (!c || typeof c.name !== 'string' || !NAME.test(c.name)) out.push(`Column ${JSON.stringify(c?.name ?? c)}: "name" is lowercase letters, digits and _ (a SQL column name).`);
      else if (seen.has(c.name)) out.push(`Column ${c.name} is defined twice.`);
      else seen.add(c.name);
      if (c?.type !== undefined && !(c.type in COLUMN_TYPES)) out.push(`Column ${c.name}: "type" is one of ${Object.keys(COLUMN_TYPES).join(', ')}.`);
      if (c?.path !== undefined && (typeof c.path !== 'string' || pathProblem(c.path))) out.push(`Column ${c.name}: ${pathProblem(String(c.path)) ?? '"path" is a string'}.`);
    }
  }
  if (s.headers !== undefined && (typeof s.headers !== 'object' || s.headers === null || Array.isArray(s.headers))) out.push('Headers must be a JSON object.');
  else
    for (const [k, v] of Object.entries((s.headers ?? {}) as Record<string, unknown>)) {
      if (!HEADER.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) out.push(`Header ${k}: not allowed (use a web credential for authorization).`);
      if (typeof v !== 'string' || /[\r\n]/.test(v)) out.push(`Header ${k}: the value is a string on one line.`);
    }
  if (typeof s.row_selector === 'string' && s.row_selector.trim()) {
    const p = pathProblem(s.row_selector);
    if (p) out.push(`Row selector: ${p}.`);
  }
  out.push(...operationProblems(s));
  return out;
}

/** Problems with the key columns and the write-back operations (empty: fine). */
export function operationProblems(s: { url?: unknown; params?: unknown; columns?: unknown; key_columns?: unknown; operations?: unknown }): string[] {
  const out: string[] = [];
  const columns = Array.isArray(s.columns) ? (s.columns as RestColumn[]).map((c) => c?.name) : [];
  const params = Array.isArray(s.params) ? (s.params as RestParam[]).map((p) => p?.name) : [];
  const keys = s.key_columns ?? [];
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !NAME.test(k))) out.push('Key columns are column names (lowercase letters, digits and _).');
  else for (const k of keys) if (columns.length && !columns.includes(k)) out.push(`Key column ${k} is not one of the columns.`);
  const ops = s.operations ?? {};
  if (typeof ops !== 'object' || ops === null || Array.isArray(ops)) return [...out, 'Operations must be a JSON object, e.g. {"update": {"method": "PUT", "path": "/{id}"}}.'];
  for (const [name, op] of Object.entries(ops as Record<string, unknown>)) {
    const at = `Operation ${name}`;
    if (!OPERATIONS.includes(name as OperationName)) {
      out.push(`${at}: operations are ${OPERATIONS.join(', ')}.`);
      continue;
    }
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      out.push(`${at}: an object with "method", "path" and "body".`);
      continue;
    }
    const o = op as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['method', 'path', 'body', 'row_selector'].includes(k)) out.push(`${at}: unknown key "${k}".`);
    if (o.method !== undefined && !INVOKE_METHODS.includes(String(o.method).toUpperCase())) out.push(`${at}: "method" is one of ${INVOKE_METHODS.join(', ')}.`);
    if (o.path !== undefined) {
      if (typeof o.path !== 'string' || o.path.length > 500) out.push(`${at}: "path" is text (at most 500 characters).`);
      else if (!/^[/?]?[^\s#\\]*$/.test(o.path) || o.path.includes('//') || o.path.includes(':') || /(^|\/)\.\.?(\/|$|\?)/.test(o.path))
        out.push(`${at}: "path" follows the source's URL, e.g. /{id} or ?id={id} (no host, no "..", no spaces).`);
      else
        for (const m of o.path.matchAll(/\{([^}]*)\}/g))
          if (!columns.includes(m[1]) && !params.includes(m[1])) out.push(`${at}: the path uses {${m[1]}}, which is not a column or parameter.`);
    }
    if (o.body !== undefined && typeof o.body !== 'string') out.push(`${at}: "body" is a JSON template (text).`);
    if (o.row_selector !== undefined && (typeof o.row_selector !== 'string' || pathProblem(o.row_selector))) out.push(`${at}: "row_selector" is a path, e.g. data.`);
    if (name !== 'insert' && Array.isArray(keys) && !keys.length) out.push(`${at}: set the key columns first (the row's identity).`);
  }
  return out;
}

export const GRANT_TYPES = ['client_credentials', 'password', 'refresh_token'];

export function credentialProblems(c: { type?: unknown; header_name?: unknown; token_url?: unknown; valid_for?: unknown; username?: unknown; grant_type?: unknown; oauth_username?: unknown }): string[] {
  const out: string[] = [];
  if (c.type === 'header' && (typeof c.header_name !== 'string' || !HEADER.test(c.header_name))) out.push('An HTTP header credential needs the header\'s name, e.g. X-API-Key.');
  if (c.type === 'header' && typeof c.header_name === 'string' && RESERVED_HEADERS.has(c.header_name.toLowerCase()) && c.header_name.toLowerCase() !== 'authorization')
    out.push(`The header ${c.header_name} cannot carry a credential.`);
  if (c.type === 'oauth2') {
    const grant = c.grant_type ?? 'client_credentials';
    if (!GRANT_TYPES.includes(grant as string)) out.push(`The OAuth2 grant type is one of ${GRANT_TYPES.join(', ')}.`);
    if (typeof c.token_url !== 'string' || !/^https?:\/\//.test(c.token_url)) out.push('OAuth2 needs the token URL.');
    if (typeof c.username !== 'string' || !c.username) out.push('OAuth2 needs the client id (in "User name / client id").');
    if (grant === 'password' && (typeof c.oauth_username !== 'string' || !c.oauth_username)) out.push('The OAuth2 password flow needs the user name to sign in with (in "OAuth2 user name").');
  }
  if (c.type === 'basic' && (typeof c.username !== 'string' || !c.username)) out.push('Basic authentication needs a user name.');
  for (const v of Array.isArray(c.valid_for) ? c.valid_for : []) {
    try {
      const u = new URL(String(v));
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      out.push(`"Valid for" ${JSON.stringify(v)} is not an http(s) URL.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- JSON paths

type Seg = string | number | '*';

function pathProblem(path: string): string | null {
  try {
    parsePath(path);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** a.b[0].c, $.a["x y"], items[*] */
export function parsePath(path: string): Seg[] {
  const segs: Seg[] = [];
  let s = path.trim();
  if (s.startsWith('$')) s = s.slice(1);
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') {
      i++;
      if (i === s.length) throw new Error(`"${path}" ends with a dot`);
      continue;
    }
    if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw new Error(`"${path}" has an unclosed [`);
      const inner = s.slice(i + 1, end).trim();
      if (inner === '*') segs.push('*');
      else if (/^\d+$/.test(inner)) segs.push(Number(inner));
      else if (/^(['"]).*\1$/.test(inner)) segs.push(inner.slice(1, -1));
      else throw new Error(`"${path}": [${inner}] is not an index, * or a quoted name`);
      i = end + 1;
      continue;
    }
    const m = /^[^.[\]]+/.exec(s.slice(i))!;
    if (!m) throw new Error(`"${path}" is not a path`);
    segs.push(m[0] === '*' ? '*' : m[0]);
    i += m[0].length;
  }
  return segs;
}

/** The values at `path` (a * gives every element). */
export function select(value: unknown, path: string | null | undefined): unknown[] {
  let current: unknown[] = [value];
  let spread = false;
  for (const seg of parsePath(path ?? '')) {
    const next: unknown[] = [];
    for (const v of current) {
      if (v === null || typeof v !== 'object') continue;
      if (seg === '*') {
        spread = true;
        next.push(...(Array.isArray(v) ? v : Object.values(v)));
      } else if (typeof seg === 'number') {
        if (Array.isArray(v) && seg < v.length) next.push(v[seg]);
      } else if (!Array.isArray(v) && Object.hasOwn(v, seg)) next.push((v as Record<string, unknown>)[seg]);
    }
    current = next;
  }
  return spread ? current : current.length ? [current[0]] : [];
}

/** The value at a path (undefined when there is none). */
export const valueAt = (value: unknown, path: string) => select(value, path)[0];

// ---------------------------------------------------------------- rows

function coerce(v: unknown, type: ColumnType): unknown {
  if (v === undefined || v === null) return null;
  switch (type) {
    case 'json':
      return v;
    case 'text':
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v) ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
      return Number.isSafeInteger(n) ? n : null;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      return ['true', 't', 'yes', 'y', '1'].includes(s) ? true : ['false', 'f', 'no', 'n', '0'].includes(s) ? false : null;
    }
    case 'date': {
      const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(v) : null;
      return m && !Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : null;
    }
    case 'timestamp': {
      const d = typeof v === 'number' ? new Date(v > 1e11 ? v : v * 1000) : typeof v === 'string' ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
    }
  }
}

/** Columns from the first rows of a response, for a source that defines none (and the builder's suggestion). */
export function guessColumns(rows: unknown[]): RestColumn[] {
  const out = new Map<string, RestColumn>();
  for (const row of rows.slice(0, 20)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const [k, v] of Object.entries(row)) {
      const name = k.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 63);
      if (!NAME.test(name) || out.has(name) || v === null) continue;
      const type: ColumnType =
        typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number')
        : typeof v === 'boolean' ? 'boolean'
        : typeof v === 'object' ? 'json'
        : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? 'date'
        : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(v)) ? 'timestamp'
        : 'text';
      out.set(name, { name, ...(name === k ? {} : { path: /^[A-Za-z_$][\w$]*$/.test(k) ? k : `[${JSON.stringify(k)}]` }), type });
    }
  }
  return [...out.values()];
}

/** The response's rows (row selector), each mapped to the columns. */
export function toRows(json: unknown, s: Pick<RestSource, 'row_selector' | 'columns' | 'max_rows'>) {
  const selected = select(json, s.row_selector);
  const raw = selected.length === 1 && Array.isArray(selected[0]) ? selected[0] : selected;
  const items = raw.slice(0, s.max_rows);
  const columns = s.columns.length ? s.columns : guessColumns(items);
  const rows = items.map((item) => {
    const row: Record<string, unknown> = {};
    for (const c of columns) row[c.name] = coerce(valueAt(item, c.path ?? c.name), c.type ?? 'text');
    return row;
  });
  return { columns, rows, truncated: raw.length > items.length };
}

/**
 * SQL for typed rows: select … from jsonb_to_recordset('[…]'). The data is
 * one escaped literal (binds skip string literals); names were checked.
 */
export function rowsSql(columns: RestColumn[], rows: Record<string, unknown>[]) {
  if (!columns.length) return 'select null::text as "no_columns" where false';
  const defs = columns.map((c) => {
    if (!NAME.test(c.name)) throw new WebError(`Column ${c.name} is not a valid SQL name.`);
    return `${pg.escapeIdentifier(c.name)} ${COLUMN_TYPES[c.type ?? 'text'] ?? 'text'}`;
  });
  return `select * from jsonb_to_recordset(${pg.escapeLiteral(JSON.stringify(rows))}::jsonb) as "__rest"(${defs.join(', ')})`;
}

/** A query over the rows: the developer's SQL reads them from the CTE "rest" (default: all of them). */
export const withRest = (rowsQuery: string, sql: string | null | undefined) =>
  `with rest as (\n${rowsQuery}\n)\n${sql?.trim() ? sql : 'select * from rest'}`;

// ---------------------------------------------------------------- loading

export async function loadSource(appId: number, name: string) {
  const s = await runtime.one<RestSource>(
    `select id, app_id, name, url, method, credential, headers, params, body, row_selector, columns, cache_seconds, timeout_s, max_rows, key_columns, operations
       from meta.rest_source where app_id = $1 and name = $2`,
    [appId, name.toUpperCase()],
  );
  if (!s) throw new WebError(`REST data source ${name} does not exist.`);
  return s;
}

/** With the (encrypted) secret: the owner connection, never the runtime role. */
export async function loadCredential(appId: number, name: string) {
  const c = await owner.one<WebCredential>(
    `select id, app_id, name, type, username, header_name, token_url, scope, valid_for, secret_enc, grant_type, oauth_username, password_enc, refresh_token_enc
       from meta.web_credential where app_id = $1 and name = $2`,
    [appId, name.toUpperCase()],
  );
  if (!c) throw new WebError(`Web credential ${name} does not exist.`);
  return c;
}

// ---------------------------------------------------------------- credentials

/** Whether a credential may be sent to this URL ("valid for" prefixes, by origin and path). */
export function credentialValidFor(c: Pick<WebCredential, 'valid_for'>, url: string) {
  if (!c.valid_for?.length) return true;
  const u = new URL(url);
  return c.valid_for.some((p) => {
    try {
      const v = new URL(p);
      const path = v.pathname.endsWith('/') ? v.pathname : `${v.pathname}/`;
      return u.origin === v.origin && (u.pathname === v.pathname || `${u.pathname}/`.startsWith(path) || u.pathname.startsWith(path));
    } catch {
      return false;
    }
  });
}

interface Token {
  access: string;
  refresh: string | null;
  expires: number;
}
const tokens = new Map<string, Token>();
const pendingTokens = new Map<string, Promise<Token>>();
const credKey = (c: WebCredential) =>
  createHash('sha256').update(JSON.stringify([c.id, c.username, c.token_url, c.scope, c.secret_enc, c.grant_type ?? null, c.oauth_username ?? null, c.password_enc ?? null])).digest('base64url');

/** Forget cached tokens (all, or one credential's). */
export function clearTokens(credentialId?: number) {
  for (const k of [...tokens.keys()]) if (credentialId === undefined || k.startsWith(`${credentialId}:`)) tokens.delete(k);
}

const secretOf = (c: WebCredential) => {
  if (!c.secret_enc) throw new WebError(`Web credential ${c.name} has no secret yet: enter it in the builder (Shared Components → Web credentials).`);
  return decryptSecret(c.secret_enc);
};

const grantOf = (c: WebCredential) => c.grant_type ?? 'client_credentials';

/** The form of a token request: the grant (or a refresh), the client's id and secret. */
export function tokenRequest(c: WebCredential, refresh: string | null) {
  const grant = grantOf(c);
  const form = new URLSearchParams();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (refresh) {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refresh);
  } else if (grant === 'password') {
    if (!c.password_enc) throw new WebError(`Web credential ${c.name} has no password yet: enter it in the builder (Shared Components → Web credentials).`);
    form.set('grant_type', 'password');
    form.set('username', c.oauth_username ?? '');
    form.set('password', decryptSecret(c.password_enc));
  } else if (grant === 'refresh_token') {
    throw new WebError(`Web credential ${c.name} has no refresh token: enter one in the builder (Shared Components → Web credentials).`);
  } else form.set('grant_type', 'client_credentials');
  if (c.scope && !refresh) form.set('scope', c.scope);
  // the client authenticates with HTTP basic when it has a secret (always for client credentials);
  // a public client (password or refresh token grant without a secret) sends its id in the form
  if (c.secret_enc || grant === 'client_credentials')
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.username ?? '')}:${encodeURIComponent(secretOf(c))}`).toString('base64')}`;
  else form.set('client_id', c.username ?? '');
  return { headers, body: form.toString() };
}

async function requestToken(c: WebCredential, refresh: string | null, timeoutMs: number): Promise<Token> {
  const { headers, body } = tokenRequest(c, refresh);
  const res = await webRequest(c.token_url!, {
    method: 'POST',
    headers,
    secretHeaders: ['authorization'],
    body,
    timeoutMs,
    maxBytes: 100_000,
  });
  let json: any = null;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch {
    // reported below
  }
  if (res.status !== 200 || typeof json?.access_token !== 'string') {
    const code = typeof json?.error === 'string' ? ` (${json.error.slice(0, 60)})` : '';
    throw new WebError(`The token endpoint of web credential ${c.name} answered ${res.status}${code}.`, res.status);
  }
  const ttl = Number(json.expires_in);
  // a new refresh token (first one, or rotated): kept encrypted, for restarts and other servers
  const newRefresh = typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null;
  if (newRefresh && newRefresh !== refresh && c.id > 0) await storeRefreshToken(c, newRefresh);
  return {
    access: json.access_token,
    refresh: newRefresh ?? refresh,
    // renew 30 seconds early; without expires_in, keep it for 5 minutes
    expires: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? Math.max(ttl - 30, ttl / 2) : 300) * 1000,
  };
}

/** Keep a refresh token (encrypted); written with the owner connection only. */
async function storeRefreshToken(c: WebCredential, token: string) {
  const enc = encryptSecret(token);
  await owner.query('update meta.web_credential set refresh_token_enc = $2, token_refreshed_at = now() where id = $1', [c.id, enc]);
  c.refresh_token_enc = enc;
}

/** The stored refresh token (null when there is none or it can't be decrypted any more). */
function storedRefresh(c: WebCredential) {
  if (!c.refresh_token_enc) return null;
  try {
    return decryptSecret(c.refresh_token_enc);
  } catch {
    return null;
  }
}

async function oauthToken(c: WebCredential, timeoutMs: number, fresh = false): Promise<string> {
  const key = `${c.id}:${credKey(c)}`;
  const cached = tokens.get(key);
  if (cached && !fresh && cached.expires > Date.now()) return cached.access;
  let p = pendingTokens.get(key);
  if (!p) {
    p = (async () => {
      const refresh = cached?.refresh ?? storedRefresh(c);
      if (refresh) {
        try {
          return await requestToken(c, refresh, timeoutMs);
        } catch (e) {
          // the refresh token may have expired: ask again with the grant (a refresh token grant has nothing else)
          if (grantOf(c) === 'refresh_token')
            throw new WebError(`${(e as Error).message} The refresh token of web credential ${c.name} may have expired: enter a new one in the builder.`, (e as WebError).status);
        }
      }
      return requestToken(c, null, timeoutMs);
    })();
    pendingTokens.set(key, p);
  }
  try {
    const t = await p;
    tokens.set(key, t);
    return t.access;
  } finally {
    pendingTokens.delete(key);
  }
}

/** Headers that sign a request with the credential; the names in secret are secrets. */
async function credentialHeaders(c: WebCredential, url: string, timeoutMs: number, fresh = false) {
  if (!credentialValidFor(c, url)) throw new WebError(`Web credential ${c.name} is not valid for this URL (see its "Valid for" URLs).`);
  switch (c.type) {
    case 'basic':
      return { authorization: `Basic ${Buffer.from(`${c.username ?? ''}:${secretOf(c)}`).toString('base64')}` };
    case 'bearer':
      return { authorization: `Bearer ${secretOf(c)}` };
    case 'header': {
      const value = secretOf(c);
      if (/[\r\n]/.test(value)) throw new WebError(`Web credential ${c.name}: the secret is not a valid header value.`);
      return { [c.header_name!.toLowerCase()]: value };
    }
    case 'oauth2':
      return { authorization: `Bearer ${await oauthToken(c, timeoutMs, fresh)}` };
    default:
      throw new WebError(`Web credential ${c.name} has an unknown type.`);
  }
}

// ---------------------------------------------------------------- calling

export interface CallOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credential?: WebCredential | null;
  timeoutMs?: number;
  /** more header names (lower case) that carry secrets: dropped on a cross-origin redirect */
  secretHeaders?: string[];
}

/** One request, signed with the credential; an OAuth2 token refused with 401 is renewed once. */
export async function call(o: CallOptions): Promise<WebResponse> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const send = async (fresh: boolean) => {
    const auth: Record<string, string> = o.credential ? await credentialHeaders(o.credential, o.url, timeoutMs, fresh) : {};
    return webRequest(o.url, {
      method: o.method ?? 'GET',
      headers: { accept: 'application/json', ...o.headers, ...auth },
      secretHeaders: [...Object.keys(auth), ...(o.secretHeaders ?? [])],
      body: o.body,
      timeoutMs,
    });
  };
  const res = await send(false);
  if (res.status === 401 && o.credential?.type === 'oauth2') {
    clearTokens(o.credential.id);
    return send(true);
  }
  return res;
}

/**
 * The request for a source with parameter values (missing ones take their
 * default; values are already substituted by the caller). Path parameters
 * are URL-encoded into the URL, query parameters appended, header
 * parameters sent as headers, body parameters as JSON.
 */
export function buildRequest(s: RestSource, values: Record<string, string | null | undefined>) {
  // checked again here: a definition may have come in through SQL
  const problems = sourceProblems(s);
  if (problems.length) throw new WebError(`REST data source ${s.name}: ${problems.join(' ')}`);
  const known = new Map(s.params.map((p) => [p.name, p]));
  for (const k of Object.keys(values)) if (!known.has(k)) throw new WebError(`REST data source ${s.name} has no parameter ${k}.`);
  const val = (p: RestParam) => {
    const v = values[p.name] ?? p.default ?? '';
    if (p.required && v === '') throw new WebError(`REST data source ${s.name} needs a value for ${p.name}.`);
    return v;
  };
  let url = s.url.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, name: string) => {
    const p = known.get(name);
    if (p?.in !== 'path') return m;
    const v = val(p);
    // "." and ".." would move up the URL's path
    if (v === '.' || v === '..') throw new WebError(`Parameter ${name}: "${v}" is not a valid value in a URL.`);
    return encodeURIComponent(v);
  });
  const u = new URL(url);
  const headers: Record<string, string> = {};
  const bodyParams: Record<string, string> = {};
  for (const p of s.params) {
    if (p.in === 'query') {
      const v = val(p);
      if (v !== '') u.searchParams.set(p.name, v);
    } else if (p.in === 'header') {
      const v = val(p);
      if (/[\r\n]/.test(v)) throw new WebError(`Parameter ${p.name}: a header value is one line.`);
      if (v !== '') headers[p.name.replace(/_/g, '-')] = v;
    } else if (p.in === 'body') bodyParams[p.name] = val(p);
  }
  url = u.toString();
  for (const [k, v] of Object.entries(s.headers ?? {})) if (!RESERVED_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = String(v);
  let body: string | undefined;
  if (!['GET', 'DELETE'].includes(s.method) || s.body?.trim()) {
    body = s.body?.trim()
      ? s.body.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (m, name: string) => {
          const p = known.get(name);
          return p ? JSON.stringify(val(p)) : m;
        })
      : JSON.stringify(bodyParams);
    headers['content-type'] ??= 'application/json';
  }
  return { url, method: s.method, headers, body };
}

// ---------------------------------------------------------------- write-back

/** A row value as JSON, by the column's type ('' and missing values are null). */
export function jsonValue(v: unknown, type: ColumnType | undefined): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (type === 'json' && typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  const c = coerce(v, type ?? 'text');
  // a value that doesn't fit its type is sent as it was typed: the service decides
  return c === null ? (typeof v === 'object' ? v : String(v)) : c;
}

/** The row as a JSON object: each column at its path when that is a plain dotted path, else under its name. */
export function rowObject(row: Record<string, unknown>, columns: RestColumn[]) {
  const out: Record<string, any> = {};
  for (const c of columns) {
    if (!Object.hasOwn(row, c.name)) continue;
    const path = c.path && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(c.path) ? c.path.split('.') : [c.name];
    let at = out;
    for (const seg of path.slice(0, -1)) at = at[seg] = typeof at[seg] === 'object' && at[seg] !== null ? at[seg] : {};
    at[path[path.length - 1]] = jsonValue(row[c.name], c.type);
  }
  return out;
}

const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/gi;

/**
 * The request of a write-back operation for a row: the path follows the
 * source's URL (without its query), {column} placeholders take the row's
 * values and {param} the parameter values, URL-encoded; the host can't
 * change (checked). The body is the template with JSON values, or the row
 * as a JSON object.
 */
export function buildOperation(s: RestSource, name: OperationName, row: Record<string, unknown>, params: Record<string, string> = {}) {
  const op = s.operations?.[name];
  if (!op) throw new WebError(`REST data source ${s.name} has no ${name} operation.`);
  const problems = sourceProblems(s);
  if (problems.length) throw new WebError(`REST data source ${s.name}: ${problems.join(' ')}`);
  const fill = (tpl: string) =>
    tpl.replace(PLACEHOLDER, (m, n: string) => {
      let v: string;
      if (Object.hasOwn(row, n)) {
        const x = row[n];
        v = x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x);
      } else {
        const p = s.params.find((q) => q.name === n);
        if (!p) return m;
        v = params[n] ?? p.default ?? '';
      }
      if (v === '.' || v === '..') throw new WebError(`REST data source ${s.name}: "${v}" is not a valid value in a URL.`);
      if (v === '' && name !== 'insert') throw new WebError(`REST data source ${s.name}: the ${name} operation needs a value for ${n}.`);
      return encodeURIComponent(v);
    });
  const base = new URL(fill(s.url));
  base.search = '';
  base.hash = '';
  const path = fill(op.path ?? '');
  let joined = base.toString();
  if (path.startsWith('?')) joined += path;
  else if (path) joined = `${joined.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const url = new URL(joined);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/+$/, '')))
    throw new WebError(`REST data source ${s.name}: the ${name} operation's path leaves the source's URL.`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.headers ?? {})) if (!RESERVED_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = String(v);
  const method = (op.method ?? OPERATION_METHOD[name]).toUpperCase();
  let body: string | undefined;
  if (op.body?.trim()) {
    const types = new Map(s.columns.map((c) => [c.name, c.type]));
    body = op.body.replace(PLACEHOLDER, (m, n: string) => {
      if (Object.hasOwn(row, n)) return JSON.stringify(jsonValue(row[n], types.get(n)));
      const p = s.params.find((q) => q.name === n);
      return p ? JSON.stringify(params[n] ?? p.default ?? '') : m;
    });
  } else if (name === 'insert' || name === 'update') body = JSON.stringify(rowObject(row, s.columns));
  if (body !== undefined) headers['content-type'] ??= 'application/json';
  return { url: url.toString(), method, headers, body };
}

/**
 * Call a write-back operation for a row with the source's credential (the
 * allow-list, address checks and "valid for" URLs apply). A status outside
 * 200–299 fails. Returns the response's JSON (null when empty) and, for
 * insert and fetch, the row in it (by the operation's row selector).
 */
export async function callOperation(s: RestSource, name: OperationName, row: Record<string, unknown>, params: Record<string, string> = {}) {
  const req = buildOperation(s, name, row, params);
  const credential = s.credential ? await loadCredential(s.app_id, s.credential) : null;
  const res = await call({ ...req, credential, timeoutMs: s.timeout_s * 1000 });
  if (name === 'fetch' && res.status === 404) return { json: null, row: null, status: 404 };
  if (res.status < 200 || res.status > 299) throw new WebError(`REST data source ${s.name}: the ${name} operation was answered with ${res.status}.`, res.status);
  const json = parseJson(res, `REST data source ${s.name}`);
  let one: Record<string, unknown> | null = null;
  if ((name === 'fetch' || name === 'insert') && json !== null && typeof json === 'object') {
    const { rows } = toRows(json, { row_selector: s.operations?.[name]?.row_selector ?? null, columns: s.columns, max_rows: 1 });
    one = rows[0] ?? null;
  }
  // the source's rows changed: cached responses are stale
  if (name !== 'fetch') clearResponseCache(s.id);
  return { json, row: one, status: res.status };
}

interface Cached {
  at: number;
  json: unknown;
}
const responses = new Map<string, Cached>();
const CACHE_ENTRIES = 200;

/** Forget cached responses (all, or one source's). */
export function clearResponseCache(sourceId?: number) {
  if (sourceId === undefined) return responses.clear();
  for (const k of [...responses.keys()]) if (k.startsWith(`${sourceId}:`)) responses.delete(k);
}

/** The parsed JSON response of a source (from the cache when it is fresh enough). */
export async function fetchSource(s: RestSource, values: Record<string, string | null | undefined>) {
  const req = buildRequest(s, values);
  const credential = s.credential ? await loadCredential(s.app_id, s.credential) : null;
  const key = s.cache_seconds > 0
    ? `${s.id}:${createHash('sha256').update(JSON.stringify([s, req, credential ? credKey(credential) : null])).digest('base64url')}`
    : null;
  if (key) {
    const hit = responses.get(key);
    if (hit && Date.now() - hit.at < s.cache_seconds * 1000) return { json: hit.json, status: 200, cached: true };
  }
  const res = await call({ ...req, credential, timeoutMs: s.timeout_s * 1000 });
  if (res.status < 200 || res.status > 299) throw new WebError(`REST data source ${s.name}: the web service answered ${res.status}.`, res.status);
  const json = parseJson(res, `REST data source ${s.name}`);
  if (key) {
    responses.delete(key);
    responses.set(key, { at: Date.now(), json });
    // the oldest entries go first
    while (responses.size > CACHE_ENTRIES) responses.delete(responses.keys().next().value!);
  }
  return { json, status: res.status, cached: false };
}

export function parseJson(res: WebResponse, what: string) {
  const text = res.body.toString('utf8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new WebError(`${what}: the response is not JSON.`);
  }
}

// ---------------------------------------------------------------- invoke API

/**
 * The call of an "invoke API" configuration, shared by the invoke_api page
 * process (src/runtime/rest-sources.ts) and the invoke_api workflow step
 * (src/workflow.ts): a REST data source (its URL, method, credential,
 * parameters), or a URL with a method, a credential and a body. Values come
 * in through &NAME. substitutions, resolved by the caller's lookup.
 */
export interface InvokeConfig {
  /** a REST data source of the app */
  source?: string;
  /** its parameter values ({"city": "&P5_CITY."}); missing ones take their default */
  params?: Record<string, string>;
  /** or a URL (&NAME. substitutions after the host, URL-encoded), method, credential and body */
  url?: string;
  method?: string;
  credential?: string;
  body?: string;
}

export const INVOKE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Problems with the call part of an invoke API configuration (empty: fine); `what` starts the first message. */
export function invokeCallProblems(conf: unknown, what = 'An invoke_api process'): string[] {
  const c = (conf ?? {}) as InvokeConfig;
  const out: string[] = [];
  if (!c.source === !c.url) out.push(`${what} needs either "source" (a REST data source) or "url".`);
  if (c.source !== undefined && typeof c.source !== 'string') out.push('"source" names a REST data source.');
  if (c.url !== undefined && (typeof c.url !== 'string' || !/^https?:\/\/[^/?#&{]+([/?#]|$)/i.test(c.url)))
    out.push('"url" starts with http:// or https:// and a fixed host (substitutions only after the host).');
  if (c.method !== undefined && !INVOKE_METHODS.includes(String(c.method).toUpperCase())) out.push(`"method" is one of ${INVOKE_METHODS.join(', ')}.`);
  for (const k of ['credential', 'body'] as const) if (c[k] !== undefined && typeof c[k] !== 'string') out.push(`"${k}" is a string.`);
  if (c.params !== undefined && !isStringMap(c.params)) out.push('"params" is an object of strings.');
  return out;
}

export const isStringMap = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/** A value for &NAME. (NAME upper case), or undefined to leave the text as written. */
export type Lookup = (name: string) => string | undefined;

const SUBST = /&([A-Za-z][A-Za-z0-9_]*)\./g;

/** &NAME. substitutions in a text. */
export const substitute = (text: string, lookup: Lookup) => text.replace(SUBST, (m, name: string) => lookup(name.toUpperCase()) ?? m);

/** Values for every parameter of the source: given ones (with substitutions), else the default (with substitutions). */
export function sourceParamValues(s: RestSource, given: Record<string, unknown> | undefined, lookup: Lookup) {
  const out: Record<string, string> = {};
  for (const k of Object.keys(given ?? {}))
    if (!s.params.some((p) => p.name === k)) throw new WebError(`REST data source ${s.name} has no parameter ${k}.`);
  for (const p of s.params) {
    const v = given?.[p.name] ?? p.default;
    out[p.name] = v === undefined || v === null ? '' : substitute(String(v), lookup);
  }
  return out;
}

/**
 * Make the call of an invoke API configuration (checked by the caller with
 * invokeCallProblems). Through call(): the host allow-list, the address
 * checks at connect time and the credential's "valid for" URLs apply.
 * `timeoutS` overrides the source's time limit (default 10 s for a URL).
 */
export async function invoke(appId: number, conf: InvokeConfig, lookup: Lookup, what: string, timeoutS?: number): Promise<{ res: WebResponse; source: RestSource | null }> {
  if (conf.source) {
    const source = await loadSource(appId, conf.source);
    const req = buildRequest(source, sourceParamValues(source, conf.params, lookup));
    const credential = source.credential ? await loadCredential(appId, source.credential) : null;
    return { res: await call({ ...req, credential, timeoutMs: (timeoutS ?? source.timeout_s) * 1000 }), source };
  }
  // values are URL-encoded and only follow the host (invokeCallProblems), so the host is always the developer's
  const url = conf.url!.replace(SUBST, (m, name: string) => {
    const v = lookup(name.toUpperCase());
    if (v === undefined) return m;
    if (v === '.' || v === '..') throw new WebError(`${what}: "${v}" is not a valid value in a URL.`);
    return encodeURIComponent(v);
  });
  const method = (conf.method ?? 'GET').toUpperCase();
  const body = conf.body ? conf.body.replace(SUBST, (m, name: string) => {
    const v = lookup(name.toUpperCase());
    return JSON.stringify(v ?? m);
  }) : undefined;
  const credential = conf.credential ? await loadCredential(appId, conf.credential) : null;
  const res = await call({ url, method, headers: body ? { 'content-type': 'application/json' } : {}, body, credential, timeoutMs: (timeoutS ?? 10) * 1000 });
  return { res, source: null };
}

/** The JSON of a successful response (null when empty); an error status fails unless the caller keeps the status. */
export function invokeJson(res: WebResponse, what: string, keepStatus: boolean): unknown {
  const ok = res.status >= 200 && res.status <= 299;
  if (!ok && !keepStatus) throw new WebError(`${what}: the web service answered ${res.status}.`, res.status);
  return ok ? parseJson(res, what) : null;
}
