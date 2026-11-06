import type { FastifyInstance } from 'fastify';
import { unifiedDiff } from '../cli/diff.ts';
import { owner } from '../db.ts';
import { appChecksum, ensureSnapshot, pageChecksums, shortSum } from '../history.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon, ICONS, LUCIDE_VERSION, lucideNames, searchIcons } from '../icons.ts';
import { appOfPath } from './locks.ts';
import { appHeader, BASE, designerUrl, developer, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

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
        ${card(`${u}/advisor`, 'check', tx('util.c_advisor'), tx('util.plans_every_sql_statement_as'))}
        ${card(`${u}/utilities/dependencies`, 'database', tx('util.c_deps'), tx('util.the_tables_views_sequences_and'))}
        ${card(`${u}/utilities/history`, 'history', tx('util.c_history'), tx('util.who_changed_which_component_and'))}
        ${card(`${u}/utilities/upgrade`, 'refresh', tx('util.c_upgrade'), tx('util.components_that_can_use_a'))}
        ${card(`${BASE}/ui-defaults`, 'sliders-horizontal', tx('util.c_ui_defaults'), tx('util.labels_format_masks_help_and'))}
        ${card(`${u}/search`, 'search', tx('util.c_search'), tx('util.names_sql_conditions_settings_and'))}
        ${card(`${u}/debug`, 'list', tx('util.c_debug'), tx('util.timed_steps_of_each_request'))}
        ${card(`${u}/activity`, 'activity', tx('util.c_activity'), tx('util.page_views_errors_sign_ins'))}
        ${card(`${u}/backups`, 'archive', tx('util.c_backups'), tx('util.back_up_now_download_and'))}
        ${card(`${u}/working-copies`, 'layers', tx('util.c_wc'), tx('util.change_a_copy_compare_it'))}
        ${card(`${u}/export`, 'download', tx('util.c_export'), tx('util.export_text', { sum: shortSum(sum) }))}
        ${card(`${BASE}/icons`, 'image', tx('util.c_icons'), tx('util.browse_the_icons_the_icon'))}
      </div>
      ${region(tx('util.application_dashboard'), html`<dl class="util-stats">
          <div><dt>${tx('util.pages')}</dt><dd>${counts.pages}</dd></div><div><dt>${tx('util.regions')}</dt><dd>${counts.regions}</dd></div>
          <div><dt>${tx('util.items')}</dt><dd>${counts.items}</dd></div><div><dt>${tx('util.processes')}</dt><dd>${counts.processes}</dd></div>
          <div><dt>${tx('util.lists_of_values')}</dt><dd>${counts.lovs}</dd></div><div><dt>${tx('util.changes_in_7_days')}</dt><dd>${counts.week}</dd></div>
        </dl>`)}
      ${region(tx('util.recently_updated_pages'), recent.length
        ? html`<div class="table-wrap"><table class="table report-reflow"><thead><tr><th scope="col">${tx('util.page')}</th><th scope="col">${tx('util.last_change')}</th><th scope="col">${tx('util.by')}</th><th scope="col">${tx('util.changes')}</th></tr></thead><tbody>
            ${recent.map((r) => html`<tr><td data-label="${tx('util.page')}"><a href="${designerUrl(a.id, r.page_no)}">${r.page_no}${pageName.has(r.page_no) ? `: ${pageName.get(r.page_no)}` : ''}</a></td><td data-label="${tx('util.last_change')}">${when(r.changed_at)}</td>
              <td data-label="${tx('util.by')}">${r.changed_by ?? 'command line'}</td><td data-label="${tx('util.changes')}"><a href="${u}/utilities/history?page=${r.page_no}">${r.n}</a></td></tr>`)}</tbody></table></div>`
        : html`<p class="muted u-mt0">${tx('util.no_recorded_changes_yet_the')}</p>`)}
      ${region(tx('util.application_checksum'), html`<p class="u-mt0">${tx('util.the_checksum_of_the_application')}</p>
        <p class="util-sum"><code>${sum}</code></p>
        <details><summary>Page checksums (${pageSums.size})</summary><div class="table-wrap"><table class="table report-reflow"><thead><tr><th scope="col">${tx('util.page')}</th><th scope="col">${tx('util.checksum')}</th></tr></thead><tbody>
          ${[...pageSums].map(([p, h]) => html`<tr><td data-label="${tx('util.page')}">${p}${pageName.has(p) ? `: ${pageName.get(p)}` : ''}</td><td data-label="${tx('util.checksum')}"><code>${shortSum(h)}</code></td></tr>`)}</tbody></table></div></details>`, '', 'checksum')}`;
    return send(reply, s, shell(s, tx('util.title', { app: a.name }), [[tx('util.app_builder'), BASE], [a.name, u], [tx('util.utilities')]], main));
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
      ${region(tx('util.change_history'), html`<p class="muted u-mt0">${tx('util.every_change_made_in_the')}</p>
        <form method="get" class="util-filters">
          ${select('dev', tx('util.developer'), dev, [['', tx('util.all')], ...devs.map((d): [string, string] => (d === null ? ['(command line)', tx('util.cmd_line')] : [d, d]))])}
          <div class="field"><label class="label" for="f_from">${tx('util.from')}</label><input id="f_from" name="from" type="date" value="${from}"></div>
          <div class="field"><label class="label" for="f_to">${tx('util.to')}</label><input id="f_to" name="to" type="date" value="${to}"></div>
          <div class="field"><label class="label" for="f_page">${tx('util.page')}</label><input id="f_page" name="page" type="number" value="${page ?? ''}"></div>
          <div class="field"><label class="label" for="f_q">${tx('util.component')}</label><input id="f_q" name="q" type="search" value="${text}" placeholder="${tx('util.e_g_p3_id')}"></div>
          <div class="buttons"><button class="btn btn-sm">${icon('filter')} ${tx('util.show')}</button></div></form>
        ${rows.length
          ? html`<div class="table-wrap"><table class="table util-history report-reflow"><thead><tr><th scope="col">${tx('util.when')}</th><th scope="col">${tx('util.developer')}</th><th scope="col">${tx('util.component')}</th><th scope="col">${tx('util.change')}</th><th scope="col">${tx('util.differences')}</th></tr></thead><tbody>
              ${rows.map((r) => html`<tr${r.id === shown ? raw(' aria-current="true"') : ''}><td data-label="${tx('util.when')}">${when(r.changed_at)}</td><td data-label="${tx('util.developer')}">${r.changed_by ?? html`<span class="muted">${r.source === 'import' ? tx('util.import') : tx('util.command_line')}</span>`}</td>
                <td data-label="${tx('util.component')}"><a href="${componentUrl(a.id, r.page_no)}">${r.label}</a></td>
                <td data-label="${tx('util.change')}"><span class="tag ${OPS[r.op] ?? ''}">${tx.dyn(`util.op.${r.op}`, r.op)}</span>${r.source !== 'builder' ? html` <span class="tag">${r.source}</span>` : ''}</td>
                <td data-label="${tx('util.differences')}"><a class="btn btn-sm" href="${link(r.id)}">${tx('util.show')}</a></td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">${where.length > 1 ? tx('util.no_changes_filtered') : tx('util.no_changes')}</p>`}`)}
      ${detail ? region(tx('util.diff_title', { label: detail.label }), html`<p class="muted u-mt0">${tx.rich('util.diff_intro', { op: tx.dyn(`util.op.${detail.op}`, detail.op), who: detail.changed_by ?? tx('util.the_command_line'), when: when(detail.changed_at), minus: html`<code>-</code>`, plus: html`<code>+</code>` })}</p>${changeDiff(detail.before, detail.after)}`, '', 'change') : ''}`;
    return send(reply, s, shell(s, tx('util.history_title', { app: a.name }), [[tx('util.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('util.utilities'), `${BASE}/apps/${a.id}/utilities`], [tx('util.change_history')]], main));
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
    const main = html`<h1 class="u-mb1">${tx('util.icons')}</h1>
      ${region(tx('util.icon_browser'), html`<p class="muted u-mt0">${tx.rich('util.icons_intro', { n: String(lucideNames().size), version: LUCIDE_VERSION, lg: html`<code>lg</code>`, spin: html`<code>spin</code>`, success: html`<code>success</code>`, example: html`<code>truck lg success</code>`, fa: html`<code>fa-users</code>` })}</p>
        <form method="get" role="search" class="util-filters"><div class="field"><label class="label" for="f_icon_q">${tx('util.search')}</label><input id="f_icon_q" name="q" type="search" value="${q}" placeholder="${tx('util.e_g_truck_money_arrow')}"></div>
          <div class="buttons"><button class="btn btn-sm">${icon('search')} ${tx('util.search')}</button></div></form>
        <h3>pgkiln (${own.length})</h3><ul class="util-icons">${own.map(tile)}</ul>
        ${needle ? html`<h3>Lucide (${lucide.length}${lucide.length === 300 ? '+' : ''})</h3>${lucide.length ? html`<ul class="util-icons">${lucide.map(tile)}</ul>` : html`<p class="muted">${tx('util.no_lucide_icon_matches')}</p>`}`
          : html`<p class="muted">${tx('util.search_to_see_the_matching')}</p>`}`)}`;
    return send(reply, s, shell(s, tx('util.icons'), [[tx('util.app_builder'), BASE], [tx('util.workspace_utilities'), `${BASE}/utilities`], [tx('util.icons')]], main));
  });
}
