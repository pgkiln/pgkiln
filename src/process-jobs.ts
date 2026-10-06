import { hostname } from 'node:os';
import pg from 'pg';
import type { FastifyRequest } from 'fastify';
import { PageCss } from './css.ts';
import { owner, runtime } from './db.ts';
import { loadApp, loadPage } from './metadata.ts';
import type { Session } from './session.ts';
import { publicError, type PageContext } from './runtime/context.ts';
import { assignable, ProcessFailed, runChain } from './runtime/engine.ts';
import { resolveLocale, translateApp, translatePage } from './runtime/locale.ts';

// Background execution chains (APEX: "Execute in background"). A chain
// process with {"background": true} is queued in meta.process_job by the
// submit that runs it (in the same transaction: nothing is queued when the
// submit fails); the server runs the queued jobs one after the other:
//
//  * claimed with FOR UPDATE SKIP LOCKED, so several servers can share the
//    queue and each job runs once;
//  * run in one transaction as the application's database role, with the
//    starter as meta.app_user() and their roles (meta.has_role reads them
//    from the job), and the page and application items of the moment it was
//    queued as binds (passwords left out); what the processes set is not
//    written back to the user's session;
//  * the job's state, current step, message or error are in meta.process_job
//    (the builder lists them) and, for its starter, in the view
//    meta.process_jobs that applications can show in a report;
//  * a running job whose server stopped (no heartbeat for two minutes) is
//    marked failed rather than run twice.
//
// Started with startProcessJobRunner() in server.ts (BACKGROUND_PROCESSES=off
// on servers that should not run them); NOTIFY pgapex_process_job wakes it,
// and it polls every PROCESS_JOB_INTERVAL_S seconds (default 10).

const WORKER = `${hostname()}:${process.pid}`;
const STALE = '2 minutes';
const HEARTBEAT_MS = 20_000;

interface Job {
  id: string;
  app_id: number;
  alias: string;
  db_role: string | null;
  page_no: number;
  process_id: number | null;
  app_user: string;
  roles: string[];
  lang: string | null;
  request: string | null;
  binds: Record<string, string | null>;
  /** (0.31) the tenant of the session that queued it ('': none) */
  tenant_id: string;
  statement_timeout: string;
}

async function finish(id: string, state: 'completed' | 'failed', message: string | null, error: string | null, done?: number) {
  await owner.query(
    `update meta.process_job set state = $2, message = $3, error = $4, ended_at = now(), updated_at = now(), current = null,
            steps_done = coalesce($5, steps_done), steps_total = case when $2 = 'completed' then coalesce($5, steps_total) else steps_total end
      where id = $1`,
    [id, state, message?.slice(0, 4000) ?? null, error?.slice(0, 4000) ?? null, done ?? null],
  );
}

