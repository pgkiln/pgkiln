import pg from 'pg';
import { owner, runtime } from './db.ts';

// Automations (Shared Components → Automations): SQL or PL/pgSQL on a cron
// schedule, run by the pgapex server as the application's database role.
// An automation has ordered actions (meta.automation_action), each with an
// optional condition, run once or once per row of a query. The actions run
// in PL/pgSQL (meta.automation_execute, migration 044), the same code that
// meta.run_automation() uses for runs from SQL; error handling "skip" rolls
// back a failing row only and records it in the run log.
//
// Every SCHEDULER_INTERVAL_S seconds the scheduler claims the automations
// that are due (FOR UPDATE SKIP LOCKED, so several servers don't take the
// same one), moves their next run forward and runs them. While one runs, a
// session advisory lock keeps a manual "Run now" from overlapping with it.
// AUTOMATIONS=off switches the scheduler off (e.g. on extra web servers).
// The same pass runs the synchronisations of REST data sources
// (src/restsync.ts: scheduled ones and runs queued from SQL) and the web
// requests queued from SQL with meta.web_request (src/webrequests.ts).

// ------------------------------------------------------------------ cron

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** day-of-month and day-of-week both restricted: either may match (as in cron) */
  either: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function field(text: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  const num = (s: string) => {
    const n = NAMES[s.toLowerCase()] ?? (/^\d+$/.test(s) ? Number(s) : NaN);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: "${s}" is not between ${min} and ${max}`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${label}: bad step in "${part}"`);
    let [from, to] = [min, max];
    if (range !== '*') {
      const [a, b] = range.split('-');
      from = num(a);
      to = b === undefined ? (stepText === undefined ? from : max) : num(b);
      if (to < from) throw new Error(`${label}: "${range}" runs backwards`);
    }
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

/** Parse "minute hour day-of-month month day-of-week" (or a macro such as @daily). */
export function parseCron(expr: string): Cron {
  const parts = (MACROS[expr.trim().toLowerCase()] ?? expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule has five fields: minute hour day-of-month month day-of-week (or @hourly, @daily, …)');
  const weekdays = field(parts[4], 0, 7, 'day of week');
  if (weekdays.delete(7)) weekdays.add(0); // 7 is Sunday too
  return {
    minutes: field(parts[0], 0, 59, 'minute'),
    hours: field(parts[1], 0, 23, 'hour'),
    days: field(parts[2], 1, 31, 'day of month'),
    months: field(parts[3], 1, 12, 'month'),
    weekdays,
    either: parts[2] !== '*' && parts[4] !== '*',
  };
}

export function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock time of an instant in a time zone. */
function wallClock(d: Date, fmt: Intl.DateTimeFormat) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WEEKDAY[p.weekday] };
}

/**
 * The first minute after `after` that matches the schedule in the time zone.
 * Hours that can't match are skipped a quarter of an hour at a time (time
 * zones are offset by whole quarters), matching hours a minute at a time.
 */
export function nextRun(cron: Cron, timeZone: string, after: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 5 * 366 * 86_400_000;
  while (t < limit) {
    const w = wallClock(new Date(t), fmt);
    const dayOk = cron.either ? cron.days.has(w.day) || cron.weekdays.has(w.weekday) : cron.days.has(w.day) && cron.weekdays.has(w.weekday);
    // to the next quarter of an hour: those are the same instants in every time zone
    const quarter = (15 - (w.minute % 15)) * 60_000;
    if (!cron.months.has(w.month) || !dayOk || !cron.hours.has(w.hour)) t += quarter;
    else if (cron.minutes.has(w.minute)) return new Date(t);
    else t += 60_000;
  }
  throw new Error('The schedule never matches (for example 30 February).');
}

