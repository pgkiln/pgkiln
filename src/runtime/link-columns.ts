// (sprint 238, MG-6) Link columns and row actions of reports (interactive and classic).
//
// config.link_columns: [{"label": "Edit", "page": 3, "items": {"P3_ID": "#id#"}, "style": "button", "icon": "edit",
//                        "heading": "Edit", "position": "start", "when": "can_edit"}, …]   (at most 10)
//   label     the link's text; #column# takes the row's value (escaped), and it is translated (Text Messages)
//   page      the target page: the link is signed as config.link's (checksum of the item values), shown only when the
//             user may open that page, and opens as a dialog when the page is modal
//   items     item values set by the link, #column# taking the row's values
//   style     link (default), button, hot (primary button), danger, icon (the icon alone; the label is its accessible name)
//   icon      an icon before the label (one of pgkiln's icons)
//   heading   the column's heading (default: the label without #column#)
//   position  start (before the report's columns) or end (default)
//   after     (sprint 260) a column of the query: the link column comes right after it (when that column is shown; else
//             where position puts it), e.g. a quantity button between the name and the unit
//   when      a column of the query: the link shows in rows where it is true (not null, false, '', 'N', 'n', '0' or 'f')
//   else      (sprint 261) "text": in the other rows the label shows as plain text instead of nothing (a quantity that
//             is a button while an order is open, and its number once it is sent)
//
// config.row_actions: {"edit": {"page": 3, "items": {"P3_ID": "#id#"}, "label": "Edit"}, "links": [{"label", "page",
//   "items"}, …]}: the grid's ⋮ menu for each row of a report (a grid's duplicate and delete don't apply to a report).
//   (sprint 261) "label": "Options" shows that text on the menu's button instead of ⋮; "style": "hot" makes it a primary button.

import { html, raw, type Raw } from '../html.ts';
import { icon, isIcon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import type { PageContext } from './context.ts';
import { fillItems, linkAttrs } from './links.ts';

export const LINK_STYLES = ['link', 'button', 'hot', 'danger', 'icon'] as const;
export type LinkStyle = (typeof LINK_STYLES)[number];

export interface LinkColumn {
  label: string;
  page: number;
  items: Record<string, string>;
  style: LinkStyle;
  icon: string | null;
  heading: string;
  position: 'start' | 'end';
  after: string | null;
  when: string | null;
  /** (sprint 261) "text": the label as text where `when` is false */
  otherwise: 'text' | null;
}

interface RowLink {
  label: string | null;
  page: number;
  items: Record<string, string>;
}

const COLUMN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function itemsOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (/^[A-Za-z][A-Za-z0-9_$]{0,127}$/.test(k) && (typeof x === 'string' || typeof x === 'number')) out[k] = String(x);
  return out;
}

const pageOf = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 && v !== '' && v !== null && typeof v !== 'boolean' ? Number(v) : null);