/** Run one claimed job. */
async function runJob(job: Job) {
  const app = await loadApp(job.alias);
  const page = app ? await loadPage(app.id, job.page_no) : undefined;
  const chain = page?.processes.find((p) => p.id === job.process_id && p.type === 'chain');
  if (!app || !page || !chain) return finish(job.id, 'failed', null, 'The process no longer exists (or its build option is excluded).');
  const session: Session = { id: '', app_id: app.id, username: job.app_user, csrf_token: '', state: { ...job.binds }, roles: job.roles };
  const req = { url: job.lang ? `/?lang=${encodeURIComponent(job.lang)}` : '/', headers: {}, cookies: {} } as unknown as FastifyRequest;
  const locale = await resolveLocale(req, app, session);
  if (locale.lang !== app.language) {
    translateApp(app, locale.tr);
    translatePage(page, locale.tr);
  }
  const ctx: PageContext = {
    app, page, session, base: `/a/${app.alias}`, params: new URLSearchParams(), request: job.request ?? '', user: job.app_user,
    roles: job.roles, ip: 'background', errors: { page: [], items: {} }, messages: [], dialog: false, authzCache: new Map(),
    detached: [], css: new PageCss(), nonce: '', locale, background: true,
  };
  let done = 0;
  const heartbeat = setInterval(() => void owner.query('update meta.process_job set updated_at = now() where id = $1', [job.id]).catch(() => {}), HEARTBEAT_MS);
  try {
    const messages = await runtime.tx(async (c) => {
      await c.query(
        `select set_config('pgapex.app_user', $1, true), set_config('pgapex.app_id', $2, true), set_config('pgapex.session_id', '', true),
                set_config('pgapex.process_job_id', $3, true), set_config('statement_timeout', $4, true), set_config('pgapex.lang', $5, true),
                set_config('pgapex.tenant_id', $6, true)`,
        [job.app_user, String(app.id), job.id, job.statement_timeout, locale.lang, job.tenant_id],
      );
      if (app.db_role) await c.query(`set local role ${pg.escapeIdentifier(app.db_role)}`);
      ctx.client = c;
      return runChain(ctx, chain, assignable(ctx), 0, async (kid) => {
        await owner.query('update meta.process_job set current = $2, steps_done = $3, updated_at = now() where id = $1', [job.id, kid.name, done++]);
      });
    });
    const message = [...messages, ...(chain.success_message ? [chain.success_message] : [])].join(' ') || null;
    await finish(job.id, 'completed', message, ctx.errors.page.join(' ') || null, done);
  } catch (e) {
    const msg = e instanceof ProcessFailed ? e.message : await publicError(ctx, e, `background process "${chain.name}"`);
    await finish(job.id, 'failed', null, msg);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Claim the oldest queued job (several servers: each job once). */
async function claim(): Promise<Job | undefined> {
  return owner.one<Job>(
    `with next as (
       select id from meta.process_job where state = 'queued' order by id for update skip locked limit 1)
     update meta.process_job j set state = 'running', started_at = now(), updated_at = now(), worker = $1
       from next, meta.app a
      where j.id = next.id and a.id = j.app_id
     returning j.id::text, j.app_id, a.alias, a.db_role, j.page_no, j.process_id, j.app_user, j.roles, j.lang, j.request, j.binds, coalesce(j.tenant_id, '') as tenant_id,
               $2::text as statement_timeout`,
    [WORKER, process.env.STATEMENT_TIMEOUT ?? '30s'],
  );
}

/** Run queued jobs (at most `max`); also fails jobs whose server stopped and forgets old ones. Returns the number run. */
export async function runProcessJobs(max = 20): Promise<number> {
  await owner.query(
    `update meta.process_job set state = 'failed', error = 'The server running it stopped.', ended_at = now(), updated_at = now()
      where state = 'running' and updated_at < now() - $1::interval`,
    [STALE],
  );
  await owner.query(`delete from meta.process_job where state in ('completed', 'failed') and ended_at < now() - interval '30 days'`);
  let n = 0;
  for (; n < max; n++) {
    const job = await claim();
    if (!job) break;
    try {
      await runJob(job);
    } catch (e) {
      // pgapex's own failure (the database went away): record it if possible
      await finish(job.id, 'failed', null, (e as Error).message).catch(() => {});
    }
  }
  return n;
}

let listener: pg.Client | undefined;
let timer: NodeJS.Timeout | undefined;

/** Listen for queued jobs and poll for them every few seconds. */
export async function startProcessJobRunner() {
  if (process.env.BACKGROUND_PROCESSES === 'off' || timer) return;
  let busy = false;
  let again = false;
  const run = async () => {
    if (busy) return void (again = true);
    busy = true;
    try {
      do {
        again = false;
        await runProcessJobs();
      } while (again);
    } catch (e) {
      console.error('background processes:', (e as Error).message);
    } finally {
      busy = false;
    }
  };
  try {
    listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    listener.on('notification', () => void run());
    listener.on('error', (e) => console.error('background processes listener:', e.message));
    await listener.query('listen pgapex_process_job');
  } catch (e) {
    console.error('background processes: no listener, polling only:', (e as Error).message);
  }
  timer = setInterval(() => void run(), Math.max(2, Number(process.env.PROCESS_JOB_INTERVAL_S ?? 10)) * 1000);
  timer.unref();
  void run();
}
