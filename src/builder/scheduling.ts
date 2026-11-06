import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  cronTimeZone, describeSchedule, EN_WORDS_TEXT, formatRun, joinSchedule, nextRuns, parseSchedule, PRESETS, ScheduleError, splitSchedule, type CronFields,
} from '../cron-schedule.ts';
import {
  activeSql, applySql, checkJob, countPurge, cronState, jobSql, listJobs, listRuns, oneJob, purgeSql, reviewDigest, RUN_STATUSES, runNow, unscheduleSql,
  type CronState, type Job, type JobSpec,
} from '../pgcron.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { tr, translatorFor, type BuilderKey, type BuilderTranslate } from './i18n.ts';

// (sprint 101, Database Actions DA-12) SQL Workshop › Scheduling: pg_cron's jobs (cron.job) with their schedule in
// words and next runs, the last run and recent failures; create, edit, disable, unschedule and run now; the run
// history (cron.job_run_details) with filters and purge. Every change is shown as SQL first and applied in one
// transaction on the owner connection. Without pg_cron: how to install it, and pgkiln's own scheduled work
// (automations and background process jobs), read-only. Administrators only. Schedules: src/cron-schedule.ts;
// catalog and SQL: src/pgcron.ts; the builder's live preview: public/builder.js (data-cron-*).

