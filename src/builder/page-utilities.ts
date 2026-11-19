import type { FastifyInstance } from 'fastify';
import { docToFiles, filesToZip, type Doc, type FileMap } from '../appfiles.ts';
import { owner } from '../db.ts';
import { pageChecksums, shortSum } from '../history.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { cacheOf, DEFERRABLE, invalidatePage, invalidateRegion, lazyOf, pageCacheEntries } from '../runtime/region-cache.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { typeName } from './type-names.ts';
import { regionTypeValue } from './component-regions.ts';
import { appHeader, back, BASE, csrf, designerUrl, developer, flash, region, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 206, AX-5) The Page Designer's menus work on the page that is open, as APEX's do: Create → Copy this page
// (Create page as copy, create-page.ts, with this page chosen) and Issue for this page (Team Development's new issue
// with the application and page filled in); Utilities → History of this page (the change history filtered to the
// page), View as text and Page checksum (GET …/apps/:app/pages/:no/text: the page's files of the text layout,
// read-only, and its checksum as on the application's Utilities) and Export this page (GET …/pages/:no/export: a zip
// with the page's folder of `pgkiln export --format text`). There is no import of a single page: the folder replaces
// the page in an application exported in the text layout, which is then imported (docs/guide/03-builder.md).
// Authorization is the builder's: developer() refuses an application outside the developer's workspaces (the path
// names it), and the copy and the issue are the existing forms with their own checks (CSRF, locks, Run only).
//
// (sprint 210, AX-5) Create → Developer comment (the designer's Lock and comments tab, opened with its comment field
// focused: ?comment=1#comment-<n>) and Utilities → Caching (GET …/pages/:no/caching: the page's regions with their
// server cache and lazy loading, what this server process holds for each now, and Purge for a region or the whole
// page: POST …/pages/:no/caching/purge, which only drops cached HTML and is allowed on a locked or Run only page).

type PageRef = { app_id: number; page_no: number };

/** The page's folder in the text layout of an export (pages/0003-employees-form/…), or an empty map. */
export function pageFiles(doc: Doc, pageNo: number): FileMap {
  const prefix = pageNo < 0 ? `m${String(-pageNo).padStart(4, '0')}` : String(pageNo).padStart(4, '0');
  const dir = new RegExp(`^pages/${prefix}-[^/]*/`);
  return new Map([...docToFiles(doc, 'text')].filter(([path]) => dir.test(path)));
}

/** (Create menu) Copy this page and Issue for this page. */
export function pageCreateLinks(s: Session, p: PageRef): Raw {
  return html`<div class="menu-section menu-links">
    <a href="${BASE}/apps/${p.app_id}/copy-page?from=${p.app_id}&amp;page=${p.page_no}">${icon('copy')} ${tx('pd.menu.copy_page')}</a>
    ${s.workspace ? html`<a href="${BASE}/team/issues/new?app=${p.app_id}&amp;page=${p.page_no}">${icon('kanban')} ${tx('pd.menu.issue_page')}</a>` : ''}
    <a href="${designerUrl(p.app_id, p.page_no, 'comment=1')}#comment-${p.page_no}">${icon('comments')} ${tx('pd.menu.dev_comment')}</a>
  </div>`;
}

/** (Utilities menu) History of this page, View as text, Page checksum, Export this page. */
export function pageUtilityLinks(p: PageRef): Raw {
  const at = `${BASE}/apps/${p.app_id}/pages/${p.page_no}`;
  return html`<div class="menu-section menu-links">
    <a href="${BASE}/apps/${p.app_id}/utilities/history?page=${p.page_no}">${icon('history')} ${tx('pd.menu.history_page')}</a>
    <a href="${at}/text">${icon('file-text')} ${tx('pd.menu.text_page')}</a>
    <a href="${at}/text#checksum">${icon('hash')} ${tx('pd.menu.checksum_page')}</a>
    <a href="${at}/export">${icon('download')} ${tx('pd.menu.export_page')}</a>
    <a href="${at}/caching">${icon('clock')} ${tx('pd.menu.caching')}</a>
  </div>`;
}

