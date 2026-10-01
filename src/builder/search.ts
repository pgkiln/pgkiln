import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { COMPONENTS, type FieldKind } from './components.ts';
import { appHeader, BASE, developer, region, send, shell, type Req } from './ui.ts';

// App Builder → Search and "Where used": every component of an application
// (pages, regions, items, buttons, dynamic actions, validations, processes
// and the shared components) as one list of fields, searched as text or
// scanned for references to an item, list of values, authorization scheme,
// page or report layout.

export interface Entry {
  kind: string;
  id: number;
  label: string;
  /** the component kind's name, e.g. "Region" */
  kindLabel: string;
  icon: string;
  pageNo: number | null;
  url: string;
  fields: { name: string; label: string; kind: FieldKind | 'page_no'; value: string }[];
}

export interface Hit {
  entry: Entry;
  field: string;
  snippet: Raw;
}

const TEXT_KINDS = new Set<string>(['text', 'code', 'json', 'select', 'upper', 'textarea', 'list', 'authz', 'page', 'icon']);
const PAGE_FIELDS = [
  { name: 'name', label: 'Name', kind: 'text' as const },
  { name: 'title', label: 'Title', kind: 'text' as const },
  { name: 'parent_page', label: 'Breadcrumb parent', kind: 'page' as const },
  { name: 'authz', label: 'Authorization', kind: 'authz' as const },
];

const asText = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Every component of an application with its searchable fields. */
export async function appEntries(appId: number): Promise<Entry[]> {
  const pages = (await owner.query('select * from meta.page where app_id = $1 order by page_no', [appId])).rows;
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const out: Entry[] = pages.map((p) => ({
    kind: 'page', id: p.id, label: `Page ${p.page_no}: ${p.name}`, kindLabel: 'Page', icon: 'file', pageNo: p.page_no,
    url: `${BASE}/pages/${p.id}?c=page`,
    fields: PAGE_FIELDS.map((f) => ({ ...f, value: asText(p[f.name]) })),
  }));
  for (const [kind, spec] of Object.entries(COMPONENTS)) {
    const rows = spec.scope === 'page'
      ? (await owner.query(`select t.* from ${spec.table} t join meta.page p on p.id = t.page_id where p.app_id = $1 order by p.page_no, t.seq, t.id`, [appId])).rows
      : (await owner.query(`select * from ${spec.table} where app_id = $1 order by id`, [appId])).rows;
    for (const row of rows) {
      const page = spec.scope === 'page' ? pageById.get(row.page_id) : null;
      out.push({
        kind, id: row.id, label: spec.summary(row), kindLabel: spec.label, icon: spec.icon, pageNo: page?.page_no ?? null,
        url: page ? `${BASE}/pages/${page.id}?c=${kind}-${row.id}` : `${BASE}/apps/${appId}/shared?c=${kind}-${row.id}`,
        fields: spec.fields.filter((f) => TEXT_KINDS.has(f.kind)).map((f) => ({ name: f.name, label: f.label, kind: f.kind, value: asText(row[f.name]) })),
      });
    }
  }
  return out;
}

/** The text around a match, with the match marked (all of it escaped). */
function snippet(value: string, start: number, length: number): Raw {
  const from = Math.max(0, start - 50);
  const to = Math.min(value.length, start + length + 50);
  return html`${from > 0 ? '…' : ''}${value.slice(from, start)}<mark>${value.slice(start, start + length)}</mark>${value.slice(start + length, to)}${to < value.length ? '…' : ''}`;
}

/** Plain text search, case-insensitive, over every field. */
export function search(entries: Entry[], q: string, limit = 500): Hit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: Hit[] = [];
  for (const entry of entries)
    for (const f of entry.fields) {
      const i = f.value.toLowerCase().indexOf(needle);
      if (i >= 0) {
        hits.push({ entry, field: f.label, snippet: snippet(f.value, i, needle.length) });
        if (hits.length >= limit) return hits;
      }
    }
  return hits;
}

