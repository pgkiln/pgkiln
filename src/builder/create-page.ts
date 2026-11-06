import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { featHelp, featLabel, featureStates } from './features.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { kindHelp, kindLabel, NO_TABLE, PAGE_KINDS, wizardTables } from './wizards.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 137, AP-3) Create Page like APEX's: a grid of page types with small previews (tab Component), the
// features (tab Feature, features.ts) and Create page as copy (tab Copy), at /builder/apps/:id/create-page.
// A type that needs a table asks for one first (?type=…), then goes to the options step (wizards.ts); the
// others go to the options step at once. Blank page and Create pages with AI stay as they were. Plain links and
// forms: no JavaScript needed. The previews are inline SVG drawn with classes (public/builder.css), no styles.

/** The grid's order (APEX's names), each with the step it starts with. */
const GRID = (): { key: string; label: string; help: string; table: boolean }[] => [
  { key: 'blank', label: tx('cpg.blank_page'), help: tx('cpg.an_empty_page_to_build'), table: false },
  ...['calendar', 'cards', 'chart', 'comments', 'content_row', 'dashboard', 'data_load', 'facets', 'form', 'grid', 'report', 'map',
    'master_detail', 'media_list', 'report_form', 'search', 'smart_filters', 'timeline', 'tree', 'tasks', 'wizard', 'workflows'].map((k) => {
    const d = PAGE_KINDS.find((x) => x[0] === k)!;
    return { key: k, label: kindLabel(k, d[1]), help: kindHelp(k, d[2]), table: !NO_TABLE.has(k) };
  }),
];

