import { owner, type Client } from '../db.ts';
import { generate, type CallInfo } from './service.ts';
import { AiError } from './types.ts';

// AI requests from SQL (migration 060): application SQL queues one with
// meta.ai_generate(service, prompt, system, schema) and reads the answer
// with meta.ai_result(id). Like meta.web_request (src/webrequests.ts), the
// server makes the call:
// - right after the page process (type sql) that queued it, in the same
//   transaction (runPendingAi, at most 3 per process);
// - otherwise after the caller commits, on the scheduler's next pass
//   (aiRequestTick).
// The prompt is sent as the developer's SQL built it (no &ITEM.
// substitutions); every call goes through generate(): the service must be
// allowed for the application, the daily limits apply, usage is logged.
// Requests and answers are kept 24 hours.

interface Pending {
  id: string;
  app_id?: number;
  requested_by?: string | null;
  service: string;
  system_prompt: string | null;
  prompt: string;
  schema: Record<string, unknown> | null;
}

const PER_PASS = 20;
const PARALLEL = 3;
const KEEP_HOURS = 24;

async function execute(r: Pending, info: CallInfo): Promise<{ status: 'ok' | 'refused' | 'error'; response: string | null; message: string | null }> {
  try {
    const res = await generate(r.service, { system: r.system_prompt, prompt: r.prompt, schema: r.schema }, info);
    return { status: 'ok', response: r.schema ? JSON.stringify(res.json) : res.text, message: res.truncated ? 'The answer was cut off at the output limit.' : null };
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError('server', 'The AI request failed.');
    return { status: err.kind === 'refused' ? 'refused' : 'error', response: null, message: err.message };
  }
}

/** The AI requests the current transaction queued (a page process): made now, answered in the same transaction. */
export async function runPendingAi(c: Client, info: Omit<CallInfo, 'source'>) {
  const taken = (await c.query<Pending>('select * from meta.ai_request_take(3)')).rows;
  for (const r of taken) {
    const res = await execute(r, { ...info, source: 'sql' });
    await c.query('select meta.ai_request_done($1, $2, $3, $4)', [r.id, res.status, res.response, res.message]);
  }
  return taken.length;
}

let lastPurge = 0;

/** Remove old requests (at most every 5 minutes, unless forced). */
export async function purgeAiRequests(force = false) {
  if (!force && Date.now() - lastPurge < 5 * 60_000) return;
  lastPurge = Date.now();
  await owner.query(
    `update meta.ai_request set status = 'error', finished_at = now(), message = 'The request was interrupted (the server stopped while it ran).'
      where status = 'running' and started_at < now() - interval '30 minutes'`,
  );
  await owner.query(
    `update meta.ai_request set status = 'error', finished_at = now(), message = 'The request was not run within 24 hours (is the scheduler switched off? AUTOMATIONS=off).'
      where status = 'queued' and requested_at < now() - interval '${KEEP_HOURS} hours'`,
  );
  await owner.query(`delete from meta.ai_request where finished_at < now() - interval '${KEEP_HOURS} hours'`);
}

/** One scheduler pass: claim committed queued requests (SKIP LOCKED) and make them, a few at a time. */
export async function aiRequestTick(): Promise<string[]> {
  const claimed = (
    await owner.query<Pending & { app_id: number }>(
      `update meta.ai_request l set status = 'running', started_at = now()
        where l.id in (select id from meta.ai_request where status = 'queued' order by id for update skip locked limit ${PER_PASS})
        returning l.id, l.app_id, l.requested_by, l.service, l.system_prompt, l.prompt, l.schema`,
    )
  ).rows.sort((a, b) => Number(a.id) - Number(b.id));
  const queue = [...claimed];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const res = await execute(r, { appId: r.app_id, user: r.requested_by ?? null, source: 'sql' });
      await owner.query(
        `update meta.ai_request set status = $2, finished_at = now(), response = $3, message = left($4, 2000) where id = $1 and status = 'running'`,
        [r.id, res.status, res.response, res.message],
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  await purgeAiRequests();
  return claimed.map((r) => r.id);
}