const URL_BASE = `${BASE}/sql/scheduling`;
const jobUrl = (id: string) => `${URL_BASE}/job/${id}`;
const crumbs = (tx: BuilderTranslate, ...more: [string, string?][]): [string, string?][] => [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.scheduling'), more.length ? URL_BASE : undefined], ...more];

const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
const chk = (on: boolean) => (on ? raw(' checked') : '');
const sel = (on: boolean) => (on ? raw(' selected') : '');
const errorList = (errors: string[]) =>
  errors.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : '';
/** (sprint 162) the schedule's phrases in the builder's language (cron.* keys, English in src/cron-schedule.ts) */
const cronWords = (tx: BuilderTranslate) => (k: string) => tx.dyn(k, EN_WORDS_TEXT[k] ?? k);
const jobName = (tx: BuilderTranslate, j: { jobname: string | null; jobid: string }) => j.jobname ?? tx('cr.job_n', { id: j.jobid });

/** An administrator's session, or null (a 403 page sent). */
async function admin(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return null;
  if (await isAdmin(s.username)) return s;
  const tx = tr(s);
  const main = html`<h1 class="u-mb1">${tx('sql.tool.scheduling')}</h1><div class="alert alert-error" role="alert">${tx('cr.admins_only')}</div>`;
  await send(reply.code(403), s, shell(s, tx('sql.tool.scheduling'), crumbs(tx), main, 'sql'));
  return null;
}

const head = (s: Session, title: string, actions: Raw | '' = '') => html`<h1 class="u-mb1">${tr(s)('rail.sql_workshop')}</h1>${workshopTabs('scheduling', s)}
  <div class="ide-head-title u-mb1"><div><h2 class="u-m0 u-break">${title}</h2></div>${actions ? html`<div class="buttons ide-head-actions">${actions}</div>` : ''}</div>`;

// ------------------------------------------------------------------ schedule preview

/** A schedule in words and its next five runs, or why it doesn't parse. */
export function schedulePreview(text: string, timeZone: string, tx: BuilderTranslate = translatorFor('en')): Raw {
  try {
    const sc = parseSchedule(text);
    const runs = nextRuns(sc, new Date(), 5, cronTimeZone(timeZone));
    return html`<p class="u-m0"><strong>${describeSchedule(sc, cronWords(tx), tx.lang)}</strong></p>
      ${runs.length ? html`<p class="muted small u-m0">${tx('cr.next_runs', { tz: timeZone })}</p><ol class="cron-runs">${runs.map((d) => html`<li><time>${formatRun(d, cronTimeZone(timeZone), sc.kind === 'seconds')}</time></li>`)}</ol>`
        : html`<p class="muted small">${tx('cr.no_times')}</p>`}`;
  } catch (e) {
    if (!(e instanceof ScheduleError)) throw e;
    return html`<p class="u-m0 cron-error" role="alert">${e.message}</p>`;
  }
}

/** The next run of a job, for the list. */
function nextRun(tx: BuilderTranslate, job: Job, timeZone: string): Raw | string {
  if (!job.active) return html`<span class="muted">${tx('cr.inactive')}</span>`;
  try {
    const sc = parseSchedule(job.schedule);
    const [d] = nextRuns(sc, new Date(), 1, cronTimeZone(timeZone));
    return d ? formatRun(d, cronTimeZone(timeZone), sc.kind === 'seconds') : html`<span class="muted">${tx('cr.at_start')}</span>`;
  } catch {
    return html`<span class="muted">?</span>`;
  }
}

const words = (tx: BuilderTranslate, schedule: string) => {
  try {
    return describeSchedule(parseSchedule(schedule), cronWords(tx), tx.lang);
  } catch (e) {
    return e instanceof ScheduleError ? e.message : tx('cr.unreadable');
  }
};

const statusTag = (tx: BuilderTranslate, status: string | null) => status === null ? html`<span class="muted">${tx('cr.never_ran')}</span>`
  : html`<span class="tag ${status === 'succeeded' ? 'tag-ok' : status === 'failed' ? 'tag-error' : 'tag-info'}">${tx.dyn(`cr.status.${status}`, status)}</span>`;
const secs = (n: number | null) => (n === null ? '' : n >= 100 ? `${n.toFixed(0)} s` : `${n.toFixed(n >= 1 ? 1 : 3)} s`);

// ------------------------------------------------------------------ without pg_cron

function installNote(tx: BuilderTranslate, st: Exclude<CronState, { ok: true }>): Raw {
  // element content needs only & < > escaped (quotes stay readable: shared_preload_libraries = 'pg_cron')
  const c = (x: string) => raw(`<code>${x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`);
  const steps = html`<ol class="u-m0">
      <li>${tx.rich('cr.step1', { apt: c('apt install postgresql-17-cron') })}</li>
      <li>${tx.rich('cr.step2', { conf: c('postgresql.conf'), alter: c('alter system set …'), preload: c("shared_preload_libraries = 'pg_cron'"), db: c(`cron.database_name = '${st.database}'`), tz: c('cron.timezone') })}</li>
      <li>${tx.rich('cr.step3', { create: c('create extension pg_cron;') })}</li>
    </ol>`;
  const why = {
    not_available: html`${tx('cr.why.not_available')}`,
    not_loaded: tx.rich('cr.why.not_loaded', { preload: c('shared_preload_libraries') }),
    other_database: tx.rich('cr.why.other_database', { other: c(st.cronDatabase ?? 'postgres'), setting: c('cron.database_name'), db: c(st.database), set: c(`cron.database_name = '${st.database}'`), fn: c('cron.schedule_in_database') }),
    not_created: html`${tx('cr.why.not_created')}`,
    no_access: tx.rich('cr.why.no_access', { message: st.message ?? '', grant: c('grant usage on schema cron to …') }),
    old: tx.rich('cr.why.old', { version: st.message ?? '?', fn1: c('cron.schedule_in_database'), fn2: c('cron.alter_job'), update: c('alter extension pg_cron update;') }),
  }[st.reason];
  return html`<div class="alert alert-info" role="status"><p class="u-mt0"><strong>${why}</strong></p>
    ${st.reason === 'no_access' || st.reason === 'old' ? '' : html`<p>${tx('cr.to_schedule')}</p>${steps}`}
    <p class="u-m0">${tx.rich('cr.own_scheduler', { automations: html`<strong>${tx('cr.automations_path')}</strong>`, jobs: html`<strong>${tx('cr.process_jobs_lower')}</strong>` })}</p></div>`;
}

/** pgkiln's own scheduled work: automations and recent process jobs, read-only. */
async function pgkilnWork(tx: BuilderTranslate): Promise<Raw> {
  const automations = (await owner.query<{ app_id: number; alias: string; id: number; name: string; enabled: boolean; schedule: string; time_zone: string; next_run: string | null; last_run: string | null; last_status: string | null }>(
    `select a.id as app_id, a.alias, x.id, x.name, x.enabled, x.schedule, x.time_zone,
            to_char(x.next_run_at at time zone x.time_zone, 'YYYY-MM-DD HH24:MI') as next_run,
            to_char(x.last_run_at at time zone x.time_zone, 'YYYY-MM-DD HH24:MI') as last_run, x.last_status
       from meta.automation x join meta.app a on a.id = x.app_id order by lower(a.alias), lower(x.name) limit 500`)).rows;
  const jobs = (await owner.query<{ id: string; app_id: number; alias: string; name: string; state: string; app_user: string; queued: string; ended: string | null; error: string | null }>(
    `select j.id::text, a.id as app_id, a.alias, j.name, j.state, j.app_user, to_char(j.queued_at, 'YYYY-MM-DD HH24:MI:SS') as queued,
            to_char(j.ended_at, 'YYYY-MM-DD HH24:MI:SS') as ended, j.error
       from meta.process_job j join meta.app a on a.id = j.app_id order by j.id desc limit 20`)).rows;
  const L = { app: tx('sm.col.application'), automation: tx('cr.col.automation'), schedule: tx('cr.col.schedule'), next: tx('cr.col.next_run'), last: tx('cr.col.last_run'), job: tx('dp.col.job'), state: tx('sm.col.state'), by: tx('cr.col.started_by'), queued: tx('cr.col.queued'), ended: tx('cr.col.ended') };
  return html`${region(tx('cr.automations'), html`<p class="muted u-mt0">${tx('cr.automations_intro')}</p>
      <div class="table-wrap"><table class="report report-reflow cron-list"><thead><tr><th>${L.app}</th><th>${L.automation}</th><th>${L.schedule}</th><th>${L.next}</th><th>${L.last}</th></tr></thead>
      <tbody>${automations.length ? automations.map((x) => html`<tr>
        <td data-label="${L.app}"><a href="${BASE}/apps/${x.app_id}">${x.alias}</a></td>
        <td data-label="${L.automation}" class="u-break"><a href="${BASE}/apps/${x.app_id}/shared?c=automation-${x.id}">${x.name}</a>${x.enabled ? '' : html` <span class="tag">${tx('cr.disabled')}</span>`}</td>
        <td data-label="${L.schedule}"><code>${x.schedule}</code><br><span class="muted small">${words(tx, x.schedule)} (${x.time_zone})</span></td>
        <td data-label="${L.next}">${x.enabled ? x.next_run ?? html`<span class="muted">${tx('cr.soon')}</span>` : html`<span class="muted">${tx('cr.disabled')}</span>`}</td>
        <td data-label="${L.last}">${x.last_run ?? html`<span class="muted">${tx('scr.never')}</span>`}${x.last_status ? html` <span class="tag ${x.last_status === 'ok' ? 'tag-ok' : x.last_status === 'error' ? 'tag-error' : 'tag-warning'}">${x.last_status}</span>` : ''}</td></tr>`)
        : html`<tr><td colspan="5" class="empty">${tx('cr.no_automations')}</td></tr>`}</tbody></table></div>`)}
    ${region(tx('cr.process_jobs'), html`<p class="muted u-mt0">${tx('cr.process_jobs_intro')}</p>
      <div class="table-wrap"><table class="report report-reflow cron-list"><thead><tr><th>${L.app}</th><th>${L.job}</th><th>${L.state}</th><th>${L.by}</th><th>${L.queued}</th><th>${L.ended}</th></tr></thead>
      <tbody>${jobs.length ? jobs.map((x) => html`<tr>
        <td data-label="${L.app}"><a href="${BASE}/apps/${x.app_id}">${x.alias}</a></td>
        <td data-label="${L.job}" class="u-break">${x.name}${x.error ? html`<br><span class="muted small">${x.error.slice(0, 300)}</span>` : ''}</td>
        <td data-label="${L.state}"><span class="tag ${x.state === 'completed' ? 'tag-ok' : x.state === 'failed' ? 'tag-error' : 'tag-info'}">${x.state}</span></td>
        <td data-label="${L.by}">${x.app_user}</td><td data-label="${L.queued}">${x.queued}</td><td data-label="${L.ended}">${x.ended ?? ''}</td></tr>`)
        : html`<tr><td colspan="6" class="empty">${tx('cr.no_process_jobs')}</td></tr>`}</tbody></table></div>`)}`;
}

// ------------------------------------------------------------------ list

async function listPage(req: Req, reply: FastifyReply, s: Session) {
  const tx = tr(s);
  const title = tx('sql.tool.scheduling');
  const st = await cronState();
  if (!st.ok) {
    const main = html`${head(s, title)}${installNote(tx, st)}${await pgkilnWork(tx)}`;
    return send(reply, s, shell(s, title, crumbs(tx), main, 'sql'));
  }
  const jobs = await listJobs(st.timeZone);
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
  const shown = jobs.filter((j) => !q || `${j.jobname ?? ''} ${j.command} ${j.database} ${j.username}`.toLowerCase().includes(q));
  const failing = jobs.filter((j) => j.last_status === 'failed').length;
  const L = { job: tx('dp.col.job'), schedule: tx('cr.col.schedule'), next: tx('cr.col.next_run'), last: tx('cr.col.last_run'), db: tx('su.database'), as: tx('cr.col.run_as') };
  const main = html`${head(s, title, html`<a class="btn btn-hot" href="${URL_BASE}/new">${icon('plus')} ${tx('cr.create')}</a><a class="btn" href="${URL_BASE}/history">${icon('list')} ${tx('cr.history')}</a>`)}
    <div class="stat-grid u-mb1 dbu-stats">
      <div class="stat"><b>${String(jobs.length)}</b><span>${tx('cr.jobs')}</span></div>
      <div class="stat"><b>${String(jobs.filter((j) => j.active).length)}</b><span>${tx('sm.active')}</span></div>
      <a class="stat" href="${URL_BASE}/history?status=failed"><b>${String(failing)}</b><span>${tx('cr.failed_last')}</span></a>
    </div>
    ${region(tx('cr.pg_cron_jobs'), html`<p class="muted u-mt0">${tx.rich('cr.list_intro', { version: st.version, tz: html`<code>${st.timeZone}</code>`, setting: html`<code>cron.timezone</code>` })}${st.seesAll ? '' : html` ${tx.rich('cr.own_only', { user: html`<code>${st.user}</code>` })}`}</p>
      <form method="get" action="${URL_BASE}" class="dbu-search u-mb1" role="search"><label class="sr-only" for="cron-q">${tx('cr.search')}</label><input id="cron-q" name="q" type="search" value="${q}" placeholder="${tx('cr.search')}" autocomplete="off"> <button class="btn btn-sm">${icon('search')} ${tx('common.search')}</button></form>
      <div class="table-wrap"><table class="report report-reflow cron-list"><thead><tr><th>${L.job}</th><th>${L.schedule}</th><th>${L.next}</th><th>${L.last}</th><th>${L.db}</th><th>${L.as}</th></tr></thead>
      <tbody>${shown.length ? shown.map((j) => html`<tr>
        <td data-label="${L.job}" class="u-break"><a href="${jobUrl(j.jobid)}"><strong>${jobName(tx, j)}</strong></a>${j.active ? '' : html` <span class="tag">${tx('cr.inactive')}</span>`}<br><code class="small cron-cmd">${j.command.replace(/\s+/g, ' ').slice(0, 120)}</code></td>
        <td data-label="${L.schedule}"><code>${j.schedule}</code><br><span class="muted small">${words(tx, j.schedule)}</span></td>
        <td data-label="${L.next}">${nextRun(tx, j, st.timeZone)}</td>
        <td data-label="${L.last}">${statusTag(tx, j.last_status)}${j.last_start ? html` <span class="small">${j.last_start}</span>` : ''}${j.failures > 1 ? html`<br><span class="small cron-error">${tx('cr.failures', { n: j.failures })}</span>` : ''}</td>
        <td data-label="${L.db}">${j.database}</td><td data-label="${L.as}">${j.username}</td></tr>`)
        : html`<tr><td colspan="6" class="empty">${jobs.length ? tx('cr.no_match') : tx.rich('cr.none_yet', { create: html`<a href="${URL_BASE}/new">${tx('cr.create_one')}</a>` })}</td></tr>`}</tbody></table></div>`)}
    <details class="u-mt1"><summary>${tx('cr.own_work')}</summary>${await pgkilnWork(tx)}</details>`;
  return send(reply, s, shell(s, title, crumbs(tx), main, 'sql'));
}

// ------------------------------------------------------------------ create / edit

interface FormContext { databases: string[]; users: string[]; timeZone: string; user: string; database: string }

async function formContext(st: Extract<CronState, { ok: true }>): Promise<FormContext> {
  const databases = (await owner.query<{ n: string }>(`select datname as n from pg_database where datallowconn and not datistemplate order by datname <> current_database(), datname`)).rows.map((r) => r.n);
  const users = (await owner.query<{ n: string }>(`select rolname as n from pg_roles where rolcanlogin and rolname !~ '^pg_' order by rolname <> current_user, lower(rolname)`)).rows.map((r) => r.n);
  return { databases, users, timeZone: st.timeZone, user: st.user, database: st.database };
}

const specOf = (j: Job): JobSpec => ({ name: j.jobname ?? '', schedule: j.schedule, command: j.command, database: j.database, username: j.username, active: j.active });

function specFromBody(b: Body): JobSpec {
  return {
    name: one(b.name).trim(),
    schedule: one(b.schedule).trim().replace(/\s+/g, ' '),
    command: one(b.command).replace(/\r\n/g, '\n'),
    database: one(b.database),
    username: one(b.username),
    active: !!b.active,
  };
}

const FIELD_LABELS: [keyof CronFields, BuilderKey, BuilderKey][] = [
  ['minute', 'cr.f.minute', 'cr.f.minute_help'], ['hour', 'cr.f.hour', 'cr.f.hour_help'], ['day', 'cr.f.day', 'cr.f.day_help'], ['month', 'cr.f.month', 'cr.f.month_help'], ['weekday', 'cr.f.weekday', 'cr.f.weekday_help'],
];

function jobForm(s: Session, spec: JobSpec, ctx: FormContext, o: { jobid: string | null; errors: string[]; fields?: CronFields | null }) {
  const tx = tr(s);
  const fields = o.fields ?? splitSchedule(spec.schedule) ?? { minute: '', hour: '', day: '', month: '', weekday: '' };
  return html`${errorList(o.errors)}
    <form method="post" action="${URL_BASE}/save" class="cron-form" data-cron-form>${csrf(s)}
      <input type="hidden" name="jobid" value="${o.jobid ?? ''}">
      ${region(tx('cr.job'), html`<div class="form-grid">
        <div class="field"><label class="label" for="f_name">${tx('scr.name')}</label><input id="f_name" name="name" value="${spec.name}" required maxlength="100" autocomplete="off" placeholder="${tx('cr.name_placeholder')}">
          <small class="help">${tx('cr.name_help')}</small></div>
        <div class="field"><label class="label" for="f_database">${tx('su.database')}</label><select id="f_database" name="database">${ctx.databases.map((d) => html`<option${sel(d === spec.database)}>${d}</option>`)}</select>
          <small class="help">${tx('cr.database_help')}</small></div>
        <div class="field"><label class="label" for="f_username">${tx('cr.col.run_as')}</label><select id="f_username" name="username">${ctx.users.map((u) => html`<option${sel(u === spec.username)}>${u}</option>`)}</select>
          <small class="help">${tx('cr.run_as_help')}</small></div>
        <div class="field"><span class="label">${tx('sm.col.state')}</span><label class="check"><input type="checkbox" name="active" value="1"${chk(spec.active)}> ${tx('sm.active')}</label>
          <small class="help">${tx('cr.active_help')}</small></div>
        <div class="field cron-wide"><label class="label" for="f_command">${tx('cr.command')}</label>
          <textarea id="f_command" name="command" class="code sql-editor" rows="8" spellcheck="false" data-code="plpgsql" required>${spec.command}</textarea>
          <small class="help">${tx.code('cr.command_help')}</small></div>
      </div>`)}
      ${region(tx('cr.col.schedule'), html`<div class="form-grid">
        <div class="field"><label class="label" for="f_schedule">${tx('cr.col.schedule')}</label><input id="f_schedule" name="schedule" value="${spec.schedule}" required maxlength="200" spellcheck="false" autocomplete="off" placeholder="0 2 * * *" data-cron-schedule aria-describedby="cron-preview">
          <small class="help">${tx.code('cr.schedule_help')}</small></div>
        <div class="field"><label class="label" for="f_preset">${tx('cr.presets')}</label><div class="cron-inline"><select id="f_preset" name="preset" data-cron-preset><option value="">${tx('cr.choose')}</option>${PRESETS.map(([l, v], i) => html`<option value="${v}">${tx.dyn(`cr.preset.p${i + 1}`, l)} (${v})</option>`)}</select>
          <button class="btn btn-sm" name="mode" value="preset" formnovalidate data-cron-nojs>${tx('cr.use')}</button></div></div>
      </div>
      <fieldset class="cron-fields"><legend class="label">${tx('cr.builder')}</legend>
        <div class="cron-field-grid">${FIELD_LABELS.map(([k, l, h]) => html`<div class="field"><label class="label" for="f_cf_${k}">${tx(l)}</label><input id="f_cf_${k}" name="cf_${k}" value="${fields[k]}" placeholder="*" maxlength="60" spellcheck="false" autocomplete="off" data-cron-field="${k}"><small class="help">${tx(h)}</small></div>`)}</div>
        <button class="btn btn-sm" name="mode" value="build" formnovalidate data-cron-nojs>${tx('cr.use_fields')}</button>
      </fieldset>
      <div class="cron-preview" id="cron-preview" aria-live="polite" data-cron-preview="${URL_BASE}/preview">${schedulePreview(spec.schedule || '0 2 * * *', ctx.timeZone, tx)}</div>
      <button class="btn btn-sm" name="mode" value="preview" formnovalidate data-cron-nojs>${tx('sd.preview')}</button>`)}
      <div class="buttons"><button class="btn btn-hot" name="mode" value="review">${icon('eye')} ${tx('cr.review')}</button><a class="btn" href="${o.jobid ? jobUrl(o.jobid) : URL_BASE}">${tx('sm.cancel')}</a></div>
    </form>`;
}

const hiddenSpec = (spec: JobSpec, jobid: string | null) => html`<input type="hidden" name="jobid" value="${jobid ?? ''}">
  <input type="hidden" name="name" value="${spec.name}"><input type="hidden" name="schedule" value="${spec.schedule}">
  <input type="hidden" name="command" value="${spec.command}"><input type="hidden" name="database" value="${spec.database}">
  <input type="hidden" name="username" value="${spec.username}">${spec.active ? html`<input type="hidden" name="active" value="1">` : ''}`;

/** The review step of any change: the SQL, Apply (with the digest), Back. */
function reviewRegion(s: Session, stmts: string[], action: string, hidden: Raw, o: { back?: Raw | ''; apply?: string; danger?: boolean; extra?: Raw | '' } = {}) {
  const tx = tr(s);
  return html`${region('SQL', stmts.length
    ? html`<p class="muted u-mt0">${tx('cr.review_intro')}</p><pre class="source cron-sql" data-code-view="sql" tabindex="0" aria-label="${tx('qs.generated')}">${stmts.join('\n\n')}</pre>`
    : html`<p class="muted u-mt0">${tx('cr.nothing')}</p>`)}
    <form method="post" action="${action}" class="cron-form">${csrf(s)}${hidden}<input type="hidden" name="reviewed" value="${reviewDigest(stmts)}">${o.extra ?? ''}
      <div class="buttons">${stmts.length ? html`<button class="btn ${o.danger ? 'btn-danger' : 'btn-hot'}" name="mode" value="apply">${icon(o.danger ? 'trash' : 'check')} ${o.apply ?? tx('qb.apply')}</button>` : ''}${o.back ?? ''}</div></form>`;
}

const failedBox = (tx: BuilderTranslate, message: string) => html`<div class="alert alert-error" role="alert"><p class="u-mt0">${tx.rich('cr.failed_box', { nothing: html`<strong>${tx('cr.nothing_changed')}</strong>` })}</p><p class="u-m0">${message}</p></div>`;

async function editPage(reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job | null, o: { spec?: JobSpec; errors?: string[]; fields?: CronFields | null } = {}) {
  const tx = tr(s);
  const ctx = await formContext(st);
  const spec = o.spec ?? (job ? specOf(job) : { name: '', schedule: '0 2 * * *', command: '', database: st.database, username: st.user, active: true });
  const title = job ? tx('cr.edit_title', { name: jobName(tx, job) }) : tx('cr.create');
  const main = html`${head(s, title)}${jobForm(s, spec, ctx, { jobid: job?.jobid ?? null, errors: o.errors ?? [], fields: o.fields })}`;
  const trail: [string, string?][] = job ? [[jobName(tx, job), jobUrl(job.jobid)], [tx('cr.edit')]] : [[tx('cr.create_crumb')]];
  return send(reply.code(o.errors?.length ? 422 : 200), s, shell(s, title, crumbs(tx, ...trail), main, 'sql'));
}

async function save(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>) {
  const tx = tr(s);
  const b = req.body ?? {};
  const jobid = one(b.jobid);
  const job = jobid ? await oneJob(st.timeZone, jobid) : null;
  if (jobid && !job) return reply.code(404).send('Not found');
  const spec = specFromBody(b);
  const mode = one(b.mode);
  const fields: CronFields = { minute: one(b.cf_minute), hour: one(b.cf_hour), day: one(b.cf_day), month: one(b.cf_month), weekday: one(b.cf_weekday) };
  // the no-JavaScript builder: a preset or the five fields become the schedule, the form comes back
  if (mode === 'preset' || mode === 'build' || mode === 'preview' || mode === 'edit') {
    if (mode === 'preset' && PRESETS.some(([, v]) => v === one(b.preset))) spec.schedule = one(b.preset);
    if (mode === 'build') spec.schedule = joinSchedule(fields).slice(0, 200);
    return editPage(reply, s, st, job, { spec, fields: mode === 'build' ? fields : null });
  }
  const ctx = await formContext(st);
  const errors = checkJob(spec, ctx);
  if (!errors.length) {
    const clash = await owner.one<{ jobid: string }>('select jobid::text from cron.job where jobname = $1 and username = $2', [spec.name, spec.username]);
    if (clash && clash.jobid !== job?.jobid) errors.push(tx('cr.err.clash', { user: spec.username, name: spec.name }));
  }
  if (errors.length) return editPage(reply, s, st, job, { spec, errors });
  const stmts = jobSql(job ? { ...specOf(job), jobid: job.jobid } : null, spec);
  const title = job ? tx('cr.change_title', { name: job.jobname ?? tx('cr.job_n_lower', { id: job.jobid }) }) : tx('cr.create_title', { name: spec.name });
  const page = (output: Raw | '' = '') => {
    const main = html`${head(s, title)}${output}
      ${region(tx('cr.col.schedule'), schedulePreview(spec.schedule, st.timeZone, tx))}
      ${reviewRegion(s, stmts, `${URL_BASE}/save`, hiddenSpec(spec, job?.jobid ?? null), { back: html`<button class="btn" name="mode" value="edit" formnovalidate>${tx('cr.back_form')}</button>` })}`;
    const trail: [string, string?][] = job ? [[jobName(tx, job), jobUrl(job.jobid)], [tx('cr.review_crumb')]] : [[tx('cr.create_crumb'), `${URL_BASE}/new`], [tx('cr.review_crumb')]];
    return send(reply.code(output ? 422 : 200), s, shell(s, title, crumbs(tx, ...trail), main, 'sql'));
  };
  if (mode !== 'apply') return page();
  if (one(b.reviewed) !== reviewDigest(stmts)) return page(errorList([tx('cr.err.changed_form')]));
  if (!stmts.length) return page(errorList([tx('cr.nothing')]));
  const failed = await applySql(stmts);
  await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}`.slice(0, 4000) });
  if (failed) return page(failedBox(tx, failed));
  const created = job ? null : await owner.one<{ jobid: string }>('select jobid::text from cron.job where jobname = $1 and username = $2', [spec.name, spec.username]);
  flash(s, job ? tx('cr.changed', { name: spec.name }) : tx('cr.created', { name: spec.name }));
  return back(reply, s, job ? jobUrl(job.jobid) : created ? jobUrl(created.jobid) : URL_BASE);
}

// ------------------------------------------------------------------ one job

function runsTable(tx: BuilderTranslate, runs: Awaited<ReturnType<typeof listRuns>>, withJob: boolean) {
  const L = { run: tx('cr.col.run'), job: tx('dp.col.job'), status: tx('sm.col.state'), started: tx('scr.col.started'), duration: tx('cr.col.duration'), message: tx('cr.col.message') };
  return html`<div class="table-wrap"><table class="report report-reflow cron-runs-table"><thead><tr><th class="num">${L.run}</th>${withJob ? html`<th>${L.job}</th>` : ''}<th>${L.status}</th><th>${L.started}</th><th class="num">${L.duration}</th><th>${L.message}</th></tr></thead>
    <tbody>${runs.length ? runs.map((r) => html`<tr>
      <td class="num" data-label="${L.run}">${r.runid}</td>
      ${withJob ? html`<td data-label="${L.job}" class="u-break">${r.jobid ? html`<a href="${jobUrl(r.jobid)}">${r.jobname ?? tx('cr.job_n', { id: r.jobid })}</a>` : ''}</td>` : ''}
      <td data-label="${L.status}">${statusTag(tx, r.status)}</td><td data-label="${L.started}">${r.start ?? ''}</td>
      <td class="num" data-label="${L.duration}">${secs(r.secs)}</td>
      <td data-label="${L.message}" class="u-break"><code class="small">${(r.return_message ?? '').slice(0, 500)}</code></td></tr>`)
      : html`<tr><td colspan="${withJob ? 6 : 5}" class="empty">${tx('cr.no_runs')}</td></tr>`}</tbody></table></div>`;
}

async function jobPage(reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job, output: Raw | '' = '') {
  const tx = tr(s);
  const runs = await listRuns(st.timeZone, { job: job.jobid, limit: 20 });
  const name = jobName(tx, job);
  const main = html`${head(s, name, html`<a class="btn btn-hot" href="${jobUrl(job.jobid)}/edit">${icon('edit')} ${tx('cr.edit')}</a>
      <form method="post" action="${jobUrl(job.jobid)}/run" class="u-inline">${csrf(s)}<button class="btn" data-confirm="${tx('cr.run_confirm', { name, user: job.username, db: job.database })}">${icon('play')} ${tx('cr.run_now')}</button></form>
      <form method="post" action="${jobUrl(job.jobid)}/active" class="u-inline">${csrf(s)}<input type="hidden" name="active" value="${job.active ? '' : '1'}"><button class="btn">${job.active ? tx('cr.disable') : tx('cr.enable')}</button></form>
      <a class="btn btn-danger" href="${jobUrl(job.jobid)}/unschedule">${icon('trash')} ${tx('cr.unschedule_dots')}</a>`)}
    ${output}
    ${region(tx('cr.job'), html`<dl class="dbu-facts">
      <dt>${tx('sm.col.state')}</dt><dd>${job.active ? tx('sm.active') : html`<span class="tag">${tx('cr.inactive')}</span>`}</dd>
      <dt>${tx('cr.col.schedule')}</dt><dd><code>${job.schedule}</code></dd>
      <dt>${tx('su.database')}</dt><dd>${job.database}</dd><dt>${tx('cr.col.run_as')}</dt><dd>${job.username}</dd><dt>${tx('cr.job_id')}</dt><dd>${job.jobid}</dd>
    </dl><pre class="source cron-sql" data-code-view="sql" tabindex="0" aria-label="${tx('cr.command')}">${job.command}</pre>`)}
    ${region(tx('cr.col.schedule'), schedulePreview(job.schedule, st.timeZone, tx))}
    ${region(tx('cr.recent_runs'), html`${runsTable(tx, runs, false)}<p class="small"><a href="${URL_BASE}/history?job=${job.jobid}">${tx('cr.all_runs')}</a> · <a href="${URL_BASE}/history/purge?job=${job.jobid}">${tx('cr.purge_its')}</a></p>`)}`;
  return send(reply, s, shell(s, name, crumbs(tx, [name]), main, 'sql'));
}

async function setActive(req: Req, reply: FastifyReply, s: Session, job: Job) {
  const tx = tr(s);
  const active = !!one(req.body?.active);
  const stmts = activeSql(job.jobid, active);
  const failed = await applySql(stmts);
  await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}` });
  if (failed) flash(s, tx(active ? 'cr.enable_failed' : 'cr.disable_failed', { error: failed }), 'error');
  else flash(s, tx(active ? 'cr.enabled' : 'cr.disabled_flash', { name: job.jobname ?? tx('cr.job_n_lower', { id: job.jobid }), sql: stmts[0] }));
  return back(reply, s, jobUrl(job.jobid));
}

