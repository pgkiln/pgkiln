import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
import { gallerySources, MAX_SOURCES, refreshSource, remoteBlueprint, REMOTE_KINDS, sourceUrlProblem, type GallerySource, type RemoteEntry, type RemoteKind } from '../gallery-remote.ts';
import { scopeForWorkspace } from '../network-acl.ts';
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
  /** (sprint 172, WS-8) the sample's version: a badge on its card, and the installed application's Version */
  version?: string;
}
interface Starter {
  key: string;
  title: string;
  icon: string;
  description: string;
  file: string;
  version?: string;
}

const GALLERY = join(root, 'examples', 'gallery');
const KEY = /^[a-z][a-z0-9-]{0,40}$/;

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
/** A catalogue entry's version as shown ("1.0", "2.1-beta"), or '' when it has none or it isn't one. */
const versionOf = (x: { version?: unknown }) => (typeof x.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/.test(x.version) ? x.version : '');

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

/** (sprint 181) Administrators: the remote catalogues, under the starter and utility apps. */
function sourcesPanel(s: Parameters<typeof csrf>[0], sources: GallerySource[], tab: 'starters' | 'utilities') {
  const hidden = html`${csrf(s)}<input type="hidden" name="tab" value="${tab}">`;
  return html`<section class="region gal-sources" aria-labelledby="gal-sources-h"><div class="region-body">
    <h2 id="gal-sources-h">${tx('gal.remote.title')}</h2>
    <p class="muted small">${tx.code('gal.remote.intro')}</p>
    ${sources.length ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('gal.remote.col.name')}</th><th>${tx('gal.remote.col.url')}</th><th>${tx('gal.remote.col.apps')}</th><th>${tx('gal.remote.col.fetched')}</th><th>${tx('gal.remote.col.actions')}</th></tr></thead><tbody>
      ${sources.map((x) => html`<tr>
        <td data-label="${tx('gal.remote.col.name')}">${x.name}${x.enabled ? '' : html` <span class="tag">${tx('gal.remote.off')}</span>`}</td>
        <td data-label="${tx('gal.remote.col.url')}" class="wrap-anywhere"><code>${x.url}</code></td>
        <td data-label="${tx('gal.remote.col.apps')}">${(x.catalogue.starters?.length ?? 0) + (x.catalogue.utilities?.length ?? 0)}</td>
        <td data-label="${tx('gal.remote.col.fetched')}">${x.fetched_at ?? '—'}${x.error ? html`<br><span class="tag tag-warning">${tx('gal.remote.problems')}</span> <span class="small">${x.error}</span>` : ''}</td>
        <td data-label="${tx('gal.remote.col.actions')}"><div class="buttons u-m0">
          <form method="post" action="${BASE}/gallery/sources/${x.id}/refresh" class="u-inline">${hidden}<button class="btn btn-sm">${tx('gal.remote.refresh')}</button></form>
          <form method="post" action="${BASE}/gallery/sources/${x.id}/toggle" class="u-inline">${hidden}<button class="btn btn-sm">${tx(x.enabled ? 'gal.remote.switch_off' : 'gal.remote.switch_on')}</button></form>
          <form method="post" action="${BASE}/gallery/sources/${x.id}/delete" class="u-inline">${hidden}<button class="btn btn-sm btn-danger" data-confirm="${tx('gal.remote.remove_confirm', { name: x.name })}">${tx('gal.remote.remove')}</button></form>
        </div></td></tr>`)}
    </tbody></table></div>` : ''}
    <form method="post" action="${BASE}/gallery/sources" class="search u-mwnone">${hidden}
      <div class="field"><label class="label" for="f_src_name">${tx('gal.remote.col.name')}</label><input id="f_src_name" name="name" maxlength="60" required></div>
      <div class="field"><label class="label" for="f_src_url">${tx('gal.remote.col.url')}</label><input id="f_src_url" name="url" type="url" maxlength="2000" placeholder="https://example.com/pgkiln-gallery.json" required></div>
      <button class="btn u-selfend">${tx('gal.remote.add')}</button></form>
  </div></section>`;
}

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
    // (sprint 181, WS-8) starter and utility apps of the enabled remote catalogues
    const sources = await gallerySources(!admin);
    const remote = (kind: RemoteKind) => sources.filter((x) => x.enabled).flatMap((src) => (src.catalogue[kind] ?? []).map((e) => ({ src, e })));
    // an installed sample: Edit only in its own workspace
    const installed = new Map(
      (await owner.query<{ alias: string; id: number; here: boolean; version: string | null }>(`select a.alias, a.id, a.version, ${inWorkspaceSql('a', 2)} as here from meta.app a where a.alias = any($1)`,
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
    const counts: Record<Tab, number> = { samples: samples.length, starters: starters.length + remote('starters').length, utilities: utilities.length + remote('utilities').length, custom: custom.length };
    // (sprint 172, WS-8) a version badge per gallery app
    const card = (ic: string, title: string, by: string, text: string, action: unknown, version = '') =>
      html`<article class="gal-card" data-filter-row><div class="gal-head"><span class="gal-icon">${icon(ic)}</span><div><h2>${title}</h2><span class="muted small">${by}</span>${version ? html` <span class="tag gal-version" title="${tx('gal.version', { version })}">v${version}</span>` : ''}</div></div>
        <p>${text}</p><div class="gal-foot">${action}</div></article>`;
    const tabs = html`<nav class="gal-tabs segmented" aria-label="${tx('gal.kinds')}">${TABS.map(([t, l]) =>
      html`<a href="${BASE}/gallery?tab=${t}${q ? `&q=${encodeURIComponent(q)}` : ''}"${tab === t ? raw(' aria-current="page"') : ''}>${tx(l)} <span class="gal-count">${counts[t]}</span></a>`)}</nav>`;
    const blueprintCard = (kind: 'starters' | 'utilities') => (x: Starter) => card(x.icon, x.title, 'pgkiln', x.description,
      html`<form method="post" action="${BASE}/gallery/${kind}/${x.key}">${csrf(s)}<button class="btn btn-sm">${tx('gal.install')}</button></form>`, versionOf(x));
    const remoteCard = (kind: RemoteKind) => ({ src, e }: { src: GallerySource; e: RemoteEntry }) => card(e.icon, e.title, src.name, e.description,
      html`<form method="post" action="${BASE}/gallery/remote/${src.id}/${kind}/${e.key}">${csrf(s)}<button class="btn btn-sm">${tx('gal.install')}</button></form>`, e.version);
    const cards =
      tab === 'samples'
        ? samples.filter(matches).map((x) => {
            const it = installed.get(x.alias);
            return card(x.icon, x.title, 'pgkiln', x.description,
              it
                ? html`<span class="tag tag-ok">${it.version && it.version !== versionOf(x) ? tx('gal.installed_version', { version: it.version }) : tx('gal.installed')}</span><a class="btn btn-sm" href="/a/${x.alias}" target="_blank" rel="noopener">${tx('common.run')}</a>${it.here
                    ? html`<a class="btn btn-sm" href="${BASE}/apps/${it.id}">${tx('gal.edit')}</a>`
                    : html`<span class="muted small">${tx('gal.other_workspace')}</span>`}`
                : admin
                  ? html`<form method="post" action="${BASE}/gallery/samples/${x.key}">${csrf(s)}<button class="btn btn-sm" data-confirm="${tx('gal.confirm_install', { title: x.title })}">${tx('gal.install')}</button></form>`
                  : html`<span class="muted small">${tx('gal.admin_installs')}</span>`, versionOf(x));
          })
        : tab === 'starters' || tab === 'utilities'
          ? [...(tab === 'starters' ? starters : utilities).filter(matches).map(blueprintCard(tab)),
             ...remote(tab).filter(({ e }) => matches(e)).map(remoteCard(tab))]
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
      ${admin && (tab === 'starters' || tab === 'utilities') ? sourcesPanel(s, sources, tab) : ''}
    </div>`;
    return send(reply, s, shell(s, tx('rail.gallery'), [[tx('rail.gallery')]], main, 'gallery'));
  });

  // (sprint 181, WS-8) remote catalogues: administrators add, refresh, switch off and remove them
  const adminOr403 = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return null;
    if (!(await isAdmin(s.username))) {
      reply.code(403).send(tx('gal.remote.admins_only'));
      return null;
    }
    return s;
  };
  const sourceId = (req: Req) => (/^\d{1,9}$/.test(String(req.params.id)) ? Number(req.params.id) : 0);
  const backTo = (req: Req) => `${BASE}/gallery?tab=${(req.body as Record<string, unknown> | undefined)?.tab === 'utilities' ? 'utilities' : 'starters'}`;

  app.post(`${BASE}/gallery/sources`, async (req: Req, reply) => {
    const s = await adminOr403(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    const problem = !name || name.length > 60 ? tx('gal.remote.bad_name')
      : sourceUrlProblem(url) ?? ((await owner.one<{ n: number }>('select count(*)::int as n from meta.gallery_source'))!.n >= MAX_SOURCES ? tx('gal.remote.too_many', { n: MAX_SOURCES }) : null);
    if (problem) {
      flash(s, problem, 'error');
      return back(reply, s, backTo(req));
    }
    const made = await owner.one<{ id: number }>(`insert into meta.gallery_source (name, url, created_by) values ($1, $2, $3) on conflict (url) do nothing returning id`, [name, url, s.username]);
    if (!made) {
      flash(s, tx('gal.remote.exists'), 'error');
      return back(reply, s, backTo(req));
    }
    await logActivity({ username: s.username, event: 'gallery_source', ip: clientIp(req), detail: `added ${url}` });
    const r = await refreshSource(made.id);
    flash(s, r.ok ? tx('gal.remote.fetched', { name, n: r.count }) : tx('gal.remote.not_fetched', { name, message: r.problems.join(' ') }), r.ok ? 'ok' : 'error');
    return back(reply, s, backTo(req));
  });

  app.post(`${BASE}/gallery/sources/:id/:action`, async (req: Req, reply) => {
    const s = await adminOr403(req, reply);
    if (!s) return;
    const id = sourceId(req);
    const src = id ? await owner.one<{ name: string; url: string }>('select name, url from meta.gallery_source where id = $1', [id]) : undefined;
    if (!src) return reply.code(404).send('Not found');
    const action = String(req.params.action);
    if (action === 'refresh') {
      const r = await refreshSource(id);
      flash(s, r.ok ? tx('gal.remote.fetched', { name: src.name, n: r.count }) : tx('gal.remote.not_fetched', { name: src.name, message: r.problems.join(' ') }), r.ok ? 'ok' : 'error');
    } else if (action === 'toggle') {
      await owner.query('update meta.gallery_source set enabled = not enabled where id = $1', [id]);
      flash(s, tx('gal.remote.saved'));
    } else if (action === 'delete') {
      await owner.query('delete from meta.gallery_source where id = $1', [id]);
      flash(s, tx('gal.remote.removed', { name: src.name }));
    } else return reply.code(404).send('Not found');
    await logActivity({ username: s.username, event: 'gallery_source', ip: clientIp(req), detail: `${action} ${src.url}` });
    return back(reply, s, backTo(req));
  });

  // a remote starter or utility app: its blueprint is fetched now and opens in the review
  for (const kind of REMOTE_KINDS)
    app.post(`${BASE}/gallery/remote/:id/${kind}/:key`, async (req: Req, reply) => {
      const s = await developer(req, reply);
      if (!s) return;
      const id = sourceId(req);
      const src = id && KEY.test(String(req.params.key))
        ? await owner.one<{ name: string; catalogue: GallerySource['catalogue'] }>('select name, catalogue from meta.gallery_source where id = $1 and enabled', [id]) : undefined;
      const entry = src?.catalogue[kind]?.find((e) => e.key === req.params.key);
      if (!src || !entry) return reply.code(404).send('Not found');
      try {
        const spec = await remoteBlueprint(entry, await scopeForWorkspace(currentWorkspace(s), `App Gallery: ${src.name}`));
        await logActivity({ username: s.username, event: 'gallery', ip: clientIp(req), detail: `opened remote blueprint ${entry.key} of ${src.name}` });
        return openBlueprint(s, reply, entry.title, spec);
      } catch (e) {
        flash(s, tx('gal.remote.blueprint_failed', { title: entry.title, message: (e as Error).message }), 'error');
        return back(reply, s, `${BASE}/gallery?tab=${kind}`);
      }
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
        // (sprint 172, WS-8) the catalogue's version becomes the application's, unless the sample set one itself
        if (versionOf(x)) await c.query('update meta.app set version = $2 where id = $1 and version is null', [made.id, versionOf(x)]);
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
