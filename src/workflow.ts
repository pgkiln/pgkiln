import pg from 'pg';
import { applyBinds, splitStatements, type BindValues } from './binds.ts';
import { owner } from './db.ts';
import { html, type Raw } from './html.ts';

// Workflows (APEX 23.2: Workflow). A definition is a list of named steps;
// an instance runs them one after the other. Each step runs in its own
// transaction, as the application's database role (with the initiator as
// meta.app_user()), and records what it did in meta.workflow_event:
//
//   {"name": "CHECK", "type": "switch", "cases": [{"when": ":DAYS::int > 5", "next": "HR"}], "otherwise": "MANAGER"}
//   {"name": "MANAGER", "type": "task", "task": "LEAVE_APPROVAL", "owners": "select … usernames", "next": {"approved": "BOOK", "rejected": "END"}}
//   {"name": "BOOK", "type": "sql", "code": "select hr.book(:DETAIL_PK::int) as booking_id"}
//   {"name": "PAUSE", "type": "wait", "for": "2 days"}
//   {"name": "END", "type": "end"}
//
// "next" is optional (the following step; after the last one, the end).
// Binds: the variables (upper case), DETAIL_PK, WORKFLOW_ID, INITIATOR, and
// after a task TASK_OUTCOME (APPROVED, REJECTED, COMPLETED, CANCELLED) and
// TASK_APPROVER. Columns that sql steps return become variables. A step
// that fails puts the workflow in "faulted"; an administrator can retry it.
//
// The server runs workflows when they start or a task of theirs ends
// (NOTIFY pgapex_workflow) and checks for due waits every few seconds.

export type Step =
  | { name: string; type: 'task'; task: string; owners?: string; next?: string | Record<string, string> }
  | { name: string; type: 'sql'; code: string; next?: string }
  | { name: string; type: 'switch'; cases: { when: string; next: string }[]; otherwise?: string }
  | { name: string; type: 'wait'; for: string; next?: string }
  | { name: string; type: 'end' };

const TYPES = ['task', 'sql', 'switch', 'wait', 'end'];
const OUTCOMES = ['approved', 'rejected', 'completed', 'cancelled'];
const INTERVAL = /^\s*\d+\s*(second|minute|hour|day|week|month)s?\s*$/i;
const MAX_STEPS_PER_RUN = 100;

/** Problems in a definition's steps (for the builder), or [] when it can run. */
export function stepProblems(steps: unknown, taskNames?: Set<string>): string[] {
  if (!Array.isArray(steps)) return ['The steps must be a JSON array.'];
  if (!steps.length) return ['A workflow needs at least one step.'];
  const problems: string[] = [];
  const names = new Set<string>();
  for (const [i, s] of steps.entries()) {
    const where = `Step ${i + 1}`;
    if (!s || typeof s !== 'object') { problems.push(`${where} is not an object.`); continue; }
    const st = s as Record<string, any>;
    if (typeof st.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(st.name)) problems.push(`${where}: "name" must be an upper-case name like CHECK_BUDGET.`);
    else if (names.has(st.name)) problems.push(`${where}: the name ${st.name} is used twice.`);
    else names.add(st.name);
    if (!TYPES.includes(st.type)) { problems.push(`${where} (${st.name ?? '?'}): "type" must be one of ${TYPES.join(', ')}.`); continue; }
    const label = `${where} (${st.name})`;
    if (st.type === 'task') {
      if (typeof st.task !== 'string' || !st.task) problems.push(`${label}: "task" names a task definition.`);
      else if (taskNames && !taskNames.has(st.task.toUpperCase())) problems.push(`${label}: task definition ${st.task} doesn't exist.`);
      if (st.owners !== undefined && typeof st.owners !== 'string') problems.push(`${label}: "owners" is a SELECT returning usernames.`);
      if (st.next && typeof st.next === 'object' && Object.keys(st.next).some((k) => !OUTCOMES.includes(k) && k !== 'default'))
        problems.push(`${label}: "next" outcomes are ${OUTCOMES.join(', ')} (and default).`);
    }
    if (st.type === 'sql' && (typeof st.code !== 'string' || !st.code.trim())) problems.push(`${label}: "code" is the SQL to run.`);
    if (st.type === 'switch' && (!Array.isArray(st.cases) || !st.cases.every((c: any) => typeof c?.when === 'string' && typeof c?.next === 'string')))
      problems.push(`${label}: "cases" is a list of {"when": "SQL condition", "next": "STEP"}.`);
    if (st.type === 'wait' && !(typeof st.for === 'string' && INTERVAL.test(st.for))) problems.push(`${label}: "for" is an interval such as "2 days" or "4 hours".`);
  }
  // every "next" points to a step
  for (const st of steps as Record<string, any>[]) {
    for (const target of targets(st as Step)) if (!names.has(target)) problems.push(`${st.name}: there is no step ${target}.`);
  }
  return problems;
}