/** config.link_columns, checked: entries without a label or a page are left out; at most 10. */
export function linkColumnsOf(r: Region): LinkColumn[] {
  const list = r.config?.link_columns;
  if (!Array.isArray(list)) return [];
  const out: LinkColumn[] = [];
  for (const x of list.slice(0, 10)) {
    if (!x || typeof x !== 'object') continue;
    const page = pageOf(x.page);
    const label = typeof x.label === 'string' ? x.label.trim().slice(0, 200) : '';
    if (!page || !label) continue;
    const style = (LINK_STYLES as readonly string[]).includes(x.style) ? (x.style as LinkStyle) : 'link';
    const ic = typeof x.icon === 'string' && isIcon(x.icon) ? x.icon : null;
    out.push({
      label,
      page,
      items: itemsOf(x.items),
      style: style === 'icon' && !ic ? 'link' : style,
      icon: ic,
      heading: typeof x.heading === 'string' ? x.heading.slice(0, 200) : label.replace(/#[A-Za-z0-9_$]+#/g, '').trim(),
      position: x.position === 'start' ? 'start' : 'end',
      after: typeof x.after === 'string' && COLUMN.test(x.after) ? x.after.toLowerCase() : null,
      when: typeof x.when === 'string' && COLUMN.test(x.when) ? x.when.toLowerCase() : null,
      otherwise: x.else === 'text' ? 'text' : null,
    });
  }
  return out;
}

/** config.row_actions of a report: an edit link and other links (a grid's duplicate and delete don't apply). */
export function reportRowActionsOf(r: Region): { edit: RowLink | null; links: RowLink[]; label: string | null; hot: boolean } | null {
  const ra = r.config?.row_actions;
  if (!ra || typeof ra !== 'object' || Array.isArray(ra)) return null;
  const link = (x: any): RowLink | null => {
    const page = x && typeof x === 'object' ? pageOf(x.page) : null;
    return page ? { label: typeof x.label === 'string' && x.label.trim() ? x.label.trim().slice(0, 200) : null, page, items: itemsOf(x.items) } : null;
  };
  const links = (Array.isArray(ra.links) ? ra.links : []).slice(0, 10).map(link).filter((x: RowLink | null): x is RowLink => !!x?.label);
  const edit = link(ra.edit);
  const label = typeof ra.label === 'string' && ra.label.trim() ? ra.label.trim().slice(0, 100) : null;
  return edit || links.length ? { edit, links, label, hot: ra.style === 'hot' } : null;
}

/** A row value as true: not null, false, '', 'N', 'n', '0' or 'f'. */
const truthy = (v: unknown) => !(v === null || v === undefined || v === false || ['', 'n', 'N', '0', 'f', 'false'].includes(String(v).trim()));

const STYLE_CLASS: Record<LinkStyle, string | null> = {
  link: null,
  button: 'btn btn-small',
  hot: 'btn btn-small btn-hot',
  danger: 'btn btn-small btn-danger',
  icon: 'link-icon',
};

export interface ReportLinks {
  /** cells before and after the report's own columns (link columns, row actions), and between them ("after") */
  lead: number;
  trail: number;
  mid: number;
  headLead: Raw[];
  headTrail: Raw[];
  rowLead(row: unknown[], rowNo: number): Raw[];
  rowTrail(row: unknown[]): Raw[];
  /** empty cells in an aggregate row */
  blankLead: Raw[];
  blankTrail: Raw[];
  /** the heading, cells and empty aggregate cells of the link columns placed after this column of the report */
  headAfter(column: string): Raw[];
  rowAfter(column: string, row: unknown[]): Raw[];
  blankAfter(column: string): Raw[];
  /** (classic report templates) the row's links side by side */
  linksOf(row: unknown[]): Raw | '';
}

/**
 * The link columns and row actions of a report region, for the user and the query's columns. `text(row, column)` is a
 * row's value as text (undefined: no such column), as config.link fills #column#. `shown` are the report's columns on
 * screen: a link column "after" one of them goes there.
 */
export async function reportLinks(ctx: PageContext, r: Region, text: (row: unknown[], column: string) => string | undefined,
  raw0: (row: unknown[], column: string) => unknown, shown: string[] = []): Promise<ReportLinks> {
  const t = ctx.locale.t;
  const tr = ctx.locale.tr;
  const allowed = new Map<number, boolean>();
  const may = async (page: number) => {
    if (!allowed.has(page)) allowed.set(page, await pageAllowed(ctx, page));
    return allowed.get(page)!;
  };
  const cols: LinkColumn[] = [];
  for (const c of linkColumnsOf(r)) if (await may(c.page)) cols.push(c);
  const ra = reportRowActionsOf(r);
  const edit = ra?.edit && (await may(ra.edit.page)) ? ra.edit : null;
  const extra: RowLink[] = [];
  for (const l of ra?.links ?? []) if (await may(l.page)) extra.push(l);
  const actions = edit || extra.length;

  const fill = (row: unknown[], s: string) => s.replace(/#([A-Za-z0-9_$]+)#/g, (m, col: string) => text(row, col) ?? m);
  const itemsFor = (row: unknown[], items: Record<string, string>) => fillItems(items, (col) => text(row, col));

  const anchor = (c: LinkColumn, row: unknown[]) => {
    const label = fill(row, tr(c.label));
    const cls = STYLE_CLASS[c.style];
    const ic = c.icon ? icon(c.icon) : '';
    if (c.style === 'icon')
      return html`<a ${linkAttrs(ctx, c.page, itemsFor(row, c.items))} class="${cls}" aria-label="${label}" title="${label}">${ic}</a>`;
    return html`<a ${linkAttrs(ctx, c.page, itemsFor(row, c.items))}${cls ? raw(` class="${cls}"`) : ''}>${ic}${ic ? ' ' : ''}${label}</a>`;
  };
  const visible = (c: LinkColumn, row: unknown[]) => !c.when || truthy(raw0(row, c.when));
  const heading = (c: LinkColumn) => tr(c.heading);
  const cellOf = (c: LinkColumn, row: unknown[]) =>
    html`<td class="link-col link-col-${c.style}" data-label="${heading(c)}">${
      visible(c, row) ? anchor(c, row) : c.otherwise === 'text' ? html`<span class="link-col-text">${fill(row, tr(c.label))}</span>` : ''}</td>`;
  const headOf = (c: LinkColumn) =>
    c.style === 'icon' || !c.heading
      ? html`<th scope="col" class="link-col" aria-label="${heading(c) || tr(c.label)}"></th>`
      : html`<th scope="col" class="link-col">${heading(c)}</th>`;
  const onScreen = new Set(shown.map((c) => c.toLowerCase()));
  const placed = (c: LinkColumn) => !!c.after && onScreen.has(c.after);
  const start = cols.filter((c) => !placed(c) && c.position === 'start');
  const end = cols.filter((c) => !placed(c) && c.position === 'end');
  const afterOf = (column: string) => cols.filter((c) => placed(c) && c.after === column.toLowerCase());

  const menu = (row: unknown[], rowNo: number) =>
    html`<td class="row-actions" data-label="${t('grid.row_actions')}"><details class="menu row-menu">
      ${ra?.label
        ? html`<summary class="btn btn-small${ra.hot ? ' btn-hot' : ''}" aria-label="${fill(row, tr(ra.label))} (${t('grid.row_actions_for', { row: rowNo })})">${fill(row, tr(ra.label))}</summary>`
        : html`<summary class="btn btn-small${ra?.hot ? ' btn-hot' : ''}" aria-label="${t('grid.row_actions_for', { row: rowNo })}"><span aria-hidden="true">⋮</span></summary>`}
      <div class="menu-panel menu-links">
        ${edit ? html`<a ${linkAttrs(ctx, edit.page, itemsFor(row, edit.items))}>${icon('edit')} ${edit.label ? fill(row, tr(edit.label)) : t('report.edit')}</a>` : ''}
        ${extra.map((l) => html`<a ${linkAttrs(ctx, l.page, itemsFor(row, l.items))}>${fill(row, tr(l.label!))}</a>`)}
      </div></details></td>`;

  const blank = (cls: string) => html`<td class="${cls}"></td>`;
  return {
    lead: (actions ? 1 : 0) + start.length,
    trail: end.length,
    mid: cols.filter(placed).length,
    headLead: [...(actions ? [html`<th scope="col" class="row-actions" aria-label="${t('grid.row_actions')}"></th>`] : []), ...start.map(headOf)],
    headTrail: end.map(headOf),
    rowLead: (row, rowNo) => [...(actions ? [menu(row, rowNo)] : []), ...start.map((c) => cellOf(c, row))],
    rowTrail: (row) => end.map((c) => cellOf(c, row)),
    blankLead: [...(actions ? [blank('row-actions')] : []), ...start.map(() => blank('link-col'))],
    blankTrail: end.map(() => blank('link-col')),
    headAfter: (column) => afterOf(column).map(headOf),
    rowAfter: (column, row) => afterOf(column).map((c) => cellOf(c, row)),
    blankAfter: (column) => afterOf(column).map(() => blank('link-col')),
    linksOf: (row) => {
      const links = cols.filter((c) => visible(c, row)).map((c) => anchor(c, row));
      return links.length ? html`<span class="cr-links">${links}</span>` : '';
    },
  };
}
