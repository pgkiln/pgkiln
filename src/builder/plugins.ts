import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { readMultipart } from '../runtime/files.ts';
import { parsePluginDocument, pluginFileDocument, type Plugin } from '../runtime/plugins.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { clearCompletions } from './code-editor.ts';
import { appOr404 } from './forms.ts';
import { resultsHtml, runScripts, type RunResult } from './supporting.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Body, type Req } from './ui.ts';
import { scopedTx as tx, type BuilderKey } from './i18n.ts';

// Shared Components → Plug-ins (migration 069; APEX: plug-ins): import a
// plug-in file (format pgkiln-plugin/2), look at what it brings, run its
// install SQL (only on request, as the application's role, like supporting
// objects), download it again and remove it. src/runtime/plugins.ts renders
// and runs plug-ins; their files are static application files and a region
// plug-in's template is a template component, so both can be read and
// changed in their own pages.

const MAX_FILE_MB = 10;

const TYPE_KEY: Record<string, BuilderKey> = { region: 'plg.type.region', item: 'plg.type.item', dynamic_action: 'plg.type.dynamic_action', process: 'plg.type.process' };
const HEADING_KEY: Record<string, BuilderKey> = { region: 'plg.heading.region', item: 'plg.heading.item', dynamic_action: 'plg.heading.dynamic_action', process: 'plg.heading.process' };
const USE_KEY = { region: 'plg.use.region', item: 'plg.use.item', process: 'plg.use.process', dynamic_action: 'plg.use.dynamic_action' } as const satisfies Record<string, BuilderKey>;
/** How to use a plug-in of a type in a component: a sentence with `code`. */
const HOW_KEY: Record<string, BuilderKey> = { region: 'plg.how.region', item: 'plg.how.item', dynamic_action: 'plg.how.dynamic_action', process: 'plg.how.process' };

/** Where an application uses each plug-in: "page 3: region Ratings", … */
async function usages(appId: number) {
  const rows = (await owner.query<{ plugin: string; kind: 'region' | 'item' | 'process' | 'dynamic_action'; page_no: number; name: string }>(
    `select r.config->>'plugin' as plugin, 'region' as kind, p.page_no, coalesce(r.title, r.id::text) as name,
            'page ' || p.page_no || ': region ' || coalesce(r.title, r.id::text) as sort
       from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.type = 'plugin'
     union all
     select i.config->>'plugin', 'item', p.page_no, i.name, 'page ' || p.page_no || ': item ' || i.name
       from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1 and i.type = 'plugin'
     union all
     select x.config->>'plugin', 'process', p.page_no, x.name, 'page ' || p.page_no || ': process ' || x.name
       from meta.process x join meta.page p on p.id = x.page_id where p.app_id = $1 and x.type = 'plugin'
     union all
     select trim(d.code), 'dynamic_action', p.page_no, d.name, 'page ' || p.page_no || ': dynamic action ' || d.name
       from meta.dynamic_action d join meta.page p on p.id = d.page_id where p.app_id = $1 and d.action = 'plugin'
     order by 5`, [appId])).rows;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.plugin, [...(out.get(r.plugin) ?? []), tx(USE_KEY[r.kind], { page: r.page_no, name: r.name })]);
  return out;
}

