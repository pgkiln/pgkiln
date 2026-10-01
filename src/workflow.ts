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
//   {"name": "SPLIT", "type": "parallel", "branches": ["IT", "DESK"], "join": "MEET"}
//   {"name": "MEET", "type": "join", "wait_for": "all"}
//   {"name": "END", "type": "end"}
//
// "next" is optional (the following step; after the last one, the end).
// Binds: the variables (upper case), DETAIL_PK, WORKFLOW_ID, INITIATOR, and
// after a task TASK_OUTCOME (APPROVED, REJECTED, COMPLETED, CANCELLED) and
// TASK_APPROVER. Columns that sql steps return become variables. A step
// that fails puts the workflow in "faulted"; an administrator can retry it.
//
// Parallel branches (migration 027): a "parallel" step starts a branch at each
// of its "branches" steps; each branch runs on its own (its own step, wait and
// task: a row in meta.workflow_branch) until it reaches the "join" step, while
// the path that split waits there. The join goes on when all branches are
// done, or with "wait_for": "any" when the first is (the others are then
// cancelled, with their tasks). Branches share the variables. An "end" step in
// a branch, or a cancelled task without a "cancelled" outcome, ends the whole
// workflow. A failing step faults its branch (and shows the workflow as
// faulted); the other branches go on, and a retry resumes the failed one.
//
// The server runs workflows when they start or a task of theirs ends
// (NOTIFY pgapex_workflow) and checks for due waits every few seconds.

export type Step =
  | { name: string; type: 'task'; task: string; owners?: string; next?: string | Record<string, string> }
  | { name: string; type: 'sql'; code: string; next?: string }
  | { name: string; type: 'switch'; cases: { when: string; next: string }[]; otherwise?: string }
  | { name: string; type: 'wait'; for: string; next?: string }
  | { name: string; type: 'parallel'; branches: string[]; join: string }
  | { name: string; type: 'join'; wait_for?: 'all' | 'any'; next?: string }
  | { name: string; type: 'end' };

const TYPES = ['task', 'sql', 'switch', 'wait', 'parallel', 'join', 'end'];
const OUTCOMES = ['approved', 'rejected', 'completed', 'cancelled'];
const INTERVAL = /^\s*\d+\s*(second|minute|hour|day|week|month)s?\s*$/i;
const MAX_STEPS_PER_RUN = 100;
const OPEN = ['active', 'waiting', 'faulted'];

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
    if (st.type === 'parallel') {
      if (!Array.isArray(st.branches) || st.branches.length < 2 || !st.branches.every((b: unknown) => typeof b === 'string' && b))
        problems.push(`${label}: "branches" lists the first step of each branch (at least two).`);
      else if (new Set(st.branches).size !== st.branches.length) problems.push(`${label}: a branch is listed twice.`);
      if (typeof st.join !== 'string' || !st.join) problems.push(`${label}: "join" names the join step where the branches meet.`);
    }
    if (st.type === 'join' && st.wait_for !== undefined && !['all', 'any'].includes(st.wait_for)) problems.push(`${label}: "wait_for" is all (the default) or any.`);
  }
  // every "next" points to a step
  for (const st of steps as Record<string, any>[]) {
    if (!st || typeof st !== 'object' || !TYPES.includes(st.type)) continue;
    try {
      for (const target of targets(st as Step)) if (!names.has(target)) problems.push(`${st.name}: there is no step ${target}.`);
    } catch {
      // a malformed step: reported above
    }
  }
  if (!problems.length) problems.push(...branchProblems(steps as Step[]));
  return problems;
}

/** The steps a step can go to (explicit targets only). */
export function targets(s: Step): string[] {
  if (s.type === 'end') return [];
  if (s.type === 'switch') return [...s.cases.map((c) => c.next), ...(s.otherwise ? [s.otherwise] : [])].filter(Boolean);
  if (s.type === 'parallel') return [...s.branches, s.join].filter(Boolean);
  const next = (s as { next?: string | Record<string, string> }).next;
  if (!next) return [];
  return typeof next === 'string' ? [next] : Object.values(next);
}

/** Where a step goes when it doesn't say: the following one, or the end. */
const following = (steps: Step[], name: string) => steps[steps.findIndex((s) => s.name === name) + 1]?.name ?? null;

/**
 * Where the flow can go after a step, defaults included. A parallel step goes
 * to its branches; with `overParallel`, straight to its join (its branches are
 * a structure of their own).
 */
