import type { FastifyInstance } from 'fastify';
import { splitStatements } from '../binds.ts';
import { appTx, owner, type Client } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { clearCompletions } from './code-editor.ts';
import { appHeader, BASE, csrf, developer, region, send, shell, type Req } from './ui.ts';
import { appOr404 } from './forms.ts';

// Supporting objects (APEX: Supporting Objects): install, upgrade and
// deinstall scripts stored with the application (meta.supporting_script,
// edited under Shared Components) and included in its export. They never
// run on their own, also not on import: a developer opens this page, reads
// them and chooses to run the scripts of one kind. They run as the
// application's database role (so they can only do what the app's role may),
// statement by statement in one transaction: the first error undoes the run.
// The results of each statement are shown.

export const SCRIPT_KINDS = ['install', 'upgrade', 'deinstall'] as const;
type Kind = (typeof SCRIPT_KINDS)[number];

/** How long one run may take (per statement). */
const RUN_TIMEOUT = '600s';
/** Rows shown per statement. */
const SHOW_ROWS = 20;

interface StatementResult {
  script: string;
  sql: string;
  ok: boolean;
  message: string;
  fields?: string[];
  rows?: unknown[][];
}

export interface RunResult {
  ok: boolean;
  results: StatementResult[];
}

/** Run the scripts of one kind as the application's role, in one transaction. */
export async function runSupportingScripts(app: { id: number; alias: string; db_role: string | null }, kind: Kind, developerName: string): Promise<RunResult> {
  const scripts = (await owner.query<{ name: string; script: string }>('select name, script from meta.supporting_script where app_id = $1 and kind = $2 order by seq, name', [app.id, kind])).rows;
  const results: StatementResult[] = [];
  class Failed extends Error {}
  try {
    await appTx({ appId: app.id, alias: app.alias, dbRole: app.db_role, appUser: developerName, sessionId: '' }, async (c: Client) => {
      await c.query(`select set_config('statement_timeout', $1, true)`, [RUN_TIMEOUT]);
      for (const s of scripts)
        for (const sql of splitStatements(s.script).map((x) => x.trim()).filter((x) => x && !/^(--[^\n]*\n?\s*)+$/.test(x))) {
          try {
            const res = await c.query({ text: sql, rowMode: 'array' });
            results.push({
              script: s.name, sql, ok: true,
              message: `${res.command ?? 'Statement'}${res.rowCount !== null && res.rowCount !== undefined ? `, ${res.rowCount} row(s)` : ''}`,
              ...(res.fields?.length ? { fields: res.fields.map((f) => f.name), rows: (res.rows as unknown[][]).slice(0, SHOW_ROWS) } : {}),
            });
          } catch (e) {
            results.push({ script: s.name, sql, ok: false, message: (e as Error).message });
            throw new Failed();
          }
        }
    });
  } catch (e) {
    if (!(e instanceof Failed)) results.push({ script: '', sql: '', ok: false, message: (e as Error).message });
    return { ok: false, results };
  }
  return { ok: true, results };
}

const cell = (v: unknown) => (v === null ? html`<span class="null">null</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v));

function resultsHtml(kind: Kind, r: RunResult): Raw {
  return html`<div class="alert ${r.ok ? 'alert-success' : 'alert-error'}" role="status">${r.ok
      ? `The ${kind} scripts ran: ${r.results.length} statement(s), committed.`
      : `The ${kind} scripts failed: everything they did was undone (rolled back).`}</div>
    <ol class="support-results">${r.results.map((x) => html`<li class="${x.ok ? 'ok' : 'failed'}">
      <div><b>${x.script}</b> <span class="${x.ok ? 'muted' : null}">${x.ok ? x.message : html`Error: ${x.message}`}</span></div>
      ${x.sql ? html`<pre class="source">${x.sql.length > 2000 ? `${x.sql.slice(0, 2000)}…` : x.sql}</pre>` : ''}
      ${x.fields ? html`<div class="table-wrap"><table class="report"><thead><tr>${x.fields.map((f) => html`<th>${f}</th>`)}</tr></thead>
        <tbody>${(x.rows ?? []).map((row) => html`<tr>${row.map((v) => html`<td>${cell(v)}</td>`)}</tr>`)}</tbody></table></div>` : ''}
    </li>`)}</ol>`;
}

async function page(req: Req, appId: string, result?: { kind: Kind; run: RunResult }) {
  const a = await appOr404(appId);
  if (!a) return null;
  const scripts = (await owner.query('select id, name, kind, seq, script from meta.supporting_script where app_id = $1 order by kind, seq, name', [a.id])).rows;
  const imported = req.query?.imported === '1';
  const byKind = (k: Kind) => scripts.filter((x) => x.kind === k);
  return { a, body: (s: Session) => html`${appHeader(a, 'shared')}
    ${imported && scripts.length ? html`<div class="alert alert-warning" role="status">${icon('alert')} This application came with supporting objects. They were <b>not</b> run: read them below and run them only if you trust them.</div>` : ''}
    ${result ? region(`Result: ${result.kind} scripts`, resultsHtml(result.kind, result.run)) : ''}
    ${region('Supporting objects', html`<p class="muted u-mt0">Scripts that install, upgrade or remove what the application needs in the database. They travel with the export and run only from here, when you choose to:
        as the application's database role <code>${a.db_role ?? '(none: the runtime connection)'}</code>, statement by statement in one transaction (an error undoes the whole run).
        <a href="${BASE}/apps/${a.id}/shared?new=supporting_script">Add a script</a> under Shared Components.</p>
      ${SCRIPT_KINDS.map((k) => html`<h3>${k[0].toUpperCase() + k.slice(1)} scripts (${byKind(k).length})</h3>
        ${byKind(k).length
          ? html`${byKind(k).map((x) => html`<details class="support-script"><summary><b>${x.seq}. ${x.name}</b> <a href="${BASE}/apps/${a.id}/shared?c=supporting_script-${x.id}">Edit</a></summary><pre class="source">${x.script}</pre></details>`)}
              <form method="post" action="${BASE}/apps/${a.id}/supporting-objects/run" class="u-mt1">${csrf(s)}<input type="hidden" name="kind" value="${k}">
                <button class="btn${k === 'deinstall' ? ' btn-danger' : ''}" data-confirm="Run the ${k} scripts of ${a.name} as ${a.db_role ?? 'the runtime connection'}?">${icon('play')} Run the ${k} scripts</button></form>`
          : html`<p class="muted">None.</p>`}`)}`)}` };
}

export async function supportingRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/supporting-objects`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await page(req, req.params.id);
    if (!p) return reply.code(404).send('Not found');
    return send(reply, s, shell(s, 'Supporting objects', [['App Builder', BASE], [p.a.name, `${BASE}/apps/${p.a.id}`], ['Supporting objects']], p.body(s)));
  });

  app.post(`${BASE}/apps/:id/supporting-objects/run`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const kind = req.body?.kind as Kind;
    if (!(SCRIPT_KINDS as readonly string[]).includes(kind)) return reply.code(400).send('Unknown kind of script');
    const run = await runSupportingScripts(a, kind, s.username!);
    clearCompletions(); // the scripts may have changed tables or grants
    await logActivity({ appId: a.id, username: s.username, event: 'supporting_objects', ip: clientIp(req), detail: `builder: ${kind} ${run.ok ? 'ran' : 'failed'} (${run.results.length} statement(s))` });
    const p = (await page(req, req.params.id, { kind, run }))!;
    return send(reply, s, shell(s, 'Supporting objects', [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Supporting objects']], p.body(s)));
  });
}
