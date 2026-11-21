import { runtime } from '../db.ts';
import { isAuthorized } from './authz.ts';
import { dbg, type PageContext } from './context.ts';
import { documentFilename, type DocumentTemplate } from './document.ts';
import { templatePdf } from './documents.ts';

// (sprint 237, MG-3) PDF bytes of a document template for mail, without the browser.
//
// SQL can't run the renderer (it is Node), so meta.document_pdf(template, items) returns a reference
// (migration 192). Right after the process that called it, renderPendingDocuments draws each reference that
// became a mail attachment and puts the PDF in its place, in the same transaction (as the app's role, with the
// data as the process left it) before anything commits. A send_email process's {"document": …} attachments are
// drawn here directly (documentAttachment). (sprint 245, MG-18) meta.document_temp_file(template, items, filename)
// gives the id of a temporary file of the session (migration 202) that is drawn here the same way, so the next
// process reads the PDF from meta.temp_files.

/** Item values over the session state: binds of the template's query and its file name (built-ins still win). */
function withItems(ctx: PageContext, items: Record<string, string | null>): PageContext {
  return { ...ctx, session: { ...ctx.session, state: { ...ctx.session.state, ...items } } };
}

/** An application's own template, if the user may have it (its authorization scheme, as for a download). */
async function ownTemplate(ctx: PageContext, name: string): Promise<DocumentTemplate> {
  const tpl = await runtime.one<DocumentTemplate>('select * from meta.document_template where app_id = $1 and name = upper($2)', [ctx.app.id, name.slice(0, 100)]);
  if (!tpl) throw new Error(`The application has no document template ${name}.`);
  if (!(await isAuthorized(ctx, tpl.authz))) throw new Error(`Document template ${tpl.name}: ${ctx.locale.t('error.document_unavailable')}`);
  return tpl;
}

/** A document template as PDF with these item values over the session state. */
export async function documentAttachment(ctx: PageContext, name: string, items: Record<string, string | null>) {
  const tpl = await ownTemplate(ctx, name);
  return templatePdf(withItems(ctx, items), tpl);
}

/**
 * The references of meta.document_pdf that became attachments of mails this transaction queued, and (sprint 245,
 * MG-18) the temporary files of meta.document_temp_file of this session: drawn now and put in their place. Called
 * after each process (and Ajax callback, dynamic action SQL, application process); cheap when there are none (one query).
 */
export async function renderPendingDocuments(ctx: PageContext) {
  const c = ctx.client!;
  const pending = (await c.query<{ kind: 'mail' | 'temp_file'; ref: string; template: string; items: Record<string, string | null>; filename: string | null }>(
    'select kind, ref, template, items, filename from meta.document_pending($1)', [ctx.app.id])).rows;
  for (const p of pending) {
    const doc = await documentAttachment(ctx, p.template, p.items ?? {});
    if (p.kind === 'mail') {
      await c.query('select meta.document_pdf_fill($1, $2)', [p.ref, doc.file]);
      dbg(ctx, 6, 'process', () => `document ${p.template} drawn for mail attachment ${p.ref} (${doc.file.length} bytes)`);
    } else {
      const name = p.filename ? documentFilename(p.filename) : doc.name;
      await c.query('select meta.document_temp_file_fill($1, $2, $3)', [p.ref, doc.file, name]);
      dbg(ctx, 6, 'process', () => `document ${p.template} drawn into temporary file ${p.ref} (${name}, ${doc.file.length} bytes)`);
    }
  }
  return pending.length;
}
