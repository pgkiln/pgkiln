import type { FastifyInstance } from 'fastify';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { isAdmin } from './locks.ts';
import { BASE, developer, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { SQL_TOOLS, toolDescription, toolLabel } from './sql-tools.ts';
import { tr } from './i18n.ts';

// (sprint 179, Database Actions DA-9 / DA-15 leftover: the guided tour) SQL Workshop › Take the tour: a walk
// through the workshop's main tools, a step per tool: what it is for (the Launchpad's own description), something
// to try, and a button that opens it. Plain pages (/builder/sql/tour?step=n): no script, nothing stored.

export const TOUR = `${BASE}/sql/tour`;
/** The tools of the tour, in the order a new developer meets them (keys of SQL_TOOLS). */
export const TOUR_STEPS = ['worksheet', 'objects', 'load', 'quicksql', 'rest', 'changes', 'monitor'] as const;

export async function sqlTourRoutes(app: FastifyInstance) {
  app.get(TOUR, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const tx = tr(s);
    const admin = await isAdmin(s.username);
    // a step for each tool this developer has (SQL Monitor is the administrators')
    const steps = TOUR_STEPS.map((k) => SQL_TOOLS.find((t) => t.key === k)!).filter((t) => admin || !t.admin);
    const n = Math.min(Math.max(Number.parseInt(String(req.query.step ?? '1'), 10) || 1, 1), steps.length);
    const t = steps[n - 1];
    const url = (i: number) => `${TOUR}?step=${i}`;
    const nav = html`<nav class="settings-tabs" aria-label="${tx('tour.title')}">${steps.map((x, i) =>
      html`<a href="${url(i + 1)}"${i + 1 === n ? raw(' aria-current="step"') : ''}>${i + 1}. ${toolLabel(tx, x)}</a>`)}</nav>`;
    const card = html`<p class="muted small u-mt0">${tx('tour.step', { n, total: steps.length })}</p>
      <p class="lead">${toolDescription(tx, t)}</p>
      <p><strong>${tx('tour.try')}</strong> ${tx.dyn(`tour.try.${t.key}`, '')}</p>
      <div class="buttons">
        ${n > 1 ? html`<a class="btn" href="${url(n - 1)}">${tx('tour.previous')}</a>` : ''}
        <a class="btn" href="${t.href}">${icon(t.icon)} ${tx('tour.open', { tool: toolLabel(tx, t) })}</a>
        ${n < steps.length ? html`<a class="btn btn-hot" href="${url(n + 1)}">${tx('tour.next')}</a>` : html`<a class="btn btn-hot" href="${BASE}/sql">${tx('tour.done')}</a>`}
      </div>`;
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('home', s)}
      <p class="muted">${tx('tour.intro')}</p>${nav}${region(toolLabel(tx, t), card)}
      ${n === steps.length ? html`<p class="muted">${tx.rich('tour.after', { pin: icon('pin') })}</p>` : ''}`;
    return send(reply, s, shell(s, tx('tour.title'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('tour.title')]], main, 'sql'));
  });
}