export type Target =
  | { type: 'item'; name: string }
  | { type: 'lov'; name: string }
  | { type: 'authz'; name: string }
  | { type: 'page'; pageNo: number }
  | { type: 'layout'; name: string }
  | { type: 'document'; name: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The components that refer to a target: item names as whole words in SQL,
 * substitutions, links and settings (:P3_ID, &P3_ID., "P3_ID", v('P3_ID'));
 * LOV:NAME; authorization fields and "public_reports"; target and parent
 * pages, "page": n in settings and meta.page_url(n, …); "layout": "NAME".
 */
export function whereUsed(entries: Entry[], target: Target, self?: { kind: string; id: number }): Hit[] {
  const hits: Hit[] = [];
  const add = (entry: Entry, field: string, value: string, m: RegExpExecArray | null) => {
    if (m) hits.push({ entry, field, snippet: snippet(value, m.index, m[0].length) });
  };
  for (const entry of entries) {
    if (self && entry.kind === self.kind && entry.id === self.id) continue;
    for (const f of entry.fields) {
      if (!f.value) continue;
      switch (target.type) {
        case 'item':
          add(entry, f.label, f.value, new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(target.name)}(?![A-Za-z0-9_$])`, 'i').exec(f.value));
          break;
        case 'lov':
          add(entry, f.label, f.value, new RegExp(`LOV:${escapeRe(target.name)}(?![A-Za-z0-9_])`, 'i').exec(f.value));
          break;
        case 'authz':
          if (f.kind === 'authz') add(entry, f.label, f.value, f.value.replace(/^!/, '') === target.name ? /.+/.exec(f.value) : null);
          else if (f.kind === 'json') add(entry, f.label, f.value, new RegExp(`"public_reports"\\s*:\\s*"${escapeRe(target.name)}"`).exec(f.value));
          break;
        case 'page':
          if (f.kind === 'page') add(entry, f.label, f.value, f.value === String(target.pageNo) ? /.+/.exec(f.value) : null);
          else if (f.kind === 'json') add(entry, f.label, f.value, new RegExp(`"page"\\s*:\\s*${target.pageNo}(?![0-9])`).exec(f.value));
          else if (f.kind === 'code') add(entry, f.label, f.value, new RegExp(`page_url\\s*\\(\\s*${target.pageNo}(?![0-9])`, 'i').exec(f.value));
          break;
        case 'layout':
          if (f.kind === 'json') add(entry, f.label, f.value, new RegExp(`"layout"\\s*:\\s*"${escapeRe(target.name)}"`, 'i').exec(f.value));
          else if (entry.kind === 'document_template' && f.name === 'layout') add(entry, f.label, f.value, f.value.toUpperCase() === target.name.toUpperCase() ? /.+/.exec(f.value) : null);
          break;
        case 'document':
          if (entry.kind === 'button' && f.name === 'document') add(entry, f.label, f.value, f.value.toUpperCase() === target.name.toUpperCase() ? /.+/.exec(f.value) : null);
          else add(entry, f.label, f.value, new RegExp(`[?&"]doc=${escapeRe(target.name)}(?![A-Za-z0-9_])`, 'i').exec(f.value));
          break;
      }
    }
  }
  return hits;
}

/** The target a component can be "used" as, if any. */
export function targetOf(kind: string, row: any): Target | null {
  if ((kind === 'item' || kind === 'app_item') && row?.name) return { type: 'item', name: row.name };
  if (kind === 'lov' && row?.name) return { type: 'lov', name: row.name };
  if (kind === 'authz_scheme' && row?.name) return { type: 'authz', name: row.name };
  if (kind === 'report_layout' && row?.name) return { type: 'layout', name: row.name };
  if (kind === 'document_template' && row?.name) return { type: 'document', name: row.name };
  if (kind === 'page' && row?.page_no !== undefined) return { type: 'page', pageNo: Number(row.page_no) };
  return null;
}

function hitList(hits: Hit[], showPage = true) {
  return html`<ul class="hits">${hits.map((h) => html`<li>
      <a href="${h.entry.url}">${icon(h.entry.icon)}<span>${h.entry.kindLabel}: ${h.entry.label}</span></a>
      ${showPage && h.entry.pageNo !== null && h.entry.kind !== 'page' ? html`<span class="tag">page ${h.entry.pageNo}</span>` : ''}
      <span class="muted">${h.field}</span>
      <code class="hit-snippet">${h.snippet}</code>
    </li>`)}</ul>`;
}

/** The "Used in" panel under a component in the page designer and shared components. */
export async function usedInPanel(appId: number, kind: string, row: any): Promise<Raw | ''> {
  const target = targetOf(kind, row);
  if (!target) return '';
  const hits = whereUsed(await appEntries(appId), target, { kind, id: row.id });
  return html`<section class="used-in" aria-labelledby="used-in-${kind}-${row.id}">
    <h3 id="used-in-${kind}-${row.id}">Used in (${hits.length})</h3>
    ${hits.length ? hitList(hits) : html`<p class="muted">Not referenced anywhere in this application${target.type === 'item' ? ' (outside its own definition)' : ''}.</p>`}
    ${target.type === 'item' || target.type === 'page' ? html`<p class="muted small">Found in SQL, substitutions, links and settings of this application. Database code (views, functions, policies) isn't searched.</p>` : ''}
  </section>`;
}

export async function searchRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/search`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = /^\d+$/.test(req.params.id) ? await owner.one('select * from meta.app where id = $1', [req.params.id]) : undefined;
    if (!a) return reply.code(404).send('Not found');
    const q = String(req.query.q ?? '').slice(0, 200);
    const hits = q.trim() ? search(await appEntries(a.id), q) : [];
    const groups = new Map<string, Hit[]>();
    for (const h of hits) groups.set(h.entry.kindLabel, [...(groups.get(h.entry.kindLabel) ?? []), h]);
    const main = html`${appHeader(a, 'search')}
      ${region('Search', html`<form method="get" action="${BASE}/apps/${a.id}/search" class="search u-mwnone" role="search">
          <input type="search" name="q" value="${q}" placeholder="Text in names, titles, SQL, settings…" aria-label="Search the application" autofocus>
          <button class="btn btn-hot">Search</button></form>
        ${q.trim()
          ? hits.length
            ? html`<p class="muted">${hits.length}${hits.length >= 500 ? '+' : ''} matches</p>
                ${[...groups].map(([label, list]) => html`<h3>${label} (${list.length})</h3>${hitList(list)}`)}`
            : html`<p class="muted">Nothing found for “${q}”.</p>`
          : html`<p class="muted">Searches every page and component of ${a.name}: names, titles, SQL, conditions, settings and help texts.</p>`}`)}`;
    return send(reply, s, shell(s, `Search · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Search']], main));
  });
}

