import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  cronTimeZone, describeSchedule, formatRun, joinSchedule, nextRuns, parseSchedule, PRESETS, ScheduleError, splitSchedule, type CronFields,
} from '../cron-schedule.ts';
import {
  activeSql, applySql, checkJob, countPurge, cronState, jobSql, listJobs, listRuns, oneJob, purgeSql, reviewDigest, RUN_STATUSES, runNow, unscheduleSql,
  type CronState, type Job, type JobSpec,
} from '../pgcron.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';

// (sprint 101, Database Actions DA-12) SQL Workshop › Scheduling: pg_cron's jobs (cron.job) with their schedule in
// words and next runs, the last run and recent failures; create, edit, disable, unschedule and run now; the run
// history (cron.job_run_details) with filters and purge. Every change is shown as SQL first and applied in one
// transaction on the owner connection. Without pg_cron: how to install it, and pgkiln's own scheduled work
// (automations and background process jobs), read-only. Administrators only. Schedules: src/cron-schedule.ts;
// catalog and SQL: src/pgcron.ts; the builder's live preview: public/builder.js (data-cron-*).

const URL_BASE = `${BASE}/sql/scheduling`;
const TITLE = 'Scheduling';
const jobUrl = (id: string) => `${URL_BASE}/job/${id}`;
const crumbs = (...more: [string, string?][]): [string, string?][] => [['SQL Workshop', `${BASE}/sql`], [TITLE, more.length ? URL_BASE : undefined], ...more];

const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
const chk = (on: boolean) => (on ? raw(' checked') : '');
const sel = (on: boolean) => (on ? raw(' selected') : '');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const errorList = (errors: string[]) =>
  errors.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : '';

/** An administrator's session, or null (a 403 page sent). */
async function admin(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return null;
  if (await isAdmin(s.username)) return s;
  const main = html`<h1 class="u-mb1">${TITLE}</h1><div class="alert alert-error" role="alert">Only administrators schedule database jobs: pg_cron runs them on the server, as any role.</div>`;
  await send(reply.code(403), s, shell(s, TITLE, crumbs(), main, 'sql'));
  return null;
}

