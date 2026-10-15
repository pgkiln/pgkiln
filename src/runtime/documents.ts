import { applyBinds } from '../binds.ts';
import { runtime, savepoint } from '../db.ts';
import { isAuthorized, Forbidden } from './authz.ts';
import { bindValues, stripSemicolon, substitute, type PageContext } from './context.ts';
import { documentData, documentFilename, documentPdf, fillTemplate, type DocumentTemplate } from './document.ts';
import { layoutFor, layoutText } from './pdf.ts';
import { exportDownload, type ExportFormat } from './data-export.ts';
import type { Process } from '../metadata.ts';

// ?doc=NAME on a page: the document template filled with the page's session
// state (after the URL's checksummed item values), as the app's role; (104)
// without a template of that name, the report query of it.

/** (104) A report query: a named query printed as PDF, Excel, CSV, JSON, XML or HTML. */
interface ReportQuery {
  name: string;
  description: string | null;
  query: string;
  format: ExportFormat;
  layout: string | null;
  file_name: string | null;
  title: string | null;
  authz: string | null;
}

export async function renderDocument(ctx: PageContext, name: string) {
  const c = ctx.client!;
  // metadata through the runtime connection: the page's transaction already runs as the app's role
  const tpl = await runtime.one<DocumentTemplate>('select * from meta.document_template where app_id = $1 and name = upper($2)', [ctx.app.id, name.slice(0, 100)]);
  // (104) without a document template of that name, a report query of it
  const rq = tpl ? null : await runtime.one<ReportQuery>('select * from meta.report_query where app_id = $1 and name = upper($2)', [ctx.app.id, name.slice(0, 100)]);
  const found = tpl ?? rq;
  if (!found || !(await isAuthorized(ctx, found.authz))) throw new Forbidden(ctx.locale.t('error.document_unavailable'));
  // without signing in (a public page of an app that has sign-in) only the documents the page itself offers
  // with a visible document button: ?doc= on any public page would otherwise hand out every template
  if (ctx.app.authentication !== 'none' && !ctx.session.username) {
    const offered = [...(ctx.vis?.buttons.values() ?? [])].some((b) => b.action === 'document' && (b.document ?? '').toUpperCase() === found.name);
    if (!offered) throw new Forbidden(ctx.locale.t('error.document_unavailable'));
  }
  if (!tpl) {
    const q = rq!;
    const d = await exportDownload(ctx, { name: q.name, code: q.query } as Process, {
      export: q.format, layout: q.layout ?? undefined, file_name: q.file_name ?? undefined, title: q.title ?? q.description ?? undefined,
    });
    // sent like a download process's file (sandboxed, never shown as a page of the application)
    return { download: { ...d, inline: false } };
  }
  const now = new Date().toISOString();
  const data = await savepoint(c, () =>
    documentData(c, stripSemicolon(applyBinds(tpl.query, bindValues(ctx))), {
      APP_USER: ctx.user, APP_NAME: ctx.app.name, TODAY: now.slice(0, 10), NOW: now,
    }),
  );
  const html = fillTemplate(tpl.template, data, { fmt: ctx.locale.format, lang: ctx.locale.lang });
  const layout = await layoutFor(ctx.app.id, tpl.layout ?? undefined);
  const title = tpl.description ?? tpl.name;
  const extra = { REPORT_TITLE: title, APP_NAME: ctx.app.name, DATE: now.slice(0, 10), TIMESTAMP: `${now.slice(0, 16).replace('T', ' ')} UTC` };
  const file = await documentPdf({
    html,
    layout,
    title,
    author: ctx.user,
    footer: layout.footer === null ? title : layoutText(layout.footer, extra, ctx),
    pageLabel: (page, pages) => ctx.locale.t('pdf.page', { page: String(page), pages: String(pages) }),
  });
  return { file, type: 'application/pdf', name: documentFilename(substitute(tpl.filename ?? tpl.name.toLowerCase(), ctx, (v) => v)) };
}
