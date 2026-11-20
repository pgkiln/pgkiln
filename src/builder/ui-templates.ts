import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { BUILTIN_COMPONENTS } from '../runtime/builtin-components.ts';
import { CLASSIC_TEMPLATES } from '../runtime/report.ts';
import { LIST_TEMPLATES } from '../runtime/lists.ts';
import { appHeader, BASE, designerUrl, developer, region, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 203, AX-7; APEX: Shared Components → User Interface → Templates) The templates an application's components
// can choose, with where each is used: page templates (meta.page.page_template), region templates (meta.region.template),
// button templates (a button's Primary (hot) setting and its menu), label templates (an item's Required setting and
// the template option "Hide the label"), classic report templates ({"report_template"}) and list templates
// ({"template"} of a list region). They are part of pgkiln's theme, so the page is read-only: a component chooses
// one in the Page Designer, Theme Roller and template options change their look, and markup of your own is a
// template component (Shared Components → Template Components), which the page links to.

/** One use of a template: the component and the link to it in the Page Designer. */
interface Use { label: string; href: string }
interface Tpl { key: string; name: string; desc: string; uses: Use[] }

const REGION_TEMPLATES = ['standard', 'plain', 'collapsible', 'hero', 'title_bar', 'buttons_container', 'inline_dialog', 'inline_drawer', 'wizard', 'tabs_container', 'flex_container'] as const;
const PAGE_TEMPLATES = ['standard', 'left_side_column', 'right_side_column', 'minimal', 'no_navigation'] as const;

/** The templates of one kind, their names and descriptions from uit.<kind>.<key> and uit.<kind>.<key>.d. */
const catalog = (kind: string, keys: readonly string[], usesOf: (key: string) => Use[]): Tpl[] =>
  keys.map((key) => ({ key, name: tx.dyn(`uit.${kind}.${key}`, key), desc: tx.dyn(`uit.${kind}.${key}.d`, ''), uses: usesOf(key) }));

/** Where-used, as a disclosure of links (the first 100), or "not used". */
function usedBy(uses: Use[]): Raw {
  if (!uses.length) return html`<span class="muted">${tx('uit.unused')}</span>`;
  return html`<details class="tpl-uses"><summary>${tx(uses.length === 1 ? 'uit.uses_one' : 'uit.uses', { n: uses.length })}</summary>
    <ul>${uses.slice(0, 100).map((u) => html`<li><a href="${u.href}">${u.label}</a></li>`)}${uses.length > 100 ? html`<li class="muted">…</li>` : ''}</ul></details>`;
}

function table(id: string, title: string, intro: string, rows: Tpl[]): Raw {
  return region(title, html`<p class="muted u-mt0">${intro}</p>
    <div class="table-wrap"><table class="table report-reflow tpl-table"><thead><tr><th scope="col">${tx('uit.template')}</th><th scope="col">${tx('uit.description')}</th><th scope="col">${tx('uit.used_by')}</th></tr></thead><tbody>
      ${rows.map((t) => html`<tr><td data-label="${tx('uit.template')}"><strong>${t.name}</strong><br><code class="small">${t.key}</code></td><td data-label="${tx('uit.description')}">${t.desc}</td><td data-label="${tx('uit.used_by')}">${usedBy(t.uses)}</td></tr>`)}
    </tbody></table></div>`, '', id);
}