async function unschedulePage(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job) {
  const tx = tr(s);
  const stmts = unscheduleSql(job.jobid);
  const name = jobName(tx, job);
  let output: Raw | '' = '';
  if (req.method === 'POST') {
    if (one(req.body?.reviewed) !== reviewDigest(stmts)) output = errorList([tx('cr.err.changed')]);
    else {
      const failed = await applySql(stmts);
      await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}` });
      if (!failed) {
        flash(s, tx('cr.unscheduled', { name }));
        return back(reply, s, URL_BASE);
      }
      output = failedBox(tx, failed);
    }
  }
  const title = tx('cr.unschedule_title', { name });
  const main = html`${head(s, title)}${output}
    <div class="alert alert-info" role="status">${tx('cr.unschedule_note')}</div>
    ${reviewRegion(s, stmts, `${jobUrl(job.jobid)}/unschedule`, html``, { danger: true, apply: tx('cr.unschedule'), back: html`<a class="btn" href="${jobUrl(job.jobid)}">${tx('sm.cancel')}</a>` })}`;
  return send(reply.code(output ? 422 : 200), s, shell(s, title, crumbs(tx, [name, jobUrl(job.jobid)], [tx('cr.unschedule')]), main, 'sql'));
}

async function runJobNow(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job) {
  const tx = tr(s);
  const r = await runNow(job);
  await logActivity({ username: s.username, event: 'cron_run_now', ip: clientIp(req), elapsedMs: Math.round(r.ms), detail: `job ${job.jobid} ${job.jobname ?? ''}: ${r.ok ? 'ok' : 'failed'}: ${r.message}`.slice(0, 4000) });
  const out = html`<div class="alert ${r.ok ? 'alert-success' : 'alert-error'}" role="${r.ok ? 'status' : 'alert'}"><p class="u-mt0">${tx.rich('cr.ran', { what: html`<strong>${r.ok ? tx('cr.ran_ok') : tx('cr.ran_failed')}</strong>`, secs: secs(r.ms / 1000), user: job.username, db: job.database, message: html`<code>${r.message}</code>` })}</p>
    ${r.notices.length ? html`<pre class="source small">${r.notices.join('\n')}</pre>` : ''}
    <p class="small u-m0">${tx('cr.run_now_note')}</p></div>`;
  return jobPage(reply.code(r.ok ? 200 : 422), s, st, job, out);
}

// ------------------------------------------------------------------ history

async function historyPage(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>) {
  const tx = tr(s);
  const f = { job: String(req.query.job ?? ''), status: String(req.query.status ?? ''), q: String(req.query.q ?? '').trim().slice(0, 100) };
  const [jobs, runs] = await Promise.all([listJobs(st.timeZone), listRuns(st.timeZone, { ...f, limit: 200 })]);
  const main = html`${head(s, tx('cr.history'), html`<a class="btn" href="${URL_BASE}/history/purge">${icon('trash')} ${tx('cr.purge_dots')}</a>`)}
    ${region(tx('cr.runs'), html`<p class="muted u-mt0">${tx.rich('cr.history_intro', { table: html`<code>cron.job_run_details</code>`, tz: html`<code>${st.timeZone}</code>` })}</p>
      <form method="get" action="${URL_BASE}/history" class="dbu-search u-mb1" role="search">
        <label class="sr-only" for="h-job">${tx('dp.col.job')}</label><select id="h-job" name="job"><option value="">${tx('cr.all_jobs')}</option>${jobs.map((j) => html`<option value="${j.jobid}"${sel(j.jobid === f.job)}>${jobName(tx, j)}</option>`)}</select>
        <label class="sr-only" for="h-status">${tx('sm.col.state')}</label><select id="h-status" name="status"><option value="">${tx('cr.any_status')}</option>${RUN_STATUSES.map((x) => html`<option value="${x}"${sel(x === f.status)}>${tx.dyn(`cr.status.${x}`, x)}</option>`)}</select>
        <label class="sr-only" for="h-q">${tx('cr.search_messages_label')}</label><input id="h-q" name="q" type="search" value="${f.q}" placeholder="${tx('cr.search_messages')}" autocomplete="off">
        <button class="btn btn-sm">${icon('filter')} ${tx('cr.filter')}</button></form>
      ${runsTable(tx, runs, true)}`)}`;
  return send(reply, s, shell(s, tx('cr.history'), crumbs(tx, [tx('cr.history')]), main, 'sql'));
}

const PURGE_DAYS: [string, BuilderKey][] = [['7', 'cr.older_7'], ['30', 'cr.older_30'], ['90', 'cr.older_90'], ['all', 'cr.purge_all']];

async function purgePage(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>) {
  const tx = tr(s);
  const src = req.method === 'POST' ? (req.body ?? {}) : req.query;
  const dayKey = PURGE_DAYS.some(([k]) => k === one(src.days)) ? one(src.days) : '30';
  const days = dayKey === 'all' ? null : Number(dayKey);
  const jobArg = one(src.job);
  const job = jobArg ? await oneJob(st.timeZone, jobArg) : null;
  if (jobArg && !job) return reply.code(404).send('Not found');
  const stmts = purgeSql(days, job?.jobid ?? null);
  let output: Raw | '' = '';
  if (req.method === 'POST') {
    if (one(src.reviewed) !== reviewDigest(stmts)) output = errorList([tx('cr.err.changed')]);
    else {
      const failed = await applySql(stmts);
      await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}` });
      if (!failed) {
        flash(s, tx('cr.purged'));
        return back(reply, s, `${URL_BASE}/history${job ? `?job=${job.jobid}` : ''}`);
      }
      output = failedBox(tx, failed);
    }
  }
  const n = await countPurge(days, job?.jobid ?? null);
  const main = html`${head(s, tx('cr.purge_title'))}${output}
    ${region(tx('cr.which_runs'), html`<form method="get" action="${URL_BASE}/history/purge" class="dbu-search">${job ? html`<input type="hidden" name="job" value="${job.jobid}">` : ''}
        <label for="p-days">${job ? tx.rich('cr.runs_of', { name: html`<strong>${job.jobname ?? tx('cr.job_n_lower', { id: job.jobid })}</strong>` }) : tx('cr.runs')}</label>
        <select id="p-days" name="days">${PURGE_DAYS.map(([k, l]) => html`<option value="${k}"${sel(k === dayKey)}>${tx(l)}</option>`)}</select>
        <button class="btn btn-sm">${icon('eye')} ${tx('cr.review')}</button></form>
      <p class="u-m0">${tx(n === 1 ? 'cr.would_delete_one' : 'cr.would_delete', { n })}</p>`)}
    ${reviewRegion(s, stmts, `${URL_BASE}/history/purge`, html`<input type="hidden" name="days" value="${dayKey}">${job ? html`<input type="hidden" name="job" value="${job.jobid}">` : ''}`,
      { danger: true, apply: tx('cr.purge'), back: html`<a class="btn" href="${URL_BASE}/history">${tx('sm.cancel')}</a>` })}`;
  return send(reply.code(output ? 422 : 200), s, shell(s, tx('cr.purge_title'), crumbs(tx, [tx('cr.history'), `${URL_BASE}/history`], [tx('cr.purge')]), main, 'sql'));
}

