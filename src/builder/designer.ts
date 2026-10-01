import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { COMPONENTS } from './components.ts';
import { back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { componentForm, lookups, saveComponent } from './forms.ts';
import { regionSettingsForm } from './region-settings.ts';
import { usedInPanel } from './search.ts';

// Page designer: a page's regions, items, buttons, dynamic actions,
// validations and processes, edited with the generic component forms.

export async function designerRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- page designer
  const PAGE_KINDS = ['region', 'item', 'button', 'dynamic_action', 'validation', 'process'];

  app.get(`${BASE}/pages/:pid`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await owner.one('select p.*, a.alias, a.name as app_name from meta.page p join meta.app a on a.id = p.app_id where p.id = $1', [req.params.pid]);
    if (!p) return reply.code(404).send('Not found');
    const rows: Record<string, any[]> = {};
    for (const kind of PAGE_KINDS) rows[kind] = (await owner.query(`select * from ${COMPONENTS[kind].table} where page_id = $1 order by seq, id`, [p.id])).rows;
    const lk = await lookups(p.app_id, p.id);
    const sel = req.query.c ?? '';
    const newKind = req.query.new;
    const url = (q: string) => `${BASE}/pages/${p.id}?${q}`;
    const cur = (key: string) => (sel === key ? raw(' aria-current="page"') : '');
    const tags = (r: any) => html`${r.authz ? html` <span class="tag" title="Authorization">${r.authz}</span>` : ''}${r.condition || r.readonly_condition ? html` <span class="tag" title="Condition">cond</span>` : ''}`;
    const node = (kind: string, r: any, label: string, extra: Raw | string = '') =>
      html`<li><a href="${url(`c=${kind}-${r.id}`)}"${cur(`${kind}-${r.id}`)}>${icon(COMPONENTS[kind].icon)}<span>${label}</span>${tags(r)}<span class="kind">${extra}</span></a></li>`;
    const addLink = (kind: string, label: string, extra = '') => html`<a href="${url(`new=${kind}${extra}`)}">＋ ${label}</a>`;

    const regionNodes = rows.region.map((r) => html`<li><a href="${url(`c=region-${r.id}`)}"${cur(`region-${r.id}`)}>${icon('layers')}<span>${r.title ?? '(untitled)'}</span>${tags(r)}<span class="kind">${r.type}</span></a>
      <ul>
        ${rows.item.filter((i) => i.region_id === r.id).map((i) => node('item', i, i.name, i.type))}
        ${rows.button.filter((b) => b.region_id === r.id).map((b) => node('button', b, b.name, b.action))}
        <li class="group">${addLink('item', 'item', `&region=${r.id}`)} ${addLink('button', 'button', `&region=${r.id}`)}</li>
      </ul></li>`);

    const tree = html`<ul class="tree">
      <li><a href="${url('c=page')}"${cur('page') || (sel === '' && !newKind ? raw(' aria-current="page"') : '')}>${icon('file')}<span>Page ${p.page_no}: ${p.name}</span>${tags(p)}</a></li>
      <li class="group">Rendering ${addLink('region', 'Region')}</li>
      ${regionNodes}
      <li class="group">Page-level items &amp; buttons ${addLink('item', 'item')}</li>
      ${rows.item.filter((i) => i.region_id === null).map((i) => node('item', i, i.name, i.type))}
      ${rows.button.filter((b) => b.region_id === null).map((b) => node('button', b, b.name, b.action))}
      <li class="group">Dynamic actions ${addLink('dynamic_action', 'Add')}</li>
      ${rows.dynamic_action.map((d) => node('dynamic_action', d, d.name, `${d.event} → ${d.action}`))}
      <li class="group">Validations ${addLink('validation', 'Add')}</li>
      ${rows.validation.map((v) => node('validation', v, v.name, v.type))}
      <li class="group">Processes ${addLink('process', 'Add')}</li>
      ${rows.process.map((x) => node('process', x, x.name, x.when_button ?? x.point))}
    </ul>`;

    let editor: Raw;
    const [kind, cid] = sel.split('-');
    if (newKind && PAGE_KINDS.includes(newKind)) {
      const spec = COMPONENTS[newKind];
      const lastSeq = Math.max(0, ...rows[newKind].map((r) => r.seq));
      const defaults = { seq: lastSeq + 10, ...spec.defaults, region_id: req.query.region ? Number(req.query.region) : null };
      editor = region(`New ${spec.label.toLowerCase()}`, componentForm(spec, newKind, defaults, lk, `${BASE}/pages/${p.id}/c/${newKind}`, s, `Create ${spec.label.toLowerCase()}`));
    } else if (kind && kind !== 'page' && PAGE_KINDS.includes(kind)) {
      const spec = COMPONENTS[kind];
      const row = rows[kind].find((r) => String(r.id) === cid);
      editor = row
        ? region(`${spec.label}: ${spec.summary(row)}`, html`${componentForm(spec, kind, row, lk, `${BASE}/pages/${p.id}/c/${kind}/${row.id}`, s, 'Save')}
            ${kind === 'region' ? await regionSettingsForm(p.id, p.app_id, row, s) : ''}
            ${await usedInPanel(p.app_id, kind, row)}
            <form method="post" action="${BASE}/pages/${p.id}/c/${kind}/${row.id}/delete" class="danger-zone">${csrf(s)}
              <button class="btn btn-danger" data-confirm="Delete this ${spec.label.toLowerCase()}?">Delete ${spec.label.toLowerCase()}</button></form>`)
        : html`<p>Component not found.</p>`;
    } else {
      editor = html`${region('Page', html`
        <form method="post" action="${BASE}/pages/${p.id}">${csrf(s)}
          <fieldset class="prop-group"><legend>Identification</legend><div class="form-grid">
            ${input('page_no', 'Page number', p.page_no, { type: 'number', required: true })}
            ${input('name', 'Name', p.name, { required: true })}
            ${input('title', 'Title', p.title, { help: 'Supports &ITEM. substitutions.' })}
          </div></fieldset>
          <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
            ${select('mode', 'Page mode', p.mode, [['normal', 'Normal'], ['modal', 'Modal dialog']])}
            ${select('parent_page', 'Breadcrumb parent', p.parent_page ?? '', [['', '- none -'], ...lk.pages.filter((x) => x.page_no !== p.page_no).map((x): [string, string] => [String(x.page_no), `${x.page_no}. ${x.name}`])])}
          </div></fieldset>
          <fieldset class="prop-group"><legend>Security</legend><div class="form-grid">
            <div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="requires_auth" value="true"${p.requires_auth ? raw(' checked') : ''}> Requires authentication</label></div>
            ${select('authz', 'Authorization scheme', p.authz ?? '', [['', '- none -'], ...['MUST_NOT_BE_PUBLIC_USER', ...lk.authz].flatMap((n): [string, string][] => [[n, n], [`!${n}`, `Not ${n}`]])])}
            ${select('protection', 'Page access protection', p.protection, [['checksum', 'Arguments must have checksum'], ['unrestricted', 'Unrestricted']],
              'With checksum, item values in the URL (?P3_ID=…) are only accepted from links the runtime generated.')}
          </div></fieldset>
          <div class="buttons"><button class="btn btn-hot">Save page</button></div>
        </form>
        <form method="post" action="${BASE}/pages/${p.id}/delete" class="danger-zone">${csrf(s)}
          <button class="btn btn-danger" data-confirm="Delete page ${p.page_no} and all its components?">Delete page</button></form>
        ${await usedInPanel(p.app_id, 'page', p)}`)}
        <div class="u-spacer"></div>
        ${region('Cheat sheet', html`<div class="cheat">
          <p><code>:P1_ITEM</code> binds an item value in any SQL (always escaped). <code>:APP_USER</code>, <code>:APP_PAGE_ID</code>, <code>:REQUEST</code> are built in.</p>
          <p><code>&amp;P1_ITEM.</code> substitutes into titles, static HTML and link targets (HTML-escaped).</p>
          <p>In SQL, PL/pgSQL and RLS policies: <code>meta.app_user()</code>, <code>meta.has_role('admin')</code>, <code>meta.v('P1_ITEM')</code>, <code>meta.page_url(3, '{"P3_ID": 7}')</code>.</p>
          <p>A PL/pgSQL <code>raise exception 'Message' using column = 'sal'</code> shows the message on the item whose source column is <code>sal</code>.</p>
        </div>`)}`;
    }

    const main = html`
      <div class="title-row"><h1>Page ${p.page_no}: ${p.name}</h1>
        <div class="buttons">
          ${p.page_no > 1 ? html`<a class="btn" href="${BASE}/apps/${p.app_id}">‹ All pages</a>` : ''}
          <a class="btn btn-hot" href="/a/${p.alias}/${p.page_no}" target="_blank" rel="noopener">${icon('play')} Run page</a>
        </div></div>
      <div class="designer">
        <aside class="region region-standard" aria-label="Page components">${tree}</aside>
        <div>${editor}</div>
      </div>`;
    return send(reply, s, shell(s, `Page ${p.page_no}`, [['App Builder', BASE], [p.app_name, `${BASE}/apps/${p.app_id}`], [`Page ${p.page_no}`]], main));
  });

  app.post(`${BASE}/pages/:pid`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.query(
        `update meta.page set page_no = $2, name = $3, title = $4, requires_auth = $5, mode = $6, parent_page = $7, authz = $8, protection = $9 where id = $1`,
        [req.params.pid, Number(b.page_no), b.name?.trim(), b.title?.trim() || null, b.requires_auth === 'true', b.mode, b.parent_page ? Number(b.parent_page) : null, b.authz || null, b.protection],
      );
      flash(s, 'Page saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/pages/${req.params.pid}?c=page`);
  });

  app.post(`${BASE}/pages/:pid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await owner.one('delete from meta.page where id = $1 returning app_id', [req.params.pid]);
    flash(s, 'Page deleted.');
    return back(reply, s, p ? `${BASE}/apps/${p.app_id}` : BASE);
  });

  app.post(`${BASE}/pages/:pid/c/:kind/:cid?`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, kind, cid } = req.params;
    if (!PAGE_KINDS.includes(kind)) return reply.code(404).send('Unknown component type');
    try {
      const id = await saveComponent(kind, 'page_id', pid, cid, req.body ?? {});
      flash(s, `${COMPONENTS[kind].label} saved.`);
      return back(reply, s, `${BASE}/pages/${pid}?c=${kind}-${id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/pages/${pid}?${cid ? `c=${kind}-${cid}` : `new=${kind}`}`);
    }
  });

  app.post(`${BASE}/pages/:pid/c/:kind/:cid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, kind, cid } = req.params;
    if (!PAGE_KINDS.includes(kind)) return reply.code(404).send('Unknown component type');
    await owner.query(`delete from ${COMPONENTS[kind].table} where id = $1 and page_id = $2`, [cid, pid]);
    flash(s, `${COMPONENTS[kind].label} deleted.`);
    return back(reply, s, `${BASE}/pages/${pid}`);
  });

}
