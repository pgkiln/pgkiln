// Ajax callbacks (APEX: On Demand processes, apex.server.process) and the
// dynamic action "download", migration 085.
//
// POST /a/:alias/:page/ajax/:name runs the page process (point "ajax") or,
// failing that, the application process (point "ajax") with that name, as the
// application's role, and answers JSON: the last statement's rows, the first
// row as `data`, and the values of the page and application items it set.
// The caller may post the page's items it may change (as a submit would) and
// x01 … x10, which are binds :X01 … :X10. CSRF token, page access, the
// process's authorization, condition and build option all apply; only SQL
// processes answer (other types are refused). (sprint 240, MG-8) A chain of
// SQL processes answers too (the last step's rows); the web requests a step
// queues are made right after it, as after a page process.
//
// POST /a/:alias/:page/da/:id/download runs the download process a dynamic
// action of type "download" names and sends its file (app.js saves it).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appTx, savepoint } from '../db.ts';
import { checkPageAccess, computeVisibility, Forbidden, isAuthorized } from './authz.ts';
import { publicError, toState, type PageContext } from './context.ts';
import { assignable, chainChildren, makeWebRequests, processConditionHolds, runSql, shouldRun } from './engine.ts';
import { INTERACTIVE_BUDGET_MS } from '../webrequests.ts';
import type { Process } from '../metadata.ts';
import { downloadFile, downloadHeaders } from './processes.ts';
import { saveState } from '../session.ts';
import { renderPendingDocuments } from './document-pdf.ts';

type Loader = (req: any, reply: FastifyReply, opts?: { json?: boolean }) => Promise<PageContext | null>;
type Tx = (ctx: PageContext) => Parameters<typeof appTx>[0];
type Body = Record<string, unknown>;
type Apply = (ctx: PageContext, body: any, only?: string[]) => void;

/** At most this many rows come back. */
export const AJAX_MAX_ROWS = 1000;
const X_PARAMS = Array.from({ length: 10 }, (_, i) => `x${String(i + 1).padStart(2, '0')}`);

const jsonSafe = (v: unknown): unknown => (typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? v.toString('base64') : v);

export function ajaxRoutes(app: FastifyInstance, loadContext: Loader, txContext: Tx, applyPostedItems: Apply) {
  app.post('/a/:alias/:page/ajax/:name', async (req: any, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = (req.body ?? {}) as Body;
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: ctx.locale.t('error.session_reload') });
    const name = String(req.params.name ?? '');
    ctx.extraBinds = Object.fromEntries(X_PARAMS.map((x) => [x.toUpperCase(), typeof body[x] === 'string' ? String(body[x]).slice(0, 32000) : null]));
    try {
      const out = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        await computeVisibility(ctx);
        // (sprint 240) a chain's child runs only inside its chain (with the chain's authorization and condition)
        const p = ctx.page.processes.find((x) => x.point === 'ajax' && x.name === name && !x.parent_process);
        const ap = p ? undefined : ctx.app.app_processes.find((x) => x.point === 'ajax' && x.name === name);
        if (!p && !ap) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        if (p) {
          if (p.type !== 'sql' && (p.type !== 'chain' || (p.config as { background?: boolean } | null)?.background))
            throw new Error(`Process "${p.name}": an Ajax callback runs an SQL process or a chain of SQL processes only.`);
          if (!(await isAuthorized(ctx, p.authz)) || !(await processConditionHolds(ctx, p))) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        } else if (!(await isAuthorized(ctx, ap!.authz))) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        // the page's items the caller may change, as a submit would set them
        applyPostedItems(ctx, body, ctx.page.items.map((i) => i.name).filter((n) => n in body));
        const before = { ...ctx.session.state };
        const names = p ? assignable(ctx) : new Set(ctx.app.app_items);
        // (sprint 240, MG-8) a chain's SQL processes run in sequence, each with its button, authorization and condition;
        // the web requests a step queued are made right after it (within INTERACTIVE_BUDGET_MS for the whole call),
        // so the next step reads meta.web_response(); the answer is the last step's rows
        const steps = p?.type === 'chain' ? chainChildren(ctx, p) : [(p ?? ap)!];
        const deadline = Date.now() + INTERACTIVE_BUDGET_MS;
        let res: Awaited<ReturnType<typeof runSql>> = undefined;
        for (const step of steps) {
          if (step !== p && step !== ap) {
            if ((step as Process).type !== 'sql') throw new Error(`Process "${step.name}": a chain called as an Ajax callback runs SQL processes only.`);
            if (!(await shouldRun(ctx, step as Process))) continue;
          }
          res = await savepoint(c, async () => {
            const r = await runSql(ctx, step.code ?? '', names);
            await renderPendingDocuments(ctx); // (sprint 237) meta.document_pdf for mail
            return r;
          });
          await makeWebRequests(ctx, Math.max(0, deadline - Date.now()));
        }
        const rows = ((res?.rows ?? []) as Record<string, unknown>[]).slice(0, AJAX_MAX_ROWS)
          .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonSafe(v)])));
        const items = Object.fromEntries([...names].filter((n) => ctx.session.state[n] !== before[n]).map((n) => [n, toState(ctx.session.state[n]) ?? '']));
        return { data: rows[0] ?? null, rows, items };
      });
      await saveState(ctx.session);
      return reply.header('cache-control', 'no-store').send(out);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, `Ajax callback "${name}"`) });
    }
  });

  app.post('/a/:alias/:page/da/:id/download', async (req: any, reply) => {
    const ctx = await loadContext(req, reply, { json: true });
    if (!ctx) return;
    const body = (req.body ?? {}) as Body;
    if (body.__csrf !== ctx.session.csrf_token) return reply.code(403).send({ error: ctx.locale.t('error.session_reload') });
    try {
      const file = await appTx(txContext(ctx), async (c) => {
        ctx.client = c;
        await checkPageAccess(ctx);
        const vis = await computeVisibility(ctx);
        const da = ctx.page.dynamic_actions.find((d) => d.id === Number(req.params.id));
        if (!da || da.action !== 'download' || !vis.dynamicActions.has(da.id)) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        const p = ctx.page.processes.find((x) => x.type === 'download' && x.name === (da.code ?? '').trim());
        if (!p) throw new Error(`Dynamic action "${da.name}": there is no download process named "${(da.code ?? '').trim()}" on this page.`);
        if (!(await isAuthorized(ctx, p.authz)) || !(await processConditionHolds(ctx, p))) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        applyPostedItems(ctx, body, (da.items_to_submit ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
        return downloadFile(ctx, p);
      });
      await saveState(ctx.session);
      return reply.headers({ ...downloadHeaders(file), 'cache-control': 'private, no-store' }).send(file.content);
    } catch (e) {
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      return reply.code(400).send({ error: await publicError(ctx, e, 'download') });
    }
  });
}
