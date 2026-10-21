import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, designerUrl, developer, flash, send, shell, type Req } from './ui.ts';
import { SQL_TOOLS, TOOL_GROUPS, toolDescription, toolLabel } from './sql-tools.ts';
import { tr } from './i18n.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { currentWorkspace, inWorkspaceSql, workshopDb } from './workspaces.ts';
import { isAdmin } from './locks.ts';

// (sprint 96, Database Actions DA-15) The SQL Workshop's Launchpad and the builder's search.
//  - The home page starts with Pinned (per developer and workspace, meta.builder_pin) and Recently visited (kept
//    in the browser by public/palette.js), then the tools in tabs: Development, Administration, Monitoring, each
//    with a line of description and a pin.
//  - POST /builder/pins pins or unpins a builder page (a tool, an object, a saved worksheet).
//  - GET /builder/palette?q= finds tools, applications, pages and database objects (tables, views, functions) by
//    name: JSON for the Ctrl+K search, or a page of results without JavaScript (the header's search field).

const MAX_PINS = 24;
const HREF_RE = /^\/builder\/[A-Za-z0-9/_\-.~%]*(\?[A-Za-z0-9_\-.~%=&+]*)?$/;

export interface Pin { href: string; label: string; icon: string }

export async function pinsOf(s: Session): Promise<Pin[]> {
  return (await owner.query<Pin>(`select href, label, icon from meta.builder_pin where username = $1 and workspace_id = $2 order by at`, [s.username, currentWorkspace(s)])).rows;
}

/** A pin toggle (a small form): pinned → unpin, else pin. */
export function pinButton(s: Session, p: Pin, pinned: boolean, backTo: string): Raw {
  const tx = tr(s);
  return html`<form method="post" action="${BASE}/pins" class="pin-form">${csrf(s)}
    <input type="hidden" name="href" value="${p.href}"><input type="hidden" name="label" value="${p.label}"><input type="hidden" name="icon" value="${p.icon}">
    <input type="hidden" name="pin" value="${pinned ? '0' : '1'}"><input type="hidden" name="back" value="${backTo}">
    <button class="pin-btn${pinned ? ' is-pinned' : ''}" title="${tx(pinned ? 'sw.unpin' : 'sw.pin_title')}" aria-pressed="${pinned ? 'true' : 'false'}">${icon('pin')}<span class="sr-only">${tx(pinned ? 'sw.unpin_what' : 'sw.pin_what', { what: p.label })}</span></button></form>`;
}

