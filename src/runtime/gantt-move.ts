import pg from 'pg';
import { applyBinds, literal } from '../binds.ts';
import { savepoint } from '../db.ts';
import type { Region } from '../metadata.ts';
import { Forbidden, isAuthorized } from './authz.ts';
import { wallClock } from './charts.ts';
import { bindValues, stripSemicolon, toState, type PageContext } from './context.ts';
import { resolveRestRegion } from './rest-sources.ts';

// Gantt chart drag and drop (sprint 69; APEX: the Gantt chart's task
// dragging): a chart region of kind "gantt" with config.gantt_move (SQL, e.g.
// an UPDATE or a function call) lets users drag a task to new dates or drag
// its end. POST /a/<app>/<page>/chart/<region>/move (routes.ts) checks the
// CSRF token, page access and the region's visibility; moveGanttTask() then
// checks config.gantt_move_authz, the dates, and that the task is one of the
// rows the region's query shows this user (as the application's role, so row
// level security applies), and runs the SQL with :TASK_ID, :NEW_START and
// :NEW_END in a savepoint of the request's transaction.

/** YYYY-MM-DD or YYYY-MM-DDTHH:MM (a day or an hour of the chart's time axis). */
const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** A target date's wall clock in ms, or NaN (also for impossible dates and years outside 1900–2200). */
export function targetTime(v: string): number {
  const m = WHEN.exec(v);
  if (!m || +m[1] < 1900 || +m[1] > 2200) return NaN;
  const t = wallClock(v.replace('T', ' '));
  // 2026-02-30 rolls over in Date.UTC: refuse what doesn't read back the same
  const d = new Date(t);
  return d.getUTCDate() === +m[3] && d.getUTCMonth() === +m[2] - 1 && (m[4] === undefined || (d.getUTCHours() === +m[4] && d.getUTCMinutes() === +m[5])) ? t : NaN;
}

/** May this user drag the region's tasks? */
export async function ganttEditable(ctx: PageContext, r: Region) {
  const cfg = r.config as Record<string, any>;
  return cfg.kind === 'gantt' && typeof cfg.gantt_move === 'string' && cfg.gantt_move.trim() !== '' && (await isAuthorized(ctx, cfg.gantt_move_authz ?? null));
}

/**
 * Give task `task` of a Gantt region the dates `start` and `end`. Throws Forbidden
 * when dragging isn't allowed or the task isn't one this user sees, RangeError for
 * dates that aren't valid. Returns the task's label (the query's first column).
 */
export async function moveGanttTask(ctx: PageContext, r: Region, task: string, start: string, end: string) {
  const t = ctx.locale.t;
  if (!(await ganttEditable(ctx, r))) throw new Forbidden(t('chart.gantt_cannot_move'));
  const s = targetTime(start);
  const e = targetTime(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) throw new RangeError(t('chart.gantt_bad_dates'));
  const c = ctx.client!;
  await resolveRestRegion(ctx, r);
  const src = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
  // the task_id column as the query names it (the chart finds it case-insensitively)
  const shape = await savepoint(c, () => c.query(`select * from (\n${src}\n) "__q" limit 0`));
  const idCol = shape.fields.find((f, i) => i > 2 && f.name.toLowerCase() === 'task_id');
  if (!idCol) throw new Forbidden(t('chart.gantt_cannot_move'));
  const res = await savepoint(c, () =>
    c.query({ text: `select * from (\n${src}\n) "__q" where "__q".${pg.escapeIdentifier(idCol.name)}::text = ${literal(task)} limit 2`, rowMode: 'array' }));
  if (res.rows.length !== 1) throw new Forbidden(t('chart.gantt_cannot_move'));
  const sql = stripSemicolon(applyBinds((r.config as Record<string, any>).gantt_move, { ...bindValues(ctx), TASK_ID: task, NEW_START: start, NEW_END: end }));
  await savepoint(c, () => c.query(sql));
  return { label: toState(res.rows[0][0]) ?? task };
}
