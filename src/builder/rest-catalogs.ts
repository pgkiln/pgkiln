import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import {
  catalogDocument, catalogProblems, insertCatalog, loadCatalog, readCatalogText, replaceCatalog, serviceProblems, serviceUrl, snake,
  sourceFromService, trimBase, wholeCatalogProblems, type Catalog, type CatalogService,
} from '../restcatalog.ts';
import { readMultipart } from '../runtime/files.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { webRequest } from '../webclient.ts';
import { sourceProblems } from '../websources.ts';
import { back, BASE, csrf, developer, flash, input, region, send, shell, type Body, type Req } from './ui.ts';
import { currentWorkspace } from './workspaces.ts';
import { scopeForWorkspace } from '../network-acl.ts';
import { scopedTx as tx } from './i18n.ts';

// Workspace utilities → REST Source Catalogs (migration 095; APEX: Workspace
// Utilities → REST Source Catalogs): the current workspace's catalogs, a
// catalog's services, creating one by hand or from an OpenAPI document (a
// file, pasted, or read from a URL on the server's allow-list) or a catalog
// file, and downloading one. Developers of the workspace manage them; an
// application's Shared Components → REST data sources → New makes a data
// source from a service (catalogPicker, below).

const NOTES = '__CATALOG_NOTES';
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const root = `${BASE}/rest-catalogs`;
const crumbs = (extra: [string, string?][] = []): [string, string?][] => [[tx('rcat.app_builder'), BASE], [tx('rcat.workspace_utilities'), `${BASE}/utilities`], ['REST Source Catalogs', root], ...extra];
const when = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const pretty = (v: unknown) => JSON.stringify(v ?? null, null, 2);

/** A catalog of the current workspace, or null (404). */
async function catalogOf(s: Session, id: string) {
  const c = await loadCatalog(id);
  return c && c.workspace_id === currentWorkspace(s) ? c : null;
}

function notesHtml(s: Session): Raw | '' {
  const v = s.state[NOTES];
  if (!v) return '';
  delete s.state[NOTES];
  const notes = JSON.parse(v) as string[];
  return notes.length
    ? html`<div class="alert alert-info" role="status"><b>${tx('rcat.what_the_document_had_that')}</b><ul>${notes.map((n) => html`<li>${n}</li>`)}</ul></div>`
    : '';
}

/** The import form: a file, pasted text or a URL; base URL and name optional. */
function importForm(s: Session, action: string, replacing: boolean): Raw {
  return html`<form method="post" action="${action}" enctype="multipart/form-data">${csrf(s)}
    <p class="muted u-mt0">${tx.rich('rcat.doc_intro', { openapi: html`<b>${tx('rcat.openapi_3')}</b>`, swagger: html`<b>${tx('rcat.swagger_2_0')}</b>`, file: html`<code>openapi.json</code>` })}${replacing ? ` ${tx('rcat.doc_replacing')}` : ''}</p>
    <div class="form-grid">
      <div class="field"><label class="label" for="f_file">${tx('rcat.file')}</label><input id="f_file" type="file" name="file" accept=".json,application/json"></div>
      ${input('url', tx('rcat.or_read_it_from_a'), '', { placeholder: tx('rcat.https_api_example_com_openapi'), help: tx('rcat.the_server_reads_it_the') })}
      <div class="field" data-wide><label class="label" for="f_text">${tx('rcat.or_paste_it')}</label><textarea id="f_text" name="text" class="code" rows="4" spellcheck="false"></textarea></div>
      ${input('base_url', tx('rcat.base_url'), '', { placeholder: tx('rcat.from_the_document'), help: tx('rcat.instead_of_the_document_s') })}
      ${replacing ? '' : input('name', tx('rcat.name'), '', { placeholder: tx('rcat.the_document_s_title') })}
    </div>
    <div class="buttons"><button class="btn btn-hot">${icon('upload')} ${replacing ? tx('rcat.replace_the_services') : tx('rcat.import')}</button></div></form>`;
}