/** The Launchpad part of the SQL Workshop home. */
export async function launchpad(s: Session, admin: boolean): Promise<Raw> {
  const pins = await pinsOf(s);
  const pinned = new Set(pins.map((p) => p.href));
  const tools = SQL_TOOLS.filter((t) => admin || !t.admin);
  const tx = tr(s);
  // a pin keeps the tool's English name (pins are stored with their label); the card shows it in the builder's language
  const card = (t: (typeof SQL_TOOLS)[number]) => html`<li class="lp-tool">
    <a href="${t.href}">${icon(t.icon)}<span><strong>${toolLabel(tx, t)}</strong><small class="muted">${toolDescription(tx, t)}</small></span></a>
    ${pinButton(s, { href: t.href, label: t.label, icon: t.icon }, pinned.has(t.href), `${BASE}/sql`)}</li>`;
  const group = (g: string, label: string) => tx.dyn(`sql.group.${g}`, label);
  return html`<section class="lp-pins" aria-labelledby="lp-pins-title">
      <h2 id="lp-pins-title">${tx('sw.pinned')}</h2>
      ${pins.length ? html`<ul class="lp-chips">${pins.map((p) => html`<li><a href="${p.href}">${icon(p.icon)}<span>${p.label}</span></a>${pinButton(s, p, true, `${BASE}/sql`)}</li>`)}</ul>`
        : html`<p class="muted small">${tx.rich('sw.pin_hint', { pin: icon('pin') })}</p>`}
      <ul class="lp-chips lp-recent" data-lp-recent aria-label="${tx('sw.recent')}" hidden></ul>
    </section>
    <div class="lp-groups">
      <div class="lp-tabs" role="tablist" aria-label="${tx('wh.tools')}" hidden>${TOOL_GROUPS.map(([g, label], i) => html`<button type="button" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}" aria-controls="lp-${g}" data-lp-tab="${g}">${group(g, label)}</button>`)}</div>
      ${TOOL_GROUPS.map(([g, label]) => html`<section class="lp-group" id="lp-${g}" data-lp-group="${g}" aria-label="${group(g, label)}"><h2>${group(g, label)}</h2><ul class="lp-list">${tools.filter((t) => t.group === g).map(card)}</ul></section>`)}
    </div>`;
}

interface Result { kind: string; label: string; detail: string; href: string; icon: string }

/** What the builder's search finds for `q`. */
async function search(s: Session, q: string, admin: boolean): Promise<Result[]> {
  const needle = q.toLowerCase();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const out: Result[] = SQL_TOOLS.filter((t) => (admin || !t.admin) && `${t.label} ${t.description}`.toLowerCase().includes(needle))
    .map((t) => ({ kind: 'Tool', label: t.label, detail: t.description, href: t.href, icon: t.icon }));
  const ws = currentWorkspace(s);
  const apps = (await owner.query<{ id: number; name: string; alias: string }>(
    `select a.id, a.name, a.alias from meta.app a where ${inWorkspaceSql('a', 1)} and (a.name ilike $2 or a.alias ilike $2) order by a.name limit 8`, [ws, like])).rows;
  out.push(...apps.map((a) => ({ kind: 'Application', label: a.name, detail: a.alias, href: `${BASE}/apps/${a.id}`, icon: 'grid' })));
  const pages = (await owner.query<{ app_id: number; page_no: number; name: string; app: string }>(
    `select p.app_id, p.page_no, p.name, a.name as app from meta.page p join meta.app a on a.id = p.app_id
      where ${inWorkspaceSql('a', 1)} and (p.name ilike $2 or p.page_no::text = $3) order by a.name, p.page_no limit 12`, [ws, like, q.trim()])).rows;
  out.push(...pages.map((p) => ({ kind: 'Page', label: `${p.page_no}: ${p.name}`, detail: p.app, href: designerUrl(p.app_id, p.page_no), icon: 'file' })));
  // a workspace without the SQL Workshop (its preference) finds no database objects
  if (s.workspace?.sql_workshop === false) return out.filter((r) => r.kind !== 'Tool' || !r.href.startsWith(`${BASE}/sql`)).slice(0, 40);
  const db = await workshopDb(s);
  const objects = (await db.query<{ k: string; schema: string; name: string; ref: string }>(
    `select * from (
       select case c.relkind when 'v' then 'view' when 'm' then 'matview' else 'table' end as k, n.nspname as schema, c.relname as name, c.oid::regclass::text as ref
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition and c.relname ilike $1
       union all
       select case p.prokind when 'p' then 'procedure' else 'function' end, n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.oid::regprocedure::text
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind in ('f', 'p') and p.proname ilike $1
     ) x join pg_namespace n on n.nspname = x.schema
     where x.schema !~ '^pg_' and x.schema <> 'information_schema' and not (x.schema = any ($2)) and has_schema_privilege(n.oid, 'USAGE')
       and not exists (select 1 from pg_extension e join pg_depend d on d.refobjid = e.oid and d.deptype = 'e' where d.objid = case when x.k in ('function', 'procedure') then x.ref::regprocedure::oid else x.ref::regclass::oid end)
     order by length(x.name), x.name limit 15`, [like, SYSTEM_SCHEMAS]).catch(() => ({ rows: [] }))).rows;
  const KIND: Record<string, [string, string]> = { table: ['Table', 'table'], view: ['View', 'layers'], matview: ['Materialized view', 'layers'], function: ['Function', 'code'], procedure: ['Procedure', 'code'] };
  out.push(...objects.map((o) => ({ kind: KIND[o.k][0], label: o.name, detail: o.schema, href: `${BASE}/sql/objects?${new URLSearchParams({ schema: o.schema, k: o.k, o: o.ref })}`, icon: KIND[o.k][1] })));
  return out.slice(0, 40);
}

export async function launchpadRoutes(app: FastifyInstance) {
  app.post(`${BASE}/pins`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const href = String(b.href ?? b.pin_href ?? '');
    const label = String(b.label ?? b.pin_label ?? '').trim().slice(0, 120);
    const ic = /^[a-z0-9-]{1,40}$/.test(String(b.icon ?? '')) ? String(b.icon) : b.pin_href ? 'code' : 'bookmark';
    const backTo = HREF_RE.test(String(b.back ?? '')) ? String(b.back) : `${BASE}/sql`;
    if (!HREF_RE.test(href) || href.length > 400 || !label) return reply.code(400).send('Not a builder page');
    const ws = currentWorkspace(s);
    if (String(b.pin ?? '1') === '0') {
      await owner.query('delete from meta.builder_pin where username = $1 and workspace_id = $2 and href = $3', [s.username, ws, href]);
      flash(s, `Unpinned ${label}.`);
    } else {
      const n = Number((await owner.one<{ n: string }>('select count(*) as n from meta.builder_pin where username = $1 and workspace_id = $2', [s.username, ws]))?.n ?? 0);
      if (n >= MAX_PINS) flash(s, `At most ${MAX_PINS} pins: unpin one first.`, 'error');
      else {
        await owner.query(
          `insert into meta.builder_pin (username, workspace_id, href, label, icon) values ($1, $2, $3, $4, $5)
           on conflict (username, workspace_id, href) do update set label = excluded.label, icon = excluded.icon`, [s.username, ws, href, label, ic]);
        flash(s, `Pinned ${label} to the SQL Workshop home.`);
      }
    }
    return back(reply, s, backTo);
  });

  app.get(`${BASE}/palette`, async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = String(req.query?.q ?? '').trim().slice(0, 100);
    const admin = await isAdmin(s.username);
    const results = q ? await search(s, q, admin) : [];
    if (req.query?.format === 'json') return reply.header('Cache-Control', 'private, no-store').send({ q, results });
    const main = html`<h1 class="u-mb1">Search</h1>
      <form method="get" action="${BASE}/palette" class="search u-mb1" role="search"><label class="sr-only" for="pal-q">Search</label>
        <input id="pal-q" name="q" type="search" value="${q}" placeholder="Tables, views, functions, applications, pages, tools" autofocus><button class="btn">${icon('search')} Search</button></form>
      ${q ? results.length ? html`<ul class="pal-results">${results.map((r) => html`<li><a href="${r.href}">${icon(r.icon)}<span><strong>${r.label}</strong> <small class="muted">${r.kind} · ${r.detail}</small></span></a></li>`)}</ul>`
        : html`<p class="muted">Nothing found for “${q}”.</p>` : html`<p class="muted">Search by name. Ctrl+K opens this search on every builder page.</p>`}`;
    return send(reply, s, shell(s, 'Search', [['Search']], main, 'apps'));
  });
}

/** For pages that show a pin for themselves (an object, a worksheet). */
export async function isPinned(s: Session, href: string) {
  return !!(await owner.one('select 1 as ok from meta.builder_pin where username = $1 and workspace_id = $2 and href = $3', [s.username, currentWorkspace(s), href]));
}
