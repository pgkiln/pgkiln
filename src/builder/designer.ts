import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { COMPONENTS } from './components.ts';
import { back, BASE, bicon, csrf, developer, flash, input, select, send, shell, type Req } from './ui.ts';
import { buildOptionChoices, componentForm, lookups, saveComponent } from './forms.ts';
import { regionSettingsForm } from './region-settings.ts';
import { usedInPanel } from './search.ts';
import { processJobsPanel } from './process-jobs.ts';
import { appLocks, lockPanel, lockText } from './locks.ts';
import { arrangeRoutes, BUTTON_ACTIONS, BUTTON_LABELS, ITEM_LABELS, ITEM_TYPES, REGION_LABELS, REGION_TYPES, undoState } from './arrange.ts';

// Page designer, laid out like APEX's Page Designer: the component tree on
// the left (Rendering / Dynamic actions / Processing / Shared components),
// the Layout in the middle (regions on the 12-column grid with their items
// and buttons, plus a gallery to drag new components from), and the
// property editor on the right. Layout changes go through arrange.ts.
//
// Without JavaScript the panes are stacked sections, every component is a
// link, the gallery entries open the create form and the Arrange buttons
// move things; builder.js adds tabs, the ARIA tree, drag and drop and the
// property filter on top.

const PAGE_KINDS = ['region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'computation', 'branch'];

const regionIcon = (type: string) => REGION_LABELS[type]?.[1] ?? 'region';
const itemIcon = (type: string) => ITEM_LABELS[type]?.[1] ?? 'item';
const firstLine = (text: string | null | undefined, max = 90) => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A titled panel that builder.js turns into a tab of the surrounding [data-tabs]. */
const tab = (id: string, title: Raw | string, body: Raw | Raw[] | string, active = false, ic = '') =>
  html`<section class="tab-panel" id="${id}" data-tab${active ? raw(' data-tab-active') : ''}><h2 class="tab-title">${ic ? bicon(ic) : ''}<span>${title}</span></h2>${body}</section>`;

export async function designerRoutes(app: FastifyInstance) {
  await arrangeRoutes(app);

  // ---------------------------------------------------------------- go to page n of an app (toolbar page switcher)
  app.get(`${BASE}/apps/:id/goto`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const appId = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null;
    const no = /^\d{1,9}$/.test(req.query.page ?? '') ? Number(req.query.page) : -1;
    const p = appId === null ? null : await owner.one('select id from meta.page where app_id = $1 and page_no = $2', [appId, no]);
    if (p) return reply.redirect(`${BASE}/pages/${p.id}`, 303);
    flash(s, `There is no page ${req.query.page ?? ''}.`, 'error');
    return back(reply, s, appId === null ? BASE : `${BASE}/apps/${appId}`);
  });

  // ---------------------------------------------------------------- page designer
  app.get(`${BASE}/pages/:pid`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await owner.one('select p.*, a.alias, a.name as app_name from meta.page p join meta.app a on a.id = p.app_id where p.id = $1', [req.params.pid]);
    if (!p) return reply.code(404).send('Not found');
    const rows: Record<string, any[]> = {};
    for (const kind of PAGE_KINDS) rows[kind] = (await owner.query(`select * from ${COMPONENTS[kind].table} where page_id = $1 order by seq, id`, [p.id])).rows;
    const [lk, pages, shared] = await Promise.all([
      lookups(p.app_id, p.id),
      owner.query('select id, page_no, name from meta.page where app_id = $1 order by page_no', [p.app_id]).then((r) => r.rows),
      Promise.all([
        owner.query('select id, name from meta.lov where app_id = $1 order by name', [p.app_id]),
        owner.query('select id, name from meta.authz_scheme where app_id = $1 order by name', [p.app_id]),
        owner.query('select id, label from meta.nav_entry where app_id = $1 order by seq, id', [p.app_id]),
        owner.query('select id, name from meta.app_item where app_id = $1 order by name', [p.app_id]),
      ]).then((r) => r.map((x) => x.rows)),
    ]);
    const sel = req.query.c ?? '';
    const newKind = PAGE_KINDS.includes(req.query.new ?? '') ? req.query.new : '';
    const [kind, cid] = sel.split('-');
    const url = (q: string) => `${BASE}/pages/${p.id}${q ? `?${q}` : ''}`;
    const isSel = (key: string) => sel === key || (key === 'page' && !sel && !newKind);
    const cur = (key: string) => (isSel(key) ? raw(' aria-current="true"') : '');
    const badges = (r: any) => html`${r.authz ? html`<span class="pd-tag" title="Authorization: ${r.authz}">${icon('shield')}<span class="sr-only">Authorization ${r.authz}</span></span>` : ''}${r.condition || r.readonly_condition || r.condition_type ? html`<span class="pd-tag" title="Has a condition">${icon('filter')}<span class="sr-only">Has a condition</span></span>` : ''}${r.build_option ? html`<span class="pd-tag" title="Build option: ${r.build_option}">${icon('settings')}<span class="sr-only">Build option ${r.build_option}</span></span>` : ''}`;
    const regionTitle = (r: any) => r.title ?? `(${r.type})`;

    // ------------------------------------------------------------ left: component tree
    const leaf = (k: string, r: any, ic: Raw | '', label: string, note = '') =>
      html`<li><a class="pd-node" href="${url(`c=${k}-${r.id}`)}"${cur(`${k}-${r.id}`)}>${ic}<span class="pd-label">${label}</span>${badges(r)}${note ? html`<span class="pd-note">${note}</span>` : ''}</a></li>`;
    const folder = (label: string, children: Raw[] | Raw, open = true) =>
      html`<li${open ? '' : raw(' data-collapsed')}><span class="pd-node pd-folder"><span class="pd-label">${label}</span></span><ul>${children}</ul></li>`;
    const none = (text: string) => html`<li class="pd-empty">${text}</li>`;
    const itemLeaf = (i: any) => leaf('item', i, bicon(itemIcon(i.type)), i.name, i.type);
    const buttonLeaf = (b: any) => leaf('button', b, bicon('button'), b.name, b.action);
    const regionLeaf = (r: any) => {
      const items = rows.item.filter((i) => i.region_id === r.id);
      const buttons = rows.button.filter((b) => b.region_id === r.id);
      const kids = [...(items.length ? [folder('Items', items.map(itemLeaf))] : []), ...(buttons.length ? [folder('Buttons', buttons.map(buttonLeaf))] : [])];
      return html`<li><a class="pd-node" href="${url(`c=region-${r.id}`)}"${cur(`region-${r.id}`)}>${bicon(regionIcon(r.type))}<span class="pd-label">${regionTitle(r)}</span>${badges(r)}<span class="pd-note">${r.type}</span></a>${kids.length ? html`<ul>${kids}</ul>` : ''}</li>`;
    };
    const pageItems = rows.item.filter((i) => i.region_id === null);
    const pageButtons = rows.button.filter((b) => b.region_id === null);
    const loadProcs = rows.process.filter((x) => x.point === 'load');
    const submitProcs = rows.process.filter((x) => x.point !== 'load');
    const headerComps = rows.computation.filter((x) => x.point === 'before_header');
    const submitComps = rows.computation.filter((x) => x.point !== 'before_header');
    const headerBranches = rows.branch.filter((x) => x.point === 'before_header');
    const branchNote = (b: any) => `${b.when_button ? `${b.when_button}: ` : ''}→ ${b.target_type === 'url' ? b.target_url : `page ${b.target_page ?? p.page_no}`}`;
    const compLeaf = (x: any) => leaf('computation', x, icon('activity'), x.item_name, x.type);
    const branchLeaf = (x: any) => leaf('branch', x, bicon('right'), x.name, branchNote(x));
    const preRendering = [...headerBranches.map(branchLeaf), ...headerComps.map(compLeaf), ...loadProcs.map((x) => leaf('process', x, icon('code'), x.name))];
    const createBar = (links: [string, string][]) =>
      html`<div class="pd-treebar">${links.map(([k, label]) => html`<a class="tb-btn tb-text" href="${url(`new=${k}`)}">${icon('plus')}<span>${label}</span></a>`)}</div>`;

    const rendering = html`${createBar([['region', 'Region'], ['item', 'Item'], ['button', 'Button']])}
      <ul class="pd-tree" aria-label="Rendering">
        <li><a class="pd-node" href="${url('c=page')}"${cur('page')}>${icon('file')}<span class="pd-label">Page ${p.page_no}: ${p.name}</span>${badges(p)}</a>
          <ul>
            ${folder('Pre-Rendering (before header)', preRendering.length ? preRendering : none('No branches, computations or processes before rendering'), preRendering.length > 0)}
            ${folder('Regions', rows.region.length ? rows.region.map(regionLeaf) : none('No regions yet'))}
            ${pageItems.length ? folder('Page items', pageItems.map(itemLeaf)) : ''}
            ${pageButtons.length ? folder('Page buttons', pageButtons.map(buttonLeaf)) : ''}
          </ul></li>
      </ul>`;
    const events: [string, string][] = [['change', 'Change'], ['click', 'Click'], ['load', 'Page load']];
    const dynamicActions = html`${createBar([['dynamic_action', 'Dynamic action']])}
      <ul class="pd-tree" aria-label="Dynamic actions">
        ${events.map(([ev, label]) => {
          const list = rows.dynamic_action.filter((d) => d.event === ev);
          return folder(`Events: ${label}`, list.length ? list.map((d) => leaf('dynamic_action', d, icon('bolt'), d.name, `${d.trigger_element ?? ''} → ${d.action}`)) : none('None'), list.length > 0);
        })}
      </ul>`;
    // after processing: the branches in sequence, then (when none applies) the pressed button's target page
    const afterBranches = rows.branch.filter((x) => x.point !== 'before_header');
    const buttonTargets = rows.button.filter((b) => b.target_page && b.action === 'submit');
    const afterProcessing = [...afterBranches.map(branchLeaf), ...buttonTargets.map((b) => leaf('button', b, bicon('right'), `${b.name} → page ${b.target_page}`, 'button target'))];
    const processing = html`${createBar([['computation', 'Computation'], ['validation', 'Validation'], ['process', 'Process'], ['branch', 'Branch']])}
      <ul class="pd-tree" aria-label="Processing">
        ${folder('After submit (computations)', submitComps.length ? submitComps.map(compLeaf) : none('No computations'), submitComps.length > 0)}
        ${folder('Validating', rows.validation.length ? rows.validation.map((v) => leaf('validation', v, icon('check'), v.name, v.when_button ?? '')) : none('No validations'))}
        ${folder('Processing', submitProcs.length ? submitProcs.map((x) => leaf('process', x, icon('code'), x.name, x.when_button ?? '')) : none('No processes'))}
        ${folder('After processing (branches)', afterProcessing.length ? afterProcessing : none('No branches'), afterProcessing.length > 0)}
      </ul>`;
    const sharedLink = (k: string, id: number, ic: string, label: string) =>
      html`<li><a class="pd-node" href="${BASE}/apps/${p.app_id}/shared?c=${k}-${id}">${icon(ic)}<span class="pd-label">${label}</span></a></li>`;
    const [lovs, schemes, navs, appItems] = shared;
    const sharedTree = html`<div class="pd-treebar"><a class="tb-btn tb-text" href="${BASE}/apps/${p.app_id}/shared">${bicon('shapes')}<span>All shared components</span></a></div>
      <ul class="pd-tree" aria-label="Shared components">
        ${folder('Lists of values', lovs.length ? lovs.map((l) => sharedLink('lov', l.id, 'list', l.name)) : none('None'), lovs.length > 0)}
        ${folder('Authorization schemes', schemes.length ? schemes.map((a) => sharedLink('authz_scheme', a.id, 'shield', a.name)) : none('None'), false)}
        ${folder('Navigation menu', navs.length ? navs.map((n) => sharedLink('nav_entry', n.id, 'menu', n.label)) : none('None'), false)}
        ${folder('Application items', appItems.length ? appItems.map((n) => sharedLink('app_item', n.id, 'edit', n.name)) : none('None'), false)}
      </ul>`;
    const selProcess = kind === 'process' ? rows.process.find((x) => String(x.id) === cid) : null;
    const selComp = kind === 'computation' ? rows.computation.find((x) => String(x.id) === cid) : null;
    const selBranch = kind === 'branch' ? rows.branch.find((x) => String(x.id) === cid) : null;
    const leftTab = kind === 'dynamic_action' || newKind === 'dynamic_action' ? 'da'
      : kind === 'validation' || ['validation', 'process', 'computation', 'branch'].includes(newKind ?? '') || (selProcess && selProcess.point !== 'load')
        || (selComp && selComp.point !== 'before_header') || (selBranch && selBranch.point !== 'before_header') ? 'proc' : 'rend';
    const left = html`<div class="pd-tabs pd-tabs-icons" data-tabs="pd-left" aria-label="Page components">
      ${tab('pd-l-rendering', 'Rendering', rendering, leftTab === 'rend', 'rendering')}
      ${tab('pd-l-da', 'Dynamic actions', dynamicActions, leftTab === 'da', 'bolt')}
      ${tab('pd-l-processing', 'Processing', processing, leftTab === 'proc', 'processing')}
      ${tab('pd-l-shared', 'Shared components', sharedTree, false, 'shapes')}
    </div>`;

    // ------------------------------------------------------------ center: layout + gallery
    const chip = (k: 'item' | 'button', r: any) =>
      html`<a class="pd-chip pd-chip-${k}${isSel(`${k}-${r.id}`) ? ' is-selected' : ''}${k === 'button' && r.hot ? ' is-hot' : ''}" href="${url(`c=${k}-${r.id}`)}" draggable="true" data-kind="${k}" data-id="${r.id}"${cur(`${k}-${r.id}`)} aria-describedby="pd-kbd">${k === 'item' ? bicon(itemIcon(r.type)) : ''}<span>${r.label || r.name}</span>${k === 'item' ? html`<small>${r.name}</small>` : ''}</a>`;
    const slot = (k: 'item' | 'button', regionId: number | null, list: any[]) =>
      html`<div class="pd-slot pd-slot-${k}" data-drop="${k}" data-region="${regionId ?? ''}">${list.length ? list.map((r) => chip(k, r)) : html`<span class="pd-slot-hint">${k === 'item' ? 'Items' : 'Buttons'}</span>`}</div>`;
    const block = (r: any) => html`<div class="pd-region pd-span-${r.columns}${isSel(`region-${r.id}`) ? ' is-selected' : ''}" data-kind="region" data-id="${r.id}" data-span="${r.columns}">
        <div class="pd-region-head" draggable="true" data-kind="region" data-id="${r.id}">
          <span class="pd-grip" title="Drag to move">${bicon('grip')}</span>
          <a class="pd-region-link" href="${url(`c=region-${r.id}`)}"${cur(`region-${r.id}`)} aria-describedby="pd-kbd">${bicon(regionIcon(r.type))}<span>${regionTitle(r)}</span></a>
          <span class="pd-region-meta">${r.columns}/12</span>
        </div>
        <div class="pd-region-body">
          <div class="pd-region-type">${REGION_LABELS[r.type]?.[0] ?? r.type}${r.template !== 'standard' ? ` · ${r.template}` : ''}</div>
          ${r.source || r.table_name ? html`<code class="pd-region-src">${firstLine(r.table_name ?? r.source)}</code>` : ''}
          ${slot('item', r.id, rows.item.filter((i) => i.region_id === r.id))}
          ${slot('button', r.id, rows.button.filter((b) => b.region_id === r.id))}
        </div>
        <span class="pd-resize" title="Drag to change the column span" aria-hidden="true"></span>
      </div>`;
    const gallery = (k: 'region' | 'item' | 'button', types: string[], labels: Record<string, [string, string]>) =>
      html`<ul class="pd-gallery-list" aria-label="${COMPONENTS[k].plural}">${types.map((t) => html`<li><a class="pd-gal" href="${url(`new=${k}&type=${t}`)}" draggable="true" data-new="${k}" data-type="${t}" title="Drag onto the layout, or open to create">${bicon(labels[t]?.[1] ?? k)}<span>${labels[t]?.[0] ?? t}</span></a></li>`)}</ul>`;
    const layout = html`
      <div class="pd-canvas-bar" role="toolbar" aria-label="Layout">
        <button type="button" class="tb-btn" data-zoom="-1" title="Zoom out" hidden>${bicon('zoom-out')}<span class="sr-only">Zoom out</span></button>
        <button type="button" class="tb-btn" data-zoom="1" title="Zoom in" hidden>${bicon('zoom-in')}<span class="sr-only">Zoom in</span></button>
        <button type="button" class="tb-btn" data-maximize title="Maximize the layout" aria-pressed="false" hidden>${bicon('expand')}<span class="sr-only">Maximize the layout</span></button>
        <span class="pd-canvas-hint" id="pd-kbd">Drag to move. Keyboard: Alt+↑/↓ moves the focused component, Alt+Shift+←/→ changes a region's width.</span>
      </div>
      <div class="pd-canvas" id="pd-layout" data-page-id="${p.id}">
        <div class="pd-page-label">${icon('file')} Page ${p.page_no}: ${p.name}${p.mode === 'modal' ? ' (modal dialog)' : ''}</div>
        <div class="pd-grid" data-drop="region">
          ${rows.region.map(block)}
          <div class="pd-grid-end" data-end><a href="${url('new=region')}">${icon('plus')} Region</a></div>
        </div>
        <div class="pd-pagelevel">
          <div class="pd-pagelevel-title">Page level (no region)</div>
          ${slot('item', null, pageItems)}
          ${slot('button', null, pageButtons)}
        </div>
      </div>
      <div class="pd-gallery">
        <div class="pd-tabs" data-tabs="pd-gallery" data-tabs-remember aria-label="Gallery">
          ${tab('pd-g-regions', 'Regions', gallery('region', REGION_TYPES(), REGION_LABELS), true)}
          ${tab('pd-g-items', 'Items', gallery('item', ITEM_TYPES(), ITEM_LABELS))}
          ${tab('pd-g-buttons', 'Buttons', gallery('button', BUTTON_ACTIONS(), BUTTON_LABELS))}
        </div>
      </div>`;
    const help = html`<div class="pd-help">
      <h3>Layout</h3>
      <p>Regions sit on a 12-column grid in sequence order; a region's <em>column span</em> sets its width, and regions wrap to a new row when the row is full.</p>
      <ul>
        <li>Drag a region by its header to move it, or drag its right edge to make it wider or narrower.</li>
        <li>Drag items and buttons to another place or another region.</li>
        <li>Drag a region, item or button from the gallery onto the layout to create it; or open a gallery entry to create one with a form.</li>
        <li>Keyboard: focus a component on the layout and press <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> to move it, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd> to change a region's width. The <strong>Arrange</strong> buttons above the properties do the same.</li>
        <li><strong>Undo</strong> and <strong>Redo</strong> in the toolbar take back layout changes.</li>
      </ul>
      <h3>Cheat sheet</h3>
      <p><code>:P1_ITEM</code> binds an item value in any SQL (always escaped). <code>:APP_USER</code>, <code>:APP_PAGE_ID</code>, <code>:REQUEST</code> are built in.</p>
      <p><code>&amp;P1_ITEM.</code> substitutes into titles, static HTML and link targets (HTML-escaped).</p>
      <p>In SQL, PL/pgSQL and RLS policies: <code>meta.app_user()</code>, <code>meta.has_role('admin')</code>, <code>meta.v('P1_ITEM')</code>, <code>meta.page_url(3, '{"P3_ID": 7}')</code>.</p>
      <p>A PL/pgSQL <code>raise exception 'Message' using column = 'sal'</code> shows the message on the item whose source column is <code>sal</code>.</p>
    </div>`;
    const pageSearch = html`<form method="get" action="${BASE}/apps/${p.app_id}/search" class="pd-search" role="search">
        <label class="label" for="pd-q">Search the application's pages and components</label>
        <div class="u-row"><input id="pd-q" name="q" type="search" placeholder="e.g. P${p.page_no}_ or a table name"><button class="btn btn-sm">${icon('search')} Search</button></div>
      </form>`;
    // a lock of another developer (on this page or the whole application) makes the page read-only
    const locks = (await appLocks(p.app_id)).filter((l) => l.page_no === 0 || l.page_no === p.page_no);
    const blocking = locks.find((l) => l.locked_by !== s.username);
    const mine = locks.find((l) => l.locked_by === s.username);
    const commentCount = (await owner.one('select count(*)::int as n from meta.dev_comment where app_id = $1 and page_no = $2', [p.app_id, p.page_no])).n;
    const center = html`${blocking ? html`<div class="alert alert-error pd-lock" role="status">${icon('key')} ${lockText(blocking)} Your changes will be refused.</div>` : ''}
      <div class="pd-tabs pd-tabs-center" data-tabs="pd-center" aria-label="Page">
      ${tab('pd-c-layout', 'Layout', layout, true)}
      ${tab('pd-c-search', 'Page search', pageSearch)}
      ${tab('pd-c-notes', `Lock and comments${commentCount ? ` (${commentCount})` : ''}${mine || blocking ? ' · locked' : ''}`, await lockPanel(s, p.app_id, p.page_no))}
      ${tab('pd-c-help', 'Help', help)}
    </div>`;

    // ------------------------------------------------------------ right: property editor
    let heading: Raw;
    let props: Raw;
    let arrange: Raw | '' = '';
    const formId = 'pd-form';
    let hasForm = true;
    const peTabs = (panels: Raw[]) => html`<div class="pd-tabs" data-tabs="pd-right" data-tabs-remember aria-label="Properties">${panels}</div>`;
    const moveForm = (k: string, id: number, fields: Raw, button: Raw, title: string) =>
      html`<form method="post" action="${url('')}/layout/move" class="pe-arrange-form">${csrf(s)}<input type="hidden" name="kind" value="${k}"><input type="hidden" name="id" value="${id}">${fields}<button class="tb-btn" title="${title}">${button}</button></form>`;
    if (newKind) {
      const spec = COMPONENTS[newKind];
      const lastSeq = Math.max(0, ...rows[newKind].map((r) => r.seq));
      const typeField = newKind === 'button' ? 'action' : 'type';
      const presetType = spec.fields.find((f) => f.name === typeField)?.options?.includes(req.query.type ?? '') ? { [typeField]: req.query.type } : {};
      const defaults = { seq: lastSeq + 10, ...spec.defaults, ...presetType, region_id: /^\d+$/.test(req.query.region ?? '') ? Number(req.query.region) : null };
      heading = html`${icon(spec.icon)}<span>New ${spec.label.toLowerCase()}</span>`;
      props = peTabs([tab('pd-r-props', spec.label, componentForm(spec, newKind, defaults, lk, `${BASE}/pages/${p.id}/c/${newKind}`, s, `Create ${spec.label.toLowerCase()}`, { id: formId }), true)]);
    } else if (kind && kind !== 'page' && PAGE_KINDS.includes(kind)) {
      const spec = COMPONENTS[kind];
      const row = rows[kind].find((r) => String(r.id) === cid);
      if (row) {
        heading = html`${kind === 'region' ? bicon(regionIcon(row.type)) : kind === 'item' ? bicon(itemIcon(row.type)) : kind === 'button' ? bicon('button') : icon(spec.icon)}<span>${spec.label}: ${spec.summary(row)}</span>`;
        const settings = kind === 'region' ? await regionSettingsForm(p.id, p.app_id, row, s) : '';
        props = html`${peTabs([
          tab('pd-r-props', spec.label, componentForm(spec, kind, row, lk, `${BASE}/pages/${p.id}/c/${kind}/${row.id}`, s, 'Save', { id: formId }), true),
          ...(settings ? [tab('pd-r-attrs', 'Attributes', settings)] : []),
          ...(kind === 'process' && row.type === 'chain' && row.config?.background ? [tab('pd-r-jobs', 'Jobs', await processJobsPanel(row.id))] : []),
        ])}
          ${await usedInPanel(p.app_id, kind, row)}
          <form method="post" action="${BASE}/pages/${p.id}/c/${kind}/${row.id}/delete" class="danger-zone">${csrf(s)}
            <button class="btn btn-sm btn-danger" data-confirm="Delete this ${spec.label.toLowerCase()}?">Delete ${spec.label.toLowerCase()}</button></form>`;
        if (kind === 'region' || kind === 'item' || kind === 'button') {
          const regionOptions = html`<option value="">- page level -</option>${rows.region.map((r) => html`<option value="${r.id}"${row.region_id === r.id ? raw(' selected') : ''}>${regionTitle(r)}</option>`)}`;
          arrange = html`<div class="pe-arrange" role="group" aria-label="Arrange">
            <span class="pe-arrange-label">Arrange</span>
            ${moveForm(kind, row.id, html`<input type="hidden" name="dir" value="up">`, html`${bicon('arrow-up')}<span class="sr-only">Move up</span>`, 'Move up (earlier in the sequence)')}
            ${moveForm(kind, row.id, html`<input type="hidden" name="dir" value="down">`, html`${bicon('arrow-down')}<span class="sr-only">Move down</span>`, 'Move down (later in the sequence)')}
            ${kind === 'region'
              ? html`<form method="post" action="${url('')}/layout/span" class="pe-arrange-form">${csrf(s)}<input type="hidden" name="id" value="${row.id}"><input type="hidden" name="delta" value="-1"><button class="tb-btn" title="Narrower (one column less)"${row.columns <= 1 ? raw(' disabled') : ''}>${bicon('narrow')}<span class="sr-only">Narrower</span></button></form>
                <span class="pe-span" title="Column span">${row.columns}/12</span>
                <form method="post" action="${url('')}/layout/span" class="pe-arrange-form">${csrf(s)}<input type="hidden" name="id" value="${row.id}"><input type="hidden" name="delta" value="1"><button class="tb-btn" title="Wider (one column more)"${row.columns >= 12 ? raw(' disabled') : ''}>${bicon('wide')}<span class="sr-only">Wider</span></button></form>`
              : moveForm(kind, row.id, html`<label class="sr-only" for="pe-move-region">Move to region</label><select id="pe-move-region" name="region">${regionOptions}</select>`, html`<span>Move</span>`, 'Move to the end of this region')}
          </div>`;
        }
      } else {
        heading = html`<span>Not found</span>`;
        props = html`<p class="muted">Component not found.</p>`;
        hasForm = false;
      }
    } else {
      heading = html`${icon('file')}<span>Page ${p.page_no}: ${p.name}</span>`;
      props = html`${peTabs([tab('pd-r-props', 'Page', html`
        <form method="post" action="${BASE}/pages/${p.id}" class="component-form" id="${formId}">${csrf(s)}
          <fieldset class="prop-group"><legend>Identification</legend><div class="form-grid">
            ${input('page_no', 'Page number', p.page_no, { type: 'number', required: true })}
            ${input('name', 'Name', p.name, { required: true })}
            ${input('title', 'Title', p.title, { help: 'Supports &ITEM. substitutions.' })}
          </div></fieldset>
          <fieldset class="prop-group"><legend>Appearance</legend><div class="form-grid">
            ${select('mode', 'Page mode', p.mode, [['normal', 'Normal'], ['modal', 'Modal dialog']])}
            ${select('dialog_position', 'Dialog position', p.dialog_position ?? 'center', [['center', 'Centred dialog'], ['right', 'Drawer from the right'], ['left', 'Drawer from the left'], ['top', 'Drawer from the top'], ['bottom', 'Drawer from the bottom']], 'Modal pages only. On phones dialogs and side drawers fill the screen.')}
            ${select('dialog_size', 'Dialog size', p.dialog_size ?? 'medium', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], 'The width (the height of top and bottom drawers).')}
            ${select('parent_page', 'Breadcrumb parent', p.parent_page ?? '', [['', '- none -'], ...lk.pages.filter((x) => x.page_no !== p.page_no).map((x): [string, string] => [String(x.page_no), `${x.page_no}. ${x.name}`])])}
          </div></fieldset>
          <fieldset class="prop-group"><legend>Security</legend><div class="form-grid">
            <div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="requires_auth" value="true"${p.requires_auth ? raw(' checked') : ''}> Requires authentication</label></div>
            ${select('authz', 'Authorization scheme', p.authz ?? '', [['', '- none -'], ...['MUST_NOT_BE_PUBLIC_USER', ...lk.authz].flatMap((n): [string, string][] => [[n, n], [`!${n}`, `Not ${n}`]])])}
            ${select('protection', 'Page access protection', p.protection, [['checksum', 'Arguments must have checksum'], ['unrestricted', 'Unrestricted']],
              'With checksum, item values in the URL (?P3_ID=…) are only accepted from links the runtime generated.')}
            ${select('build_option', 'Build option', p.build_option ?? '', buildOptionChoices(lk, p.build_option),
              'While the option is excluded (or "Not": included) the page does not exist in the running application.')}
          </div></fieldset>
          <div class="buttons"><button class="btn btn-hot">Save page</button></div>
        </form>`, true)])}
        ${await usedInPanel(p.app_id, 'page', p)}
        <form method="post" action="${BASE}/pages/${p.id}/delete" class="danger-zone">${csrf(s)}
          <button class="btn btn-sm btn-danger" data-confirm="Delete page ${p.page_no} and all its components?">Delete page</button></form>`;
    }
    const right = html`
      <div class="pe-head"><div class="pe-title">${heading}</div>
        <div class="pe-filter-row" hidden><label class="sr-only" for="pe-filter">Filter properties</label>${icon('filter')}<input id="pe-filter" class="pe-filter" type="search" placeholder="Filter" autocomplete="off"></div>
      </div>
      ${arrange}
      <div class="pe">${props}</div>`;

    // ------------------------------------------------------------ toolbar
    const idx = pages.findIndex((x) => x.id === p.id);
    const prev = pages[idx - 1];
    const next = pages[idx + 1];
    const h = undoState(s, p.id);
    const tbForm = (op: string, ic: string, label: string, title: string | null) =>
      html`<form method="post" action="${url('')}/layout/${op}" class="tb-form">${csrf(s)}<button class="tb-btn" title="${title ? `${label}: ${title}` : `Nothing to ${label.toLowerCase()}`}"${title ? '' : raw(' disabled')}>${bicon(ic)}<span class="sr-only">${label}</span></button></form>`;
    const createMenu = html`<details class="menu tb-menu">
        <summary class="tb-btn" title="Create">${icon('plus')}${bicon('down', 'icon tb-caret')}<span class="sr-only">Create</span></summary>
        <div class="menu-panel align-right"><div class="menu-section menu-links">
          ${[['region', 'Region'], ['item', 'Page item'], ['button', 'Button'], ['dynamic_action', 'Dynamic action'], ['computation', 'Computation'], ['validation', 'Validation'], ['process', 'Process'], ['branch', 'Branch']].map(([k, label]) =>
            html`<a href="${url(`new=${k}`)}">${icon(COMPONENTS[k].icon)} ${label}</a>`)}
        </div><div class="menu-section menu-links">
          <a href="${BASE}/apps/${p.app_id}#create-page">${icon('file')} Page…</a>
        </div></div></details>`;
    const utilMenu = html`<details class="menu tb-menu">
        <summary class="tb-btn" title="Utilities">${bicon('wrench')}${bicon('down', 'icon tb-caret')}<span class="sr-only">Utilities</span></summary>
        <div class="menu-panel align-right"><div class="menu-section menu-links">
          <a href="${BASE}/apps/${p.app_id}/advisor">${icon('check')} Advisor</a>
          <a href="${BASE}/apps/${p.app_id}/search?q=P${p.page_no}_">${icon('search')} Search this page's items</a>
          <a href="${BASE}/apps/${p.app_id}/shared">${bicon('shapes')} Shared components</a>
          <a href="${BASE}/apps/${p.app_id}">${bicon('pages')} All pages</a>
          <a href="${BASE}/apps/${p.app_id}/export">${icon('download')} Export application</a>
        </div></div></details>`;
    const toolbar = html`
      <div class="tb-group pd-pagenav" role="group" aria-label="Page">
        ${prev ? html`<a class="tb-btn" href="${BASE}/pages/${prev.id}" title="Previous page: ${prev.page_no}. ${prev.name}">${bicon('left')}<span class="sr-only">Previous page</span></a>` : html`<span class="tb-btn" aria-disabled="true">${bicon('left')}</span>`}
        <form method="get" action="${BASE}/apps/${p.app_id}/goto" class="tb-form pd-goto">
          <label class="sr-only" for="pd-goto">Go to page</label>
          <select id="pd-goto" name="page" data-autosubmit>${pages.map((x) => html`<option value="${x.page_no}"${x.id === p.id ? raw(' selected') : ''}>${x.page_no} · ${x.name}</option>`)}</select>
          <button class="tb-btn tb-text pd-goto-go">Go</button>
        </form>
        ${next ? html`<a class="tb-btn" href="${BASE}/pages/${next.id}" title="Next page: ${next.page_no}. ${next.name}">${bicon('right')}<span class="sr-only">Next page</span></a>` : html`<span class="tb-btn" aria-disabled="true">${bicon('right')}</span>`}
      </div>
      <div class="tb-group tb-undo" role="group" aria-label="History">${tbForm('undo', 'undo', 'Undo', h.undo)}${tbForm('redo', 'redo', 'Redo', h.redo)}</div>
      <div class="tb-group tb-menus">${createMenu}${utilMenu}</div>
      <div class="tb-group tb-main">
        ${hasForm ? html`<button class="btn btn-sm tb-save" form="${formId}" title="Save the properties">${bicon('save')}<span>Save</span></button>` : ''}
        <a class="btn btn-sm btn-run" href="/a/${p.alias}/${p.page_no}" target="_blank" rel="noopener" title="Run page ${p.page_no}">${icon('play')}<span>Run</span></a>
      </div>`;

    const pane = newKind || sel ? 'pd-p-props' : 'pd-p-layout';
    const main = html`<h1 class="sr-only">Page designer: page ${p.page_no}, ${p.name}</h1>
      <div class="pd" data-tabs="pd-panes" data-tabs-media="(max-width: 1023px)" aria-label="Page designer">
        <section class="pd-pane pd-left tab-panel" id="pd-p-tree" data-tab><h2 class="tab-title pd-pane-title"><span>Tree</span></h2>${left}</section>
        <section class="pd-pane pd-center tab-panel" id="pd-p-layout" data-tab${pane === 'pd-p-layout' ? raw(' data-tab-active') : ''}><h2 class="tab-title pd-pane-title"><span>Layout</span></h2>${center}</section>
        <section class="pd-pane pd-right tab-panel" id="pd-p-props" data-tab${pane === 'pd-p-props' ? raw(' data-tab-active') : ''}><h2 class="tab-title pd-pane-title"><span>Properties</span></h2>${right}</section>
      </div>`;
    return send(reply, s, shell(s, `Page ${p.page_no}`, [['App Builder', BASE], [p.app_name, `${BASE}/apps/${p.app_id}`], [`Page ${p.page_no}: ${p.name}`]], main, 'apps', { toolbar, full: true }));
  });

  app.post(`${BASE}/pages/:pid`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const before = await owner.one('select app_id, page_no from meta.page where id = $1', [req.params.pid]);
      await owner.query(
        `update meta.page set page_no = $2, name = $3, title = $4, requires_auth = $5, mode = $6, parent_page = $7, authz = $8, protection = $9, build_option = $10,
                dialog_position = $11, dialog_size = $12 where id = $1`,
        [req.params.pid, Number(b.page_no), b.name?.trim(), b.title?.trim() || null, b.requires_auth === 'true', b.mode, b.parent_page ? Number(b.parent_page) : null, b.authz || null, b.protection, b.build_option?.trim().toUpperCase() || null,
         ['left', 'right', 'top', 'bottom'].includes(b.dialog_position ?? '') ? b.dialog_position : 'center', ['small', 'large'].includes(b.dialog_size ?? '') ? b.dialog_size : 'medium'],
      );
      // the page's lock and comments follow a new page number
      if (before && before.page_no !== Number(b.page_no))
        for (const t of ['builder_lock', 'dev_comment'])
          await owner.query(`update meta.${t} set page_no = $3 where app_id = $1 and page_no = $2`, [before.app_id, before.page_no, Number(b.page_no)]);
      flash(s, 'Page saved.');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/pages/${req.params.pid}?c=page`);
  });

  app.post(`${BASE}/pages/:pid/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = await owner.one('delete from meta.page where id = $1 returning app_id, page_no', [req.params.pid]);
    if (p) for (const t of ['builder_lock', 'dev_comment']) await owner.query(`delete from meta.${t} where app_id = $1 and page_no = $2`, [p.app_id, p.page_no]);
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