/** The text of an uploaded, pasted or fetched document (and where it came from). */
async function documentText(req: Req): Promise<{ text: string; from?: string; url?: string }> {
  let text = '';
  if (req.isMultipart()) {
    const parsed = await readMultipart(req, MAX_DOC_BYTES / 1024 / 1024);
    req.body = parsed.body as Body;
    const f = parsed.files.get('file');
    if (f?.truncated) throw new Error(tx('rcat.the_file_is_larger_than'));
    if (f) text = f.data.toString('utf8');
  }
  if (!text.trim()) text = String(req.body?.text ?? '');
  if (text.trim()) return { text };
  const url = String(req.body?.url ?? '').trim();
  if (!url) throw new Error(tx('rcat.choose_a_file_paste_a'));
  if (!/^https?:\/\//i.test(url)) throw new Error(tx('rcat.the_url_starts_with_http'));
  return { text: '', url };
}

/**
 * The document itself: the uploaded or pasted text, or (sprint 118) the URL read now, after the developer
 * was checked, within the installation's allow-list and the current workspace's network access list.
 */
async function documentOf(doc: { text: string; from?: string; url?: string }, s: Session): Promise<{ text: string; from?: string }> {
  if (!doc.url) return doc;
  const r = await webRequest(doc.url, {
    headers: { accept: 'application/json' }, timeoutMs: 15_000, maxBytes: MAX_DOC_BYTES,
    scope: await scopeForWorkspace(currentWorkspace(s), 'REST source catalog (read from a URL)'),
  });
  if (r.status !== 200) throw new Error(tx('rcat.url_answered', { status: r.status }));
  return { text: r.body.toString('utf8'), from: r.url };
}

/** A service's fields from a form (JSON fields parsed; problems thrown). */
function serviceFromBody(b: Body): CatalogService {
  const json = (k: string, empty: unknown) => {
    const v = String(b[k] ?? '').trim();
    if (!v) return empty;
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`${k.replace('_', ' ')}: not valid JSON.`);
    }
  };
  const text = (k: string) => String(b[k] ?? '').trim() || null;
  return {
    name: String(b.name ?? '').trim().toUpperCase(),
    description: text('description'),
    path: String(b.path ?? '').trim(),
    method: String(b.method ?? 'GET').toUpperCase(),
    params: json('params', []) as CatalogService['params'],
    headers: json('headers', {}) as CatalogService['headers'],
    body: text('body'),
    row_selector: text('row_selector'),
    columns: json('columns', []) as CatalogService['columns'],
    key_columns: String(b.key_columns ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    operations: json('operations', {}) as CatalogService['operations'],
  };
}

function serviceForm(s: Session, action: string, v: Partial<CatalogService>, label: string): Raw {
  const area = (name: string, title: string, value: string, help: string, rows = 4) =>
    html`<div class="field" data-wide><label class="label" for="f_${name}">${title}</label><textarea id="f_${name}" name="${name}" class="code" rows="${rows}" spellcheck="false">${value}</textarea><small class="help">${help}</small></div>`;
  return html`<form method="post" action="${action}">${csrf(s)}
    <div class="form-grid">
      ${input('name', tx('rcat.name'), v.name ?? '', { required: true, placeholder: 'GET_PETS', help: tx('rcat.the_data_source_s_name') })}
      <div class="field"><label class="label" for="f_method">${tx('rcat.method')}</label><select id="f_method" name="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => html`<option${(v.method ?? 'GET') === m ? raw(' selected') : ''}>${m}</option>`)}</select></div>
      ${input('path', tx('rcat.path'), v.path ?? '', { required: true, placeholder: tx('rcat.pets_pet_id'), help: tx('rcat.after_the_catalog_s_base') })}
      ${input('row_selector', tx('rcat.row_selector'), v.row_selector ?? '', { placeholder: 'items', help: tx('rcat.where_the_rows_are_in') })}
      <div class="field" data-wide><label class="label" for="f_description">${tx('rcat.description')}</label><input id="f_description" name="description" value="${v.description ?? ''}"></div>
      ${area('params', tx('rcat.parameters_json'), pretty(v.params ?? []), '[{"name": "page_size", "in": "query", "key": "pageSize", "default": "20"}] · in: path, query, header, body; "key": the service\'s name for it when it isn\'t lower case with _.')}
      ${area('columns', tx('rcat.columns_json'), pretty(v.columns ?? []), '[{"name": "id", "path": "id", "type": "integer"}] · types: text, number, integer, boolean, date, timestamp, json.', 6)}
      ${area('headers', tx('rcat.headers_json'), pretty(v.headers ?? {}), tx('rcat.headers_help'), 2)}
      ${area('body', tx('rcat.body_template'), v.body ?? '', '{"query": {q}} — empty: the body parameters as a JSON object.', 2)}
      ${input('key_columns', tx('rcat.key_columns'), (v.key_columns ?? []).join(', '), { placeholder: 'id' })}
      ${area('operations', tx('rcat.operations_json'), pretty(v.operations ?? {}), '{"update": {"method": "PUT", "path": "/{id}"}, "delete": {"method": "DELETE", "path": "/{id}"}} · write-back for forms and grids.', 3)}
    </div>
    <div class="buttons"><button class="btn btn-hot">${icon('save')} ${label}</button></div></form>`;
}