const head = (s: Session, title: string, actions: Raw | '' = '') => html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('scheduling')}
  <div class="ide-head-title u-mb1"><div><h2 class="u-m0 u-break">${title}</h2></div>${actions ? html`<div class="buttons ide-head-actions">${actions}</div>` : ''}</div>`;

// ------------------------------------------------------------------ schedule preview

/** A schedule in words and its next five runs, or why it doesn't parse. */
export function schedulePreview(text: string, timeZone: string): Raw {
  try {
    const sc = parseSchedule(text);
    const runs = nextRuns(sc, new Date(), 5, cronTimeZone(timeZone));
    return html`<p class="u-m0"><strong>${describeSchedule(sc)}</strong></p>
      ${runs.length ? html`<p class="muted small u-m0">Next runs (${timeZone}):</p><ol class="cron-runs">${runs.map((d) => html`<li><time>${formatRun(d, cronTimeZone(timeZone), sc.kind === 'seconds')}</time></li>`)}</ol>`
        : html`<p class="muted small">No scheduled times: it runs when the database server starts.</p>`}`;
  } catch (e) {
    if (!(e instanceof ScheduleError)) throw e;
    return html`<p class="u-m0 cron-error" role="alert">${e.message}</p>`;
  }
}

/** The next run of a job, for the list. */
function nextRun(job: Job, timeZone: string): Raw | string {
  if (!job.active) return html`<span class="muted">inactive</span>`;
  try {
    const sc = parseSchedule(job.schedule);
    const [d] = nextRuns(sc, new Date(), 1, cronTimeZone(timeZone));
    return d ? formatRun(d, cronTimeZone(timeZone), sc.kind === 'seconds') : html`<span class="muted">at server start</span>`;
  } catch {
    return html`<span class="muted">?</span>`;
  }
}

const words = (schedule: string) => {
  try {
    return describeSchedule(parseSchedule(schedule));
  } catch (e) {
    return e instanceof ScheduleError ? e.message : 'unreadable';
  }
};

const statusTag = (status: string | null) => status === null ? html`<span class="muted">never ran</span>`
  : html`<span class="tag ${status === 'succeeded' ? 'tag-ok' : status === 'failed' ? 'tag-error' : 'tag-info'}">${status}</span>`;
const secs = (n: number | null) => (n === null ? '' : n >= 100 ? `${n.toFixed(0)} s` : `${n.toFixed(n >= 1 ? 1 : 3)} s`);

// ------------------------------------------------------------------ without pg_cron

function installNote(st: Exclude<CronState, { ok: true }>): Raw {
  const steps = html`<ol class="u-m0">
      <li>Install the pg_cron package on the database server (for example <code>apt install postgresql-17-cron</code>, or your cloud provider's pg_cron option).</li>
      <li>In <code>postgresql.conf</code> (or <code>alter system set …</code>): <code>shared_preload_libraries = 'pg_cron'</code> and <code>cron.database_name = '${st.database}'</code>; optionally <code>cron.timezone</code> (GMT unless set). Restart PostgreSQL.</li>
      <li>As a superuser, in this database: <code>create extension pg_cron;</code></li>
    </ol>`;
  const why = {
    not_available: html`pg_cron isn't installed on this database server.`,
    not_loaded: html`pg_cron is installed on the server but not loaded: it isn't in <code>shared_preload_libraries</code>.`,
    other_database: html`pg_cron runs in the database <code>${st.cronDatabase ?? 'postgres'}</code> (<code>cron.database_name</code>), not in <code>${st.database}</code>. Set <code>cron.database_name = '${st.database}'</code> and restart, or schedule from that database (jobs can still run here with <code>cron.schedule_in_database</code>).`,
    not_created: html`pg_cron is loaded, but the extension isn't created in this database yet.`,
    no_access: html`pg_cron is installed, but pgkiln's owner connection can't read its jobs: ${st.message ?? ''}. Grant it access (as a superuser: <code>grant usage on schema cron to …</code>), or connect pgkiln as the role that owns the jobs.`,
    old: html`This pg_cron (${st.message ?? '?'}) is too old: pgkiln needs version 1.4 or later (<code>cron.schedule_in_database</code>, <code>cron.alter_job</code>). <code>alter extension pg_cron update;</code>`,
  }[st.reason];
  return html`<div class="alert alert-info" role="status"><p class="u-mt0"><strong>${why}</strong></p>
    ${st.reason === 'no_access' || st.reason === 'old' ? '' : html`<p>To schedule SQL with pg_cron:</p>${steps}`}
    <p class="u-m0">pgkiln's own scheduler works without it: an application's <strong>Shared Components › Automations</strong> run SQL on a schedule as the application, and background execution chains run as <strong>process jobs</strong>. They are listed below.</p></div>`;
}

