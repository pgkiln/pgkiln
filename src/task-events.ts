import pg from 'pg';
import { applyBinds, splitStatements, type BindValues } from './binds.ts';
import { owner } from './db.ts';
import { isQuery, stepTx } from './workflow.ts';

// (123) Task events and built-in notifications (APEX 26.2: Human Task events).
//
// A task definition's "events" are actions on what happens to its tasks:
//
//   [{"on": "complete", "type": "sql", "code": "select hr.salary_decided(:DETAIL_PK::int, :OUTCOME)"},
//    {"on": "expire", "type": "mail", "to": "select email from staff where role = 'hr'", "template": "TASK_EXPIRED"},
//    {"on": "fail", "type": "workflow", "workflow": "ESCALATE", "vars": {"REASON": "&ERROR."}}]
//
//   on    complete  the task was completed (any outcome; also meta.close_tasks with an outcome)
//         expire    the task expired (the definition's expiration policy)
//         fail      the definition's completion SQL raised an error: the actions run in the same
//                   request, after the SQL's effect is undone; "fail_recovery" says whether the task
//                   then stays open (reopen, the default: the decision is undone) or is completed
//   type  sql       statements, as the application's role, with the task's binds
//         mail      meta.send_mail_template (template) or meta.send_mail (subject, body); "to" is a
//                   SELECT returning addresses, or addresses with &NAME. substitutions
//         workflow  meta.start_workflow(workflow, the task's detail_pk, its parameters + "vars")
//
// Binds (and #NAME# placeholders in mail): the task's parameters, TASK_ID, DETAIL_PK, SUBJECT,
// OUTCOME (upper case), APPROVER, INITIATOR, EVENT, and for fail ERROR and COMMENT.
//
// "notifications" ({"create": "TEMPLATE", "complete": "TEMPLATE", "expire": "TEMPLATE"}) send the
// application's e-mail template to the potential owners (create), the initiator (complete) or both
// (expire), at the addresses of their accounts.
//
// Complete, expire and create run after the commit: a trigger queues them in meta.task_hook and the
// workflow runner (src/workflow.ts startWorkflowRunner) works them off, each in its own transaction as
// the application's role. A hook that fails is tried three times; its error stays on the row.

export const EVENTS = ['complete', 'expire', 'fail'] as const;
export const ACTION_TYPES = ['sql', 'mail', 'workflow'] as const;
export const OUTCOME_COLOURS = ['default', 'primary', 'success', 'danger', 'warning'] as const;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

export interface TaskAction {
  on: (typeof EVENTS)[number];
  type: (typeof ACTION_TYPES)[number];
  code?: string;
  to?: string;
  template?: string;
  subject?: string;
  body?: string;
  workflow?: string;
  vars?: Record<string, string>;
}

/** Problems with a task definition's custom outcomes (the database checks the same). */
export function outcomeProblems(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (!Array.isArray(v)) return ['Outcomes: a JSON array of {"name": "YES", "label": "Yes", "colour": "success"}.'];
  const problems: string[] = [];
  const seen = new Set<string>();
  if (v.length > 10) problems.push('Outcomes: at most 10.');
  for (const o of v) {
    if (!o || typeof o !== 'object') { problems.push('Outcomes: each is an object {"name", "label", "colour"}.'); continue; }
    const { name, label, colour } = o as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(name)) { problems.push(`Outcome ${JSON.stringify(name)}: a name of letters, digits and underscores, e.g. YES.`); continue; }
    if (['cancelled', 'expired', 'default'].includes(name.toLowerCase())) problems.push(`Outcome ${name}: the name is reserved.`);
    if (seen.has(name.toLowerCase())) problems.push(`Outcome ${name} is listed twice.`);
    seen.add(name.toLowerCase());
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 60)) problems.push(`Outcome ${name}: the label is text (at most 60 characters).`);
    if (colour !== undefined && !OUTCOME_COLOURS.includes(colour as never)) problems.push(`Outcome ${name}: the colour is ${OUTCOME_COLOURS.join(', ')}.`);
  }
  return problems;
}

