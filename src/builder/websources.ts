import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { encryptSecret, secretKeyConfigured } from '../secrets.ts';
import type { Session } from '../session.ts';
import { buildRequest, call, clearTokens, credentialProblems, guessColumns, loadCredential, parseJson, rowsSql, select, sourceProblems, toRows, withRest, type RestColumn, type RestSource } from '../websources.ts';
import type { ComponentSpec } from './components.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Shared Components → Web credentials and REST data sources: their property
// specs, the secret's status (never the secret), "Test" for a source (its
// rows, a column suggestion, the start of the response) and "Use these
// columns".

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

export const WEB_CREDENTIAL_SPEC: ComponentSpec = {
  table: 'meta.web_credential',
  scope: 'app',
  label: 'Web credential',
  plural: 'Web credentials',
  icon: 'key',
  summary: (c) => c.name,
  defaults: { type: 'basic' },
  validate: (v) => {
    const problems = credentialProblems(v);
    return problems.length ? problems.join(' ') : null;
  },
  // the secret is encrypted here and never stored or shown in clear; empty keeps the stored one
  beforeSave: async (values) => {
    const secret = values.secret as string | null;
    delete values.secret;
    if (secret) values.secret_enc = encryptSecret(secret);
  },
  fields: [
    { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'e.g. WEATHER_API; REST data sources and invoke_api processes use it by this name.' },
    { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
    { name: 'type', label: 'Authentication', kind: 'select', options: ['basic', 'header', 'bearer', 'oauth2'], group: 'Authentication',
      help: 'basic: HTTP basic (user name + password) · header: an HTTP header with the secret, e.g. an API key · bearer: Authorization: Bearer <secret> · oauth2: client credentials (pgapex gets, caches and renews the token).' },
    { name: 'username', label: 'User name / client id', kind: 'text', group: 'Authentication' },
    { name: 'header_name', label: 'Header name (header)', kind: 'text', group: 'Authentication', help: 'e.g. X-API-Key' },
    { name: 'token_url', label: 'Token URL (oauth2)', kind: 'text', wide: true, group: 'Authentication', help: 'e.g. https://login.example.com/oauth/token' },
    { name: 'scope', label: 'Scope (oauth2)', kind: 'text', group: 'Authentication' },
    { name: 'secret', label: 'Secret', kind: 'secret', wide: true, group: 'Secret',
      help: 'The password, header value, token or client secret. Stored encrypted; it is never shown again or exported. Leave empty to keep the stored secret.' },
    { name: 'valid_for', label: 'Valid for URLs', kind: 'list', wide: true, group: 'Security',
      help: 'Comma separated URL prefixes, e.g. https://api.example.com/v2/ — the credential is only ever sent to these. Recommended.' },
  ],
};

export const REST_SOURCE_SPEC: ComponentSpec = {
  table: 'meta.rest_source',
  scope: 'app',
  label: 'REST data source',
  plural: 'REST data sources',
  icon: 'database',
  summary: (s) => s.name,
  defaults: { method: 'GET', cache_seconds: 0, timeout_s: 10, max_rows: 1000, params: [], columns: [], headers: {} },
  validate: (v) => {
    // an empty JSON field arrives as {}
    for (const k of ['params', 'columns']) if (v[k] === '{}') v[k] = '[]';
    const problems = sourceProblems({ url: v.url, params: json(v.params), columns: json(v.columns), headers: json(v.headers), row_selector: v.row_selector });
    return problems.length ? problems.join(' ') : null;
  },
  fields: [
    { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'Regions and lists of values use it by this name, e.g. COUNTRIES.' },
    { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
    { name: 'url', label: 'URL', kind: 'text', wide: true, group: 'Request',
      help: 'e.g. https://api.example.com/v1/cities/{city}/weather — {name} is a path parameter. The host must be on the server\'s allow-list (PGAPEX_REST_ALLOWED_HOSTS).' },
    { name: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], group: 'Request' },
    { name: 'credential', label: 'Web credential', kind: 'upper', group: 'Request', help: 'The name of a web credential, or empty.' },
    { name: 'params', label: 'Parameters (JSON)', kind: 'json', wide: true, group: 'Request',
      help: '[{"name": "city", "in": "path", "default": "&P1_CITY.", "required": true}, {"name": "units", "in": "query", "default": "metric"}] · in: path, query, header, body. Defaults may use &ITEM. substitutions; regions override them with {"rest_params": {…}}.' },
    { name: 'headers', label: 'Headers (JSON)', kind: 'json', group: 'Request', help: '{"Accept-Language": "en"} — not for secrets: use a web credential.' },
    { name: 'body', label: 'Body (POST, PUT, PATCH)', kind: 'textarea', wide: true, group: 'Request', help: '{"query": {q}} — {name} becomes the parameter as a JSON string. Empty: the body parameters as a JSON object.' },
    { name: 'row_selector', label: 'Row selector', kind: 'text', group: 'Response', help: 'Where the rows are, e.g. items, data.results or $.list[*]. Empty: the response (an array, or one object = one row).' },
    { name: 'columns', label: 'Columns (JSON)', kind: 'json', wide: true, group: 'Response',
      help: '[{"name": "city", "path": "location.name", "type": "text"}, {"name": "temp", "path": "main.temp", "type": "number"}] · types: text, number, integer, boolean, date, timestamp, json. Use "Test" below to get a suggestion.' },
    { name: 'cache_seconds', label: 'Cache (seconds)', kind: 'int', group: 'Response', help: '0: no cache. Cached responses are shared by all users of the application.' },
    { name: 'timeout_s', label: 'Timeout (seconds)', kind: 'int', group: 'Response' },
    { name: 'max_rows', label: 'Maximum rows', kind: 'int', group: 'Response' },
  ],
};

/**
 * A region's SQL for the builder (columns, checks): with a REST data source,
 * the source's columns without rows, so nothing is fetched.
 */
export async function designSql(appId: number, r: { source: string | null; rest_source?: string | null }) {
  if (!r.rest_source) return r.source;
  const s = await owner.one<{ columns: RestColumn[] }>('select columns from meta.rest_source where app_id = $1 and name = $2', [appId, r.rest_source]);
  return s ? withRest(rowsSql(s.columns, []), r.source) : r.source;
}

// ---------------------------------------------------------------- extras

export function credentialExtras(appId: number, row: { id: number; secret_enc: string | null; type: string }, s: Session) {
  return html`<fieldset class="prop-group u-mt125"><legend>Secret</legend>
    <p>${row.secret_enc ? html`<b>A secret is stored</b> (encrypted). It is never shown; type a new one above to replace it.` : html`<b>No secret yet.</b> Requests with this credential fail until one is entered.`}</p>
    ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">The server has no <code>PGAPEX_SECRET_KEY</code>: secrets can't be saved or used until it is set (at least 32 characters).</div>`}
    ${row.secret_enc
      ? html`<form method="post" action="${BASE}/apps/${appId}/web-credentials/${row.id}/clear">${csrf(s)}<button class="btn" data-confirm="Remove the stored secret?">Remove the secret</button></form>`
      : ''}
  </fieldset>`;
}

interface TestResult {
  id: number;
  ok: boolean;
  message: string;
  columns?: string[];
  rows?: unknown[][];
  suggested?: string;
  excerpt?: string;
}

const RESULT = '__RESTTEST';

export function restSourceExtras(appId: number, row: RestSource, s: Session) {
  let result: TestResult | null = null;
  try {
    const r = JSON.parse(s.state[RESULT] ?? 'null') as TestResult | null;
    if (r?.id === row.id) result = r;
  } catch {
    // ignored
  }
  delete s.state[RESULT];
  const params = Array.isArray(row.params) ? row.params : [];
  return html`<fieldset class="prop-group u-mt125"><legend>Test</legend>
    <form method="post" action="${BASE}/apps/${appId}/rest-sources/${row.id}/test">${csrf(s)}
      ${params.length
        ? html`<div class="form-grid">${params.map((p) => html`<div class="field"><label class="label" for="rt_${p.name}">${p.name} <span class="muted">(${p.in})</span></label>
            <input id="rt_${p.name}" name="p_${p.name}" value="${p.default && !p.default.includes('&') ? p.default : ''}"></div>`)}</div>`
        : ''}
      <div class="buttons"><button class="btn">Test</button></div>
    </form>
    ${result
      ? html`<div class="alert ${result.ok ? 'alert-success' : 'alert-error'}" role="status">${result.message}</div>
        ${result.columns?.length
          ? html`<div class="table-wrap"><table class="report"><thead><tr>${result.columns.map((c) => html`<th>${c}</th>`)}</tr></thead>
              <tbody>${(result.rows ?? []).map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? '' : String(v)}</td>`)}</tr>`)}</tbody></table></div>`
          : ''}
        ${result.suggested
          ? html`<form method="post" action="${BASE}/apps/${appId}/rest-sources/${row.id}/columns" class="u-mt1">${csrf(s)}
              <label class="label" for="rt_cols">Suggested columns</label>
              <textarea id="rt_cols" name="columns" class="code" rows="4" spellcheck="false">${result.suggested}</textarea>
              <div class="buttons"><button class="btn">Use these columns</button></div></form>`
          : ''}
        ${result.excerpt ? html`<details class="u-mt1"><summary>Response</summary><pre class="source">${result.excerpt}</pre></details>` : ''}`
      : ''}
  </fieldset>`;
}

// ---------------------------------------------------------------- routes

export async function webSourceRoutes(app: FastifyInstance) {
  app.post(`${BASE}/apps/:id(^\\d+$)/web-credentials/:cid(^\\d+$)/clear`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.query('update meta.web_credential set secret_enc = null where id = $1 and app_id = $2', [req.params.cid, req.params.id]);
    clearTokens(Number(req.params.cid));
    flash(s, r.rowCount ? 'The secret was removed.' : 'Not found.', r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared?c=web_credential-${req.params.cid}`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/rest-sources/:sid(^\\d+$)/test`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const src = await owner.one<RestSource>('select * from meta.rest_source where id = $1 and app_id = $2', [req.params.sid, req.params.id]);
    if (!src) return reply.code(404).send('Not found');
    const result: TestResult = { id: src.id, ok: false, message: '' };
    const started = Date.now();
    try {
      const values: Record<string, string> = {};
      for (const p of src.params) values[p.name] = String(req.body?.[`p_${p.name}`] ?? '');
      const r = buildRequest(src, values);
      const credential = src.credential ? await loadCredential(src.app_id, src.credential) : null;
      const res = await call({ ...r, credential, timeoutMs: src.timeout_s * 1000 });
      const text = res.body.toString('utf8');
      result.excerpt = text.length > 3000 ? `${text.slice(0, 3000)}…` : text;
      if (res.status < 200 || res.status > 299) throw new Error(`The web service answered ${res.status}.`);
      const body = parseJson(res, 'The source');
      const { columns, rows, truncated } = toRows(body, { ...src, max_rows: Math.min(src.max_rows, 1000) });
      const selected = select(body, src.row_selector);
      const items = selected.length === 1 && Array.isArray(selected[0]) ? selected[0] : selected;
      result.ok = true;
      result.message = `${res.status} in ${Date.now() - started} ms: ${rows.length}${truncated ? '+' : ''} row(s)${src.columns.length ? '' : ' (no columns defined: guessed from the first rows)'}.`;
      result.columns = columns.map((c) => c.name);
      result.rows = rows.slice(0, 10).map((row) => columns.map((c) => {
        const v = row[c.name];
        const t = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return t && t.length > 200 ? `${t.slice(0, 200)}…` : t;
      }));
      const guess = guessColumns(items);
      if (guess.length) result.suggested = JSON.stringify(guess, null, 2);
    } catch (e) {
      result.message = (e as Error).message;
    }
    s.state[RESULT] = JSON.stringify(result);
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared?c=rest_source-${src.id}`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/rest-sources/:sid(^\\d+$)/columns`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    try {
      const cols = JSON.parse(req.body?.columns ?? '');
      const problems = sourceProblems({ url: 'https://x', params: [], columns: cols });
      if (problems.length) throw new Error(problems.join(' '));
      const r = await owner.query('update meta.rest_source set columns = $3 where id = $1 and app_id = $2', [req.params.sid, req.params.id, JSON.stringify(cols)]);
      if (!r.rowCount) throw new Error('Not found.');
      flash(s, 'Columns saved.');
    } catch (e) {
      flash(s, e instanceof SyntaxError ? 'The columns are not valid JSON.' : (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/shared?c=rest_source-${req.params.sid}`);
  });
}