/** pgkiln's own scheduled work: automations and recent process jobs, read-only. */
async function pgkilnWork(): Promise<Raw> {
  const automations = (await owner.query<{ app_id: number; alias: string; id: number; name: string; enabled: boolean; schedule: string; time_zone: string; next_run: string | null; last_run: string | null; last_status: string | null }>(
    `select a.id as app_id, a.alias, x.id, x.name, x.enabled, x.schedule, x.time_zone,
            to_char(x.next_run_at at time zone x.time_zone, 'YYYY-MM-DD HH24:MI') as next_run,
            to_char(x.last_run_at at time zone x.time_zone, 'YYYY-MM-DD HH24:MI') as last_run, x.last_status
       from meta.automation x join meta.app a on a.id = x.app_id order by lower(a.alias), lower(x.name) limit 500`)).rows;
  const jobs = (await owner.query<{ id: string; app_id: number; alias: string; name: string; state: string; app_user: string; queued: string; ended: string | null; error: string | null }>(
    `select j.id::text, a.id as app_id, a.alias, j.name, j.state, j.app_user, to_char(j.queued_at, 'YYYY-MM-DD HH24:MI:SS') as queued,
            to_char(j.ended_at, 'YYYY-MM-DD HH24:MI:SS') as ended, j.error
       from meta.process_job j join meta.app a on a.id = j.app_id order by j.id desc limit 20`)).rows;
  return html`${region('Automations', html`<p class="muted u-mt0">Scheduled by pgkiln itself, per application (Shared Components › Automations), in each automation's time zone.</p>
      <div class="table-wrap"><table class="report report-reflow cron-list"><thead><tr><th>Application</th><th>Automation</th><th>Schedule</th><th>Next run</th><th>Last run</th></tr></thead>
      <tbody>${automations.length ? automations.map((x) => html`<tr>
        <td data-label="Application"><a href="${BASE}/apps/${x.app_id}">${x.alias}</a></td>
        <td data-label="Automation" class="u-break"><a href="${BASE}/apps/${x.app_id}/shared?c=automation-${x.id}">${x.name}</a>${x.enabled ? '' : html` <span class="tag">disabled</span>`}</td>
        <td data-label="Schedule"><code>${x.schedule}</code><br><span class="muted small">${words(x.schedule)} (${x.time_zone})</span></td>
        <td data-label="Next run">${x.enabled ? x.next_run ?? html`<span class="muted">soon</span>` : html`<span class="muted">disabled</span>`}</td>
        <td data-label="Last run">${x.last_run ?? html`<span class="muted">never</span>`}${x.last_status ? html` <span class="tag ${x.last_status === 'ok' ? 'tag-ok' : x.last_status === 'error' ? 'tag-error' : 'tag-warning'}">${x.last_status}</span>` : ''}</td></tr>`)
        : html`<tr><td colspan="5" class="empty">No automations.</td></tr>`}</tbody></table></div>`)}
    ${region('Process jobs', html`<p class="muted u-mt0">The latest execution chains that pages started in the background.</p>
      <div class="table-wrap"><table class="report report-reflow cron-list"><thead><tr><th>Application</th><th>Job</th><th>State</th><th>Started by</th><th>Queued</th><th>Ended</th></tr></thead>
      <tbody>${jobs.length ? jobs.map((x) => html`<tr>
        <td data-label="Application"><a href="${BASE}/apps/${x.app_id}">${x.alias}</a></td>
        <td data-label="Job" class="u-break">${x.name}${x.error ? html`<br><span class="muted small">${x.error.slice(0, 300)}</span>` : ''}</td>
        <td data-label="State"><span class="tag ${x.state === 'completed' ? 'tag-ok' : x.state === 'failed' ? 'tag-error' : 'tag-info'}">${x.state}</span></td>
        <td data-label="Started by">${x.app_user}</td><td data-label="Queued">${x.queued}</td><td data-label="Ended">${x.ended ?? ''}</td></tr>`)
        : html`<tr><td colspan="6" class="empty">No process jobs.</td></tr>`}</tbody></table></div>`)}`;
}

// ------------------------------------------------------------------ list