/** Problems with a task definition's events. */
export function eventProblems(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (!Array.isArray(v)) return ['Events: a JSON array of {"on": "complete", "type": "sql", "code": "…"}.'];
  const problems: string[] = [];
  if (v.length > 20) problems.push('Events: at most 20 actions.');
  v.forEach((x, i) => {
    const where = `Event ${i + 1}`;
    if (!x || typeof x !== 'object') return void problems.push(`${where}: an object.`);
    const a = x as Record<string, unknown>;
    if (!EVENTS.includes(a.on as never)) problems.push(`${where}: "on" is ${EVENTS.join(', ')}.`);
    if (!ACTION_TYPES.includes(a.type as never)) return void problems.push(`${where}: "type" is ${ACTION_TYPES.join(', ')}.`);
    if (a.type === 'sql' && (typeof a.code !== 'string' || !a.code.trim())) problems.push(`${where}: "code" is the SQL to run.`);
    if (a.type === 'mail') {
      if (typeof a.to !== 'string' || !a.to.trim()) problems.push(`${where}: "to" is a SELECT returning e-mail addresses, or addresses.`);
      if (a.template !== undefined && (typeof a.template !== 'string' || !NAME.test(a.template))) problems.push(`${where}: "template" names an e-mail template.`);
      if (a.template === undefined && (typeof a.subject !== 'string' || !a.subject.trim() || typeof a.body !== 'string')) problems.push(`${where}: give a "template", or a "subject" and a "body".`);
    }
    if (a.type === 'workflow') {
      if (typeof a.workflow !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(a.workflow)) problems.push(`${where}: "workflow" names a workflow definition.`);
      if (a.vars !== undefined && (!a.vars || typeof a.vars !== 'object' || Array.isArray(a.vars) || Object.entries(a.vars).some(([k, val]) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(k) || typeof val !== 'string')))
        problems.push(`${where}: "vars" is an object of variable → text (&NAME. allowed).`);
    }
  });
  return problems;
}

/** Problems with a task definition's notifications. */
export function notificationProblems(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (typeof v !== 'object' || Array.isArray(v)) return ['Notifications: a JSON object such as {"create": "TASK_CREATED", "complete": "TASK_DONE"}.'];
  const problems: string[] = [];
  for (const [k, t] of Object.entries(v)) {
    if (!['create', 'complete', 'expire'].includes(k)) problems.push(`Notifications: "${k}" is not create, complete or expire.`);
    if (typeof t !== 'string' || !NAME.test(t)) problems.push(`Notifications: "${k}" names an e-mail template.`);
  }
  return problems;
}

/** Binds for a task's actions: upper-case names, text values. */
export function taskBinds(t: { id: string; detail_pk: string | null; params: Record<string, unknown> | null; subject: string; outcome: string | null; completed_by: string | null; initiator: string },
  extra: Record<string, string | null> = {}): BindValues {
  const params = Object.fromEntries(Object.entries(t.params ?? {}).map(([k, v]) => [k.toUpperCase(), v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  return { ...params, TASK_ID: String(t.id), DETAIL_PK: t.detail_pk, SUBJECT: t.subject, OUTCOME: t.outcome ? t.outcome.toUpperCase() : null, APPROVER: t.completed_by, INITIATOR: t.initiator, ...extra };
}

const substitute = (text: string, b: BindValues) => text.replace(/&([A-Za-z][A-Za-z0-9_]*)\./g, (m, name: string) => (name.toUpperCase() in b ? (b[name.toUpperCase()] ?? '') : m));

/** Addresses from a "to": a SELECT (as the application's role) or a list with &NAME. substitutions. */
export async function recipients(q: pg.PoolClient, to: string, b: BindValues): Promise<string> {
  if (!isQuery(to)) return substitute(to, b);
  const rows = (await q.query({ text: applyBinds(to.trim().replace(/;+\s*$/, ''), b), rowMode: 'array' })).rows;
  return rows.map((r) => r[0]).filter((x) => typeof x === 'string' && x.trim()).join(', ');
}

/** Queue a mail as the application's role: a template with #NAME# placeholders, or a subject and body. */
export async function queueMail(q: pg.PoolClient, m: { to: string; template?: string; subject?: string; body?: string }, b: BindValues) {
  const values = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v ?? '']));
  return m.template
    ? (await q.query('select meta.send_mail_template($1, $2, $3) as id', [m.template, values, m.to])).rows[0].id
    : (await q.query(`select meta.send_mail($1, regexp_replace(meta.mail_fill($2, $4, false), '[\\r\\n]+', ' ', 'g'), meta.mail_fill($3, $4, false)) as id`, [m.to, m.subject ?? '', m.body ?? '', values])).rows[0].id;
}