function successors(steps: Step[], s: Step, overParallel = false): string[] {
  const after = following(steps, s.name);
  const out: (string | null | undefined)[] = [];
  switch (s.type) {
    case 'end':
      break;
    case 'parallel':
      out.push(...(overParallel ? [s.join] : s.branches));
      break;
    case 'switch':
      out.push(...s.cases.map((c) => c.next), s.otherwise ?? after);
      break;
    case 'task':
      if (s.next && typeof s.next === 'object') {
        out.push(...Object.values(s.next));
        // outcomes without a branch go to the following step
        if (!('default' in s.next)) out.push(after);
      } else out.push(s.next ?? after);
      break;
    default:
      out.push((s as { next?: string }).next ?? after);
  }
  return [...new Set(out.filter((x): x is string => !!x))];
}

/** Parallel branches: every branch reaches its join and stays inside; every join belongs to one parallel step. */
function branchProblems(steps: Step[]): string[] {
  const problems: string[] = [];
  const byName = new Map(steps.map((s) => [s.name, s]));
  const parallels = steps.filter((s): s is Extract<Step, { type: 'parallel' }> => s.type === 'parallel');
  for (const j of steps.filter((s) => s.type === 'join')) {
    const users = parallels.filter((p) => p.join === j.name);
    if (!users.length) problems.push(`${j.name}: no parallel step joins here.`);
    if (users.length > 1) problems.push(`${j.name}: is the join of several parallel steps (${users.map((p) => p.name).join(', ')}); give each its own join.`);
  }
  for (const p of parallels) {
    const join = byName.get(p.join);
    if (join?.type !== 'join') { problems.push(`${p.name}: ${p.join} is not a join step.`); continue; }
    // the steps after the join (up to the parallel step again, in a loop)
    const afterJoin = new Set<string>();
    const todo = successors(steps, join, true);
    while (todo.length) {
      const x = todo.pop()!;
      if (x === p.name || afterJoin.has(x)) continue;
      afterJoin.add(x);
      const s = byName.get(x);
      if (s) todo.push(...successors(steps, s, true));
    }
    const sets: [string, Set<string>][] = [];
    for (const b of p.branches) {
      if (b === p.join) { problems.push(`${p.name}: branch ${b} is the join itself (an empty branch).`); continue; }
      const seen = new Set<string>();
      const nestedJoins = new Set<string>();
      let reaches = false;
      const stack = [b];
      while (stack.length) {
        const x = stack.pop()!;
        if (x === p.join) { reaches = true; continue; }
        if (seen.has(x)) continue;
        seen.add(x);
        const s = byName.get(x);
        if (!s) continue;
        if (x === p.name) { problems.push(`${p.name}: branch ${b} goes back to ${p.name}; a branch ends at its join.`); continue; }
        if (s.type === 'join' && !nestedJoins.has(x)) { problems.push(`${p.name}: branch ${b} runs into ${x}, the join of another parallel step.`); continue; }
        if (s.type !== 'end' && afterJoin.has(x)) { problems.push(`${p.name}: branch ${b} continues past the join to ${x}.`); continue; }
        if (s.type === 'parallel') nestedJoins.add(s.join);
        stack.push(...successors(steps, s, true));
      }
      if (!reaches) problems.push(`${p.name}: branch ${b} never reaches the join ${p.join}.`);
      for (const [other, set] of sets) {
        const shared = [...seen].find((x) => set.has(x) && byName.get(x)?.type !== 'end');
        if (shared) problems.push(`${p.name}: branches ${other} and ${b} both go through ${shared}; branches must be separate.`);
      }
      sets.push([b, seen]);
    }
    // only its branches lead to the join
    const inside = new Set(sets.flatMap(([, set]) => [...set]));
    for (const s of steps)
      if (s.name !== p.name && !inside.has(s.name) && successors(steps, s, true).includes(p.join))
        problems.push(`${s.name}: goes to the join ${p.join} from outside the branches of ${p.name}.`);
  }
  return [...new Set(problems)];
}