async function listPage(req: Req, reply: FastifyReply, s: Session) {
  const st = await cronState();
  if (!st.ok) {
    const main = html`${head(s, 'Scheduling')}${installNote(st)}${await pgkilnWork()}`;
    return send(reply, s, shell(s, TITLE, crumbs(), main, 'sql'));
  }
  const jobs = await listJobs(st.timeZone);
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
  const shown = jobs.filter((j) => !q || `${j.jobname ?? ''} ${j.command} ${j.database} ${j.username}`.toLowerCase().includes(q));
  const failing = jobs.filter((j) => j.last_status === 'failed').length;
  const main = html`${head(s, 'Scheduling', html`<a class="btn btn-hot" href="${URL_BASE}/new">${icon('plus')} Create job</a><a class="btn" href="${URL_BASE}/history">${icon('list')} Run history</a>`)}
    <div class="stat-grid u-mb1 dbu-stats">
      <div class="stat"><b>${String(jobs.length)}</b><span>Jobs</span></div>
      <div class="stat"><b>${String(jobs.filter((j) => j.active).length)}</b><span>Active</span></div>
      <a class="stat" href="${URL_BASE}/history?status=failed"><b>${String(failing)}</b><span>Failed on their last run</span></a>
    </div>
    ${region('pg_cron jobs', html`<p class="muted u-mt0">pg_cron ${st.version} runs these jobs on the database server; times are in its time zone <code>${st.timeZone}</code> (<code>cron.timezone</code>).${st.seesAll ? '' : html` pgkiln's owner connection (<code>${st.user}</code>) sees only its own jobs: pg_cron shows each role its own.`}</p>
      <form method="get" action="${URL_BASE}" class="dbu-search u-mb1" role="search"><label class="sr-only" for="cron-q">Search jobs</label><input id="cron-q" name="q" type="search" value="${q}" placeholder="Search jobs" autocomplete="off"> <button class="btn btn-sm">${icon('search')} Search</button></form>
      <div class="table-wrap"><table class="report report-reflow cron-list"><thead><tr><th>Job</th><th>Schedule</th><th>Next run</th><th>Last run</th><th>Database</th><th>Run as</th></tr></thead>
      <tbody>${shown.length ? shown.map((j) => html`<tr>
        <td data-label="Job" class="u-break"><a href="${jobUrl(j.jobid)}"><strong>${j.jobname ?? `Job ${j.jobid}`}</strong></a>${j.active ? '' : html` <span class="tag">inactive</span>`}<br><code class="small cron-cmd">${j.command.replace(/\s+/g, ' ').slice(0, 120)}</code></td>
        <td data-label="Schedule"><code>${j.schedule}</code><br><span class="muted small">${words(j.schedule)}</span></td>
        <td data-label="Next run">${nextRun(j, st.timeZone)}</td>
        <td data-label="Last run">${statusTag(j.last_status)}${j.last_start ? html` <span class="small">${j.last_start}</span>` : ''}${j.failures > 1 ? html`<br><span class="small cron-error">${plural(j.failures, 'failure')} in the last 10 runs</span>` : ''}</td>
        <td data-label="Database">${j.database}</td><td data-label="Run as">${j.username}</td></tr>`)
        : html`<tr><td colspan="6" class="empty">${jobs.length ? 'No jobs match.' : html`No jobs yet. <a href="${URL_BASE}/new">Create one</a>.`}</td></tr>`}</tbody></table></div>`)}
    <details class="u-mt1"><summary>pgkiln's own scheduled work (automations, process jobs)</summary>${await pgkilnWork()}</details>`;
  return send(reply, s, shell(s, TITLE, crumbs(), main, 'sql'));
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

const FIELD_LABELS: [keyof CronFields, string, string][] = [
  ['minute', 'Minute', '0-59'], ['hour', 'Hour', '0-23'], ['day', 'Day of month', '1-31, $ = last'], ['month', 'Month', '1-12 or jan-dec'], ['weekday', 'Day of week', '0-6 (0 = Sunday) or sun-sat'],
];

function jobForm(s: Session, spec: JobSpec, ctx: FormContext, o: { jobid: string | null; errors: string[]; fields?: CronFields | null }) {
  const fields = o.fields ?? splitSchedule(spec.schedule) ?? { minute: '', hour: '', day: '', month: '', weekday: '' };
  return html`${errorList(o.errors)}
    <form method="post" action="${URL_BASE}/save" class="cron-form" data-cron-form>${csrf(s)}
      <input type="hidden" name="jobid" value="${o.jobid ?? ''}">
      ${region('Job', html`<div class="form-grid">
        <div class="field"><label class="label" for="f_name">Name</label><input id="f_name" name="name" value="${spec.name}" required maxlength="100" autocomplete="off" placeholder="nightly vacuum">
          <small class="help">Unique per role it runs as.</small></div>
        <div class="field"><label class="label" for="f_database">Database</label><select id="f_database" name="database">${ctx.databases.map((d) => html`<option${sel(d === spec.database)}>${d}</option>`)}</select>
          <small class="help">pg_cron connects to it to run the command.</small></div>
        <div class="field"><label class="label" for="f_username">Run as</label><select id="f_username" name="username">${ctx.users.map((u) => html`<option${sel(u === spec.username)}>${u}</option>`)}</select>
          <small class="help">The role the command runs as. Only a superuser schedules jobs for another role.</small></div>
        <div class="field"><span class="label">State</span><label class="check"><input type="checkbox" name="active" value="1"${chk(spec.active)}> Active</label>
          <small class="help">An inactive job keeps its schedule and doesn't run.</small></div>
        <div class="field cron-wide"><label class="label" for="f_command">Command</label>
          <textarea id="f_command" name="command" class="code sql-editor" rows="8" spellcheck="false" data-code="plpgsql" required>${spec.command}</textarea>
          <small class="help">SQL run outside a transaction block, as pg_cron runs it: <code>vacuum analyze</code> works; several statements each commit on their own.</small></div>
      </div>`)}
      ${region('Schedule', html`<div class="form-grid">
        <div class="field"><label class="label" for="f_schedule">Schedule</label><input id="f_schedule" name="schedule" value="${spec.schedule}" required maxlength="200" spellcheck="false" autocomplete="off" placeholder="0 2 * * *" data-cron-schedule aria-describedby="cron-preview">
          <small class="help">Five fields, <code>minute hour day-of-month month day-of-week</code>; <code>n seconds</code> (1 to 59); or <code>@hourly</code>, <code>@daily</code>, <code>@weekly</code>, <code>@monthly</code>, <code>@yearly</code>, <code>@reboot</code>.</small></div>
        <div class="field"><label class="label" for="f_preset">Common schedules</label><div class="cron-inline"><select id="f_preset" name="preset" data-cron-preset><option value="">Choose…</option>${PRESETS.map(([l, v]) => html`<option value="${v}">${l} (${v})</option>`)}</select>
          <button class="btn btn-sm" name="mode" value="preset" formnovalidate data-cron-nojs>Use</button></div></div>
      </div>
      <fieldset class="cron-fields"><legend class="label">Schedule builder</legend>
        <div class="cron-field-grid">${FIELD_LABELS.map(([k, l, h]) => html`<div class="field"><label class="label" for="f_cf_${k}">${l}</label><input id="f_cf_${k}" name="cf_${k}" value="${fields[k]}" placeholder="*" maxlength="60" spellcheck="false" autocomplete="off" data-cron-field="${k}"><small class="help">${h}</small></div>`)}</div>
        <button class="btn btn-sm" name="mode" value="build" formnovalidate data-cron-nojs>Use these fields</button>
      </fieldset>
      <div class="cron-preview" id="cron-preview" aria-live="polite" data-cron-preview="${URL_BASE}/preview">${schedulePreview(spec.schedule || '0 2 * * *', ctx.timeZone)}</div>
      <button class="btn btn-sm" name="mode" value="preview" formnovalidate data-cron-nojs>Preview</button>`)}
      <div class="buttons"><button class="btn btn-hot" name="mode" value="review">${icon('eye')} Review SQL</button><a class="btn" href="${o.jobid ? jobUrl(o.jobid) : URL_BASE}">Cancel</a></div>
    </form>`;
}

const hiddenSpec = (spec: JobSpec, jobid: string | null) => html`<input type="hidden" name="jobid" value="${jobid ?? ''}">
  <input type="hidden" name="name" value="${spec.name}"><input type="hidden" name="schedule" value="${spec.schedule}">
  <input type="hidden" name="command" value="${spec.command}"><input type="hidden" name="database" value="${spec.database}">
  <input type="hidden" name="username" value="${spec.username}">${spec.active ? html`<input type="hidden" name="active" value="1">` : ''}`;

/** The review step of any change: the SQL, Apply (with the digest), Back. */
function reviewRegion(s: Session, stmts: string[], action: string, hidden: Raw, o: { back?: Raw | ''; apply?: string; danger?: boolean; extra?: Raw | '' } = {}) {
  return html`${region('SQL', stmts.length
    ? html`<p class="muted u-mt0">These statements run in one transaction on pgkiln's owner connection when you apply them: all of them, or none.</p><pre class="source cron-sql" data-code-view="sql" tabindex="0" aria-label="Generated SQL">${stmts.join('\n\n')}</pre>`
    : html`<p class="muted u-mt0">Nothing to change.</p>`)}
    <form method="post" action="${action}" class="cron-form">${csrf(s)}${hidden}<input type="hidden" name="reviewed" value="${reviewDigest(stmts)}">${o.extra ?? ''}
      <div class="buttons">${stmts.length ? html`<button class="btn ${o.danger ? 'btn-danger' : 'btn-hot'}" name="mode" value="apply">${icon(o.danger ? 'trash' : 'check')} ${o.apply ?? 'Apply'}</button>` : ''}${o.back ?? ''}</div></form>`;
}

const failedBox = (message: string) => html`<div class="alert alert-error" role="alert"><p class="u-mt0"><strong>Nothing was changed</strong>: the statements ran in one transaction, which was rolled back.</p><p class="u-m0">${message}</p></div>`;

async function editPage(reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job | null, o: { spec?: JobSpec; errors?: string[]; fields?: CronFields | null } = {}) {
  const ctx = await formContext(st);
  const spec = o.spec ?? (job ? specOf(job) : { name: '', schedule: '0 2 * * *', command: '', database: st.database, username: st.user, active: true });
  const title = job ? `Edit ${job.jobname ?? `job ${job.jobid}`}` : 'Create job';
  const main = html`${head(s, title)}${jobForm(s, spec, ctx, { jobid: job?.jobid ?? null, errors: o.errors ?? [], fields: o.fields })}`;
  const trail: [string, string?][] = job ? [[job.jobname ?? `Job ${job.jobid}`, jobUrl(job.jobid)], ['Edit']] : [['Create']];
  return send(reply.code(o.errors?.length ? 422 : 200), s, shell(s, title, crumbs(...trail), main, 'sql'));
}

async function save(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>) {
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
    if (clash && clash.jobid !== job?.jobid) errors.push(`${spec.username} has a job named ${spec.name} already.`);
  }
  if (errors.length) return editPage(reply, s, st, job, { spec, errors });
  const stmts = jobSql(job ? { ...specOf(job), jobid: job.jobid } : null, spec);
  const title = job ? `Change ${job.jobname ?? `job ${job.jobid}`}` : `Create job ${spec.name}`;
  const page = (output: Raw | '' = '') => {
    const main = html`${head(s, title)}${output}
      ${region('Schedule', schedulePreview(spec.schedule, st.timeZone))}
      ${reviewRegion(s, stmts, `${URL_BASE}/save`, hiddenSpec(spec, job?.jobid ?? null), { back: html`<button class="btn" name="mode" value="edit" formnovalidate>Back to the form</button>` })}`;
    const trail: [string, string?][] = job ? [[job.jobname ?? `Job ${job.jobid}`, jobUrl(job.jobid)], ['Review']] : [['Create', `${URL_BASE}/new`], ['Review']];
    return send(reply.code(output ? 422 : 200), s, shell(s, title, crumbs(...trail), main, 'sql'));
  };
  if (mode !== 'apply') return page();
  if (one(b.reviewed) !== reviewDigest(stmts)) return page(errorList(['The statements changed since you reviewed them (the job or the form changed): review them again.']));
  if (!stmts.length) return page(errorList(['Nothing to change.']));
  const failed = await applySql(stmts);
  await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}`.slice(0, 4000) });
  if (failed) return page(failedBox(failed));
  const created = job ? null : await owner.one<{ jobid: string }>('select jobid::text from cron.job where jobname = $1 and username = $2', [spec.name, spec.username]);
  flash(s, `${job ? 'Changed' : 'Created'} the job ${spec.name}.`);
  return back(reply, s, job ? jobUrl(job.jobid) : created ? jobUrl(created.jobid) : URL_BASE);
}

