import { html } from '../html.ts';
import { handlerProblems, type Handler } from '../runtime/rest.ts';
import { publicUrl } from '../sso.ts';
import { scopedTx as tx } from './i18n.ts';

// Shared Components → REST modules: the endpoints, curl examples and the
// OpenAPI description of a module.

export function restExtras(a: { id: number; alias: string }, row: { name: string; enabled: boolean; handlers: Handler[] }) {
  const base = `${publicUrl()}/a/${a.alias}/rest/${row.name}`;
  const handlers = Array.isArray(row.handlers) ? row.handlers : [];
  const problems = handlerProblems(handlers);
  const example = handlers.find((h) => h.method === 'GET') ?? handlers[0];
  return html`<fieldset class="prop-group u-mt125"><legend>${tx('rst.endpoints')}</legend>
    ${problems.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    ${!row.enabled ? html`<p class="muted">${tx('rst.disabled')}</p>` : ''}
    <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rst.method')}</th><th>${tx('rst.url')}</th><th>${tx('rst.type')}</th><th>${tx('rst.access')}</th></tr></thead>
      <tbody>${handlers.map((h) => html`<tr><td data-label="${tx('rst.method')}"><code>${h.method}</code></td><td data-label="${tx('rst.url')}"><code>${base}/${h.path}</code></td>
        <td data-label="${tx('rst.type')}">${h.type}</td><td data-label="${tx('rst.access')}">${h.auth === 'public' ? 'public' : h.roles?.length ? `token, role ${h.roles.join(' or ')}` : 'token'}</td></tr>`)}</tbody></table></div>
    ${example ? html`<p class="muted small">${tx.rich('rst.try_it', { link: html`<a href="/builder/apps/${a.id}/api">${tx('rst.rest_api')}</a>` })}</p>
      <pre class="source">curl ${base}/${example.path.replace(/:([a-z_]+)/gi, '1')} -H "Authorization: Bearer $TOKEN"</pre>` : ''}
    <p class="muted small">${tx.rich('rst.edit_in', { link: html`<a href="/builder/sql/rest/modules">${tx('rst.modules_path')}</a>` })}</p>
    <p class="wrap-anywhere">${tx('rst.openapi')} <a href="${base}/openapi.json" target="_blank" rel="noopener"><code>${base}/openapi.json</code></a></p>
  </fieldset>`;
}