// ---------------------------------------------------------------- previews (80 × 50, inline SVG, classes only)
const rect = (x: number, y: number, w: number, h: number, cls = 'pv-line', rx = 1.5) => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const circle = (cx: number, cy: number, r: number, cls = 'pv-soft') => `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"/>`;
const rows = (y0: number, n: number, x = 6, w = 68, gap = 7) => Array.from({ length: n }, (_, i) => rect(x, y0 + i * gap, w, 3)).join('');
const table = `${rect(6, 6, 68, 6, 'pv-soft')}${rows(16, 5)}`;
const listRows = (n: number, avatar: boolean, right = false) => Array.from({ length: n }, (_, i) => {
  const y = 7 + i * 13;
  return `${avatar ? circle(11, y + 4, 4.5) : ''}${rect(avatar ? 20 : 6, y, 30, 3.5, 'pv-acc')}${rect(avatar ? 20 : 6, y + 5.5, 40, 2.5)}${right ? rect(62, y + 1, 12, 5, 'pv-soft', 2.5) : ''}`;
}).join('');
const PREVIEWS: Record<string, string> = {
  blank: rect(6, 6, 68, 38, 'pv-frame', 3),
  calendar: `${rect(6, 6, 68, 6, 'pv-soft')}${Array.from({ length: 15 }, (_, i) => rect(6 + (i % 5) * 14, 15 + Math.floor(i / 5) * 10, 12, 8, i === 7 ? 'pv-acc' : 'pv-line')).join('')}`,
  cards: Array.from({ length: 4 }, (_, i) => `${rect(6 + (i % 2) * 35, 6 + Math.floor(i / 2) * 20, 33, 18, 'pv-frame', 2)}${rect(9 + (i % 2) * 35, 9 + Math.floor(i / 2) * 20, 18, 3, 'pv-acc')}${rect(9 + (i % 2) * 35, 15 + Math.floor(i / 2) * 20, 24, 2.5)}`).join(''),
  chart: [14, 26, 20, 32, 10].map((h, i) => rect(10 + i * 13, 44 - h, 9, h, i === 3 ? 'pv-acc' : 'pv-soft', 1)).join('') + rect(6, 44, 68, 1.5),
  comments: listRows(3, true),
  content_row: listRows(3, true, true),
  dashboard: Array.from({ length: 4 }, (_, i) => {
    const x = 6 + (i % 2) * 35;
    const y = 6 + Math.floor(i / 2) * 20;
    return `${rect(x, y, 33, 18, 'pv-frame', 2)}${[6, 10, 7, 12].map((h, j) => rect(x + 4 + j * 7, y + 15 - h, 5, h, j === i ? 'pv-acc' : 'pv-soft', 0.8)).join('')}`;
  }).join(''),
  data_load: `${rect(18, 26, 44, 18, 'pv-frame', 2)}${rect(37, 10, 6, 18, 'pv-acc', 1)}<path class="pv-acc" d="M30 14 L40 4 L50 14 Z"/>${rect(24, 32, 32, 2.5)}${rect(24, 37, 24, 2.5)}`,
  facets: `${rect(6, 6, 18, 38, 'pv-soft', 2)}${[10, 16, 22, 28].map((y) => rect(9, y, 12, 2.5)).join('')}${rect(28, 6, 46, 6, 'pv-soft')}${rows(16, 5, 28, 46)}`,
  form: [8, 20, 32].map((y) => `${rect(8, y, 16, 3)}${rect(28, y - 2, 44, 7, 'pv-frame', 1.5)}`).join('') + rect(56, 42, 16, 5, 'pv-acc', 2),
  grid: `${table}${[25, 45].map((x) => rect(x, 13, 0.8, 34, 'pv-line', 0)).join('')}${rect(25.8, 22, 19.2, 6, 'pv-frame', 0)}`,
  report: `${rect(6, 3, 30, 5, 'pv-frame', 1.5)}${rect(6, 11, 68, 6, 'pv-soft')}${rows(21, 4)}`,
  map: `${rect(6, 6, 68, 38, 'pv-soft', 3)}<path class="pv-stroke" d="M6 30 C 24 20, 40 40, 74 18"/>${circle(48, 20, 5, 'pv-acc')}${circle(48, 20, 2, 'pv-bg')}`,
  master_detail: `${rect(6, 4, 68, 5, 'pv-soft')}${rows(12, 2)}${rect(6, 12, 68, 4, 'pv-acc')}${rect(6, 28, 68, 5, 'pv-soft')}${rows(36, 2)}`,
  media_list: Array.from({ length: 3 }, (_, i) => `${rect(6, 6 + i * 13, 9, 9, 'pv-soft', 2)}${rect(19, 7 + i * 13, 30, 3.5, 'pv-acc')}${rect(19, 12.5 + i * 13, 40, 2.5)}${rect(62, 8 + i * 13, 12, 5, 'pv-soft', 2.5)}`).join(''),
  report_form: `${rect(6, 6, 42, 6, 'pv-soft')}${rows(16, 4, 6, 42)}${rect(52, 10, 22, 32, 'pv-frame', 2)}${[15, 22, 29].map((y) => rect(55, y, 16, 3)).join('')}${rect(59, 35, 12, 4, 'pv-acc', 1.5)}`,
  search: `${rect(6, 6, 68, 8, 'pv-frame', 4)}${circle(12, 10, 2.2, 'pv-acc')}${[18, 30].map((y) => `${rect(6, y, 26, 3.5, 'pv-acc')}${rect(6, y + 5, 60, 2.5)}`).join('')}`,
  smart_filters: `${rect(6, 3, 68, 7, 'pv-frame', 3.5)}${rect(8, 12, 16, 4, 'pv-soft', 2)}${rect(26, 12, 14, 4, 'pv-soft', 2)}${rect(6, 19, 68, 5, 'pv-soft')}${rows(27, 3)}`,
  timeline: `${rect(13, 4, 1.5, 42, 'pv-line', 0)}${[8, 22, 36].map((y, i) => `${circle(13.75, y, 3, i === 0 ? 'pv-acc' : 'pv-soft')}${rect(21, y - 3, 28, 3, 'pv-acc')}${rect(21, y + 2, 46, 2.5)}`).join('')}`,
  tree: `${rect(6, 5, 24, 4, 'pv-acc')}<path class="pv-stroke" d="M10 9 V38 M10 18 H18 M10 28 H18 M10 38 H18 M22 32 V38 M22 38 H28"/>${rect(20, 16, 22, 3.5)}${rect(20, 26, 26, 3.5)}${rect(30, 36, 20, 3.5)}`,
  tasks: [8, 20, 32].map((y, i) => `${rect(8, y, 7, 7, i === 0 ? 'pv-acc' : 'pv-frame', 1.5)}${rect(19, y, 34, 3)}${rect(19, y + 4.5, 22, 2.5)}${rect(60, y + 1, 14, 5, 'pv-soft', 2.5)}`).join(''),
  wizard: `<path class="pv-stroke" d="M16 9 H64"/>${[16, 40, 64].map((x, i) => circle(x, 9, 4, i === 0 ? 'pv-acc' : 'pv-soft')).join('')}${[20, 30].map((y) => `${rect(10, y, 14, 3)}${rect(28, y - 2, 42, 7, 'pv-frame', 1.5)}`).join('')}${rect(54, 41, 16, 5, 'pv-acc', 2)}`,
  workflows: `${rect(4, 19, 18, 12, 'pv-acc', 2)}${rect(31, 8, 18, 12, 'pv-soft', 2)}${rect(31, 30, 18, 12, 'pv-soft', 2)}${rect(58, 19, 18, 12, 'pv-frame', 2)}<path class="pv-stroke" d="M22 25 L31 14 M22 25 L31 36 M49 14 L58 25 M49 36 L58 25"/>`,
  ai: `<path class="pv-acc" d="M40 6 L44 20 L58 25 L44 30 L40 44 L36 30 L22 25 L36 20 Z"/>${circle(62, 12, 3, 'pv-soft')}${circle(18, 38, 2.5, 'pv-soft')}`,
};
/** A page type's small picture, decorative (the label says what it is). */
export const preview = (key: string): Raw =>
  raw(`<svg class="cp-svg" viewBox="0 0 80 50" aria-hidden="true" focusable="false">${PREVIEWS[key] ?? PREVIEWS.blank}</svg>`);

