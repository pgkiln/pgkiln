import type { FastifyInstance } from 'fastify';
import { unifiedDiff } from '../cli/diff.ts';
import { owner } from '../db.ts';
import { appChecksum, ensureSnapshot, pageChecksums, shortSum } from '../history.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon, ICONS, LUCIDE_VERSION, lucideNames, searchIcons } from '../icons.ts';
import { appOfPath } from './locks.ts';
import { appHeader, BASE, designerUrl, developer, region, select, send, shell, type Req } from './ui.ts';

// (sprint 138, AP-5) App Builder → an application's Utilities (APEX: Application
// Utilities): one page for what an application's maintenance needs, the tools
// that existed elsewhere (Advisor, Search, Debug messages, Backups, Activity,
// Working copies, Export) and the new ones: Database object dependencies
// (dependencies.ts), Change history (below; recorded by src/history.ts), Upgrade
// application (upgrade.ts), UI defaults (ui-defaults.ts), the application and
// page checksums (history.ts) and the icon browser (/builder/icons).

const appOf = async (id: string) => (/^\d{1,9}$/.test(id) ? owner.one('select * from meta.app where id = $1', [id]) : undefined);
const when = (t: string | null | undefined) => (t ? String(t).slice(0, 16).replace('T', ' ') : '');

/** A unified diff with its added and removed lines marked (escaped). */
export function diffHtml(path: string, a: string | null | undefined, b: string | null | undefined, names: [string, string]): Raw {
  const text = unifiedDiff(path, a === null || a === undefined ? undefined : Buffer.from(a), b === null || b === undefined ? undefined : Buffer.from(b), names);
  return html`<pre class="code-block diff">${text.replace(/\n$/, '').split('\n').map((l) =>
    l.startsWith('+') && !l.startsWith('+++') ? html`<span class="diff-add">${l}</span>\n` : l.startsWith('-') && !l.startsWith('---') ? html`<span class="diff-del">${l}</span>\n` : html`${l}\n`)}</pre>`;
}

/** The files of one change as diffs (before → after). */
function changeDiff(before: Record<string, string> | null, after: Record<string, string> | null): Raw {
  const paths = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return html`${paths.map((p) => (before?.[p] === after?.[p] ? '' : diffHtml(p, before?.[p], after?.[p], ['before', 'after'])))}`;
}

/** The component of a history row in the builder (a page component opens the page designer). */
const componentUrl = (appId: number, page: number | null) => (page !== null && page !== undefined && page >= 0 ? designerUrl(appId, page) : `${BASE}/apps/${appId}/shared`);

/** (registered on the root instance, like app-updates.ts) a first snapshot before an application's first recorded change */
export function historyHooks(app: FastifyInstance) {
  const snapshotted = new Set<number>();
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'POST' || !req.url.startsWith(`${BASE}/`)) return;
    const target = await appOfPath(req.url).catch(() => null);
    if (!target || snapshotted.has(target.appId)) return;
    await ensureSnapshot(target.appId).catch((err) => req.log.warn({ err }, 'app snapshot not taken'));
    snapshotted.add(target.appId);
  });
}