// ------------------------------------------------------------------ one job

function runsTable(runs: Awaited<ReturnType<typeof listRuns>>, withJob: boolean) {
  return html`<div class="table-wrap"><table class="report report-reflow cron-runs-table"><thead><tr><th class="num">Run</th>${withJob ? html`<th>Job</th>` : ''}<th>Status</th><th>Started</th><th class="num">Duration</th><th>Message</th></tr></thead>
    <tbody>${runs.length ? runs.map((r) => html`<tr>
      <td class="num" data-label="Run">${r.runid}</td>
      ${withJob ? html`<td data-label="Job" class="u-break">${r.jobid ? html`<a href="${jobUrl(r.jobid)}">${r.jobname ?? `Job ${r.jobid}`}</a>` : ''}</td>` : ''}
      <td data-label="Status">${statusTag(r.status)}</td><td data-label="Started">${r.start ?? ''}</td>
      <td class="num" data-label="Duration">${secs(r.secs)}</td>
      <td data-label="Message" class="u-break"><code class="small">${(r.return_message ?? '').slice(0, 500)}</code></td></tr>`)
      : html`<tr><td colspan="${withJob ? 6 : 5}" class="empty">No runs.</td></tr>`}</tbody></table></div>`;
}

async function jobPage(reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job, output: Raw | '' = '') {
  const runs = await listRuns(st.timeZone, { job: job.jobid, limit: 20 });
  const name = job.jobname ?? `Job ${job.jobid}`;
  const main = html`${head(s, name, html`<a class="btn btn-hot" href="${jobUrl(job.jobid)}/edit">${icon('edit')} Edit</a>
      <form method="post" action="${jobUrl(job.jobid)}/run" class="u-inline">${csrf(s)}<button class="btn" data-confirm="Run ${name} now, as ${job.username} in ${job.database}?">${icon('play')} Run now</button></form>
      <form method="post" action="${jobUrl(job.jobid)}/active" class="u-inline">${csrf(s)}<input type="hidden" name="active" value="${job.active ? '' : '1'}"><button class="btn">${job.active ? 'Disable' : 'Enable'}</button></form>
      <a class="btn btn-danger" href="${jobUrl(job.jobid)}/unschedule">${icon('trash')} Unschedule…</a>`)}
    ${output}
    ${region('Job', html`<dl class="dbu-facts">
      <dt>State</dt><dd>${job.active ? 'Active' : html`<span class="tag">inactive</span>`}</dd>
      <dt>Schedule</dt><dd><code>${job.schedule}</code></dd>
      <dt>Database</dt><dd>${job.database}</dd><dt>Run as</dt><dd>${job.username}</dd><dt>Job id</dt><dd>${job.jobid}</dd>
    </dl><pre class="source cron-sql" data-code-view="sql" tabindex="0" aria-label="Command">${job.command}</pre>`)}
    ${region('Schedule', schedulePreview(job.schedule, st.timeZone))}
    ${region('Recent runs', html`${runsTable(runs, false)}<p class="small"><a href="${URL_BASE}/history?job=${job.jobid}">All runs of this job</a> · <a href="${URL_BASE}/history/purge?job=${job.jobid}">Purge its history</a></p>`)}`;
  return send(reply, s, shell(s, name, crumbs([name]), main, 'sql'));
}