const TABS: [string, string][] = [['component', tx('cpg.component')], ['feature', tx('cpg.feature')], ['copy', tx('cpg.copy')]];

export async function createPageRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/create-page`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const q = req.query as Record<string, string | undefined>;
    const tab = TABS.some(([t]) => t === q.tab) ? q.tab! : 'component';
    const type = GRID().find((g) => g.key === q.type);
    const crumbs: [string, string?][] = [[tx('cpg.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], ['Create page', type ? `${BASE}/apps/${a.id}/create-page` : undefined]];
    const nextPage = async () => {
      const used = new Set((await owner.query('select page_no from meta.page where app_id = $1', [a.id])).rows.map((r) => r.page_no as number));
      let n = Math.max(0, ...[...used].filter((x) => x < 9000)) + 1;
      while (used.has(n)) n++;
      return n;
    };

    // a page type that needs a table: choose it first (APEX: the data source step)
    if (type) {
      let body: Raw;
      if (type.key === 'blank') {
        body = html`<form method="post" action="${BASE}/apps/${a.id}/pages">${csrf(s)}
            <div class="form-grid">
              ${input('page_no', tx('cpg.page_number'), await nextPage(), { type: 'number', required: true })}
              ${input('name', tx('cpg.name'), '', { required: true })}
              ${select('mode', tx('cpg.page_mode'), 'normal', [['normal', tx('cpg.normal_page')], ['modal', tx('cpg.modal_dialog')]])}
              ${input('parent_page', tx('cpg.breadcrumb_parent'), a.home_page ?? '', { type: 'number' })}
            </div>
            <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}/create-page">${tx('cpg.back')}</a><button class="btn btn-hot">${tx('cpg.create_page')}</button></div>
          </form>`;
      } else {
        const tables = await wizardTables(a.db_role);
        body = html`<form method="get" action="${BASE}/apps/${a.id}/wizard">
            <input type="hidden" name="kind" value="${type.key}">
            <div class="form-grid">
              ${select('table', tx('cpg.table_or_view'), '', tables.map((t): [string, string] => [t.t, t.access ? t.t : `${t.t} (no access for ${a.db_role})`]),
                'The next step proposes the columns, keys and foreign keys from the database catalog.')}
            </div>
            <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}/create-page">${tx('cpg.back')}</a><button class="btn btn-hot">${tx('cpg.next')}</button></div>
          </form>`;
      }
      const main = html`${appHeader(a, 'pages', s)}
        ${region(type.label, html`<div class="cp-step"><span class="cp-preview cp-preview-lg">${preview(type.key)}</span><p class="muted">${type.help}</p></div>${body}`)}`;
      return send(reply, s, shell(s, tx('cpg.page_title', { app: a.name }), [...crumbs, [type.label]], main));
    }

    const tabs = html`<nav class="gal-tabs segmented cp-tabs" aria-label="${tx('cpg.create_page')}">${TABS.map(([t, l]) =>
      html`<a href="${BASE}/apps/${a.id}/create-page?tab=${t}"${t === tab ? raw(' aria-current="page"') : ''}>${l}</a>`)}</nav>`;
    let body: Raw;
    if (tab === 'component') {
      const href = (g: ReturnType<typeof GRID>[number]) =>
        g.key !== 'blank' && !g.table ? `${BASE}/apps/${a.id}/wizard?kind=${g.key}` : `${BASE}/apps/${a.id}/create-page?type=${g.key}`;
      body = html`<p class="muted u-mt0">${tx('cpg.choose_a_page_type_types')}</p>
        <ul class="cp-grid">${GRID().map((g) => html`<li><a class="cp-type" href="${href(g)}"><span class="cp-preview">${preview(g.key)}</span><b>${g.label}</b><small>${g.help}</small></a></li>`)}
          <li><a class="cp-type" href="${BASE}/apps/${a.id}/ai-pages"><span class="cp-preview">${preview('ai')}</span><b>${tx('cpg.create_pages_with_ai')}</b><small>${tx('cpg.describe_the_pages_in_your')}</small></a></li></ul>`;
    } else if (tab === 'feature') {
      const states = await featureStates(a.id);
      body = html`<p class="muted u-mt0">${tx('cpg.features_add_pages_and_settings')}</p>
        <ul class="cp-grid">${states.map(({ f, installed, blocked }) => html`<li><a class="cp-type${installed || blocked ? ' cp-done' : ''}" href="${BASE}/apps/${a.id}/features/${f.key}">
            <span class="cp-feature-icon">${icon(f.icon)}</span><b>${featLabel(f)}</b><small>${featHelp(f)}</small>
            ${installed ? html`<span class="tag">${tx('cpg.installed')}</span>` : blocked ? html`<span class="tag">${tx('cpg.not_available')}</span>` : ''}</a></li>`)}</ul>`;
    } else {
      body = await copyStep1(a, s.username!);
    }
    const main = html`${appHeader(a, 'pages', s)}${region(tx('cpg.create_page'), html`${tabs}${body}`)}`;
    return send(reply, s, shell(s, tx('cpg.page_title', { app: a.name }), crumbs, main));
  });

  // ---------------------------------------------------------------- Create page as copy
  // step 2 (?from=): the page to copy; step 3 (?from=&page=): number, name and the shared components; POST: copy
  app.get(`${BASE}/apps/:id/copy-page`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const q = req.query as Record<string, string | undefined>;
    const from = await sourceApp(a.id, q.from);
    if (!from) {
      flash(s, tx('cpg.choose_an_application_of_this'), 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/create-page?tab=copy`);
    }
    const pages = (await owner.query<{ id: number; page_no: number; name: string }>('select id, page_no, name from meta.page where app_id = $1 order by page_no', [from.id])).rows;
    const page = pages.find((p) => String(p.page_no) === q.page);
    const crumbs: [string, string?][] = [[tx('cpg.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('cpg.create_page'), `${BASE}/apps/${a.id}/create-page?tab=copy`], [tx('cpg.copy')]];
    let body: Raw;
    if (!page) {
      body = html`<form method="get" action="${BASE}/apps/${a.id}/copy-page"><input type="hidden" name="from" value="${from.id}">
          <div class="form-grid">${select('page', tx('cpg.page_of', { app: from.name }), '', pages.map((p): [string, string] => [String(p.page_no), `${p.page_no} ${p.name}`]))}</div>
          <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}/create-page?tab=copy">${tx('cpg.back')}</a><button class="btn btn-hot">${tx('cpg.next')}</button></div></form>`;
    } else {
      const refs = (await owner.query<{ kind: string; name: string; in_target: boolean }>('select * from meta.page_shared_refs($1, $2)', [page.id, a.id])).rows;
      const used = new Set((await owner.query('select page_no from meta.page where app_id = $1', [a.id])).rows.map((r) => r.page_no as number));
      let no = used.has(page.page_no) ? Math.max(0, ...[...used].filter((x) => x < 9000)) + 1 : page.page_no;
      while (used.has(no)) no++;
      const same = from.id === a.id;
      const options = async (kind: string) => (await owner.query<{ n: string }>(SHARED_NAMES[kind], [a.id])).rows.map((r) => r.n);
      const mapRows = await Promise.all(refs.map(async (r) => {
        const names = await options(r.kind);
        const opts: [string, string][] = [...(same || r.in_target ? [] : [['', tx('cpg.copy_it_into_this_application')] as [string, string]]), ...names.map((n): [string, string] => [n, tx('cpg.use_name', { name: n })])];
        return html`<tr><td>${kindName(r.kind)}</td><td><code>${r.name}</code></td><td>
          <select name="map:${r.kind}:${r.name}" aria-label="${kindName(r.kind)} ${r.name}">${opts.map(([v, l]) => html`<option value="${v}"${v === (r.in_target || same ? r.name : '') ? raw(' selected') : ''}>${l}</option>`)}</select></td></tr>`;
      }));
      body = html`<p class="muted u-mt0">${tx.rich('cpg.copy_intro', { n: page.page_no, name: html`<b>${page.name}</b>`, app: from.name, prefix: `P${page.page_no}_` })}</p>
        <form method="post" action="${BASE}/apps/${a.id}/copy-page">${csrf(s)}
          <input type="hidden" name="from" value="${from.id}"><input type="hidden" name="page" value="${page.page_no}">
          <div class="form-grid">
            ${input('new_page', tx('cpg.new_page_number'), no, { type: 'number', required: true })}
            ${input('name', tx('cpg.name'), page.name, { required: true })}
          </div>
          ${refs.length
            ? html`<h3>${tx('cpg.shared_components')}</h3><p class="muted small">${tx('cpg.refers_by_name')} ${same ? tx('cpg.in_the_same_application_they') : tx('cpg.use_one_of_this_application')}</p>
              <div class="table-wrap"><table class="report"><thead><tr><th>${tx('cpg.kind')}</th><th>${tx('cpg.name')}</th><th>${tx('cpg.in_this_application')}</th></tr></thead><tbody>${mapRows}</tbody></table></div>`
            : html`<p class="muted">${tx('cpg.the_page_uses_no_shared')}</p>`}
          ${same ? '' : html`<p class="muted small">${tx.rich('cpg.sql_runs_as', { role: html`<code>${a.db_role ?? tx('cpg.none')}</code>`, app: from.name })}</p>`}
          <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}/copy-page?from=${from.id}">${tx('cpg.back')}</a><button class="btn btn-hot">${tx('cpg.copy_page')}</button></div>
        </form>`;
    }
    const main = html`${appHeader(a, 'pages', s)}${region(tx('cpg.create_page_as_copy'), body)}`;
    return send(reply, s, shell(s, tx('cpg.copy_title', { app: a.name }), crumbs, main));
  });

  app.post(`${BASE}/apps/:id/copy-page`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const from = await sourceApp(a.id, String(b.from ?? ''));
    const retry = `${BASE}/apps/${a.id}/copy-page?from=${encodeURIComponent(String(b.from ?? ''))}&page=${encodeURIComponent(String(b.page ?? ''))}`;
    if (!from) {
      flash(s, tx('cpg.choose_an_application_of_this'), 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/create-page?tab=copy`);
    }
    try {
      const page = /^\d{1,6}$/.test(String(b.page ?? '')) ? Number(b.page) : NaN;
      const no = /^\d{1,6}$/.test(String(b.new_page ?? '').trim()) ? Number(String(b.new_page).trim()) : NaN;
      if (!(no >= 1)) throw new Error(tx('cpg.enter_a_page_number'));
      const name = String(b.name ?? '').trim().slice(0, 200);
      if (!name) throw new Error(tx('cpg.enter_a_name'));
      // map:<kind>:<NAME> → a name of the target's (empty: copy); only known kinds pass
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(b)) {
        const m = /^map:([a-z_]+):(.{1,100})$/.exec(k);
        if (m && Object.hasOwn(SHARED_NAMES, m[1]) && typeof v === 'string') map[`${m[1]}:${m[2]}`] = v.slice(0, 100);
      }
      const id = await owner.tx(async (c) => (await c.query('select meta.copy_page($1, $2, $3, $4, $5, $6::jsonb) as id', [from.id, page, a.id, no, name, JSON.stringify(map)])).rows[0].id as number);
      flash(s, from.id === a.id ? tx('cpg.copied', { n: no, name, page }) : tx('cpg.copied_from', { n: no, name, page, app: from.name }));
      return back(reply, s, `${BASE}/pages/${id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, retry);
    }
  });
}

