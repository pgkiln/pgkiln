import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { owner, ownerUrl } from '../db.ts';
import { root } from '../env.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { migrate } from '../migrate.ts';
import { clientIp, logActivity } from '../session.ts';
import { openBlueprint } from './blueprints.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, send, shell, type Req } from './ui.ts';
import { currentWorkspace, inWorkspaceSql, placeApp } from './workspaces.ts';
import { workspacesChanged } from '../workspace-db.ts';

// The App Gallery (sprint 61; APEX: App Gallery with Sample, Starter and Custom Apps).
//
//   Sample apps   applications shipped with pgkiln (examples/): an administrator installs
//                 one with its schema, data and demo accounts, as `pgkiln migrate --example`;
//   Starter apps  blueprints shipped with pgkiln (examples/gallery/starters/): Install opens
//                 the blueprint's review, and the developer creates the application from it
//                 in the current workspace (a new role and schema, like every new application);
//   Custom apps   the workspace's boilerplate applications: Create application starts from one.
//
// The list is examples/gallery/gallery.json.

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

function catalog(): { samples: Sample[]; starters: Starter[] } {
  try {
    const c = JSON.parse(readFileSync(join(GALLERY, 'gallery.json'), 'utf8'));
    return { samples: Array.isArray(c.samples) ? c.samples : [], starters: Array.isArray(c.starters) ? c.starters : [] };
  } catch {
    return { samples: [], starters: [] };
  }
}

/** A file of the gallery: only names from the catalogue, never a path from the request. */
const galleryFile = (rel: string) => readFileSync(join(rel.includes('/') ? GALLERY : join(root, 'examples'), rel), 'utf8');

type Tab = 'samples' | 'starters' | 'custom';