async function setActive(req: Req, reply: FastifyReply, s: Session, job: Job) {
  const active = !!one(req.body?.active);
  const stmts = activeSql(job.jobid, active);
  const failed = await applySql(stmts);
  await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}` });
  if (failed) flash(s, `${active ? 'Enabling' : 'Disabling'} failed: ${failed}`, 'error');
  else flash(s, `${active ? 'Enabled' : 'Disabled'} ${job.jobname ?? `job ${job.jobid}`}: ${stmts[0]}`);
  return back(reply, s, jobUrl(job.jobid));
}

async function unschedulePage(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job) {
  const stmts = unscheduleSql(job.jobid);
  const name = job.jobname ?? `Job ${job.jobid}`;
  let output: Raw | '' = '';
  if (req.method === 'POST') {
    if (one(req.body?.reviewed) !== reviewDigest(stmts)) output = errorList(['The statements changed since you reviewed them: review them again.']);
    else {
      const failed = await applySql(stmts);
      await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}` });
      if (!failed) {
        flash(s, `Unscheduled ${name}. Its run history stays until you purge it.`);
        return back(reply, s, URL_BASE);
      }
      output = failedBox(failed);
    }
  }
  const main = html`${head(s, `Unschedule ${name}`)}${output}
    <div class="alert alert-info" role="status">pg_cron forgets the job; its runs stay in the history until purged.</div>
    ${reviewRegion(s, stmts, `${jobUrl(job.jobid)}/unschedule`, html``, { danger: true, apply: 'Unschedule', back: html`<a class="btn" href="${jobUrl(job.jobid)}">Cancel</a>` })}`;
  return send(reply.code(output ? 422 : 200), s, shell(s, `Unschedule ${name}`, crumbs([name, jobUrl(job.jobid)], ['Unschedule']), main, 'sql'));
}