/** The steps a step can go to (explicit targets only). */
export function targets(s: Step): string[] {
  if (s.type === 'end') return [];
  if (s.type === 'switch') return [...s.cases.map((c) => c.next), ...(s.otherwise ? [s.otherwise] : [])].filter(Boolean);
  const next = (s as { next?: string | Record<string, string> }).next;
  if (!next) return [];
  return typeof next === 'string' ? [next] : Object.values(next);
}

/** Where a step goes when it doesn't say: the following one, or the end. */
const following = (steps: Step[], name: string) => steps[steps.findIndex((s) => s.name === name) + 1]?.name ?? null;

interface Instance {
  id: string;
  app_id: number;
  name: string;
  detail_pk: string | null;
  vars: Record<string, unknown>;
  steps: Step[];
  state: string;
  current_step: string;
  waiting_task: string | null;
  initiator: string;
  db_role: string | null;
}

const asBind = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

class StepError extends Error {}

/**
 * Advance one workflow as far as it can go now (until it waits, ends or
 * faults). Returns the number of steps taken.
 */
export async function runWorkflow(id: string | number): Promise<number> {
  let taken = 0;
  for (; taken < MAX_STEPS_PER_RUN; taken++) {
    let more: boolean;
    try {
      more = await owner.tx((c) => step(c, String(id)));
    } catch (e) {
      const msg = (e as Error).message.slice(0, 2000);
      await owner.tx(async (c) => {
        const w = (await c.query(`update meta.workflow set state = 'faulted', error = $2, updated_at = now() where id = $1 and state in ('active', 'waiting') returning current_step`, [id, msg])).rows[0];
        if (w) await c.query(`select meta.workflow_log($1, $2, 'faulted', $3)`, [id, w.current_step, msg]);
      });
      return taken;
    }
    if (!more) return taken;
  }
  // a loop of steps that never waits: stop it rather than spin
  await owner.tx(async (c) => {
    const w = (await c.query(`update meta.workflow set state = 'faulted', error = $2, updated_at = now() where id = $1 returning current_step`, [id, `More than ${MAX_STEPS_PER_RUN} steps without waiting: a loop?`])).rows[0];
    if (w) await c.query(`select meta.workflow_log($1, $2, 'faulted', 'More than ${MAX_STEPS_PER_RUN} steps without waiting')`, [id, w.current_step]);
  });
  return taken;
}

