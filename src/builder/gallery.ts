import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { owner, ownerUrl, type Client } from '../db.ts';
import { root } from '../env.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { migrate } from '../migrate.ts';
import { clientIp, logActivity } from '../session.ts';
import { openBlueprint } from './blueprints.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, pageHeader, send, shell, type Req } from './ui.ts';
import { currentWorkspace, inWorkspaceSql, placeApp } from './workspaces.ts';
import { workspacesChanged } from '../workspace-db.ts';
import { scopedTx as tx, type BuilderKey } from './i18n.ts';

// The App Gallery (sprint 61, sprint 120; APEX: App Gallery with Sample, Starter, Utility and
// Custom Apps).
//
//   Sample apps   applications shipped with pgkiln: an administrator installs one with its
//                 schema, data and demo account, either an example directory (`example`, as
//                 `pgkiln migrate --example`) or one SQL file (`file`: examples/*.sql or
//                 examples/gallery/samples/*.sql, run in one transaction as the owner);
//   Starter apps  blueprints shipped with pgkiln (examples/gallery/starters/): Install opens
//                 the blueprint's review, and the developer creates the application from it
//                 in the current workspace (a new role and schema, like every new application);
//   Utility apps  (sprint 120) blueprints too (examples/gallery/utilities/), of applications a
//                 workspace uses rather than learns from, installed the same way;
//   Custom apps   the workspace's boilerplate applications: Create application starts from one.
//
// The list is examples/gallery/gallery.json; requests only ever name a key of it.

interface Sample {
  key: string;
  title: string;
  alias: string;
  icon: string;
  description: string;
  example?: string;
  file?: string;
}
interface Starter {
  key: string;
  title: string;
  icon: string;
  description: string;
  file: string;
}

const GALLERY = join(root, 'examples', 'gallery');
const KEY = /^[a-z][a-z0-9-]{0,40}$/;

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);

function catalog(): { samples: Sample[]; starters: Starter[]; utilities: Starter[] } {
  try {
    const c = JSON.parse(readFileSync(join(GALLERY, 'gallery.json'), 'utf8'));
    return { samples: list(c.samples), starters: list(c.starters), utilities: list(c.utilities) };
  } catch {
    return { samples: [], starters: [], utilities: [] };
  }
}

/** The blueprint files a kind of entry may name: starters/x.json or utilities/x.json. */
const BLUEPRINT_FILE = { starters: /^starters\/[a-z0-9-]+\.json$/, utilities: /^utilities\/[a-z0-9-]+\.json$/ } as const;
/** The SQL files a sample may name: examples/x.sql or examples/gallery/samples/x.sql. */
const SAMPLE_FILE = /^(samples\/)?[a-z0-9-]+\.sql$/;

/** A file of the gallery: only names from the catalogue, never a path from the request. */
const galleryFile = (rel: string) => readFileSync(join(rel.includes('/') ? GALLERY : join(root, 'examples'), rel), 'utf8');

type Tab = 'samples' | 'starters' | 'utilities' | 'custom';
const TABS: readonly [Tab, BuilderKey][] = [['samples', 'gal.tab.samples'], ['starters', 'gal.tab.starters'], ['utilities', 'gal.tab.utilities'], ['custom', 'gal.tab.custom']];