export async function uiTemplateRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/templates`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = /^\d{1,9}$/.test(req.params.id) ? await owner.one('select * from meta.app where id = $1', [req.params.id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const pages = (await owner.query<{ page_no: number; name: string; page_template: string }>('select page_no, name, page_template from meta.page where app_id = $1 order by page_no', [a.id])).rows;
    const regions = (await owner.query<{ id: number; title: string | null; type: string; template: string; rt: string | null; lt: string | null; page_no: number; page: string }>(
      `select r.id, r.title, r.type, r.template, r.config->>'report_template' as rt, r.config->>'template' as lt, p.page_no, p.name as page
         from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 order by p.page_no, r.seq, r.id`, [a.id])).rows;
    const buttons = (await owner.query<{ id: number; name: string; label: string | null; hot: boolean; menu: boolean; page_no: number; page: string }>(
      `select b.id, b.name, b.label, b.hot, b.menu is not null and b.menu::text not in ('null', '[]') as menu, p.page_no, p.name as page
         from meta.button b join meta.page p on p.id = b.page_id where p.app_id = $1 order by p.page_no, b.seq, b.id`, [a.id])).rows;
    const items = (await owner.query<{ id: number; name: string; required: boolean; hidden: boolean; page_no: number; page: string }>(
      `select i.id, i.name, coalesce(i.required, false) as required, 'to-hide-label' = any (i.template_options) as hidden, p.page_no, p.name as page
         from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1 and i.type <> 'hidden' order by p.page_no, i.seq, i.id`, [a.id])).rows;
    const custom = (await owner.one<{ n: number }>('select count(*)::int as n from meta.template_component where app_id = $1', [a.id]))?.n ?? 0;

    const where = (pageNo: number, page: string, what: string) => `${tx('uit.page_n', { n: pageNo, name: page })} › ${what}`;
    const regionUse = (r: (typeof regions)[number]): Use => ({ label: where(r.page_no, r.page, r.title || `#${r.id}`), href: designerUrl(a.id, r.page_no, `c=region-${r.id}`) });
    const buttonKind = (b: (typeof buttons)[number]) => (b.menu ? 'menu' : b.hot ? 'hot' : 'text');
    const labelKind = (i: (typeof items)[number]) => (i.hidden ? 'hidden' : i.required ? 'required' : 'optional');

    const u = `${BASE}/apps/${a.id}`;
    const main = html`${appHeader(a, 'shared', s)}
      ${region(tx('uit.title'), html`<p class="u-mt0">${tx('uit.intro')}</p>
        <ul class="sc-links tpl-links">
          <li><a href="${u}/shared?type=template_component">${icon('puzzle')} ${tx('uit.components_link', { n: custom, builtin: BUILTIN_COMPONENTS.length })}</a></li>
          <li><a href="${u}/theme">${icon('palette')} ${tx('uit.theme_link')}</a></li>
        </ul>`)}
      ${table('page-templates', tx('uit.h.page'), tx('uit.i.page'), catalog('page', PAGE_TEMPLATES, (k) => pages.filter((p) => (p.page_template || 'standard') === k).map((p) => ({ label: tx('uit.page_n', { n: p.page_no, name: p.name }), href: designerUrl(a.id, p.page_no, 'c=page') }))))}
      ${table('region-templates', tx('uit.h.region'), tx('uit.i.region'), catalog('region', REGION_TEMPLATES, (k) => regions.filter((r) => (r.template || 'standard') === k).map(regionUse)))}
      ${table('button-templates', tx('uit.h.button'), tx('uit.i.button'), catalog('button', ['text', 'hot', 'menu'], (k) => buttons.filter((b) => buttonKind(b) === k).map((b) => ({ label: where(b.page_no, b.page, b.label || b.name), href: designerUrl(a.id, b.page_no, `c=button-${b.id}`) }))))}
      ${table('label-templates', tx('uit.h.label'), tx('uit.i.label'), catalog('label', ['optional', 'required', 'hidden'], (k) => items.filter((i) => labelKind(i) === k).map((i) => ({ label: where(i.page_no, i.page, i.name), href: designerUrl(a.id, i.page_no, `c=item-${i.id}`) }))))}
      ${table('report-templates', tx('uit.h.report'), tx('uit.i.report'), catalog('report', CLASSIC_TEMPLATES, (k) => regions.filter((r) => r.type === 'classic_report' && ((CLASSIC_TEMPLATES as readonly string[]).includes(r.rt ?? '') ? r.rt : 'standard') === k).map(regionUse)))}
      ${table('list-templates', tx('uit.h.list'), tx('uit.i.list'), catalog('list', LIST_TEMPLATES, (k) => regions.filter((r) => r.type === 'list' && ((LIST_TEMPLATES as readonly string[]).includes(r.lt ?? '') ? r.lt : 'links') === k).map(regionUse)))}`;
    return send(reply, s, shell(s, tx('uit.title'), [[tx('util.app_builder'), BASE], [a.name, u], [tx('uit.shared'), `${u}/shared`], [tx('uit.title')]], main));
  });
}

/** For tests: the i18n keys of the catalog (every one must exist in every builder language). */
export const TEMPLATE_KEYS: string[] = [
  ...PAGE_TEMPLATES.map((k) => `page.${k}`), ...REGION_TEMPLATES.map((k) => `region.${k}`), ...['text', 'hot', 'menu'].map((k) => `button.${k}`),
  ...['optional', 'required', 'hidden'].map((k) => `label.${k}`), ...CLASSIC_TEMPLATES.map((k) => `report.${k}`), ...LIST_TEMPLATES.map((k) => `list.${k}`),
].flatMap((k) => [`uit.${k}`, `uit.${k}.d`]);
