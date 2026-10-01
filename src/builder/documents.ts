import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { applyBinds } from '../binds.ts';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { english } from '../i18n.ts';
import { documentData, documentPdf, fillTemplate, TemplateError } from '../runtime/document.ts';
import { dateFormatter } from '../runtime/format.ts';
import { layoutFor } from '../runtime/pdf.ts';
import { BASE, developer, type Req } from './ui.ts';

// Shared Components → Document templates → Preview: the template filled with
// item values typed by the developer, as the app's role (rolled back).

/** "P5_ID=42" lines → binds */
export const previewBinds = (text: string) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => /^\s*:?([A-Za-z][A-Za-z0-9_$]*)\s*=\s*(.*?)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1].toUpperCase(), m[2]]),
  );

export function documentExtras(appId: number, row: { id: number; query: string }) {
  const binds = [...new Set([...(row.query ?? '').matchAll(/(?<![:\w]):([A-Za-z][A-Za-z0-9_$]*)/g)].map((m) => m[1].toUpperCase()))];
  return html`<fieldset class="prop-group u-mt125"><legend>Preview</legend>
    <form method="get" action="${BASE}/apps/${appId}/documents/${row.id}/preview" target="_blank">
      <div class="field" data-wide><label class="label" for="f_doc_binds">Item values</label>
        <textarea id="f_doc_binds" name="binds" rows="3" placeholder="${binds.map((b) => `${b}=`).join('\n') || 'P1_ITEM=value'}">${binds.map((b) => `${b}=`).join('\n')}</textarea>
        <small class="help">One per line, NAME=value. The query runs as the application's database role and is rolled back.</small></div>
      <div class="buttons"><button class="btn">Preview PDF</button></div>
    </form></fieldset>`;
}

export async function documentRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/documents/:tid/preview`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, tid } = req.params;
    const a = /^\d+$/.test(id) ? await owner.one('select * from meta.app where id = $1', [id]) : undefined;
    const tpl = a && /^\d+$/.test(tid) ? await owner.one('select * from meta.document_template where id = $1 and app_id = $2', [tid, a.id]) : undefined;
    if (!a || !tpl) return reply.code(404).send('Not found');
    const binds = previewBinds(String(req.query.binds ?? ''));
    const c = await owner.pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local statement_timeout = '10s'`);
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true)`, [String(a.id), s.username ?? 'builder']);
      if (a.db_role) await c.query(`set local role ${pg.escapeIdentifier(a.db_role)}`);
      const now = new Date().toISOString();
      const data = await documentData(c, applyBinds(tpl.query.trim().replace(/;+\s*$/, ''), binds), { APP_USER: s.username ?? 'builder', APP_NAME: a.name, TODAY: now.slice(0, 10), NOW: now });
      const lang = a.language ?? 'en';
      const htmlOut = fillTemplate(tpl.template, data, { fmt: dateFormatter(lang, a.date_format, a.timestamp_format), lang });
      const layout = await layoutFor(a.id, tpl.layout ?? undefined);
      const file = await documentPdf({
        html: htmlOut, layout, title: tpl.description ?? tpl.name, author: s.username ?? 'builder',
        footer: `${tpl.description ?? tpl.name} · preview`, pageLabel: (p, n) => english('pdf.page', { page: String(p), pages: String(n) }),
      });
      return reply.type('application/pdf').header('content-disposition', `inline; filename="${tpl.name.toLowerCase()}-preview.pdf"`).send(file);
    } catch (e) {
      const msg = e instanceof TemplateError ? `Template: ${e.message}` : (e as Error).message;
      return reply.code(422).type('text/plain; charset=utf-8').send(`The preview failed: ${msg}`);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });
}