async function page(s: Session, a: any, selected: string | undefined, result?: { name: string; run: RunResult }) {
  const list = (await owner.query<Plugin>('select * from meta.plugin where app_id = $1 order by name', [a.id])).rows;
  const used = await usages(a.id);
  const base = `${BASE}/apps/${a.id}/plugins`;
  const p = list.find((x) => x.name === selected);
  const tc = p?.template_component
    ? await owner.one<{ id: number }>('select id from meta.template_component where app_id = $1 and static_id = $2', [a.id, p.template_component])
    : null;
  const missingFiles = p
    ? (await owner.query<{ n: string }>('select n from unnest($2::text[]) n where not exists (select 1 from meta.static_file f where f.app_id = $1 and f.name = n)', [a.id, p.files])).rows.map((r) => r.n)
    : [];

  const detail = p
    ? region(tx(HEADING_KEY[p.type], { label: p.label }), html`
        <dl class="props">
          <dt>${tx('plg.name')}</dt><dd><code>${p.name}</code>${p.version ? html` · ${tx('plg.version_n', { version: p.version })}` : ''}</dd>
          ${p.help ? html`<dt>${tx('plg.help')}</dt><dd>${p.help}</dd>` : ''}
          <dt>${tx('plg.used_by')}</dt><dd>${(used.get(p.name) ?? []).join('; ') || html`<span class="muted">${tx('plg.nothing_yet')}</span>`}</dd>
          <dt>${tx('plg.files')}</dt><dd>${p.files.length ? p.files.map((f, i) => html`${i ? ', ' : ''}<a href="${BASE}/apps/${a.id}/static-files?edit=${encodeURIComponent(f)}">${f}</a>${missingFiles.includes(f) ? html` <span class="badge badge-warning">${tx('plg.missing')}</span>` : ''}`) : html`<span class="muted">${tx('plg.none')}</span>`}</dd>
          ${p.template_component ? html`<dt>${tx('plg.template')}</dt><dd>${tc ? html`<a href="${BASE}/apps/${a.id}/shared?c=template_component-${tc.id}">${p.template_component}</a>` : html`${p.template_component} <span class="badge badge-warning">${tx('plg.missing')}</span>`}</dd>` : ''}
          ${p.sql_function ? html`<dt>${tx('plg.function')}</dt><dd><code>${p.sql_function}(attributes jsonb) returns text</code></dd>` : ''}
        </dl>
        ${p.attributes.length
          ? html`<div class="table-wrap"><table class="report"><caption>${tx('plg.attributes')}</caption><thead><tr><th scope="col">${tx('plg.name')}</th><th scope="col">${tx('plg.label')}</th><th scope="col">${tx('plg.type')}</th><th scope="col">${tx('plg.default')}</th></tr></thead>
              <tbody>${p.attributes.map((x) => html`<tr><td><code>${x.name}</code></td><td>${x.label ?? ''}</td><td>${x.type ?? 'text'}${x.options ? `: ${x.options.join(', ')}` : ''}</td><td>${x.default ?? ''}</td></tr>`)}</tbody></table></div>`
          : ''}
        <p class="muted">${tx.code(HOW_KEY[p.type], { name: p.name })}</p>
        ${p.install_sql
          ? html`<h3>${tx('plg.install_sql')}</h3><p class="muted">${tx.rich('plg.install_help', { role: html`<code>${a.db_role ?? tx('plg.role_none')}</code>` })}</p>
              <pre class="source">${p.install_sql}</pre>
              <form method="post" action="${base}/install" class="u-mt1">${csrf(s)}<input type="hidden" name="name" value="${p.name}">
                <button class="btn" data-confirm="${a.db_role ? tx('plg.confirm_install', { label: p.label, role: a.db_role }) : tx('plg.confirm_install_runtime', { label: p.label })}">${icon('play')} ${tx('plg.run_install')}</button></form>`
          : ''}
        <div class="buttons u-mt1">
          <a class="btn" href="${base}/download?name=${encodeURIComponent(p.name)}">${icon('download')} ${tx('plg.download')}</a>
          <form method="post" action="${base}/delete" class="inline">${csrf(s)}<input type="hidden" name="name" value="${p.name}">
            <button class="btn btn-danger" data-confirm="${tx('plg.confirm_remove', { label: p.label })}">${icon('trash')} ${tx('plg.remove')}</button></form>
        </div>`)
    : '';

  return html`${appHeader(a, 'shared', s)}
    ${result ? region(tx('plg.result', { name: result.name }), resultsHtml('install', result.run)) : ''}
    ${detail}
    ${region(tx('plg.title'), html`<p class="muted u-mt0">${tx.rich('plg.intro', { files: html`<a href="${BASE}/apps/${a.id}/static-files">${tx('plg.static_files')}</a>`, register: html`<code>pgkiln.plugins.register</code>` })}
        ${tx('plg.intro_trust')}</p>
      ${list.length
        ? html`<div class="table-wrap"><table class="report"><caption class="sr-only">${tx('plg.title')}</caption>
            <thead><tr><th scope="col">${tx('plg.plugin')}</th><th scope="col">${tx('plg.type')}</th><th scope="col">${tx('plg.version')}</th><th scope="col">${tx('plg.used_by')}</th></tr></thead>
            <tbody>${list.map((x) => html`<tr><td><a href="${base}?p=${x.name}"${x.name === selected ? raw(' aria-current="page"') : ''}>${x.label}</a> <code class="muted">${x.name}</code></td>
              <td>${tx(TYPE_KEY[x.type])}</td><td>${x.version ?? ''}</td><td>${(used.get(x.name) ?? []).length || ''}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">${tx('plg.no_plugins')}</p>`}`)}
    ${region(tx('plg.import_title'), html`<form method="post" action="${base}/import" enctype="multipart/form-data">${csrf(s)}
        <div class="field"><label class="label" for="f_plugin_file">${tx.code('plg.file_label')}</label>
          <input type="file" id="f_plugin_file" name="file" accept=".json,application/json"></div>
        <div class="field" data-wide><label class="label" for="f_plugin_json">${tx('plg.or_paste')}</label>
          <textarea id="f_plugin_json" name="plugin" class="code" rows="6" spellcheck="false" placeholder='{"format": "pgkiln-plugin/2", "type": "region", "name": …}'></textarea></div>
        <div class="field"><label class="check"><input type="checkbox" name="replace" value="true"> ${tx('plg.replace')}</label></div>
        <div class="buttons"><button class="btn btn-hot">${icon('upload')} ${tx('plg.import')}</button></div>
        <small class="help">${tx.code('plg.import_help')}</small>
      </form>`)}`;
}

/** Check a plug-in file (the template against the allow-list too) and install it (meta.import_plugin). */
export async function installPlugin(appId: number, doc: unknown, replace: boolean) {
  const parsed = parsePluginDocument(doc);
  if (typeof parsed === 'string') throw new Error(parsed);
  const { plugin: p, files, component } = parsed;
  const clean = {
    format: 'pgkiln-plugin/2', type: p.type, name: p.name, label: p.label, version: p.version, help: p.help, attributes: p.attributes,
    files, template_component: component, sql_function: p.sql_function, install_sql: p.install_sql,
  };
  await owner.query('select meta.import_plugin($1, $2::jsonb, $3)', [appId, JSON.stringify(clean), replace]);
  return p;
}

/** A plug-in of an application as a plug-in file. */
export async function exportPlugin(appId: number, name: string) {
  const p = await owner.one<Plugin>('select * from meta.plugin where app_id = $1 and name = $2', [appId, name]);
  if (!p) return null;
  const files = (await owner.query<{ name: string; content: Buffer }>('select name, content from meta.static_file where app_id = $1 and name = any ($2) order by array_position($2, name)', [appId, p.files])).rows;
  const component = p.template_component
    ? await owner.one('select static_id, name, description, template, wrapper, css_classes, attributes from meta.template_component where app_id = $1 and static_id = $2', [appId, p.template_component])
    : null;
  return pluginFileDocument(p, files, component ?? null);
}

export async function pluginRoutes(app: FastifyInstance) {
  const crumbs = (a: any) => [[tx('rail.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('app.tab.shared'), `${BASE}/apps/${a.id}/shared`], [tx('plg.title')]] as [string, string?][];
  const find = async (id: string) => (/^\d+$/.test(id) ? appOr404(id) : undefined);

  app.get(`${BASE}/apps/:id/plugins`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    return send(reply, s, shell(s, tx('plg.title'), crumbs(a), await page(s, a, req.query?.p)));
  });

  app.post(`${BASE}/apps/:id/plugins/import`, async (req: Req, reply) => {
    let text = '';
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, MAX_FILE_MB);
      req.body = parsed.body as Body;
      const f = parsed.files.get('file');
      if (f && !f.truncated) text = f.data.toString('utf8');
    }
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const base = `${BASE}/apps/${a.id}/plugins`;
    text = text.trim() || String(req.body?.plugin ?? '').trim();
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      flash(s, text ? tx('plg.not_json') : tx('plg.choose_file'), 'error');
      return back(reply, s, base);
    }
    try {
      const p = await installPlugin(a.id, doc, req.body?.replace === 'true');
      await logActivity({ appId: a.id, username: s.username, event: 'plugin', ip: clientIp(req), detail: `builder: imported plug-in ${p.name}` });
      flash(s, tx(p.install_sql ? 'plg.imported_install' : 'plg.imported', { label: p.label }));
      return back(reply, s, `${base}?p=${p.name}`);
    } catch (e) {
      flash(s, tx('plg.import_failed', { message: (e as Error).message }), 'error');
      return back(reply, s, base);
    }
  });

  app.get(`${BASE}/apps/:id/plugins/download`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    const doc = a ? await exportPlugin(a.id, String(req.query?.name ?? '')) : null;
    if (!doc) return reply.code(404).send('Not found');
    return reply
      .type('application/json')
      .header('content-disposition', `attachment; filename="${doc.name}.plugin.json"`)
      .send(JSON.stringify(doc, null, 2) + '\n');
  });

  app.post(`${BASE}/apps/:id/plugins/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const r = await owner.query('delete from meta.plugin where app_id = $1 and name = $2', [a.id, String(req.body?.name ?? '')]);
    flash(s, r.rowCount ? tx('plg.removed') : tx('plg.no_such'), r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${a.id}/plugins`);
  });

  app.post(`${BASE}/apps/:id/plugins/install`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const p = await owner.one<Plugin>('select * from meta.plugin where app_id = $1 and name = $2', [a.id, String(req.body?.name ?? '')]);
    if (!p?.install_sql) return reply.code(404).send('Not found');
    const run = await runScripts(a, [{ name: p.name, script: p.install_sql }], s.username!);
    clearCompletions();
    await logActivity({ appId: a.id, username: s.username, event: 'plugin', ip: clientIp(req), detail: `builder: install SQL of ${p.name} ${run.ok ? 'ran' : 'failed'} (${run.results.length} statement(s))` });
    return send(reply, s, shell(s, tx('plg.title'), crumbs(a), await page(s, a, p.name, { name: p.label, run })));
  });
}