/** The application and page of a request's :app/:no, with the application's export, or undefined. */
async function pageOf(req: Req) {
  if (!/^\d{1,9}$/.test(req.params.app) || !/^-?\d{1,9}$/.test(req.params.no)) return undefined;
  const p = await owner.one<{ app_id: number; page_no: number; name: string; alias: string; app_name: string }>(
    'select p.app_id, p.page_no, p.name, a.alias, a.name as app_name from meta.page p join meta.app a on a.id = p.app_id where p.app_id = $1 and p.page_no = $2',
    [req.params.app, req.params.no]);
  if (!p) return undefined;
  const doc: Doc = (await owner.one('select meta.export_app($1) as d', [p.alias])).d;
  return { p, doc, files: pageFiles(doc, p.page_no), sum: pageChecksums(doc).get(p.page_no) ?? '' };
}

const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024));

export async function pageUtilityRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- (sprint 210) Caching
  app.get(`${BASE}/apps/:app/pages/:no/caching`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = /^\d{1,9}$/.test(req.params.app) && /^-?\d{1,9}$/.test(req.params.no)
      ? await owner.one<{ id: number; app_id: number; page_no: number; name: string; app_name: string }>(
        'select p.id, p.app_id, p.page_no, p.name, a.name as app_name from meta.page p join meta.app a on a.id = p.app_id where p.app_id = $1 and p.page_no = $2', [req.params.app, req.params.no])
      : undefined;
    if (!p) return reply.code(404).send('Not found');
    const regions = (await owner.query<Region>('select id, title, type, config, seq from meta.region where page_id = $1 order by seq, id', [p.id])).rows;
    const held = pageCacheEntries(p.app_id, p.page_no);
    const a = await owner.one('select * from meta.app where id = $1', [p.app_id]);
    const at = `${BASE}/apps/${p.app_id}/pages/${p.page_no}/caching`;
    const purge = (rid: number | null, label: string) => html`<form method="post" action="${at}/purge" class="u-inline">${csrf(s)}${rid ? html`<input type="hidden" name="region" value="${rid}">` : ''}<button class="btn btn-sm">${icon('trash')} ${label}</button></form>`;
    const cacheable = regions.filter((r) => DEFERRABLE.has(r.type));
    const total = [...held.values()].reduce((n, x) => n + x.entries, 0);
    const rows = cacheable.map((r) => {
      const c = cacheOf(r);
      const h = held.get(r.id);
      return html`<tr>
        <td data-label="${tx('pdca.region')}"><a href="${designerUrl(p.app_id, p.page_no, `c=region-${r.id}`)}">${r.title ?? `(${typeName('region', regionTypeValue(r))})`}</a></td>
        <td data-label="${tx('pdca.type')}">${typeName('region', regionTypeValue(r))}</td>
        <td data-label="${tx('pdca.cache')}">${c ? tx('pdca.cached_for', { scope: tx.dyn(`pdca.scope.${c.scope}`, c.scope), seconds: c.seconds }) : html`<span class="muted">${tx('pdca.no_cache')}</span>`}</td>
        <td data-label="${tx('pdca.lazy')}">${lazyOf(r) ? tx('pdc.yes') : tx('pdc.no')}</td>
        <td data-label="${tx('pdca.held')}">${h ? tx('pdca.entries', { n: h.entries, kb: kb(h.bytes) }) : '-'}</td>
        <td>${h ? purge(r.id, tx('pdca.purge')) : ''}</td>
      </tr>`;
    });
    const others = regions.length - cacheable.length;
    const main = html`${appHeader(a, 'pages', s)}
      ${region(tx('pdca.heading', { n: p.page_no, name: p.name }), html`<p class="muted u-mt0">${tx('pdca.intro')}</p>
        ${cacheable.length
          ? html`<div class="table-wrap"><table class="report stack-sm"><thead><tr><th scope="col">${tx('pdca.region')}</th><th scope="col">${tx('pdca.type')}</th><th scope="col">${tx('pdca.cache')}</th><th scope="col">${tx('pdca.lazy')}</th><th scope="col">${tx('pdca.held')}</th><th scope="col"><span class="sr-only">${tx('pdca.purge')}</span></th></tr></thead>
              <tbody>${rows}</tbody></table></div>`
          : html`<p>${tx('pdca.none')}</p>`}
        ${others ? html`<p class="muted small">${tx('pdca.others', { n: others })}</p>` : ''}
        <div class="buttons">
          ${total ? purge(null, tx('pdca.purge_page')) : ''}
          <a class="btn btn-sm" href="${designerUrl(p.app_id, p.page_no)}">${icon('edit')} ${tx('pd.designer')}</a>
        </div>
        <p class="muted small">${tx('pdca.process_note')}</p>`)}`;
    return send(reply, s, shell(s, tx('pdca.title', { n: p.page_no }), [[tx('pdz.app_builder'), BASE], [p.app_name, `${BASE}/apps/${p.app_id}`],
      [tx('pd.page_title', { n: p.page_no, name: p.name }), designerUrl(p.app_id, p.page_no)], [tx('pd.menu.caching')]], main));
  });

  app.post(`${BASE}/apps/:app/pages/:no/caching/purge`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const p = /^\d{1,9}$/.test(req.params.app) && /^-?\d{1,9}$/.test(req.params.no)
      ? await owner.one<{ id: number; app_id: number; page_no: number }>('select id, app_id, page_no from meta.page where app_id = $1 and page_no = $2', [req.params.app, req.params.no])
      : undefined;
    if (!p) return reply.code(404).send('Not found');
    const rid = String(req.body?.region ?? '');
    if (/^\d{1,9}$/.test(rid)) {
      // only a region of this page
      if (!(await owner.one('select 1 as ok from meta.region where id = $1 and page_id = $2', [rid, p.id]))) return reply.code(404).send('Not found');
      invalidateRegion(p.app_id, p.page_no, Number(rid));
    } else invalidatePage(p.app_id, p.page_no);
    await logActivity({ appId: p.app_id, username: s.username, event: 'cache_purge', ip: clientIp(req), detail: rid ? `${p.page_no}/${rid}` : String(p.page_no) });
    flash(s, tx(rid ? 'pdca.purged_region' : 'pdca.purged'));
    return back(reply, s, `${BASE}/apps/${p.app_id}/pages/${p.page_no}/caching`);
  });

  // ---------------------------------------------------------------- Export this page
  app.get(`${BASE}/apps/:app/pages/:no/export`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const it = await pageOf(req);
    if (!it) return reply.code(404).send('Not found');
    const { p, files, sum } = it;
    await logActivity({ appId: p.app_id, username: s.username, event: 'page_export', ip: clientIp(req), detail: String(p.page_no) });
    return reply
      .header('x-pgkiln-checksum', sum)
      .header('content-disposition', `attachment; filename="${p.alias}-page-${p.page_no}.pgkiln.zip"`)
      .type('application/zip')
      .send(Buffer.from(filesToZip(files, p.alias)));
  });

  // ---------------------------------------------------------------- View as text and Page checksum
  app.get(`${BASE}/apps/:app/pages/:no/text`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const it = await pageOf(req);
    if (!it) return reply.code(404).send('Not found');
    const { p, files, sum } = it;
    const a = await owner.one('select * from meta.app where id = $1', [p.app_id]);
    const at = `${BASE}/apps/${p.app_id}/pages/${p.page_no}`;
    const main = html`${appHeader(a, 'pages', s)}
      ${region(tx('pdu.heading', { n: p.page_no, name: p.name }), html`<p class="muted u-mt0">${tx('pdu.intro')}</p>
        <div class="buttons">
          <a class="btn btn-sm" href="${designerUrl(p.app_id, p.page_no)}">${icon('edit')} ${tx('pd.designer')}</a>
          <a class="btn btn-sm" href="${BASE}/apps/${p.app_id}/utilities/history?page=${p.page_no}">${icon('history')} ${tx('pd.menu.history_page')}</a>
          <a class="btn btn-sm" href="${at}/export">${icon('download')} ${tx('pd.menu.export_page')}</a>
        </div>`)}
      ${region(tx('pd.menu.checksum_page'), html`<p class="u-mt0">${tx('pdu.checksum_text')}</p>
        <p class="util-sum"><code>${sum}</code></p><p class="muted small">${tx('pdu.checksum_short', { sum: shortSum(sum) })}</p>`, '', 'checksum')}
      ${region(tx('pdu.files', { n: files.size }), html`<p class="muted u-mt0">${tx('pdu.export_help')}</p>
        ${[...files].map(([path, buf]) => html`<section class="pdu-file"><h3><code>${path}</code></h3>
          <pre class="source wrap-pre" tabindex="0" aria-label="${path}">${buf.toString('utf8')}</pre></section>`)}`, '', 'files')}`;
    return send(reply, s, shell(s, tx('pdu.title', { n: p.page_no }), [[tx('pdz.app_builder'), BASE], [p.app_name, `${BASE}/apps/${p.app_id}`],
      [tx('pd.page_title', { n: p.page_no, name: p.name }), designerUrl(p.app_id, p.page_no)], [tx('pd.menu.text_page')]], main));
  });
}