// ------------------------------------------------------------------ routes

export async function schedulingRoutes(app: FastifyInstance) {
  /** an administrator with pg_cron usable, else the list page (which explains) */
  const ready = async (req: Req, reply: FastifyReply) => {
    const s = await admin(req, reply);
    if (!s) return null;
    const st = await cronState();
    if (!st.ok) {
      reply.code(409);
      await listPage(req, reply, s);
      return null;
    }
    return { s, st };
  };
  const withJob = async (req: Req, reply: FastifyReply) => {
    const r = await ready(req, reply);
    if (!r) return null;
    const job = await oneJob(r.st.timeZone, req.params.id);
    if (!job) {
      reply.code(404).send('Not found');
      return null;
    }
    return { ...r, job };
  };

  app.get(URL_BASE, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (s) return listPage(req, reply, s);
  });
  app.get(`${URL_BASE}/preview`, async (req: Req, reply) => {
    const s = await admin(req, reply);
    if (!s) return;
    const st = await cronState();
    return reply.type('text/html').send(String(schedulePreview(String(req.query.schedule ?? '').slice(0, 300), st.ok ? st.timeZone : 'GMT', tr(s))));
  });
  app.get(`${URL_BASE}/new`, async (req: Req, reply) => {
    const r = await ready(req, reply);
    if (r) return editPage(reply, r.s, r.st, null);
  });
  app.post(`${URL_BASE}/save`, async (req: Req, reply) => {
    const r = await ready(req, reply);
    if (r) return save(req, reply, r.s, r.st);
  });
  app.get(`${URL_BASE}/history`, async (req: Req, reply) => {
    const r = await ready(req, reply);
    if (r) return historyPage(req, reply, r.s, r.st);
  });
  for (const method of ['GET', 'POST'] as const) {
    app.route({ method, url: `${URL_BASE}/history/purge`, handler: async (req: Req, reply) => {
      const r = await ready(req, reply);
      if (r) return purgePage(req, reply, r.s, r.st);
    } });
    app.route({ method, url: `${URL_BASE}/job/:id/unschedule`, handler: async (req: Req, reply) => {
      const r = await withJob(req, reply);
      if (r) return unschedulePage(req, reply, r.s, r.st, r.job);
    } });
  }
  app.get(`${URL_BASE}/job/:id`, async (req: Req, reply) => {
    const r = await withJob(req, reply);
    if (r) return jobPage(reply, r.s, r.st, r.job);
  });
  app.get(`${URL_BASE}/job/:id/edit`, async (req: Req, reply) => {
    const r = await withJob(req, reply);
    if (r) return editPage(reply, r.s, r.st, r.job);
  });
  app.post(`${URL_BASE}/job/:id/active`, async (req: Req, reply) => {
    const r = await withJob(req, reply);
    if (r) return setActive(req, reply, r.s, r.job);
  });
  app.post(`${URL_BASE}/job/:id/run`, async (req: Req, reply) => {
    const r = await withJob(req, reply);
    if (r) return runJobNow(req, reply, r.s, r.st, r.job);
  });
}
