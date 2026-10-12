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
// processes answer (other types are refused).
//
// POST /a/:alias/:page/da/:id/download runs the download process a dynamic
// action of type "download" names and sends its file (app.js saves it).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { appTx, savepoint } from '../db.ts';
import { checkPageAccess, computeVisibility, Forbidden, isAuthorized } from './authz.ts';
import { publicError, toState, type PageContext } from './context.ts';
import { assignable, processConditionHolds, runSql } from './engine.ts';
import { downloadFile, downloadHeaders } from './processes.ts';
import { saveState } from '../session.ts';

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
        const p = ctx.page.processes.find((x) => x.point === 'ajax' && x.name === name);
        const ap = p ? undefined : ctx.app.app_processes.find((x) => x.point === 'ajax' && x.name === name);
        if (!p && !ap) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        if (p) {
          if (p.type !== 'sql') throw new Error(`Process "${p.name}": an Ajax callback runs SQL processes only.`);
          if (!(await isAuthorized(ctx, p.authz)) || !(await processConditionHolds(ctx, p))) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        } else if (!(await isAuthorized(ctx, ap!.authz))) throw new Forbidden(ctx.locale.t('error.unknown_da'));
        // the page's items the caller may change, as a submit would set them
        applyPostedItems(ctx, body, ctx.page.items.map((i) => i.name).filter((n) => n in body));
        const before = { ...ctx.session.state };
        const names = p ? assignable(ctx) : new Set(ctx.app.app_items);
        const res = await savepoint(c, () => runSql(ctx, (p ?? ap)!.code ?? '', names));
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