/** Run a task event's actions on `q`, which is the application's role. Returns what was done (for the log). */
export async function runActions(q: pg.PoolClient, actions: TaskAction[], b: BindValues, detailPk: string | null): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    if (a.type === 'sql' && a.code?.trim()) {
      for (const stmt of splitStatements(applyBinds(a.code, b))) await q.query(stmt);
      done.push('sql');
    } else if (a.type === 'mail' && a.to) {
      const to = await recipients(q, a.to, b);
      if (to.trim()) done.push(`mail ${await queueMail(q, { to, template: a.template, subject: a.subject, body: a.body }, b)}`);
    } else if (a.type === 'workflow' && a.workflow) {
      const params = Object.fromEntries(Object.entries(b).filter(([k]) => !['TASK_ID', 'SUBJECT', 'APPROVER', 'INITIATOR', 'EVENT', 'ERROR', 'COMMENT', 'DETAIL_PK'].includes(k)));
      const vars = { ...params, TASK_ID: b.TASK_ID, OUTCOME: b.OUTCOME, ...Object.fromEntries(Object.entries(a.vars ?? {}).map(([k, v]) => [k.toUpperCase(), substitute(v, b)])) };
      done.push(`workflow ${(await q.query('select meta.start_workflow($1, $2, $3) as id', [a.workflow, detailPk, vars])).rows[0].id}`);
    }
  }
  return done;
}

/** The actions of a definition's events for one event. */
export const actionsFor = (events: unknown, on: string): TaskAction[] => (Array.isArray(events) ? (events as TaskAction[]).filter((a) => a && typeof a === 'object' && a.on === on) : []);

interface Hook {
  hook_id: string;
  event: 'create' | 'complete' | 'expire';
  id: string;
  app_id: number;
  detail_pk: string | null;
  params: Record<string, unknown> | null;
  subject: string;
  outcome: string | null;
  completed_by: string | null;
  initiator: string;
  tenant_id: string;
  workflow_id: string | null;
  events: unknown;
  notifications: Record<string, string> | null;
  db_role: string | null;
}

/** Run one queued hook in its own transaction. */
async function runHook(id: string): Promise<boolean> {
  return stepTx(async (c, side) => {
    const h = (
      await c.query<Hook>(
        `select h.id::text as hook_id, h.event, t.id::text, t.app_id, t.detail_pk, t.params, t.subject, t.outcome, t.completed_by, t.initiator,
                coalesce(t.tenant_id, '') as tenant_id, t.workflow_id::text, d.events, d.notifications, a.db_role
           from meta.task_hook h join meta.task t on t.id = h.task_id join meta.task_definition d on d.id = t.definition_id join meta.app a on a.id = t.app_id
          where h.id = $1 and h.done_at is null for update of h skip locked`,
        [id],
      )
    ).rows[0];
    if (!h) return false;
    // the person whose act it was: the one who completed it, else the initiator
    const actor = h.event === 'complete' ? (h.completed_by ?? h.initiator) : h.initiator;
    await c.query(
      `select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true), set_config('pgkiln.session_id', '', true),
              set_config('pgkiln.workflow_id', $3, true), set_config('statement_timeout', '30s', true), set_config('pgkiln.tenant_id', $4, true)`,
      [String(h.app_id), actor, h.workflow_id ?? '', h.tenant_id],
    );
    const template = h.notifications?.[h.event];
    // recipients of a notification, as the owner (accounts aren't the application's)
    const to = template
      ? ((await c.query('select meta.task_addresses($1, $2, $3) as a', [h.id, h.event !== 'complete', h.event !== 'create'])).rows[0].a as string[])
      : [];
    const b = taskBinds(h, { EVENT: h.event.toUpperCase() });
    const asApp = async <T>(fn: (q: pg.PoolClient) => Promise<T>) => {
      const isolated = await side.open({ app_id: h.app_id, db_role: h.db_role, initiator: actor, id: h.workflow_id ?? '', tenant_id: h.tenant_id });
      if (isolated) return fn(isolated);
      if (h.db_role) await c.query(`set local role ${pg.escapeIdentifier(h.db_role)}`);
      const result = await fn(c);
      if (h.db_role) await c.query('reset role');
      return result;
    };
    await asApp(async (q) => {
      await runActions(q, actionsFor(h.events, h.event), b, h.detail_pk);
      if (template && to.length) await queueMail(q, { to: to.join(', '), template }, b);
    });
    await c.query('update meta.task_hook set done_at = now(), attempts = attempts + 1, error = null where id = $1', [h.hook_id]);
    return true;
  });
}

/** Work off the queued task events and notifications. Returns how many ran. */
export async function runTaskHooks(): Promise<number> {
  const ids = (await owner.query<{ id: string }>('select id::text from meta.task_hook where done_at is null and attempts < 3 order by id limit 100')).rows.map((r) => r.id);
  let n = 0;
  for (const id of ids) {
    try {
      if (await runHook(id)) n++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 2000);
      await owner.query(`update meta.task_hook set attempts = attempts + 1, error = $2, done_at = case when attempts + 1 >= 3 then now() end where id = $1`, [id, msg]);
      console.error(`task event ${id}:`, msg);
    }
  }
  return n;
}