export async function galleryRoutes(app: FastifyInstance) {
  app.get(`${BASE}/gallery`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tab: Tab = (['samples', 'starters', 'custom'] as const).find((t) => t === req.query?.tab) ?? 'samples';
    const admin = await isAdmin(s.username);
    const { samples, starters } = catalog();
    const installed = new Map(
      (await owner.query<{ alias: string; id: number }>('select alias, id from meta.app where alias = any($1)', [samples.map((x) => x.alias)])).rows.map((r) => [r.alias, r.id]),
    );
    const custom = (await owner.query<{ id: number; name: string; description: string | null }>(
      `select a.id, a.name, null::text as description from meta.app a where a.app_type = 'boilerplate' and ${inWorkspaceSql('a', 1)} order by lower(a.name), a.id`,
      [currentWorkspace(s)],
    )).rows;
    const card = (ic: string, title: string, by: string, text: string, action: unknown) =>
      html`<article class="gal-card" data-filter-row><div class="gal-head"><span class="gal-icon">${icon(ic)}</span><div><h2>${title}</h2><span class="muted small">${by}</span></div></div>
        <p>${text}</p><div class="gal-foot">${action}</div></article>`;
    const tabs = html`<nav class="gal-tabs segmented" aria-label="Kinds of applications">${([['samples', 'Sample Apps'], ['starters', 'Starter Apps'], ['custom', 'Custom Apps']] as const).map(([t, l]) =>
      html`<a href="${BASE}/gallery?tab=${t}"${tab === t ? raw(' aria-current="page"') : ''}>${l}</a>`)}</nav>`;
    const cards =
      tab === 'samples'
        ? samples.map((x) => card(x.icon, x.title, 'pgkiln', x.description,
            installed.has(x.alias)
              ? html`<span class="tag tag-ok">Installed</span><a class="btn btn-sm" href="/a/${x.alias}" target="_blank" rel="noopener">Run</a><a class="btn btn-sm" href="${BASE}/apps/${installed.get(x.alias)}">Edit</a>`
              : admin
                ? html`<form method="post" action="${BASE}/gallery/samples/${x.key}">${csrf(s)}<button class="btn btn-hot btn-sm" data-confirm="Install ${x.title}? It adds its own schema, data and demo accounts with known passwords: not for a production instance.">Install</button></form>`
                : html`<span class="muted small">An administrator installs it.</span>`))
        : tab === 'starters'
          ? starters.map((x) => card(x.icon, x.title, 'pgkiln', x.description,
              html`<form method="post" action="${BASE}/gallery/starters/${x.key}">${csrf(s)}<button class="btn btn-hot btn-sm">Install</button></form>`))
          : custom.map((x) => card('copy', x.name, 'This workspace', x.description ?? 'A boilerplate application: a new application starts with its pages, shared components and settings.',
              html`<a class="btn btn-hot btn-sm" href="${BASE}/create?boilerplate=${x.id}">Create from it</a><a class="btn btn-sm" href="${BASE}/apps/${x.id}">Edit</a>`));
    const empty = tab === 'custom'
      ? html`<p class="muted">No custom apps yet: make an application of type <em>Boilerplate</em> (Application settings → Application type) and it appears here.</p>`
      : html`<p class="muted">The gallery is empty.</p>`;
    const intro = {
      samples: 'Applications that show what pgkiln can do, with their own data and demo accounts. Install them on a development or demo instance.',
      starters: 'Small, ready-to-use applications. Install shows what will be created (tables, pages, sample data) before anything happens; the application gets its own role and schema in this workspace.',
      custom: 'The boilerplate applications of this workspace: start a new application from one.',
    }[tab];
    const main = html`<div class="gal">
      <div class="gal-bar">
        <div class="ab-search gal-search" role="search"><label class="sr-only" for="gal-q">Search apps</label>${icon('search')}
          <input id="gal-q" type="search" placeholder="Search apps" autocomplete="off" data-filter-list=".gal [data-filter-row]"></div>
        ${tabs}
      </div>
      <h1 class="sr-only">App Gallery</h1>
      <p class="muted">${intro}</p>
      ${cards.length ? html`<div class="gal-grid">${cards}</div>` : empty}
    </div>`;
    return send(reply, s, shell(s, 'App Gallery', [['App Gallery']], main, 'gallery'));
  });

  // a sample app: an administrator installs it (shipped SQL, run as the owner)
  app.post(`${BASE}/gallery/samples/:key`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators install sample apps.');
    const x = KEY.test(req.params.key) ? catalog().samples.find((c) => c.key === req.params.key) : undefined;
    if (!x) return reply.code(404).send('Not found');
    try {
      if (await owner.one('select 1 as ok from meta.app where alias = $1', [x.alias])) throw new Error(`an application with the alias ${x.alias} exists already.`);
      if (x.example && KEY.test(x.example)) await migrate({ root, databaseUrl: ownerUrl, example: x.example, log: () => {} });
      else if (x.file && /^[a-z0-9-]+\.sql$/.test(x.file)) await owner.query(galleryFile(x.file));
      else throw new Error('the gallery entry names nothing to install.');
      const made = await owner.one<{ id: number; db_role: string | null }>('select id, db_role from meta.app where alias = $1', [x.alias]);
      if (!made) throw new Error(`the scripts ran, but there is no application ${x.alias}.`);
      // into the current workspace (an isolated one gets the application's role too)
      const ws = currentWorkspace(s);
      if (ws > 1)
        await owner.tx(async (c) => {
          if (made.db_role && (await c.query('select 1 from meta.workspace where id = $1 and isolated', [ws])).rowCount)
            await c.query('insert into meta.workspace_role (workspace_id, role_name) values ($1, $2) on conflict do nothing', [ws, made.db_role]);
          await placeApp(c, made.id, ws);
        });
      await workspacesChanged();
      await logActivity({ appId: made.id, username: s.username, event: 'gallery', ip: clientIp(req), detail: `installed sample app ${x.key}` });
      flash(s, `${x.title} installed (/a/${x.alias}).`);
      return back(reply, s, `${BASE}/apps/${made.id}`);
    } catch (e) {
      flash(s, `${x.title} was not installed: ${(e as Error).message}`, 'error');
      return back(reply, s, `${BASE}/gallery`);
    }
  });

  // a starter app: its blueprint's review (nothing is created before the developer confirms there)
  app.post(`${BASE}/gallery/starters/:key`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const x = KEY.test(req.params.key) ? catalog().starters.find((c) => c.key === req.params.key) : undefined;
    if (!x || !/^starters\/[a-z0-9-]+\.json$/.test(x.file)) return reply.code(404).send('Not found');
    return openBlueprint(s, reply, x.title, JSON.stringify(JSON.parse(galleryFile(x.file)), null, 2));
  });
}