export async function restCatalogRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- the list
  app.get(root, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const rows = (await owner.query(
      `select c.id, c.name, c.description, c.base_url, c.server, c.source, c.api_version, c.updated_at,
              (select count(*)::int from meta.rest_catalog_service x where x.catalog_id = c.id) as services
         from meta.rest_catalog c where c.workspace_id = $1 order by lower(c.name)`, [currentWorkspace(s)])).rows;
    const main = html`<div class="title-row"><h1>${tx('rcat.rest_source_catalogs')}</h1></div>
      <p class="muted u-mt0">Web services described once for ${s.workspace?.name ?? 'this workspace'}: their base URL and services. An application makes a REST data source from a service in Shared Components → REST data sources → New. The data source is a copy; credentials stay with the application.</p>
      ${notesHtml(s)}
      ${region(tx('rcat.catalogs'), html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('rcat.catalog')}</th><th>${tx('rcat.base_url')}</th><th class="num">${tx('rcat.services')}</th><th>${tx('rcat.from')}</th><th>${tx('rcat.updated_utc')}</th></tr></thead>
        <tbody>${rows.length ? rows.map((c) => html`<tr>
          <td data-label="${tx('rcat.catalog')}"><a href="${root}/${c.id}">${c.name}</a>${c.description ? html`<br><span class="muted small">${String(c.description).slice(0, 160)}</span>` : ''}</td>
          <td data-label="${tx('rcat.base_url')}">${c.server ? html`<span class="tag">${icon('server')} ${c.server}</span> ` : ''}<code class="wrap-anywhere">${c.base_url ?? ''}</code></td>
          <td class="num" data-label="${tx('rcat.services')}">${c.services}</td>
          <td data-label="${tx('rcat.from')}">${c.source === 'openapi' ? html`OpenAPI${c.api_version ? html` <span class="muted">${c.api_version}</span>` : ''}` : 'by hand'}</td>
          <td data-label="${tx('rcat.updated')}">${when(c.updated_at)}</td></tr>`)
          : html`<tr><td colspan="5" class="empty">${tx('rcat.no_catalogs_yet_import_an')}</td></tr>`}</tbody></table></div>`)}
      ${region(tx('rcat.import_a_catalog'), importForm(s, `${root}/import`, false))}
      ${region(tx('rcat.create_a_catalog_by_hand'), html`<form method="post" action="${root}">${csrf(s)}
        <div class="form-grid">${input('name', tx('rcat.name'), '', { required: true, placeholder: tx('rcat.e_g_weather_service') })}${input('base_url', tx('rcat.base_url'), '', { required: true, placeholder: tx('rcat.https_api_example_com_v1') })}
          <div class="field" data-wide><label class="label" for="f_cdescription">${tx('rcat.description')}</label><input id="f_cdescription" name="description"></div></div>
        <div class="buttons"><button class="btn">${icon('plus')} ${tx('rcat.create')}</button></div></form>`)}`;
    return send(reply, s, shell(s, tx('rcat.rest_source_catalogs'), crumbs(), main));
  });

  app.post(root, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c: Catalog = {
      name: String(req.body?.name ?? '').trim(), description: String(req.body?.description ?? '').trim() || null,
      base_url: trimBase(String(req.body?.base_url ?? '')), source: 'manual', api_version: null, services: [],
    };
    const problems = catalogProblems(c);
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, root);
    }
    try {
      const id = await insertCatalog(owner, currentWorkspace(s), c, s.username);
      flash(s, tx('rcat.catalog_created_add_its_services'));
      return back(reply, s, `${root}/${id}`);
    } catch (e) {
      flash(s, uniqueError(e), 'error');
      return back(reply, s, root);
    }
  });

  app.post(`${root}/import`, async (req: Req, reply) => {
    let doc: { text: string; from?: string; url?: string } | Error;
    try {
      doc = await documentText(req);
    } catch (e) {
      doc = e as Error;
    }
    const s = await developer(req, reply);
    if (!s) return;
    try {
      if (doc instanceof Error) throw doc;
      doc = await documentOf(doc, s);
      const { catalog, notes } = readCatalogText(doc.text, { baseUrl: req.body?.base_url, from: doc.from, name: req.body?.name });
      const problems = wholeCatalogProblems(catalog);
      if (problems.length) throw new Error(tx('rcat.unusable', { problems: `${problems.slice(0, 8).join(' ')}${problems.length > 8 ? ` ${tx('rcat.and_more', { n: problems.length - 8 })}` : ''}` }));
      const id = await owner.tx((c) => insertCatalog(c, currentWorkspace(s), catalog, s.username));
      s.state[NOTES] = JSON.stringify(notes);
      await logActivity({ appId: null, username: s.username, event: 'rest_catalog', ip: clientIp(req), detail: `imported catalog ${catalog.name} (${catalog.services.length} services)` });
      flash(s, tx('rcat.imported', { name: catalog.name, n: catalog.services.length }));
      return back(reply, s, `${root}/${id}`);
    } catch (e) {
      flash(s, tx('rcat.import_failed', { error: uniqueError(e) }), 'error');
      return back(reply, s, root);
    }
  });

  // ---------------------------------------------------------------- one catalog
  app.get(`${root}/:cid(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await catalogOf(s, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    const base = `${root}/${c.id}`;
    const sel = req.query.service ? c.services.find((x) => String(x.id) === req.query.service) : null;
    const main = html`<div class="title-row"><h1>${c.name}</h1>
        <a class="btn" href="${base}/download">${icon('download')} ${tx('rcat.download')}</a></div>
      <p class="muted u-mt0">${c.server ? html`${tx.rich('rcat.on_server', { server: html`<a href="${BASE}/remote-servers">${c.server}</a>` })} · ` : ''}<code class="wrap-anywhere">${c.base_url ?? ''}</code>${c.source === 'openapi' ? html` · ${c.api_version ? tx('rcat.from_openapi_version', { version: c.api_version }) : tx('rcat.from_openapi')}` : ''} · ${tx('rcat.updated_when', { when: when(c.updated_at) })}</p>
      ${notesHtml(s)}
      ${region(tx('rcat.services'), html`<div class="table-wrap"><table class="report report-reflow">
        <thead><tr><th>${tx('rcat.service')}</th><th>${tx('rcat.method')}</th><th>${tx('rcat.path')}</th><th class="num">${tx('rcat.parameters')}</th><th class="num">${tx('rcat.columns')}</th><th>${tx('rcat.write_back')}</th></tr></thead>
        <tbody>${c.services.length ? c.services.map((x) => html`<tr${sel?.id === x.id ? raw(' aria-current="true"') : ''}>
          <td data-label="${tx('rcat.service')}"><a href="${base}?service=${x.id}#service">${x.name}</a>${x.description ? html`<br><span class="muted small">${x.description.slice(0, 140)}</span>` : ''}</td>
          <td data-label="${tx('rcat.method')}"><span class="tag">${x.method}</span></td>
          <td data-label="${tx('rcat.path')}"><code class="wrap-anywhere">${x.path}</code></td>
          <td class="num" data-label="${tx('rcat.parameters')}">${x.params.length}</td>
          <td class="num" data-label="${tx('rcat.columns')}">${x.columns.length}</td>
          <td data-label="${tx('rcat.write_back')}">${Object.keys(x.operations).join(', ') || html`<span class="muted">—</span>`}</td></tr>`)
          : html`<tr><td colspan="6" class="empty">${tx('rcat.no_services_yet')}</td></tr>`}</tbody></table></div>
        <p class="u-m0 u-mt1"><a class="btn" href="${base}?service=new#service">${icon('plus')} ${tx('rcat.add_a_service')}</a></p>`)}
      ${req.query.service === 'new'
        ? region(tx('rcat.new_service'), serviceForm(s, `${base}/services`, { method: 'GET', path: '/' }, tx('rcat.add')), '', 'service')
        : sel
          ? region(tx('rcat.service_title', { name: sel.name }), html`<p class="muted u-mt0">${tx('rcat.url')} <code class="wrap-anywhere">${c.server ? `${c.server} + ${sel.path}` : serviceUrl(c.base_url ?? '', sel.path)}</code></p>
              ${serviceForm(s, `${base}/services/${sel.id}`, sel, tx('rcat.save'))}
              <form method="post" action="${base}/services/${sel.id}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('rcat.delete_service_confirm', { name: sel.name })}">${tx('rcat.delete_service')}</button></form>`, '', 'service')
          : ''}
      ${region(tx('rcat.catalog'), html`<form method="post" action="${base}">${csrf(s)}
        <div class="form-grid">${input('name', tx('rcat.name'), c.name, { required: true })}${input('base_url', tx('rcat.base_url'), c.base_url ?? '', { help: tx('rcat.e_g_a_test_system') })}
          ${input('server', tx('rcat.remote_server'), c.server ?? '', { placeholder: tx('rcat.e_g_crm'), help: tx('rcat.the_static_id_of_a') })}
          ${input('api_version', tx('rcat.api_version'), c.api_version ?? '')}
          <div class="field" data-wide><label class="label" for="f_cdescription">${tx('rcat.description')}</label><textarea id="f_cdescription" name="description" rows="2">${c.description ?? ''}</textarea></div></div>
        <div class="buttons"><button class="btn btn-hot">${icon('save')} ${tx('rcat.save')}</button></div></form>`)}
      ${region(tx('rcat.replace_from_a_document'), importForm(s, `${base}/import`, true))}
      <form method="post" action="${base}/delete" class="danger-zone">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('rcat.delete_catalog_confirm', { name: c.name })}">${tx('rcat.delete_catalog')}</button></form>`;
    return send(reply, s, shell(s, c.name, crumbs([[c.name]]), main));
  });

  app.post(`${root}/:cid(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await catalogOf(s, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    const v = {
      name: String(req.body?.name ?? '').trim(), base_url: trimBase(String(req.body?.base_url ?? '')),
      server: String(req.body?.server ?? '').trim().toUpperCase() || null,
      description: String(req.body?.description ?? '').trim() || null, api_version: String(req.body?.api_version ?? '').trim() || null,
    };
    // the services must still make sense on the new base URL
    const problems = [...catalogProblems(v), ...c.services.flatMap((x) => serviceProblems(v.base_url || 'https://x', x))];
    if (problems.length) flash(s, problems.slice(0, 6).join(' '), 'error');
    else
      try {
        await owner.query('update meta.rest_catalog set name = $2, base_url = $3, description = $4, api_version = $5, server = $6, updated_at = now() where id = $1',
          [c.id, v.name, v.base_url || null, v.description, v.api_version, v.server]);
        if (v.server && !(await owner.one('select 1 as ok from meta.remote_server where workspace_id = $1 and static_id = $2', [c.workspace_id, v.server])))
          flash(s, tx('rcat.no_server', { server: v.server }), 'error');
        else
        flash(s, tx('rcat.catalog_saved'));
      } catch (e) {
        flash(s, uniqueError(e), 'error');
      }
    return back(reply, s, `${root}/${c.id}`);
  });

  app.post(`${root}/:cid(^\\d+$)/import`, async (req: Req, reply) => {
    let doc: { text: string; from?: string; url?: string } | Error;
    try {
      doc = await documentText(req);
    } catch (e) {
      doc = e as Error;
    }
    const s = await developer(req, reply);
    if (!s) return;
    const c = await catalogOf(s, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    try {
      if (doc instanceof Error) throw doc;
      doc = await documentOf(doc, s);
      const { catalog, notes } = readCatalogText(doc.text, { baseUrl: req.body?.base_url, from: doc.from, name: c.name });
      // (141) the catalog stays on its remote server
      catalog.server = c.server ?? null;
      const problems = wholeCatalogProblems(catalog);
      if (problems.length) throw new Error(problems.slice(0, 8).join(' '));
      await owner.tx((db) => replaceCatalog(db, c.id, catalog));
      s.state[NOTES] = JSON.stringify(notes);
      await logActivity({ appId: null, username: s.username, event: 'rest_catalog', ip: clientIp(req), detail: `replaced catalog ${c.name} (${catalog.services.length} services)` });
      flash(s, tx('rcat.replaced', { name: c.name, n: catalog.services.length }));
    } catch (e) {
      flash(s, tx('rcat.import_failed', { error: uniqueError(e) }), 'error');
    }
    return back(reply, s, `${root}/${c.id}`);
  });

  app.get(`${root}/:cid(^\\d+$)/download`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await catalogOf(s, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    return reply
      .type('application/json')
      .header('content-disposition', `attachment; filename="${snake(c.name).replace(/_/g, '-')}.catalog.json"`)
      .send(JSON.stringify(catalogDocument(c), null, 2));
  });

  app.post(`${root}/:cid(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await catalogOf(s, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    await owner.query('delete from meta.rest_catalog where id = $1', [c.id]);
    await logActivity({ appId: null, username: s.username, event: 'rest_catalog', ip: clientIp(req), detail: `deleted catalog ${c.name}` });
    flash(s, tx('rcat.deleted', { name: c.name }));
    return back(reply, s, root);
  });

  // ---------------------------------------------------------------- services
  // a new service (no sid) or a changed one
  const saveService = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await catalogOf(s, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    const sid = req.params.sid ? Number(req.params.sid) : null;
    if (sid && !c.services.some((x) => x.id === sid)) return reply.code(404).send('Not found');
    const retry = `${root}/${c.id}?service=${sid ?? 'new'}#service`;
    try {
      const v = serviceFromBody(req.body ?? {});
      const problems = serviceProblems(c.base_url || 'https://x', v);
      if (problems.length) throw new Error(problems.join(' '));
      const vals = [v.name, v.description, v.path, v.method, JSON.stringify(v.params), JSON.stringify(v.headers), v.body, v.row_selector, JSON.stringify(v.columns), v.key_columns, JSON.stringify(v.operations)];
      let id = sid;
      if (sid)
        await owner.query(
          `update meta.rest_catalog_service set name = $3, description = $4, path = $5, method = $6, params = $7, headers = $8, body = $9, row_selector = $10, columns = $11, key_columns = $12, operations = $13
            where id = $1 and catalog_id = $2`, [sid, c.id, ...vals]);
      else
        id = (await owner.one(
          `insert into meta.rest_catalog_service (catalog_id, name, description, path, method, params, headers, body, row_selector, columns, key_columns, operations, position)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, (select coalesce(max(position), 0) + 10 from meta.rest_catalog_service where catalog_id = $1)) returning id`, [c.id, ...vals])).id;
      await owner.query('update meta.rest_catalog set updated_at = now() where id = $1', [c.id]);
      flash(s, tx('rcat.service_saved', { name: v.name }));
      return back(reply, s, `${root}/${c.id}?service=${id}#service`);
    } catch (e) {
      flash(s, uniqueError(e), 'error');
      return back(reply, s, retry);
    }
  };
  app.post(`${root}/:cid(^\\d+$)/services`, saveService);
  app.post(`${root}/:cid(^\\d+$)/services/:sid(^\\d+$)`, saveService);

  app.post(`${root}/:cid(^\\d+$)/services/:sid(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const c = await catalogOf(s, req.params.cid);
    if (!c) return reply.code(404).send('Not found');
    await owner.query('delete from meta.rest_catalog_service where id = $1 and catalog_id = $2', [req.params.sid, c.id]);
    await owner.query('update meta.rest_catalog set updated_at = now() where id = $1', [c.id]);
    flash(s, tx('rcat.service_deleted'));
    return back(reply, s, `${root}/${c.id}`);
  });

  // ---------------------------------------------------------------- an application's data source from a service
  app.post(`${BASE}/apps/:id(^\\d+$)/rest-sources/from-catalog`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const appId = Number(req.params.id);
    if (!(await owner.one('select 1 as ok from meta.app where id = $1', [appId]))) return reply.code(404).send('Not found');
    const retry = `${BASE}/apps/${appId}/shared?new=rest_source`;
    try {
      // the service must belong to a catalog of the application's workspace
      const svc = await owner.one<{ id: number; catalog_id: number }>(
        `select x.id, x.catalog_id from meta.rest_catalog_service x join meta.rest_catalog c on c.id = x.catalog_id
          where x.id = $1 and c.workspace_id = meta.app_workspace($2)`, [/^\d{1,9}$/.test(String(req.body?.service)) ? req.body!.service : null, appId]);
      if (!svc) throw new Error(tx('rcat.choose_a_service_of_one'));
      const c = (await loadCatalog(svc.catalog_id))!;
      const v = sourceFromService(c, c.services.find((x) => x.id === svc.id)!, { name: req.body?.name, credential: req.body?.credential });
      if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(v.name)) throw new Error(tx('rcat.the_name_is_upper_case'));
      if (v.credential && !(await owner.one('select 1 as ok from meta.web_credential where app_id = $1 and name = $2 union all select 1 from meta.workspace_credential where workspace_id = meta.app_workspace($1) and name = $2', [appId, v.credential])))
        throw new Error(tx('rcat.no_credential', { name: v.credential }));
      const problems = sourceProblems(v);
      if (problems.length) throw new Error(problems.join(' '));
      const r = await owner.one<{ id: number }>(
        `insert into meta.rest_source (app_id, name, description, url, method, credential, params, headers, body, row_selector, columns, key_columns, operations, server)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [appId, v.name, v.description, v.url, v.method, v.credential, JSON.stringify(v.params), JSON.stringify(v.headers), v.body, v.row_selector, JSON.stringify(v.columns), v.key_columns, JSON.stringify(v.operations), v.server]);
      flash(s, `REST data source ${v.name} made from ${c.name}. Test it below${v.credential ? '' : '; add a web credential if the service needs one'}.`);
      return back(reply, s, `${BASE}/apps/${appId}/shared?c=rest_source-${r!.id}`);
    } catch (e) {
      const m = (e as Error).message;
      flash(s, m.includes('rest_source_app_id_name_key') ? tx('rcat.this_application_has_a_rest') : m, 'error');
      return back(reply, s, retry);
    }
  });
}