export async function utilityRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- the Utilities page
  app.get(`${BASE}/apps/:id/utilities`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const doc = (await owner.one('select meta.export_app($1) as d', [a.alias])).d;
    const sum = appChecksum(doc);
    const pageSums = pageChecksums(doc);
    const counts = await owner.one(
      `select (select count(*) from meta.page where app_id = $1)::int as pages,
              (select count(*) from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1)::int as regions,
              (select count(*) from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1)::int as items,
              (select count(*) from meta.process x join meta.page p on p.id = x.page_id where p.app_id = $1)::int as processes,
              (select count(*) from meta.lov where app_id = $1)::int as lovs,
              (select count(*) from meta.component_change where app_id = $1 and changed_at > now() - interval '7 days')::int as week`,
      [a.id],
    );
    const pages = (await owner.query<{ page_no: number; name: string }>('select page_no, name from meta.page where app_id = $1 order by page_no', [a.id])).rows;
    const recent = (await owner.query<{ page_no: number; changed_at: string; changed_by: string | null; n: number }>(
      `select distinct on (page_no) page_no, changed_at::text, changed_by, count(*) over (partition by page_no)::int as n
         from meta.component_change where app_id = $1 and page_no is not null order by page_no, changed_at desc`, [a.id])).rows
      .sort((x, y) => (x.changed_at < y.changed_at ? 1 : -1)).slice(0, 10);
    const pageName = new Map(pages.map((p) => [p.page_no, p.name]));
    const card = (href: string, ic: string, title: string, text: string) =>
      html`<a class="ab-tile" href="${href}"><span class="ab-tile-icon">${icon(ic)}</span><strong>${title}</strong><span>${text}</span></a>`;
    const u = `${BASE}/apps/${a.id}`;
    const main = html`${appHeader(a, 'utilities', s)}
      <div class="ab-tiles ab-tiles-wrap util-tiles">
        ${card(`${u}/advisor`, 'check', 'Advisor', 'Plans every SQL statement as the application\'s role and checks every reference.')}
        ${card(`${u}/utilities/dependencies`, 'database', 'Database object dependencies', 'The tables, views, sequences and functions the application uses, missing ones and missing grants.')}
        ${card(`${u}/utilities/history`, 'history', 'Change history', 'Who changed which component and when, with the differences.')}
        ${card(`${u}/utilities/upgrade`, 'refresh', 'Upgrade application', 'Components that can use a newer default of this pgkiln version.')}
        ${card(`${BASE}/ui-defaults`, 'sliders-horizontal', 'UI defaults', 'Labels, format masks, help and lists of values per table column, used by the page wizards.')}
        ${card(`${u}/search`, 'search', 'Search', 'Names, SQL, conditions, settings and help texts of every component.')}
        ${card(`${u}/debug`, 'list', 'Debug messages', 'Timed steps of each request and messages from meta.debug().')}
        ${card(`${u}/activity`, 'activity', 'Activity', 'Page views, errors, sign-ins and the application\'s logs.')}
        ${card(`${u}/backups`, 'archive', 'Backups', 'Back up now, download and restore earlier versions.')}
        ${card(`${u}/working-copies`, 'layers', 'Working copies', 'Change a copy, compare it and merge it back.')}
        ${card(`${u}/export`, 'download', 'Export', `The application as a file (checksum ${shortSum(sum)}).`)}
        ${card(`${BASE}/icons`, 'image', 'Icons', 'Browse the icons the icon picker offers.')}
      </div>
      ${region('Application dashboard', html`<dl class="util-stats">
          <div><dt>Pages</dt><dd>${counts.pages}</dd></div><div><dt>Regions</dt><dd>${counts.regions}</dd></div>
          <div><dt>Items</dt><dd>${counts.items}</dd></div><div><dt>Processes</dt><dd>${counts.processes}</dd></div>
          <div><dt>Lists of values</dt><dd>${counts.lovs}</dd></div><div><dt>Changes in 7 days</dt><dd>${counts.week}</dd></div>
        </dl>`)}
      ${region('Recently updated pages', recent.length
        ? html`<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Page</th><th scope="col">Last change</th><th scope="col">By</th><th scope="col">Changes</th></tr></thead><tbody>
            ${recent.map((r) => html`<tr><td data-label="Page"><a href="${designerUrl(a.id, r.page_no)}">${r.page_no}${pageName.has(r.page_no) ? `: ${pageName.get(r.page_no)}` : ''}</a></td><td data-label="Last change">${when(r.changed_at)}</td>
              <td data-label="By">${r.changed_by ?? 'command line'}</td><td data-label="Changes"><a href="${u}/utilities/history?page=${r.page_no}">${r.n}</a></td></tr>`)}</tbody></table></div>`
        : html`<p class="muted u-mt0">No recorded changes yet: the change history starts with the first change after the upgrade to this version.</p>`)}
      ${region('Application checksum', html`<p class="u-mt0">The checksum of the application's definition (its export without the alias): the same definition gives the same checksum on any installation, so two installations, or an application and its working copy, compare at a glance.</p>
        <p class="util-sum"><code>${sum}</code></p>
        <details><summary>Page checksums (${pageSums.size})</summary><div class="table-wrap"><table class="table"><thead><tr><th scope="col">Page</th><th scope="col">Checksum</th></tr></thead><tbody>
          ${[...pageSums].map(([p, h]) => html`<tr><td data-label="Page">${p}${pageName.has(p) ? `: ${pageName.get(p)}` : ''}</td><td data-label="Checksum"><code>${shortSum(h)}</code></td></tr>`)}</tbody></table></div></details>`, '', 'checksum')}`;
    return send(reply, s, shell(s, `Utilities · ${a.name}`, [['App Builder', BASE], [a.name, u], ['Utilities']], main));
  });

  // ---------------------------------------------------------------- change history
  app.get(`${BASE}/apps/:id/utilities/history`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const q = req.query ?? {};
    const dev = typeof q.dev === 'string' ? q.dev.slice(0, 200) : '';
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const from = typeof q.from === 'string' && DATE.test(q.from) ? q.from : '';
    const to = typeof q.to === 'string' && DATE.test(q.to) ? q.to : '';
    const page = typeof q.page === 'string' && /^-?\d{1,9}$/.test(q.page) ? Number(q.page) : null;
    const text = typeof q.q === 'string' ? q.q.trim().slice(0, 100) : '';
    const shown = typeof q.c === 'string' && /^\d{1,18}$/.test(q.c) ? q.c : '';
    const devs = (await owner.query<{ d: string | null }>('select distinct changed_by as d from meta.component_change where app_id = $1 order by 1 nulls last', [a.id])).rows.map((r) => r.d);
    const params: unknown[] = [a.id];
    const where = ['app_id = $1'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (dev === '(command line)') where.push('changed_by is null');
    else if (dev) add('changed_by = ?', dev);
    if (from) add(`changed_at >= ?::date`, from);
    if (to) add(`changed_at < ?::date + 1`, to);
    if (page !== null) add('page_no = ?', page);
    if (text) add(`(label ilike '%' || ? || '%' escape '\\')`, text.replace(/[\\%_]/g, (m) => `\\${m}`));
    const rows = (await owner.query(
      `select id::text, component, label, page_no, op, changed_by, source, changed_at::text from meta.component_change
        where ${where.join(' and ')} order by changed_at desc, id desc limit 500`, params)).rows;
    const detail = shown ? await owner.one('select id::text, label, page_no, op, before, after, changed_by, source, changed_at::text from meta.component_change where app_id = $1 and id = $2', [a.id, shown]) : null;
    const keep = new URLSearchParams(Object.entries({ dev, from, to, page: page === null ? '' : String(page), q: text }).filter(([, v]) => v));
    const link = (id: string) => `?${new URLSearchParams([...keep, ['c', id]])}#change`;
    const OPS: Record<string, string> = { added: 'tag-info', changed: 'tag-warning', deleted: 'tag-error' };
    const main = html`${appHeader(a, 'utilities', s)}
      ${region('Change history', html`<p class="muted u-mt0">Every change made in the builder (and every import, restore or merge) is compared with the application before it: each component that was added, changed or deleted is listed here with who and when. Changes from the command line or the MCP server have no developer.</p>
        <form method="get" class="util-filters">
          ${select('dev', 'Developer', dev, [['', 'All'], ...devs.map((d): [string, string] => (d === null ? ['(command line)', 'Command line / import'] : [d, d]))])}
          <div class="field"><label class="label" for="f_from">From</label><input id="f_from" name="from" type="date" value="${from}"></div>
          <div class="field"><label class="label" for="f_to">To</label><input id="f_to" name="to" type="date" value="${to}"></div>
          <div class="field"><label class="label" for="f_page">Page</label><input id="f_page" name="page" type="number" value="${page ?? ''}"></div>
          <div class="field"><label class="label" for="f_q">Component</label><input id="f_q" name="q" type="search" value="${text}" placeholder="e.g. P3_ID"></div>
          <div class="buttons"><button class="btn btn-sm">${icon('filter')} Show</button></div></form>
        ${rows.length
          ? html`<div class="table-wrap"><table class="table util-history"><thead><tr><th scope="col">When</th><th scope="col">Developer</th><th scope="col">Component</th><th scope="col">Change</th><th scope="col">Differences</th></tr></thead><tbody>
              ${rows.map((r) => html`<tr${r.id === shown ? raw(' aria-current="true"') : ''}><td data-label="When">${when(r.changed_at)}</td><td data-label="Developer">${r.changed_by ?? html`<span class="muted">${r.source === 'import' ? 'import' : 'command line'}</span>`}</td>
                <td data-label="Component"><a href="${componentUrl(a.id, r.page_no)}">${r.label}</a></td>
                <td data-label="Change"><span class="tag ${OPS[r.op] ?? ''}">${r.op}</span>${r.source !== 'builder' ? html` <span class="tag">${r.source}</span>` : ''}</td>
                <td data-label="Differences"><a class="btn btn-sm" href="${link(r.id)}">Show</a></td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">No changes${where.length > 1 ? ' with these filters' : ' recorded yet'}.</p>`}`)}
      ${detail ? region(`Differences: ${detail.label}`, html`<p class="muted u-mt0">${detail.op} by ${detail.changed_by ?? 'the command line'}, ${when(detail.changed_at)}. Lines with <code>-</code> are before the change, lines with <code>+</code> after it.</p>${changeDiff(detail.before, detail.after)}`, '', 'change') : ''}`;
    return send(reply, s, shell(s, `Change history · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Utilities', `${BASE}/apps/${a.id}/utilities`], ['Change history']], main));
  });

  // ---------------------------------------------------------------- icons
  app.get(`${BASE}/icons`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const needle = q.toLowerCase().replace(/^fa-/, '');
    const own = (ICONS as readonly string[]).filter((n) => !needle || n.includes(needle));
    const lucide = needle ? searchIcons(q, 300) : [];
    const tile = (n: string) => html`<li><span class="icon-tile">${icon(n, 'icon icon-2x')}<code>${n}</code></span></li>`;
    const main = html`<h1 class="u-mb1">Icons</h1>
      ${region('Icon browser', html`<p class="muted u-mt0">The icons of the icon picker: pgkiln's own set and ${String(lucideNames().size)} Lucide icons (${LUCIDE_VERSION}, ISC licence). Use the name in an icon field; modifiers such as <code>lg</code>, <code>spin</code> or <code>success</code> may follow it (e.g. <code>truck lg success</code>), and Font APEX names work where Lucide has the same icon (<code>fa-users</code>).</p>
        <form method="get" role="search" class="util-filters"><div class="field"><label class="label" for="f_icon_q">Search</label><input id="f_icon_q" name="q" type="search" value="${q}" placeholder="e.g. truck, money, arrow"></div>
          <div class="buttons"><button class="btn btn-sm">${icon('search')} Search</button></div></form>
        <h3>pgkiln (${own.length})</h3><ul class="util-icons">${own.map(tile)}</ul>
        ${needle ? html`<h3>Lucide (${lucide.length}${lucide.length === 300 ? '+' : ''})</h3>${lucide.length ? html`<ul class="util-icons">${lucide.map(tile)}</ul>` : html`<p class="muted">No Lucide icon matches.</p>`}`
          : html`<p class="muted">Search to see the matching Lucide icons.</p>`}`)}`;
    return send(reply, s, shell(s, 'Icons', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Icons']], main));
  });
}