async function runJobNow(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>, job: Job) {
  const r = await runNow(job);
  await logActivity({ username: s.username, event: 'cron_run_now', ip: clientIp(req), elapsedMs: Math.round(r.ms), detail: `job ${job.jobid} ${job.jobname ?? ''}: ${r.ok ? 'ok' : 'failed'}: ${r.message}`.slice(0, 4000) });
  const out = html`<div class="alert ${r.ok ? 'alert-success' : 'alert-error'}" role="${r.ok ? 'status' : 'alert'}"><p class="u-mt0"><strong>${r.ok ? 'Ran' : 'Failed'}</strong> in ${secs(r.ms / 1000)}, as ${job.username} in ${job.database}: <code>${r.message}</code></p>
    ${r.notices.length ? html`<pre class="source small">${r.notices.join('\n')}</pre>` : ''}
    <p class="small u-m0">Run now runs the command from pgkiln, not from pg_cron: it isn't in pg_cron's run history; pgkiln's activity log has it.</p></div>`;
  return jobPage(reply.code(r.ok ? 200 : 422), s, st, job, out);
}

// ------------------------------------------------------------------ history

async function historyPage(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>) {
  const f = { job: String(req.query.job ?? ''), status: String(req.query.status ?? ''), q: String(req.query.q ?? '').trim().slice(0, 100) };
  const [jobs, runs] = await Promise.all([listJobs(st.timeZone), listRuns(st.timeZone, { ...f, limit: 200 })]);
  const main = html`${head(s, 'Run history', html`<a class="btn" href="${URL_BASE}/history/purge">${icon('trash')} Purge…</a>`)}
    ${region('Runs', html`<p class="muted u-mt0">pg_cron's <code>cron.job_run_details</code>, newest first (200 at most); times in <code>${st.timeZone}</code>. pg_cron keeps every run until it is purged.</p>
      <form method="get" action="${URL_BASE}/history" class="dbu-search u-mb1" role="search">
        <label class="sr-only" for="h-job">Job</label><select id="h-job" name="job"><option value="">All jobs</option>${jobs.map((j) => html`<option value="${j.jobid}"${sel(j.jobid === f.job)}>${j.jobname ?? `Job ${j.jobid}`}</option>`)}</select>
        <label class="sr-only" for="h-status">Status</label><select id="h-status" name="status"><option value="">Any status</option>${RUN_STATUSES.map((x) => html`<option${sel(x === f.status)}>${x}</option>`)}</select>
        <label class="sr-only" for="h-q">Search messages and commands</label><input id="h-q" name="q" type="search" value="${f.q}" placeholder="Search messages" autocomplete="off">
        <button class="btn btn-sm">${icon('filter')} Filter</button></form>
      ${runsTable(runs, true)}`)}`;
  return send(reply, s, shell(s, 'Run history', crumbs(['Run history']), main, 'sql'));
}