const KIND_LABELS: Record<string, string> = {
  authz_scheme: 'Authorization scheme', build_option: 'Build option', lov: 'List of values', list: 'List',
  template_component: 'Template component', search_config: 'Search configuration', data_load_def: 'Data load definition',
};
const kindName = (k: string) => (Object.hasOwn(KIND_LABELS, k) ? tx.dyn(`cpg.k.${k}`, KIND_LABELS[k]) : k);
/** The target application's names of each kind (the choices of the mapping). */
const SHARED_NAMES: Record<string, string> = {
  authz_scheme: 'select name as n from meta.authz_scheme where app_id = $1 order by 1',
  build_option: 'select name as n from meta.build_option where app_id = $1 order by 1',
  lov: 'select name as n from meta.lov where app_id = $1 order by 1',
  list: 'select name as n from meta.list where app_id = $1 order by 1',
  template_component: 'select static_id as n from meta.template_component where app_id = $1 order by 1',
  search_config: 'select name as n from meta.search_config where app_id = $1 order by 1',
  data_load_def: 'select name as n from meta.data_load_def where app_id = $1 order by 1',
};

/** An application of the same workspace as the target (the target itself too), or null. */
async function sourceApp(targetId: number, from: string | undefined) {
  if (!/^\d{1,9}$/.test(String(from ?? ''))) return null;
  return (await owner.one<{ id: number; name: string; alias: string }>(
    'select id, name, alias from meta.app where id = $1 and meta.app_workspace(id) = meta.app_workspace($2)', [from, targetId],
  )) ?? null;
}

/** Copy, step 1: the application to copy from (this one first). */
async function copyStep1(a: { id: number; name: string }, _user: string): Promise<Raw> {
  const apps = (await owner.query<{ id: number; name: string; alias: string }>(
    'select id, name, alias from meta.app where meta.app_workspace(id) = meta.app_workspace($1) order by id <> $1, lower(name)', [a.id],
  )).rows;
  return html`<p class="muted u-mt0">${tx('cpg.copy_a_page_of_this')}</p>
    <form method="get" action="${BASE}/apps/${a.id}/copy-page">
      <div class="form-grid">${select('from', tx('cpg.copy_from_application'), String(a.id), apps.map((x): [string, string] => [String(x.id), x.id === a.id ? `${x.name} (this application)` : `${x.name} (${x.alias})`]))}</div>
      <div class="buttons"><button class="btn btn-hot">${tx('cpg.next')}</button></div>
    </form>`;
}
