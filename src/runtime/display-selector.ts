import { html, type Raw } from '../html.ts';
import type { PageContext } from './context.ts';
import type { Region } from '../metadata.ts';

// Region display selector (APEX): a bar of tabs, or a select list, that
// shows one region of the page at a time, or all of them ("Show all").
// Regions take part with "display_selector": true in their settings (a tab
// named after the region), or "display_selector": "Tab name" (regions with
// the same name share one tab, e.g. a smart filters region and its report).
// They stay where the page puts them.
//   config: {"style": "tabs" | "select", "show_all": true, "remember": true}
//
// Without JavaScript the bar is a list of links to the regions (#R<id>) and
// every region shows. app.js turns it into ARIA tabs (arrow keys, Home,
// End) or a select list, hides the other regions, follows #R<id> in the
// URL, and remembers the choice per page in the browser session.

export interface SelectorTab {
  label: string;
  regions: number[];
}

/** The tabs of the page's display selectors: visible regions that take part, grouped by tab name, in page order. */
export function selectorTabs(ctx: PageContext, fallback: (r: Region) => string): SelectorTab[] {
  const tabs = new Map<string, SelectorTab>();
  for (const x of ctx.page.regions) {
    const flag = x.config?.display_selector;
    if (x.type === 'display_selector' || !ctx.vis!.regions.has(x.id)) continue;
    const named = typeof flag === 'string' && flag.trim() !== '';
    if (flag !== true && !named) continue;
    const key = named ? `t:${flag.trim()}` : `r:${x.id}`;
    const tab = tabs.get(key) ?? { label: named ? flag.trim() : x.title || fallback(x), regions: [] };
    tab.regions.push(x.id);
    tabs.set(key, tab);
  }
  return [...tabs.values()];
}

export function renderDisplaySelector(ctx: PageContext, r: Region): Raw {
  const t = ctx.locale.t;
  const tabs = selectorTabs(ctx, (x) => `${t('rds.region')} ${x.id}`);
  if (!tabs.length) return html`<p class="muted">${t('rds.empty')}</p>`;
  const style = r.config.style === 'select' ? 'select' : 'tabs';
  const showAll = r.config.show_all !== false;
  const id = `rds${r.id}`;
  const label = r.title || t('rds.label');
  const targets = (x: SelectorTab) => x.regions.map((n) => `R${n}`).join(' ');
  return html`<nav class="rds rds-${style}" id="${id}" aria-label="${label}" data-rds="${r.id}"${r.config.remember !== false ? html` data-rds-remember` : ''}>
    <ul class="rds-list">
      ${showAll ? html`<li><a class="rds-tab" id="${id}_all" href="#${id}" data-rds-all>${t('rds.show_all')}</a></li>` : ''}
      ${tabs.map((x, i) => html`<li><a class="rds-tab" id="${id}_${i}" href="#R${x.regions[0]}" data-rds-target="${targets(x)}">${x.label}</a></li>`)}
    </ul>
    ${style === 'select'
      ? html`<label class="rds-select-label" hidden><span class="sr-only">${label}</span>
          <select class="rds-select">
            ${showAll ? html`<option value="*">${t('rds.show_all')}</option>` : ''}
            ${tabs.map((x, i) => html`<option value="${i}">${x.label}</option>`)}
          </select></label>`
      : ''}
  </nav>`;
}