/** Things worth a look that don't stop a workflow from running (Advisor warnings). */
export function stepWarnings(steps: unknown): string[] {
  if (!Array.isArray(steps) || !steps.length || stepProblems(steps).length) return [];
  const list = steps as Step[];
  const byName = new Map(list.map((s) => [s.name, s]));
  const reached = new Set<string>();
  const todo = [list[0].name];
  while (todo.length) {
    const x = todo.pop()!;
    if (reached.has(x)) continue;
    reached.add(x);
    const s = byName.get(x);
    if (s) todo.push(...successors(list, s), ...(s.type === 'parallel' ? [s.join] : []));
  }
  return list.filter((s) => !reached.has(s.name)).map((s) => `Step ${s.name} is never reached.`);
}

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
  due: boolean;
  initiator: string;
  db_role: string | null;
}

/** Where a workflow is: its main path (branch null) or one of its parallel branches. */
interface Cursor {
  branch: string | null;
  parent: string | null;
  name: string | null;
  state: string;
  current_step: string;
  waiting_task: string | null;
  join_step: string | null;
}

const asBind = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

class StepError extends Error {}

/**
 * Advance one workflow as far as it can go now (until its main path and every
 * branch waits, ends or faults). Returns the number of steps taken.
 */
export async function runWorkflow(id: string | number): Promise<number> {
  let taken = 0;
  const at: { branch: string | null } = { branch: null };
  for (; taken < MAX_STEPS_PER_RUN; taken++) {
    let more: boolean;
    at.branch = null;
    try {
      more = await owner.tx((c) => step(c, String(id), at));
    } catch (e) {
      await fault(String(id), at.branch, (e as Error).message.slice(0, 2000));
      // the other branches may go on
      if (at.branch) continue;
      return taken;
    }
    if (!more) return taken;
  }
  // a loop of steps that never waits: stop it rather than spin
  await fault(String(id), at.branch, `More than ${MAX_STEPS_PER_RUN} steps without waiting: a loop?`);
  return taken;
}

/** A step failed: its branch and the workflow are faulted (in a transaction of their own). */
async function fault(id: string, branch: string | null, msg: string) {
  await owner.tx(async (c) => {
    if (branch) {
      const b = (await c.query(`update meta.workflow_branch set state = 'faulted', error = $2, updated_at = now() where id = $1 and state in ('active', 'waiting') returning name, current_step`, [branch, msg])).rows[0];
      if (!b) return;
      await c.query(`update meta.workflow set state = 'faulted', error = $2, updated_at = now() where id = $1 and state in ('active', 'waiting')`, [id, `${b.name}: ${msg}`.slice(0, 2000)]);
      await c.query(`select meta.workflow_log($1, $2, 'faulted', $3)`, [id, b.current_step, msg]);
      return;
    }
    const w = (await c.query(`update meta.workflow set state = 'faulted', error = $2, updated_at = now() where id = $1 and state in ('active', 'waiting') returning current_step`, [id, msg])).rows[0];
    if (w) await c.query(`select meta.workflow_log($1, $2, 'faulted', $3)`, [id, w.current_step, msg]);
  });
}

