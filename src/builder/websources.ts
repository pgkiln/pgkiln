import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { encryptSecret, secretKeyConfigured } from '../secrets.ts';
import type { Session } from '../session.ts';
import { nextRun, parseCron } from '../automations.ts';
import { icon } from '../icons.ts';
import { runSync, syncLog, syncProblems } from '../restsync.ts';
import { buildRequest, call, clearResponseCache, clearTokens, credentialProblems, guessColumns, loadCredential, parseJson, rowsSql, select, sourceProblems, toRows, withRest, type RestColumn, type RestSource } from '../websources.ts';
import type { ComponentSpec } from './components.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Shared Components → Web credentials and REST data sources: their property
// specs, the secrets' status (never a secret), "Test" for a source (its
// rows, a column suggestion, the start of the response), "Use these
// columns", and a source's synchronisation (Synchronise now, run history).

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
  // secrets are encrypted here and never stored or shown in clear; empty keeps the stored one
  beforeSave: async (values, cid) => {
    for (const k of ['secret', 'password', 'refresh_token']) {
      const secret = values[k] as string | null;
      delete values[k];
      if (secret) values[`${k}_enc`] = encryptSecret(secret);
    }
    if (values.refresh_token_enc) values.token_refreshed_at = null;
    if (cid) clearTokens(Number(cid));
  },
  fields: [
    { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'e.g. WEATHER_API; REST data sources and invoke_api processes use it by this name.' },
    { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
    { name: 'type', label: 'Authentication', kind: 'select', options: ['basic', 'header', 'bearer', 'oauth2', 'aws_sigv4'], group: 'Authentication',
      help: 'basic: HTTP basic (user name + password) · header: an HTTP header with the secret, e.g. an API key · bearer: Authorization: Bearer <secret> · oauth2: OAuth2 (pgkiln gets, caches and renews the token) · aws_sigv4: an S3-compatible object store\'s access key (AWS Signature Version 4), for file items that keep files in object storage.' },
    { name: 'username', label: 'User name / client id / access key id', kind: 'text', group: 'Authentication' },
    { name: 'grant_type', label: 'Grant type (oauth2)', kind: 'select', options: ['client_credentials', 'password', 'refresh_token'], group: 'Authentication',
      help: 'client_credentials: the client id and secret · password: also a user name and password to sign in with · refresh_token: a refresh token you got elsewhere (e.g. once through the service\'s consent page), entered below; pgkiln keeps the newest one.' },
    { name: 'oauth_username', label: 'OAuth2 user name (password)', kind: 'text', group: 'Authentication', help: 'The password flow: the user pgkiln signs in as.' },
    { name: 'header_name', label: 'Header name (header)', kind: 'text', group: 'Authentication', help: 'e.g. X-API-Key' },
    { name: 'token_url', label: 'Token URL (oauth2)', kind: 'text', wide: true, group: 'Authentication', help: 'e.g. https://login.example.com/oauth/token' },
    { name: 'scope', label: 'Scope (oauth2) / region (aws_sigv4)', kind: 'text', group: 'Authentication', help: 'aws_sigv4: the region, e.g. eu-west-1 (MinIO: us-east-1, R2: auto).' },
    { name: 'secret', label: 'Secret', kind: 'secret', wide: true, group: 'Secret',
      help: 'The password, header value, token, client secret or secret access key (oauth2: optional for the password and refresh token grants of a public client). Stored encrypted; it is never shown again or exported. Leave empty to keep the stored secret.' },
    { name: 'password', label: 'OAuth2 password (password)', kind: 'secret', wide: true, group: 'Secret', help: 'The password flow: the password of the OAuth2 user. Write-only, like the secret.' },
    { name: 'refresh_token', label: 'Refresh token (refresh_token)', kind: 'secret', wide: true, group: 'Secret',
      help: 'The refresh token grant: a refresh token to start with. Write-only; replaced by the newer one when the service sends it.' },
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
  defaults: { method: 'GET', cache_seconds: 0, timeout_s: 10, max_rows: 1000, params: [], columns: [], headers: {}, operations: {}, key_columns: [], sync_mode: 'merge', sync_time_zone: 'UTC' },
  validate: (v) => {
    // an empty JSON field arrives as {}
    for (const k of ['params', 'columns']) if (v[k] === '{}') v[k] = '[]';
    if (v.sync_time_zone === null) v.sync_time_zone = 'UTC';
    if (v.sync_mode === null) v.sync_mode = 'merge';
    const problems = [
      ...sourceProblems({ url: v.url, params: json(v.params), columns: json(v.columns), headers: json(v.headers), row_selector: v.row_selector, key_columns: v.key_columns, operations: json(v.operations) }),
      ...syncProblems(v),
    ];
    return problems.length ? problems.join(' ') : null;
  },
  // a changed schedule is computed again by the scheduler's next pass
  beforeSave: async (values, cid) => {
    values.sync_next_at = null;
    if (cid) clearResponseCache(Number(cid));
  },
  fields: [
    { name: 'name', label: 'Name', kind: 'upper', group: 'Identification', help: 'Regions and lists of values use it by this name, e.g. COUNTRIES.' },
    { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
    { name: 'url', label: 'URL', kind: 'text', wide: true, group: 'Request',
      help: 'e.g. https://api.example.com/v1/cities/{city}/weather — {name} is a path parameter. The host must be on the server\'s allow-list (PGKILN_REST_ALLOWED_HOSTS).' },
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
    { name: 'key_columns', label: 'Key columns', kind: 'list', group: 'Write back',
      help: 'Comma separated: the columns that identify a row, e.g. id. Forms, grids and a merge use them.' },
    { name: 'operations', label: 'Operations (JSON)', kind: 'json', wide: true, group: 'Write back',
      help: '{"insert": {"method": "POST"}, "update": {"method": "PUT", "path": "/{id}"}, "delete": {"method": "DELETE", "path": "/{id}"}, "fetch": {"method": "GET", "path": "/{id}"}} · the path follows the URL (without its query); {column} is the row\'s value. "body": a JSON template ({column} as a JSON value), empty: the row as JSON. Forms and interactive grids on this source save through these.' },
    { name: 'sync_table', label: 'Local table', kind: 'text', group: 'Synchronisation',
      help: 'Copy the rows into this table (columns matched by name), e.g. app.country_copy. Written as the application\'s database role.' },
    { name: 'sync_mode', label: 'Mode', kind: 'select', options: ['merge', 'replace', 'append'], group: 'Synchronisation',
      help: 'merge: update and insert by the key columns · replace: delete every row, then insert · append: insert.' },
    { name: 'sync_delete', label: 'Delete rows the service no longer returns (merge)', kind: 'bool', group: 'Synchronisation' },
    { name: 'sync_schedule', label: 'Schedule', kind: 'text', group: 'Synchronisation', help: 'Cron, e.g. @hourly or 0 6 * * 1-5 (minute hour day month weekday).' },
    { name: 'sync_time_zone', label: 'Time zone', kind: 'text', group: 'Synchronisation', help: 'Of the schedule, e.g. Europe/Amsterdam.' },
    { name: 'sync_enabled', label: 'Scheduled', kind: 'bool', group: 'Synchronisation', help: 'Run on the schedule (the automations scheduler).' },
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

/** Whether a credential needs its secret (oauth2 password and refresh token grants may be public clients). */
export const needsSecret = (row: { type: string; grant_type?: string | null }) => row.type !== 'oauth2' || (row.grant_type ?? 'client_credentials') === 'client_credentials';

const CLEARABLE: Record<string, { column: string; label: string }> = {
  secret: { column: 'secret_enc', label: 'the secret' },
  password: { column: 'password_enc', label: 'the password' },
  refresh: { column: 'refresh_token_enc', label: 'the refresh token' },
};

export function credentialExtras(
  appId: number,
  row: { id: number; secret_enc: string | null; type: string; grant_type?: string | null; password_enc?: string | null; refresh_token_enc?: string | null; token_refreshed_at?: Date | null },
  s: Session,
) {
  const clear = (what: string) =>
    html`<form method="post" action="${BASE}/apps/${appId}/web-credentials/${row.id}/clear" class="u-inline">${csrf(s)}<input type="hidden" name="what" value="${what}"><button class="btn" data-confirm="Remove ${CLEARABLE[what].label}?">Remove ${CLEARABLE[what].label}</button></form>`;
  const oauth = row.type === 'oauth2';
  const grant = row.grant_type ?? 'client_credentials';
  return html`<fieldset class="prop-group u-mt125"><legend>Secrets</legend>
    <p>${row.secret_enc
      ? html`<b>A secret is stored</b> (encrypted). It is never shown; type a new one above to replace it.`
      : needsSecret(row) ? html`<b>No secret yet.</b> Requests with this credential fail until one is entered.` : html`No client secret (a public client).`}</p>
    ${oauth && grant === 'password' ? html`<p>${row.password_enc ? html`<b>A password is stored</b> (encrypted).` : html`<b>No password yet.</b> The password flow fails until one is entered.`}</p>` : ''}
    ${oauth
      ? html`<p>${row.refresh_token_enc
          ? html`<b>A refresh token is stored</b> (encrypted)${row.token_refreshed_at ? html`, received ${new Date(row.token_refreshed_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}. pgkiln uses it to renew the access token and keeps the newer one the service sends.`
          : grant === 'refresh_token' ? html`<b>No refresh token yet.</b> Enter one above.` : html`No refresh token yet (kept when the token endpoint sends one).`}</p>`
      : ''}
    ${secretKeyConfigured() ? '' : html`<div class="alert alert-error" role="alert">The server has no <code>PGKILN_SECRET_KEY</code>: secrets can't be saved or used until it is set (at least 32 characters).</div>`}
    <div class="buttons">${row.secret_enc ? clear('secret') : ''}${row.password_enc ? clear('password') : ''}${row.refresh_token_enc ? clear('refresh') : ''}</div>
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

const SYNC_TAG: Record<string, string> = { error: ' tag-error', ok: ' tag-ok' };
const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—');

/** A source's synchronisation: next run, Synchronise now, the last runs. */
async function syncExtras(appId: number, row: RestSource & Record<string, any>, s: Session) {
  if (!row.sync_table) return html`<fieldset class="prop-group u-mt125"><legend>Synchronisation</legend>
    <p class="muted">Set a local table above to copy this source's rows into a table (on demand, from SQL or on a schedule).</p></fieldset>`;
  let next = 'not scheduled';
  if (row.sync_enabled && row.sync_schedule)
    try {
      next = when(nextRun(parseCron(row.sync_schedule), row.sync_time_zone ?? 'UTC', new Date()));
    } catch (e) {
      next = `never: ${(e as Error).message}`;
    }
  const scheduler = process.env.AUTOMATIONS === 'off' ? html` <b>(the scheduler is off on this server: AUTOMATIONS=off)</b>` : '';
  const log = await syncLog(row.id);
  return html`<fieldset class="prop-group u-mt125"><legend>Synchronisation</legend>
    <p>Into <code>${row.sync_table}</code> (${row.sync_mode}${row.sync_mode === 'merge' && row.sync_delete ? ', deleting missing rows' : ''}). Next run: <b>${next}</b>${scheduler}</p>
    <p class="muted">From application code: <code>select meta.request_rest_sync('${row.name}')</code> queues a run for the server's next scheduler pass.</p>
    <form method="post" action="${BASE}/apps/${appId}/rest-sources/${row.id}/sync">${csrf(s)}<button class="btn">${icon('play')} Synchronise now</button></form>
    ${log.length
      ? html`<div class="table-wrap u-mt075"><table class="report report-reflow"><thead><tr><th>Requested</th><th>Took</th><th>By</th><th>Status</th><th class="num">Rows</th><th class="num">Inserted</th><th class="num">Updated</th><th class="num">Deleted</th><th>Message</th></tr></thead><tbody>
          ${log.map((l) => html`<tr>
            <td data-label="Requested">${when(l.requested_at)}</td>
            <td data-label="Took">${l.finished_at && l.started_at ? `${((new Date(l.finished_at).getTime() - new Date(l.started_at).getTime()) / 1000).toFixed(1)} s` : '…'}</td>
            <td data-label="By">${l.trigger}${l.requested_by ? html` <span class="muted">(${l.requested_by})</span>` : ''}</td>
            <td data-label="Status"><span class="tag${SYNC_TAG[l.status] ?? ''}">${l.status}</span></td>
            <td class="num" data-label="Rows">${l.rows_fetched ?? ''}</td>
            <td class="num" data-label="Inserted">${l.inserted ?? ''}</td>
            <td class="num" data-label="Updated">${l.updated ?? ''}</td>
            <td class="num" data-label="Deleted">${l.deleted ?? ''}</td>
            <td data-label="Message">${l.message ?? ''}</td></tr>`)}
        </tbody></table></div>`
      : html`<p class="muted">No runs yet.</p>`}
  </fieldset>`;
}

export async function restSourceExtras(appId: number, row: RestSource, s: Session) {
  return html`${testExtras(appId, row, s)}${await syncExtras(appId, row, s)}`;
}

function testExtras(appId: number, row: RestSource, s: Session) {
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
    const what = CLEARABLE[String(req.body?.what ?? 'secret')] ?? CLEARABLE.secret;
    // the column comes from the fixed list above, never from the request
    const r = await owner.query(`update meta.web_credential set ${what.column} = null${what.column === 'refresh_token_enc' ? ', token_refreshed_at = null' : ''} where id = $1 and app_id = $2`, [req.params.cid, req.params.id]);
    clearTokens(Number(req.params.cid));
    flash(s, r.rowCount ? `${what.label[0].toUpperCase()}${what.label.slice(1)} was removed.` : 'Not found.', r.rowCount ? 'ok' : 'error');
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

  app.post(`${BASE}/apps/:id(^\\d+$)/rest-sources/:sid(^\\d+$)/sync`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const src = await owner.one<{ id: number }>('select id from meta.rest_source where id = $1 and app_id = $2', [req.params.sid, req.params.id]);
    if (!src) return reply.code(404).send('Not found');
    const r = await runSync(src.id, 'manual', { by: s.username ?? undefined });
    if (r.status === 'ok')
      flash(s, `Synchronised ${r.rows} row(s): ${r.inserted} inserted, ${r.updated} updated, ${r.deleted} deleted.${r.message ? ` ${r.message}` : ''}`);
    else flash(s, r.message ?? 'The synchronisation failed.', 'error');
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
