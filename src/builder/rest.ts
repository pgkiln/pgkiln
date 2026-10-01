import { html } from '../html.ts';
import { handlerProblems, type Handler } from '../runtime/rest.ts';
import { publicUrl } from '../sso.ts';

// Shared Components → REST modules: the endpoints, curl examples and the
// OpenAPI description of a module.

export function restExtras(a: { id: number; alias: string }, row: { name: string; enabled: boolean; handlers: Handler[] }) {
  const base = `${publicUrl()}/a/${a.alias}/rest/${row.name}`;
  const handlers = Array.isArray(row.handlers) ? row.handlers : [];
  const problems = handlerProblems(handlers);
  const example = handlers.find((h) => h.method === 'GET') ?? handlers[0];
  return html`<fieldset class="prop-group u-mt125"><legend>Endpoints</legend>
    ${problems.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    ${!row.enabled ? html`<p class="muted">The module is disabled: its endpoints answer 404.</p>` : ''}
    <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Method</th><th>URL</th><th>Type</th><th>Access</th></tr></thead>
      <tbody>${handlers.map((h) => html`<tr><td data-label="Method"><code>${h.method}</code></td><td data-label="URL"><code>${base}/${h.path}</code></td>
        <td data-label="Type">${h.type}</td><td data-label="Access">${h.auth === 'public' ? 'public' : h.roles?.length ? `token, role ${h.roles.join(' or ')}` : 'token'}</td></tr>`)}</tbody></table></div>
    ${example ? html`<p class="muted small">Try it with a token from <a href="/builder/apps/${a.id}/api">REST API</a>:</p>
      <pre class="source">curl ${base}/${example.path.replace(/:([a-z_]+)/gi, '1')} -H "Authorization: Bearer $TOKEN"</pre>` : ''}
    <p class="wrap-anywhere">OpenAPI description: <a href="${base}/openapi.json" target="_blank" rel="noopener"><code>${base}/openapi.json</code></a></p>
  </fieldset>`;
}