/** One step, in the caller's transaction. Returns whether the workflow can go on right away. */
async function step(c: pg.PoolClient, id: string): Promise<boolean> {
  const w = (
    await c.query<Instance>(
      `select w.id::text, w.app_id, w.name, w.detail_pk, w.vars, w.steps, w.state, w.current_step, w.waiting_task::text, w.initiator, a.db_role
         from meta.workflow w join meta.app a on a.id = w.app_id
        where w.id = $1 and (w.state = 'active' or (w.state = 'waiting' and w.wait_until <= now()))
        for update of w skip locked`,
      [id],
    )
  ).rows[0];
  if (!w) return false;
  await c.query(
    `select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true), set_config('pgapex.session_id', '', true),
            set_config('pgapex.workflow_id', $3, true), set_config('statement_timeout', '30s', true)`,
    [String(w.app_id), w.initiator, w.id],
  );
  const steps = w.steps;
  const s = steps.find((x) => x.name === w.current_step);
  if (!s) throw new StepError(`There is no step ${w.current_step}.`);
  const vars = { ...w.vars };
  const binds = (): BindValues => ({
    ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toUpperCase(), asBind(v)])),
    DETAIL_PK: w.detail_pk, WORKFLOW_ID: w.id, INITIATOR: w.initiator,
  });
  // the application's SQL runs as its role; pgapex's own bookkeeping as the owner
  // (on an error the transaction is rolled back as a whole: resetting the role then would only hide the error)
  const asApp = async <T>(fn: () => Promise<T>) => {
    if (w.db_role) await c.query(`set local role ${pg.escapeIdentifier(w.db_role)}`);
    const result = await fn();
    if (w.db_role) await c.query('reset role');
    return result;
  };
  const log = (event: string, detail?: string | null, at = s.name) => c.query('select meta.workflow_log($1, $2, $3, $4)', [w.id, at, event, detail ?? null]);
  const goTo = async (next: string | null | undefined, detail?: string) => {
    const target = next === undefined ? following(steps, s.name) : next;
    await log('step', detail);
    if (!target) {
      await c.query(`update meta.workflow set state = 'completed', current_step = null, vars = $2, ended_at = now(), updated_at = now(), wait_until = null where id = $1`, [w.id, vars]);
      await log('completed', null, s.name);
      return false;
    }
    if (!steps.some((x) => x.name === target)) throw new StepError(`Step ${s.name} goes to ${target}, which doesn't exist.`);
    await c.query(`update meta.workflow set state = 'active', current_step = $2, vars = $3, wait_until = null, waiting_task = null, updated_at = now() where id = $1`, [w.id, target, vars]);
    return true;
  };

  // back from a wait or a task
  if (w.state === 'waiting') {
    await log('resumed');
    return goTo((s as { next?: string }).next ?? undefined, 'waited');
  }
  if (w.waiting_task) {
    const t = (await c.query('select state, outcome, completed_by from meta.task where id = $1', [w.waiting_task])).rows[0];
    if (!t || !['completed', 'cancelled'].includes(t.state)) return false;
    const outcome: string = t.state === 'cancelled' ? 'cancelled' : t.outcome;
    vars.TASK_OUTCOME = outcome.toUpperCase();
    vars.TASK_APPROVER = t.completed_by;
    const next = (s as { next?: string | Record<string, string> }).next;
    let target: string | null | undefined = typeof next === 'string' ? next : next?.[outcome] ?? next?.default;
    if (target === undefined && outcome === 'cancelled') {
      // a cancelled task without a "cancelled" branch ends the workflow
      await c.query(`update meta.workflow set state = 'terminated', vars = $2, waiting_task = null, ended_at = now(), updated_at = now() where id = $1`, [w.id, vars]);
      await log('terminated', 'its task was cancelled');
      return false;
    }
    return goTo(target, outcome);
  }

  switch (s.type) {
    case 'sql': {
      const statements = splitStatements(applyBinds(s.code, binds()));
      const res = await asApp(async () => {
        let last: pg.QueryResult | undefined;
        for (const stmt of statements) last = await c.query(stmt);
        return last;
      });
      const row = res?.rows?.[0];
      if (row) for (const [k, v] of Object.entries(row)) vars[k.toUpperCase()] = v;
      return goTo(s.next);
    }
    case 'switch': {
      for (const cs of s.cases) {
        const ok = await asApp(async () => (await c.query(`select (${applyBinds(cs.when, binds())})::boolean as ok`)).rows[0].ok);
        if (ok === true) return goTo(cs.next, `when ${cs.when}`);
      }
      return goTo(s.otherwise ?? undefined, 'otherwise');
    }
    case 'task': {
      const owners = s.owners?.trim()
        ? await asApp(async () => (await c.query({ text: applyBinds(s.owners!.trim().replace(/;+\s*$/, ''), binds()), rowMode: 'array' })).rows.map((r) => String(r[0])).filter(Boolean))
        : [];
      const params = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v]));
      const taskId = (await c.query(`select meta.create_task($1, $2, $3, $4) as id`, [s.task, w.detail_pk, params, owners])).rows[0].id;
      await c.query('update meta.task set workflow_id = $2 where id = $1', [taskId, w.id]);
      await c.query(`update meta.workflow set state = 'waiting', waiting_task = $2, wait_until = null, vars = $3, updated_at = now() where id = $1`, [w.id, taskId, vars]);
      await log('task', `task ${taskId}${owners.length ? ` for ${owners.join(', ')}` : ''}`);
      return false;
    }
    case 'wait': {
      await c.query(`update meta.workflow set state = 'waiting', wait_until = now() + $2::interval, vars = $3, updated_at = now() where id = $1`, [w.id, s.for, vars]);
      await log('waiting', s.for);
      return false;
    }
    case 'end':
      await c.query(`update meta.workflow set state = 'completed', vars = $2, ended_at = now(), updated_at = now() where id = $1`, [w.id, vars]);
      await log('completed');
      return false;
    default:
      throw new StepError(`Unknown step type in ${(s as Step).name}.`);
  }
}

/** Run every workflow that can go on now (started, woken by its task, or a wait that's over). */
export async function runWorkflows(): Promise<number> {
  const ids = (
    await owner.query<{ id: string }>(
      `select id::text from meta.workflow where state = 'active' or (state = 'waiting' and wait_until <= now()) order by updated_at limit 100`,
    )
  ).rows.map((r) => r.id);
  let steps = 0;
  for (const id of ids) steps += await runWorkflow(id);
  return steps;
}

// ------------------------------------------------------------------ in the server

