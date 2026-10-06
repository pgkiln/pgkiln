import { applyBinds } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { linkAttrs } from './links.ts';

// Tree region (APEX: Tree). The SELECT returns id, parent_id and label
// (optionally icon, and columns for the link); rows whose parent isn't in
// the result are the roots. config:
//   {"link": {"page": 3, "items": {"P3_EMPNO": "#id#"}}, "expanded": 1}
// Drawn on the server with <details>, so it works without script; "expanded"
// levels are open (default 1: the roots).

const MAX_NODES = 5000;

interface Node {
  id: string;
  parent: string | null;
  label: string;
  icon: string | null;
  row: Record<string, unknown>;
  children: Node[];
}

export async function renderTree(ctx: PageContext, r: Region): Promise<Raw> {
  let rows: Record<string, unknown>[];
  try {
    const sql = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
    const c = ctx.client!;
    rows = (await savepoint(c, () => c.query(`select * from (\n${sql}\n) "__t" limit ${MAX_NODES}`))).rows;
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `tree "${r.title ?? r.id}"`)}</div>`;
  }
  if (!rows.length) return html`<p class="empty">${r.config.empty ?? ctx.locale.t('report.no_data')}</p>`;
  const nodes = new Map<string, Node>();
  for (const row of rows) {
    const id = toState(row.id);
    if (id === null || nodes.has(id)) continue;
    nodes.set(id, { id, parent: toState(row.parent_id), label: toState(row.label) ?? id, icon: toState(row.icon), row, children: [] });
  }
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const p = n.parent !== null && n.parent !== n.id ? nodes.get(n.parent) : undefined;
    if (p) p.children.push(n);
    else roots.push(n);
  }
  const link = r.config.link as { page: number; items?: Record<string, string> } | undefined;
  const linkOk = link ? await pageAllowed(ctx, link.page) : false;
  const expanded = Number.isInteger(r.config.expanded) ? Math.max(0, r.config.expanded) : 1;
  const seen = new Set<string>(); // a cycle (a → b → a) is drawn once
  const draw = (n: Node, depth: number): Raw => {
    if (seen.has(n.id)) return html``;
    seen.add(n.id);
    let label: Raw = html`${n.icon ? icon(n.icon) : ''}<span>${n.label}</span>`;
    if (linkOk && link) {
      const items: Record<string, string> = {};
      for (const [k, v] of Object.entries(link.items ?? {}))
        items[k] = v.replace(/#([A-Za-z0-9_]+)#/g, (m, c: string) => {
          const key = Object.keys(n.row).find((x) => x.toLowerCase() === c.toLowerCase());
          return key === undefined ? m : (toState(n.row[key]) ?? '');
        });
      label = html`<a ${linkAttrs(ctx, link.page, items)}>${label}</a>`;
    }
    if (!n.children.length) return html`<li class="tree-leaf">${label}</li>`;
    const open = depth < expanded ? raw(' open') : '';
    const children = html`<ul>${n.children.map((ch) => draw(ch, depth + 1))}</ul>`;
    // a linked branch: the link is a row of its own and the disclosure only toggles (no link inside <summary>)
    if (linkOk && link)
      return html`<li class="tree-branch"><span class="tree-row">${label} <span class="tree-count" aria-hidden="true">${n.children.length}</span></span>
        <details${open}><summary><span class="sr-only">${n.label} (${n.children.length})</span></summary>${children}</details></li>`;
    return html`<li><details${open}><summary>${label} <span class="tree-count">${n.children.length}</span></summary>
      ${children}</details></li>`;
  };
  return html`<ul class="tree-view">${roots.map((n) => draw(n, 0))}</ul>`;
}
