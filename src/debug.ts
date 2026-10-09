// Debug messages (APEX debug). When an application's debug level is above 0,
// every request that loads a page context gets a DebugLog: timed entries of
// its steps, regions, processes and errors, plus the messages application SQL
// writes with meta.debug(level, text) (NOTICEs collected on the connection in
// db.ts appTx). After the response the log is stored with meta.debug_save()
// (migration 051). With debug off there is no log and nothing is written.
//
// Levels as in APEX: 1 error, 2 warning, 4 information, 6 trace, 9 everything.
// Item values are only written at level 9, and never those of password items.
import type { FastifyRequest } from 'fastify';
import { runtime } from './db.ts';

export const DEBUG_LEVELS: [number, string][] = [
  [0, 'Off'],
  [1, '1 errors'],
  [2, '2 warnings'],
  [4, '4 information'],
  [6, '6 trace (regions, processes, timings)'],
  [9, '9 everything (item values, SQL notices)'],
];

const MAX_ENTRIES = 2000;
const MAX_TEXT = 4000;

export interface DebugEntry {
  ms: number;
  dur?: number;
  level: number;
  component: string;
  text: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

export class DebugLog {
  readonly started = performance.now();
  readonly startedAt = new Date();
  readonly entries: DebugEntry[] = [];
  dropped = 0;
  pageNo: number | null = null;
  username: string | null = null;
  sessionId: string | null = null;
  saved = false;

  constructor(
    readonly appId: number,
    readonly level: number,
    readonly method: string,
    readonly path: string,
  ) {}

  on(level: number) {
    return level >= 1 && level <= this.level;
  }

  add(level: number, component: string, text: string): DebugEntry | null {
    if (!this.on(level)) return null;
    if (this.entries.length >= MAX_ENTRIES) {
      this.dropped++;
      return null;
    }
    const e: DebugEntry = { ms: round(performance.now() - this.started), level, component, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text };
    this.entries.push(e);
    return e;
  }

  /** Run `fn` as a timed step: the entry is written when the step starts, its duration when it ends. */
  async time<T>(level: number, component: string, text: string, fn: () => Promise<T>): Promise<T> {
    const e = this.add(level, component, text);
    if (!e) return fn();
    const t0 = performance.now();
    try {
      return await fn();
    } catch (err) {
      e.text += ` (failed: ${(err as Error).message})`;
      throw err;
    } finally {
      e.dur = round(performance.now() - t0);
    }
  }

  /** A NOTICE from the database: meta.debug() messages, other notices and warnings at level 9 / 2. */
  notice(msg: { message?: string; detail?: string; hint?: string; severity?: string }) {
    if (msg.detail === 'pgkiln.debug') {
      const level = Number(msg.hint);
      this.add(Number.isInteger(level) ? level : 4, 'meta.debug', msg.message ?? '');
    } else if (msg.severity === 'WARNING') this.add(2, 'sql', `warning: ${msg.message ?? ''}`);
    else this.add(9, 'sql', `${(msg.severity ?? 'notice').toLowerCase()}: ${msg.message ?? ''}`);
  }

  async save(status: number) {
    if (this.saved) return;
    this.saved = true;
    if (this.dropped) this.entries.push({ ms: round(performance.now() - this.started), level: 1, component: 'debug', text: `${this.dropped} more entries left out (at most ${MAX_ENTRIES} per request)` });
    await runtime.query('select meta.debug_save($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)', [
      this.appId, this.pageNo, this.username, this.sessionId, this.method, this.path, status, this.level,
      this.startedAt.toISOString(), round(performance.now() - this.started), JSON.stringify(this.entries),
    ]);
  }
}

/** The log of a request (set by loadContext in runtime/routes.ts). */
const logs = new WeakMap<FastifyRequest, DebugLog>();

/** Start a debug log for this request when the application is in debug. */
export function startDebug(req: FastifyRequest, app: { id: number; debug_level?: number | null }): DebugLog | undefined {
  const level = Number(app.debug_level ?? 0);
  if (!(level > 0)) return undefined;
  const existing = logs.get(req);
  if (existing) return existing;
  const log = new DebugLog(app.id, level, req.method, req.url.split('?')[0].slice(0, 500));
  const query = req.url.includes('?') ? new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1)) : null;
  // parameter names only: their values can be item values
  log.add(4, 'request', `${req.method} ${log.path}${query && [...query.keys()].length ? ` (parameters: ${[...new Set(query.keys())].join(', ')})` : ''}`);
  logs.set(req, log);
  return log;
}

export const debugOf = (req: FastifyRequest) => logs.get(req);

/** Store a request's log after the response (Fastify onResponse hook); never fails the request. */
export async function finishDebug(req: FastifyRequest, status: number) {
  const log = logs.get(req);
  if (!log) return;
  logs.delete(req);
  log.add(4, 'response', `status ${status}`);
  try {
    await log.save(status);
  } catch (e) {
    req.log.warn({ err: e }, 'debug messages not saved');
  }
}

/** Delete debug messages past their retention (the automations scheduler calls this at most once an hour). */
let lastPurge = 0;
export async function purgeDebug(now = Date.now()) {
  if (now - lastPurge < 3600_000) return 0;
  lastPurge = now;
  return (await runtime.one<{ n: number }>('select meta.debug_purge() as n'))?.n ?? 0;
}