const PURGE_DAYS: [string, string][] = [['7', 'older than 7 days'], ['30', 'older than 30 days'], ['90', 'older than 90 days'], ['all', 'all']];

async function purgePage(req: Req, reply: FastifyReply, s: Session, st: Extract<CronState, { ok: true }>) {
  const src = req.method === 'POST' ? (req.body ?? {}) : req.query;
  const dayKey = PURGE_DAYS.some(([k]) => k === one(src.days)) ? one(src.days) : '30';
  const days = dayKey === 'all' ? null : Number(dayKey);
  const jobArg = one(src.job);
  const job = jobArg ? await oneJob(st.timeZone, jobArg) : null;
  if (jobArg && !job) return reply.code(404).send('Not found');
  const stmts = purgeSql(days, job?.jobid ?? null);
  let output: Raw | '' = '';
  if (req.method === 'POST') {
    if (one(src.reviewed) !== reviewDigest(stmts)) output = errorList(['The statements changed since you reviewed them: review them again.']);
    else {
      const failed = await applySql(stmts);
      await logActivity({ username: s.username, event: 'cron_job', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${stmts.join('\n')}` });
      if (!failed) {
        flash(s, 'Purged the run history.');
        return back(reply, s, `${URL_BASE}/history${job ? `?job=${job.jobid}` : ''}`);
      }
      output = failedBox(failed);
    }
  }
  const n = await countPurge(days, job?.jobid ?? null);
  const main = html`${head(s, 'Purge run history')}${output}
    ${region('Which runs', html`<form method="get" action="${URL_BASE}/history/purge" class="dbu-search">${job ? html`<input type="hidden" name="job" value="${job.jobid}">` : ''}
        <label for="p-days">Runs${job ? html` of <strong>${job.jobname ?? `job ${job.jobid}`}</strong>` : ''}</label>
        <select id="p-days" name="days">${PURGE_DAYS.map(([k, l]) => html`<option value="${k}"${sel(k === dayKey)}>${l}</option>`)}</select>
        <button class="btn btn-sm">${icon('eye')} Review SQL</button></form>
      <p class="u-m0">${plural(n, 'run')} would be deleted.</p>`)}
    ${reviewRegion(s, stmts, `${URL_BASE}/history/purge`, html`<input type="hidden" name="days" value="${dayKey}">${job ? html`<input type="hidden" name="job" value="${job.jobid}">` : ''}`,
      { danger: true, apply: 'Purge', back: html`<a class="btn" href="${URL_BASE}/history">Cancel</a>` })}`;
  return send(reply.code(output ? 422 : 200), s, shell(s, 'Purge run history', crumbs(['Run history', `${URL_BASE}/history`], ['Purge']), main, 'sql'));
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
    return reply.type('text/html').send(String(schedulePreview(String(req.query.schedule ?? '').slice(0, 300), st.ok ? st.timeZone : 'GMT')));
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
