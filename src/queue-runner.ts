import pg from 'pg';

// (sprint 177) The NOTIFY + polling loop of a queue the server works off (the web request outbox in
// src/webrequests.ts, webhook events in src/webhook-events.ts), as background process jobs do it
// (src/process-jobs.ts): the queueing SQL notifies a channel, a dedicated connection listens and wakes the
// worker at once; a timer polls as the fallback (a lost connection, a retry that falls due). The work itself
// is claimed with FOR UPDATE SKIP LOCKED and a lease, so several servers can share one queue.

export interface QueueRunner {
  /** run a pass now (or right after the one that runs) */
  wake: () => void;
  stop: () => Promise<void>;
}

export async function startQueueRunner(o: {
  channel: string;
  label: string;
  /** one pass over the queue */
  tick: () => Promise<unknown>;
  /** seconds until the next row falls due (null: nothing waits); the runner wakes then */
  nextDueS?: () => Promise<number | null>;
  pollS: number;
}): Promise<QueueRunner> {
  let busy = false;
  let again = false;
  let stopped = false;
  let due: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    if (busy) return void (again = true);
    busy = true;
    try {
      do {
        again = false;
        await o.tick();
      } while (again && !stopped);
      if (o.nextDueS && !stopped) {
        const s = await o.nextDueS();
        clearTimeout(due);
        if (s !== null && s < o.pollS) {
          due = setTimeout(() => void run(), Math.max(0.05, s) * 1000 + 20);
          due.unref();
        }
      }
    } catch (e) {
      console.error(`${o.label}:`, (e as Error).message);
    } finally {
      busy = false;
    }
  };
  let listener: pg.Client | undefined;
  try {
    listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    listener.on('notification', () => void run());
    listener.on('error', (e) => console.error(`${o.label} listener:`, e.message));
    await listener.query(`listen ${pg.escapeIdentifier(o.channel)}`);
  } catch (e) {
    listener = undefined;
    console.error(`${o.label}: no listener, polling only:`, (e as Error).message);
  }
  const timer = setInterval(() => void run(), o.pollS * 1000);
  timer.unref();
  void run();
  return {
    wake: () => void run(),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(due);
      await listener?.end().catch(() => {});
    },
  };
}

/** Seconds to wait before attempt n + 1 (n ≥ 1 attempts made): base × 2^(n−1), at most the cap, with ±20 % jitter. */
export function backoffS(attempts: number, baseS: number, capS: number, jitter = Math.random()): number {
  const s = Math.min(capS, baseS * 2 ** Math.max(0, Math.min(attempts, 30) - 1));
  return Math.max(0, Math.min(capS, s * (0.8 + 0.4 * jitter)));
}

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
/** The first retry's delay (QUEUE_RETRY_S, default 30 s) and the longest one (QUEUE_RETRY_MAX_S, default 1 hour). */
export const retryBaseS = () => num(process.env.QUEUE_RETRY_S, 30, 0, 3600);
export const retryCapS = () => num(process.env.QUEUE_RETRY_MAX_S, 3600, 0, 86400);