export async function galleryRoutes(app: FastifyInstance) {
  app.get(`${BASE}/gallery`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tab: Tab = TABS.map(([t]) => t).find((t) => t === req.query?.tab) ?? 'samples';
    const q = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const admin = await isAdmin(s.username);
    const ws = currentWorkspace(s);
    const { samples, starters, utilities } = catalog();
    // an installed sample: Edit only in its own workspace
    const installed = new Map(
      (await owner.query<{ alias: string; id: number; here: boolean }>(`select a.alias, a.id, ${inWorkspaceSql('a', 2)} as here from meta.app a where a.alias = any($1)`,
        [samples.map((x) => x.alias), ws])).rows.map((r) => [r.alias, r]),
    );
    const custom = (await owner.query<{ id: number; name: string; description: string | null }>(
      `select a.id, a.name, null::text as description from meta.app a where a.app_type = 'boilerplate' and ${inWorkspaceSql('a', 1)} order by lower(a.name), a.id`,
      [ws],
    )).rows;
    // (sprint 120) the search also works without JavaScript: ?q= leaves out what doesn't match
    // (like the script's filter: every word of the search in the title or description)
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (x: { title?: string; name?: string; description?: string | null }) => {
      const text = `${x.title ?? x.name ?? ''} ${x.description ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    };
    const counts: Record<Tab, number> = { samples: samples.length, starters: starters.length, utilities: utilities.length, custom: custom.length };
    const card = (ic: string, title: string, by: string, text: string, action: unknown) =>
      html`<article class="gal-card" data-filter-row><div class="gal-head"><span class="gal-icon">${icon(ic)}</span><div><h2>${title}</h2><span class="muted small">${by}</span></div></div>
        <p>${text}</p><div class="gal-foot">${action}</div></article>`;
    const tabs = html`<nav class="gal-tabs segmented" aria-label="${tx('gal.kinds')}">${TABS.map(([t, l]) =>
      html`<a href="${BASE}/gallery?tab=${t}${q ? `&q=${encodeURIComponent(q)}` : ''}"${tab === t ? raw(' aria-current="page"') : ''}>${tx(l)} <span class="gal-count">${counts[t]}</span></a>`)}</nav>`;
    const blueprintCard = (kind: 'starters' | 'utilities') => (x: Starter) => card(x.icon, x.title, 'pgkiln', x.description,
      html`<form method="post" action="${BASE}/gallery/${kind}/${x.key}">${csrf(s)}<button class="btn btn-sm">${tx('gal.install')}</button></form>`);
    const cards =
      tab === 'samples'
        ? samples.filter(matches).map((x) => {
            const it = installed.get(x.alias);
            return card(x.icon, x.title, 'pgkiln', x.description,
              it
                ? html`<span class="tag tag-ok">${tx('gal.installed')}</span><a class="btn btn-sm" href="/a/${x.alias}" target="_blank" rel="noopener">${tx('common.run')}</a>${it.here
                    ? html`<a class="btn btn-sm" href="${BASE}/apps/${it.id}">${tx('gal.edit')}</a>`
                    : html`<span class="muted small">${tx('gal.other_workspace')}</span>`}`
                : admin
                  ? html`<form method="post" action="${BASE}/gallery/samples/${x.key}">${csrf(s)}<button class="btn btn-sm" data-confirm="${tx('gal.confirm_install', { title: x.title })}">${tx('gal.install')}</button></form>`
                  : html`<span class="muted small">${tx('gal.admin_installs')}</span>`);
          })
        : tab === 'starters' || tab === 'utilities'
          ? (tab === 'starters' ? starters : utilities).filter(matches).map(blueprintCard(tab))
          : custom.filter(matches).map((x) => card('copy', x.name, tx('gal.this_workspace'), x.description ?? tx('gal.boilerplate_desc'),
              html`<a class="btn btn-sm" href="${BASE}/create?boilerplate=${x.id}">${tx('gal.create_from')}</a><a class="btn btn-sm" href="${BASE}/apps/${x.id}">${tx('gal.edit')}</a>`));
    const empty = q && counts[tab]
      ? html`<p class="muted">${tx.rich('gal.no_match', { q: html`<strong>${q}</strong>` })} <a href="${BASE}/gallery?tab=${tab}">${tx('gal.show_all')}</a></p>`
      : tab === 'custom'
        ? html`<p class="muted">${tx.rich('gal.no_custom', { type: html`<em>${tx('gal.boilerplate')}</em>` })}</p>`
        : html`<p class="muted">${tx('gal.empty')}</p>`;
    const intro = tx(({ samples: 'gal.intro.samples', starters: 'gal.intro.starters', utilities: 'gal.intro.utilities', custom: 'gal.intro.custom' } as const)[tab]);
    const main = html`<div class="gal">
      ${pageHeader(tx('rail.gallery'))}
      <div class="gal-bar">
        <form class="ab-search gal-search" role="search" method="get" action="${BASE}/gallery"><label class="sr-only" for="gal-q">${tx('gal.search')}</label>${icon('search')}
          <input type="hidden" name="tab" value="${tab}">
          <input id="gal-q" name="q" type="search" placeholder="${tx('gal.search')}" autocomplete="off" value="${q}" data-filter-list=".gal [data-filter-row]"></form>
        ${tabs}
      </div>
      <p class="muted">${intro}</p>
      ${cards.length ? html`<div class="gal-grid">${cards}</div>` : empty}
    </div>`;
    return send(reply, s, shell(s, tx('rail.gallery'), [[tx('rail.gallery')]], main, 'gallery'));
  });

  // a sample app: an administrator installs it (shipped SQL, run as the owner)
  app.post(`${BASE}/gallery/samples/:key`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators install sample apps.');
    const x = KEY.test(req.params.key) ? catalog().samples.find((c) => c.key === req.params.key) : undefined;
    if (!x) return reply.code(404).send('Not found');
    try {
      if (await owner.one('select 1 as ok from meta.app where alias = $1', [x.alias])) throw new Error(tx('gal.err_alias', { alias: x.alias }));
      const ws = currentWorkspace(s);
      // into the current workspace (an isolated one gets the application's role too)
      const place = async (c: Client) => {
        const made = (await c.query('select id, db_role from meta.app where alias = $1', [x.alias])).rows[0] as { id: number; db_role: string | null } | undefined;
        if (!made) throw new Error(tx('gal.err_no_app', { alias: x.alias }));
        if (ws > 1) {
          if (made.db_role && (await c.query('select 1 from meta.workspace where id = $1 and isolated', [ws])).rowCount)
            await c.query('insert into meta.workspace_role (workspace_id, role_name) values ($1, $2) on conflict do nothing', [ws, made.db_role]);
          await placeApp(c, made.id, ws);
        }
        return made;
      };
      let made: { id: number; db_role: string | null };
      if (x.example && KEY.test(x.example)) {
        await migrate({ root, databaseUrl: ownerUrl, example: x.example, log: () => {} });
        made = await owner.tx(place);
      } else if (x.file && SAMPLE_FILE.test(x.file)) {
        // (sprint 120) the file and the placement in one transaction: a failing script leaves nothing behind
        const sql = galleryFile(x.file);
        made = await owner.tx(async (c) => {
          await c.query(sql);
          return place(c);
        });
      } else throw new Error(tx('gal.err_nothing'));
      await workspacesChanged();
      await logActivity({ appId: made.id, username: s.username, event: 'gallery', ip: clientIp(req), detail: `installed sample app ${x.key}` });
      flash(s, tx('gal.installed_flash', { title: x.title, alias: x.alias }));
      return back(reply, s, `${BASE}/apps/${made.id}`);
    } catch (e) {
      flash(s, tx('gal.not_installed', { title: x.title, message: (e as Error).message }), 'error');
      return back(reply, s, `${BASE}/gallery`);
    }
  });

  // a starter or utility app: its blueprint's review (nothing is created before the developer confirms there)
  for (const kind of ['starters', 'utilities'] as const)
    app.post(`${BASE}/gallery/${kind}/:key`, async (req: Req, reply) => {
      const s = await developer(req, reply);
      if (!s) return;
      const x = KEY.test(req.params.key) ? catalog()[kind].find((c) => c.key === req.params.key) : undefined;
      if (!x || typeof x.file !== 'string' || !BLUEPRINT_FILE[kind].test(x.file)) return reply.code(404).send('Not found');
      return openBlueprint(s, reply, x.title, JSON.stringify(JSON.parse(galleryFile(x.file)), null, 2));
    });
}