let listener: pg.Client | undefined;
let timer: NodeJS.Timeout | undefined;

/** Listen for started and woken workflows, and check for due waits every few seconds. */
export async function startWorkflowRunner() {
  if (process.env.WORKFLOWS === 'off' || timer) return;
  let busy = false;
  let again = false;
  const run = async () => {
    if (busy) return void (again = true);
    busy = true;
    try {
      do {
        again = false;
        await runWorkflows();
      } while (again);
    } catch (e) {
      console.error('workflows:', (e as Error).message);
    } finally {
      busy = false;
    }
  };
  try {
    listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    listener.on('notification', () => void run());
    listener.on('error', (e) => console.error('workflows listener:', e.message));
    await listener.query('listen pgapex_workflow');
  } catch (e) {
    console.error('workflows: no listener, polling only:', (e as Error).message);
  }
  timer = setInterval(() => void run(), Math.max(2, Number(process.env.WORKFLOW_INTERVAL_S ?? 10)) * 1000);
  timer.unref();
  void run();
}

// ------------------------------------------------------------------ diagram

/** The steps as a top-down diagram (inline SVG; colours from app.css). */
export function workflowDiagram(steps: Step[]): Raw {
  if (!Array.isArray(steps) || !steps.length) return html``;
  // levels: the longest path from the first step (cycles are cut)
  const level = new Map<string, number>([[steps[0].name, 0]]);
  const edges: { from: string; to: string; label: string }[] = [];
  for (const s of steps) {
    if (s.type === 'switch') {
      for (const cs of s.cases) edges.push({ from: s.name, to: cs.next, label: cs.when.length > 24 ? `${cs.when.slice(0, 22)}…` : cs.when });
      edges.push({ from: s.name, to: s.otherwise ?? following(steps, s.name) ?? '', label: 'otherwise' });
    } else if (s.type !== 'end') {
      const next = (s as { next?: string | Record<string, string> }).next;
      if (next && typeof next === 'object') for (const [k, v] of Object.entries(next)) edges.push({ from: s.name, to: v, label: k });
      else edges.push({ from: s.name, to: (next as string | undefined) ?? following(steps, s.name) ?? '', label: '' });
    }
  }
  const real = edges.filter((e) => e.to && steps.some((s) => s.name === e.to));
  for (let pass = 0; pass < steps.length; pass++)
    for (const e of real) {
      const l = level.get(e.from);
      if (l !== undefined && (level.get(e.to) ?? -1) < l + 1 && l + 1 < steps.length) level.set(e.to, l + 1);
    }
  for (const s of steps) if (!level.has(s.name)) level.set(s.name, 0);
  const rows = new Map<number, string[]>();
  for (const s of steps) rows.set(level.get(s.name)!, [...(rows.get(level.get(s.name)!) ?? []), s.name]);
  const W = 150, H = 44, GX = 40, GY = 56;
  const widest = Math.max(...[...rows.values()].map((r) => r.length));
  const width = widest * (W + GX) + GX;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, names] of rows) names.forEach((n, i) => pos.set(n, { x: GX + i * (W + GX) + ((widest - names.length) * (W + GX)) / 2, y: 20 + l * (H + GY) }));
  const height = 20 + (Math.max(...rows.keys()) + 1) * (H + GY);
  const typeOf = new Map(steps.map((s) => [s.name, s.type]));
  return html`<svg class="wf-diagram" viewBox="0 0 ${width} ${height}" role="img" aria-label="Workflow diagram" preserveAspectRatio="xMidYMin meet">
    <defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wf-arrowhead"/></marker></defs>
    ${real.map((e) => {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y;
      const back = y2 <= y1;
      const d = back ? `M${x1},${y1} C${x1 + W},${y1 + 40} ${x2 + W},${y2 - 40} ${x2 + W / 2 - 4},${y2 + H / 2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2 - 2}`;
      return html`<path d="${d}" class="wf-edge" marker-end="url(#wf-arrow)"/>${e.label ? html`<text x="${(x1 + x2) / 2 + 4}" y="${(y1 + y2) / 2}" class="wf-label">${e.label}</text>` : ''}`;
    })}
    ${steps.map((s) => {
      const p = pos.get(s.name)!;
      return html`<g class="wf-node wf-${typeOf.get(s.name)}"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8"/>
        <text x="${p.x + W / 2}" y="${p.y + 18}" class="wf-name">${s.name}</text>
        <text x="${p.x + W / 2}" y="${p.y + 34}" class="wf-type">${s.type === 'task' ? `task ${(s as { task: string }).task}` : s.type}</text></g>`;
    })}
  </svg>`;
}