/** One step of the main path or of a branch, in the caller's transaction. Returns whether the workflow may go on right away. */
async function step(c: pg.PoolClient, id: string, at: { branch: string | null }): Promise<boolean> {
  const w = (
    await c.query<Instance>(
      `select w.id::text, w.app_id, w.name, w.detail_pk, w.vars, w.steps, w.state, w.current_step, w.waiting_task::text,
              coalesce(w.wait_until <= now(), false) as due, w.initiator, a.db_role
         from meta.workflow w join meta.app a on a.id = w.app_id
        where w.id = $1 and w.state in ('active', 'waiting', 'faulted')
        for update of w skip locked`,
      [id],
    )
  ).rows[0];
  if (!w) return false;
  // the main path first, then a branch that can go on
  const k: Cursor | undefined =
    w.state === 'active' || (w.state === 'waiting' && w.due)
      ? { branch: null, parent: null, name: null, state: w.state, current_step: w.current_step, waiting_task: w.waiting_task, join_step: null }
      : (
          await c.query<Cursor>(
            `select id::text as branch, parent_id::text as parent, name, state, current_step, waiting_task::text, join_step
               from meta.workflow_branch
              where workflow_id = $1 and (state = 'active' or (state = 'waiting' and wait_until <= now()))
              order by id limit 1 for update`,
            [id],
          )
        ).rows[0];
  if (!k) return false;
  at.branch = k.branch;
  await c.query(
    `select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true), set_config('pgapex.session_id', '', true),
            set_config('pgapex.workflow_id', $3, true), set_config('statement_timeout', '30s', true)`,
    [String(w.app_id), w.initiator, w.id],
  );
  const steps = w.steps;
  const s = steps.find((x) => x.name === k.current_step);
  if (!s) throw new StepError(`There is no step ${k.current_step}.`);
  const vars = { ...w.vars };
  const binds = (): BindValues => ({
    ...Object.fromEntries(Object.entries(vars).map(([key, v]) => [key.toUpperCase(), asBind(v)])),
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
  const log = (event: string, detail?: string | null, stepName = s.name) => c.query('select meta.workflow_log($1, $2, $3, $4)', [w.id, stepName, event, detail ?? null]);

  /** Where this path is now: its state, step, wait or task (and the variables). */
  const save = async (state: string, stepName: string | null, wait: { interval?: string; task?: string } = {}) => {
    if (k.branch === null) {
      await c.query(
        `update meta.workflow set state = $2, current_step = $3, wait_until = now() + $4::interval, waiting_task = $5, vars = $6,
                error = case when $2 = 'active' then null else error end, updated_at = now() where id = $1`,
        [w.id, state, stepName, wait.interval ?? null, wait.task ?? null, vars],
      );
    } else {
      await c.query(`update meta.workflow_branch set state = $2, current_step = $3, wait_until = now() + $4::interval, waiting_task = $5, updated_at = now() where id = $1`,
        [k.branch, state, stepName, wait.interval ?? null, wait.task ?? null]);
      await c.query('update meta.workflow set vars = $2, updated_at = now() where id = $1', [w.id, vars]);
    }
  };
  /** Cancel open branches (`ids`, or all of them) with the branches they started, and the tasks they wait for. */
  const cancelBranches = async (ids: string[] | null, why: string) => {
    const gone = (
      await c.query(
        `with recursive tree as (
           select id from meta.workflow_branch where workflow_id = $1 and ($2::bigint[] is null or id = any($2::bigint[]))
           union select b.id from meta.workflow_branch b join tree t on b.parent_id = t.id)
         update meta.workflow_branch set state = 'cancelled', ended_at = now(), updated_at = now()
          where id in (select id from tree) and state in ('active', 'waiting', 'faulted')
          returning current_step, waiting_task::text`,
        [w.id, ids],
      )
    ).rows;
    const tasks = gone.map((g) => g.waiting_task).filter(Boolean);
    if (tasks.length)
      await c.query(`update meta.task set state = 'cancelled', completed_at = now(), completed_by = meta.app_user() where id = any($1::bigint[]) and state in ('unassigned', 'assigned')`, [tasks]);
    for (const g of gone) await log('cancelled', why, g.current_step);
  };
  /** No branch is faulted any more: neither is the workflow (its main path waits at a join). */
  const unfault = () =>
    c.query(`update meta.workflow set state = 'waiting', error = null, updated_at = now()
              where id = $1 and state = 'faulted' and not exists (select 1 from meta.workflow_branch where workflow_id = $1 and state = 'faulted')`, [w.id]);
  const finish = async (state: 'completed' | 'terminated', clearStep: boolean, detail?: string) => {
    if (k.branch !== null) await c.query(`update meta.workflow_branch set state = 'done', ended_at = now(), updated_at = now() where id = $1`, [k.branch]);
    await cancelBranches(null, state === 'completed' ? 'the workflow is complete' : 'the workflow ended');
    await c.query(
      `update meta.workflow set state = $2, current_step = case when $3 then null else current_step end, vars = $4, waiting_task = null,
              wait_until = null, ended_at = now(), updated_at = now() where id = $1`,
      [w.id, state, clearStep && k.branch === null, vars],
    );
    await log(state, detail ?? null);
    return false;
  };
  const goTo = async (next: string | null | undefined, detail?: string | null, event = 'step') => {
    const target = next === undefined ? following(steps, s.name) : next;
    await log(event, detail);
    if (!target) return finish('completed', true);
    if (!steps.some((x) => x.name === target)) throw new StepError(`Step ${s.name} goes to ${target}, which doesn't exist.`);
    if (k.branch !== null && target === k.join_step) {
      // this branch is done: the path that split may go on at the join
      await c.query(`update meta.workflow_branch set state = 'done', wait_until = null, waiting_task = null, ended_at = now(), updated_at = now() where id = $1`, [k.branch]);
      await c.query('update meta.workflow set vars = $2, updated_at = now() where id = $1', [w.id, vars]);
      if (k.parent === null)
        await c.query(`update meta.workflow set state = 'active', updated_at = now()
                        where id = $1 and state in ('waiting', 'faulted') and current_step = $2 and wait_until is null and waiting_task is null`, [w.id, target]);
      else await c.query(`update meta.workflow_branch set state = 'active', updated_at = now() where id = $1 and state = 'waiting' and current_step = $2`, [k.parent, target]);
      return true;
    }
    await save('active', target);
    return true;
  };

  // back from a wait or a task
  if (k.state === 'waiting') {
    await log('resumed');
    return goTo((s as { next?: string }).next ?? undefined, 'waited');
  }
  if (k.waiting_task) {
    const t = (await c.query('select state, outcome, completed_by from meta.task where id = $1', [k.waiting_task])).rows[0];
    if (!t || !['completed', 'cancelled'].includes(t.state)) {
      // woken before its task ended: wait again
      await save('waiting', k.current_step, { task: k.waiting_task });
      return true;
    }
    const outcome: string = t.state === 'cancelled' ? 'cancelled' : t.outcome;
    vars.TASK_OUTCOME = outcome.toUpperCase();
    vars.TASK_APPROVER = t.completed_by;
    const next = (s as { next?: string | Record<string, string> }).next;
    const target: string | null | undefined = typeof next === 'string' ? next : next?.[outcome] ?? next?.default;
    // a cancelled task without a "cancelled" branch ends the workflow
    if (target === undefined && outcome === 'cancelled') return finish('terminated', false, 'its task was cancelled');
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
      if (row) for (const [key, v] of Object.entries(row)) vars[key.toUpperCase()] = v;
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
      const params = Object.fromEntries(Object.entries(vars).map(([key, v]) => [key, v]));
      const taskId = (await c.query(`select meta.create_task($1, $2, $3, $4) as id`, [s.task, w.detail_pk, params, owners])).rows[0].id;
      await c.query('update meta.task set workflow_id = $2 where id = $1', [taskId, w.id]);
      await save('waiting', s.name, { task: String(taskId) });
      await log('task', `task ${taskId}${owners.length ? ` for ${owners.join(', ')}` : ''}`);
      return true;
    }
    case 'wait': {
      await save('waiting', s.name, { interval: s.for });
      await log('waiting', s.for);
      return true;
    }
    case 'parallel': {
      if (!steps.some((x) => x.name === s.join && x.type === 'join')) throw new StepError(`Step ${s.name} joins at ${s.join}, which is not a join step.`);
      const missing = s.branches.find((b) => !steps.some((x) => x.name === b));
      if (missing) throw new StepError(`Step ${s.name} starts a branch at ${missing}, which doesn't exist.`);
      await c.query(
        `with f as (select nextval('meta.workflow_fork_seq') as fork)
         insert into meta.workflow_branch (workflow_id, parent_id, fork, split_step, join_step, name, current_step)
         select $1, $2::bigint, f.fork, $3, $4, b.name, b.name from f, unnest($5::text[]) with ordinality b(name, i) order by b.i`,
        [w.id, k.branch, s.name, s.join, s.branches],
      );
      await log('split', s.branches.join(', '));
      // this path waits at the join until its branches are done
      await save('waiting', s.join);
      return true;
    }
    case 'join': {
      const fork = (
        await c.query<{ branch: string; name: string; state: string }>(
          `select id::text as branch, name, state from meta.workflow_branch
            where workflow_id = $1 and parent_id is not distinct from $2::bigint
              and fork = (select max(fork) from meta.workflow_branch where workflow_id = $1 and parent_id is not distinct from $2::bigint and join_step = $3)
            order by id`,
          [w.id, k.branch, s.name],
        )
      ).rows;
      const open = fork.filter((b) => OPEN.includes(b.state));
      const done = fork.filter((b) => b.state === 'done');
      const any = s.wait_for === 'any';
      if (fork.length && (any ? !done.length : open.length)) {
        // not yet; shown as faulted while a branch is
        if (k.branch === null) {
          const faulted = (await c.query(`select 1 from meta.workflow_branch where workflow_id = $1 and state = 'faulted' limit 1`, [w.id])).rowCount;
          await c.query(`update meta.workflow set state = $2, wait_until = null, waiting_task = null, vars = $3, updated_at = now() where id = $1`, [w.id, faulted ? 'faulted' : 'waiting', vars]);
        } else await save('waiting', s.name);
        return true;
      }
      if (any && open.length) {
        await cancelBranches(open.map((b) => b.branch), `${done.map((b) => b.name).join(', ')} came first`);
        await unfault();
      }
      return goTo(s.next, any ? done.map((b) => b.name).join(', ') : fork.length ? 'all branches' : null, 'joined');
    }
    case 'end':
      return finish('completed', false);
    default:
      throw new StepError(`Unknown step type in ${(s as Step).name}.`);
  }
}

/** Run every workflow that can go on now (started, woken by a task, a wait that's over), with its branches. */
export async function runWorkflows(): Promise<number> {
  const ids = (
    await owner.query<{ id: string }>(
      `select w.id::text from meta.workflow w
        where w.state = 'active' or (w.state = 'waiting' and w.wait_until <= now())
           or (w.state in ('waiting', 'faulted') and exists (select 1 from meta.workflow_branch b
                where b.workflow_id = w.id and (b.state = 'active' or (b.state = 'waiting' and b.wait_until <= now()))))
        order by w.updated_at limit 100`,
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

/**
 * The steps as a top-down diagram (inline SVG; colours from app.css). `active`
 * marks the steps an instance is at (several with parallel branches); `id`
 * keeps the arrow marker unique when a page shows several diagrams.
 */
export function workflowDiagram(steps: Step[], opts: { active?: string[]; id?: string } = {}): Raw {
  if (!Array.isArray(steps) || !steps.length || steps.some((s) => !s || typeof s !== 'object' || typeof s.name !== 'string')) return html``;
  const marker = `wf-arrow${opts.id ? `-${opts.id}` : ''}`;
  const active = new Set(opts.active ?? []);
  // levels: the longest path from the first step (cycles are cut)
  const level = new Map<string, number>([[steps[0].name, 0]]);
  const edges: { from: string; to: string; label: string; branch?: boolean }[] = [];
  for (const s of steps) {
    if (s.type === 'switch' && Array.isArray(s.cases)) {
      for (const cs of s.cases) {
        const when = String(cs?.when ?? '');
        edges.push({ from: s.name, to: cs?.next, label: when.length > 24 ? `${when.slice(0, 22)}…` : when });
      }
      edges.push({ from: s.name, to: s.otherwise ?? following(steps, s.name) ?? '', label: 'otherwise' });
    } else if (s.type === 'parallel') {
      for (const b of Array.isArray(s.branches) ? s.branches : []) edges.push({ from: s.name, to: b, label: '', branch: true });
    } else if (s.type !== 'end') {
      const next = (s as { next?: string | Record<string, string> }).next;
      if (next && typeof next === 'object') for (const [key, v] of Object.entries(next)) edges.push({ from: s.name, to: v, label: key });
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
  const typeText = (s: Step) =>
    s.type === 'task' ? `task ${s.task}`
    : s.type === 'join' ? `join (${s.wait_for === 'any' ? 'any' : 'all'})`
    : s.type === 'parallel' ? `parallel ×${Array.isArray(s.branches) ? s.branches.length : 0}`
    : s.type;
  return html`<svg class="wf-diagram" viewBox="0 0 ${width} ${height}" role="img" aria-label="Workflow diagram${active.size ? `; at ${[...active].join(', ')}` : ''}" preserveAspectRatio="xMidYMin meet">
    <defs><marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="wf-arrowhead"/></marker></defs>
    ${real.map((e) => {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y;
      const back = y2 <= y1;
      const d = back ? `M${x1},${y1} C${x1 + W},${y1 + 40} ${x2 + W},${y2 - 40} ${x2 + W / 2 - 4},${y2 + H / 2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2 - 2}`;
      return html`<path d="${d}" class="wf-edge${e.branch ? ' wf-edge-branch' : ''}" marker-end="url(#${marker})"/>${e.label ? html`<text x="${(x1 + x2) / 2 + 4}" y="${(y1 + y2) / 2}" class="wf-label">${e.label}</text>` : ''}`;
    })}
    ${steps.map((s) => {
      const p = pos.get(s.name)!;
      return html`<g class="wf-node wf-${TYPES.includes(s.type) ? s.type : 'unknown'}${active.has(s.name) ? ' wf-active' : ''}"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="${s.type === 'parallel' || s.type === 'join' ? 20 : 8}"/>
        <text x="${p.x + W / 2}" y="${p.y + 18}" class="wf-name">${s.name}</text>
        <text x="${p.x + W / 2}" y="${p.y + 34}" class="wf-type">${typeText(s)}</text></g>`;
    })}
  </svg>`;
}