function uniqueError(e: unknown) {
  const m = (e as Error).message;
  if (m.includes('rest_catalog_name_key')) return 'This workspace has a catalog with that name already.';
  if (m.includes('rest_catalog_service_catalog_id_name_key')) return 'The catalog has a service with that name already.';
  return m;
}

/**
 * Shared Components → REST data sources → New: a data source from a service of
 * one of the workspace's catalogs ('' when it has none).
 */
export async function catalogPicker(appId: number, s: Session): Promise<Raw | ''> {
  const services = (await owner.query(
    `select x.id, x.name, x.method, x.path, c.name as catalog from meta.rest_catalog_service x join meta.rest_catalog c on c.id = x.catalog_id
      where c.workspace_id = meta.app_workspace($1) order by lower(c.name), x.position, x.name`, [appId])).rows;
  if (!services.length)
    return html`<p class="muted u-mt0 u-mb1">${icon('globe')} Services described once for the workspace: <a href="${root}">${tx('rcat.rest_source_catalogs')}</a>.</p>`;
  const credentials = (await owner.query('select name from meta.web_credential where app_id = $1 union select name from meta.workspace_credential where workspace_id = meta.app_workspace($1) order by name', [appId])).rows;
  const groups = new Map<string, typeof services>();
  for (const x of services) groups.set(x.catalog, [...(groups.get(x.catalog) ?? []), x]);
  return region(tx('rcat.from_a_rest_source_catalog'), html`<form method="post" action="${BASE}/apps/${appId}/rest-sources/from-catalog">${csrf(s)}
    <p class="muted u-mt0">${tx.rich('rcat.copy_of', { link: html`<a href="${root}">${tx('rcat.catalogs_link')}</a>` })}</p>
    <div class="form-grid">
      <div class="field" data-wide><label class="label" for="f_service">${tx('rcat.service')}</label><select id="f_service" name="service" required>
        ${[...groups].map(([cat, xs]) => html`<optgroup label="${cat}">${xs.map((x) => html`<option value="${x.id}">${x.name} · ${x.method} ${x.path}</option>`)}</optgroup>`)}</select></div>
      ${input('name', tx('rcat.name'), '', { placeholder: tx('rcat.the_service_s_name') })}
      <div class="field"><label class="label" for="f_credential">${tx('rcat.web_credential')}</label><select id="f_credential" name="credential"><option value="">none</option>${credentials.map((c) => html`<option>${c.name}</option>`)}</select></div>
    </div>
    <div class="buttons"><button class="btn btn-hot">${icon('plus')} ${tx('rcat.create_from_the_catalog')}</button></div></form>`);
}