/** A problem with a schedule and time zone, for the builder; null when fine. */
export function scheduleProblem(schedule: string, timeZone: string): string | null {
  if (!validTimeZone(timeZone)) return `Unknown time zone "${timeZone}" (use an IANA name such as Europe/Amsterdam or UTC).`;
  try {
    nextRun(parseCron(schedule), timeZone, new Date());
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// ------------------------------------------------------------------ running

export interface AutomationRow {
  id: number;
  app_id: number;
  name: string;
  schedule: string;
  time_zone: string;
  query: string | null;
  timeout_s: number;
  enabled: boolean;
  error_handling: 'stop' | 'skip' | 'disable';
}

export interface RowError {
  row: number;
  action: string;
  message: string;
  values?: string;
}

export interface RunResult {
  status: 'ok' | 'warning' | 'error' | 'busy';
  /** rows of the query processed (0 without a query) */
  rows?: number;
  /** rows that failed (error handling "skip") */
  failed?: number;
  errors?: RowError[];
  message?: string;
}

/** Advisory lock namespace of automation runs ("pgax"); meta.run_automation() uses it too. */
const LOCK_CLASS = 0x70676178;

/** What meta.automation_definition() returns: the automation, its actions and binds. */
interface Definition {
  id: number;
  app_id: number;
  name: string;
  timeout_s: number;
  db_role: string | null;
  error_handling: 'stop' | 'skip' | 'disable';
  binds: Record<string, string>;
}

/** The status of a run that finished without an error. */
export function runStatus(rows: number, failed: number): 'ok' | 'warning' | 'error' {
  return failed === 0 ? 'ok' : failed >= rows ? 'error' : 'warning';
}

/**
 * Run one automation now, as its application's database role, in one
 * transaction. Records the run in meta.automation_log.
 */
export async function runAutomation(id: number, trigger: 'schedule' | 'manual' = 'manual'): Promise<RunResult> {
  const lock = await owner.pool.connect();
  try {
    const got = (await lock.query('select pg_try_advisory_lock($1, $2) as ok', [LOCK_CLASS, id])).rows[0].ok;
    if (!got) return { status: 'busy', message: 'This automation is running already.' };
    try {
      const def: Definition | null = (await lock.query('select meta.automation_definition($1) as d', [id])).rows[0].d;
      if (!def) return { status: 'error', message: 'Automation not found.' };
      const log = (await lock.query('insert into meta.automation_log (automation_id, trigger) values ($1, $2) returning id', [id, trigger])).rows[0].id;
      let result: RunResult;
      try {
        const r = await execute(def);
        const status = runStatus(r.rows, r.failed);
        result = { status, rows: r.rows, failed: r.failed, errors: r.errors, ...(status === 'ok' ? {} : { message: `${r.failed} of ${r.rows} row(s) failed` }) };
      } catch (e) {
        result = { status: 'error', message: (e as Error).message.slice(0, 2000) };
      }
      const disable = result.status === 'error' && def.error_handling === 'disable';
      if (disable) result.message = `${result.message ?? 'The automation failed.'} (the automation was disabled)`;
      await lock.query(
        `update meta.automation_log set finished_at = now(), status = $2, rows = $3, rows_failed = $4, errors = $5, message = $6 where id = $1`,
        [log, result.status, result.rows ?? null, result.failed ?? null, result.errors?.length ? JSON.stringify(result.errors) : null, result.message?.slice(0, 2000) ?? null],
      );
      await lock.query(`update meta.automation set last_run_at = now(), last_status = $2, enabled = enabled and not $3 where id = $1`, [id, result.status, disable]);
      // keep the last 100 runs
      await lock.query(
        `delete from meta.automation_log where automation_id = $1 and id not in (select id from meta.automation_log where automation_id = $1 order by started_at desc, id desc limit 100)`,
        [id],
      );
      return result;
    } finally {
      await lock.query('select pg_advisory_unlock($1, $2)', [LOCK_CLASS, id]);
    }
  } finally {
    lock.release();
  }
}

/** The actions, as the application's role, through meta.automation_execute() (also used by meta.run_automation). */
async function execute(def: Definition): Promise<{ rows: number; failed: number; errors: RowError[] }> {
  return runtime.tx(async (c) => {
    await c.query(
      `select set_config('pgapex.app_user', $1, true), set_config('pgapex.app_id', $2, true),
              set_config('pgapex.automation_id', $3, true), set_config('pgapex.session_id', '', true),
              set_config('pgapex.automation_chain', $4, true), set_config('statement_timeout', $5, true)`,
      [def.binds.APP_USER, String(def.app_id), String(def.id), `,${def.id},`, `${def.timeout_s}s`],
    );
    if (def.db_role) await c.query(`set local role ${pg.escapeIdentifier(def.db_role)}`);
    return (await c.query('select meta.automation_execute($1::jsonb) as r', [JSON.stringify(def)])).rows[0].r;
  });
}

// ------------------------------------------------------------------ scheduler

/**
 * One scheduler pass: compute missing next runs, claim what is due (moving
 * its next run forward first) and run it. Returns the ids that ran.
 */
export async function tick(now = new Date()): Promise<number[]> {
  const due = await owner.tx(async (c) => {
    const rows = (
      await c.query<AutomationRow & { next_run_at: Date | null }>(
        `select id, schedule, time_zone, next_run_at from meta.automation
          where enabled and (next_run_at is null or next_run_at <= $1)
          order by next_run_at nulls first
          for update skip locked
          limit 50`,
        [now],
      )
    ).rows;
    const run: number[] = [];
    for (const a of rows) {
      let next: Date | null = null;
      try {
        next = nextRun(parseCron(a.schedule), a.time_zone, now);
      } catch {
        // an invalid schedule (edited in SQL) never runs; the builder shows why
      }
      if (a.next_run_at) run.push(a.id); // null: newly scheduled, first run at `next`
      await c.query('update meta.automation set next_run_at = $2 where id = $1', [a.id, next ?? new Date('9999-12-31T00:00:00Z')]);
    }
    return run;
  });
  for (const id of due) await runAutomation(id, 'schedule');
  return due;
}

let timer: NodeJS.Timeout | undefined;

export function startScheduler() {
  if (process.env.AUTOMATIONS === 'off' || timer) return;
  const every = Math.max(5, Number(process.env.SCHEDULER_INTERVAL_S ?? 30)) * 1000;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (e) {
      console.error('automations:', (e as Error).message);
    }
    try {
      // REST data source synchronisations: scheduled ones and runs queued from SQL (src/restsync.ts)
      await (await import('./restsync.ts')).syncTick();
    } catch (e) {
      console.error('REST synchronisation:', (e as Error).message);
    }
    try {
      // web requests queued from SQL (meta.web_request; src/webrequests.ts)
      await (await import('./webrequests.ts')).webRequestTick();
    } catch (e) {
      console.error('web requests:', (e as Error).message);
    }
    try {
      // debug messages past their retention (at most once an hour; src/debug.ts)
      await (await import('./debug.ts')).purgeDebug();
    } catch (e) {
      console.error('debug messages:', (e as Error).message);
    } finally {
      busy = false;
    }
  }, every);
  timer.unref();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
