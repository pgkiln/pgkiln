// (sprint 92, Database Actions DA-4) A query plan from EXPLAIN (FORMAT JSON) as a tree for the SQL
// Worksheet's Explain Plan and Autotrace tabs: per step the operation, the relation or index, cost,
// estimated rows and width, and with ANALYZE the actual time, rows, loops and buffers, the time spent in
// the step itself (without its children), the slowest step, and estimates that are off by 10× or more.

export interface PlanNode {
  op: string;
  /** "on emp e", "using emp_pkey" … */
  target: string;
  details: [string, string][];
  startupCost: number;
  totalCost: number;
  planRows: number;
  width: number;
  /** ANALYZE */
  actualTotal?: number;
  actualRows?: number;
  loops?: number;
  /** ms in this step itself: its time × loops minus its children's */
  selfMs?: number;
  sharedHit?: number;
  sharedRead?: number;
  /** estimated / actual rows, when off by 10× or more (> 1: overestimated) */
  misestimate?: number;
  slowest?: boolean;
  /** never executed (ANALYZE) */
  neverRun?: boolean;
  children: PlanNode[];
}

export interface Plan {
  root: PlanNode;
  planningMs?: number;
  executionMs?: number;
  analyze: boolean;
}

const DETAIL_KEYS = ['Index Cond', 'Recheck Cond', 'Filter', 'Join Filter', 'Hash Cond', 'Merge Cond', 'Sort Key', 'Group Key', 'Rows Removed by Filter', 'Sort Method', 'Strategy', 'Subplan Name', 'CTE Name', 'Function Name'];

type Json = Record<string, unknown>;

function node(p: Json, analyze: boolean): PlanNode {
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
  let op = str('Node Type') ?? '?';
  // INSERT / UPDATE / DELETE / MERGE are a ModifyTable step: name it by its operation, like the text plan
  if (op === 'ModifyTable' && str('Operation')) op = str('Operation')!;
  if (str('Join Type') && /Join|Nested Loop/.test(op) && str('Join Type') !== 'Inner') op = `${op} (${str('Join Type')})`;
  if (str('Strategy') && op === 'Aggregate') op = `${str('Strategy') === 'Plain' ? '' : `${str('Strategy')} `}Aggregate`;
  if (p['Parallel Aware'] === true) op = `Parallel ${op}`;
  const parts: string[] = [];
  if (str('Index Name')) parts.push(`using ${str('Index Name')}`);
  if (str('Relation Name')) parts.push(`on ${str('Schema') ? `${str('Schema')}.` : ''}${str('Relation Name')}${str('Alias') && str('Alias') !== str('Relation Name') ? ` ${str('Alias')}` : ''}`);
  const details: [string, string][] = [];
  for (const k of DETAIL_KEYS) {
    const v = p[k];
    if (v === undefined || v === null || k === 'Strategy') continue;
    details.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
  }
  const children = Array.isArray(p.Plans) ? (p.Plans as Json[]).map((c) => node(c, analyze)) : [];
  const n: PlanNode = {
    op,
    target: parts.join(' '),
    details,
    startupCost: num('Startup Cost') ?? 0,
    totalCost: num('Total Cost') ?? 0,
    planRows: num('Plan Rows') ?? 0,
    width: num('Plan Width') ?? 0,
    children,
  };
  if (analyze) {
    n.loops = num('Actual Loops') ?? 0;
    n.neverRun = n.loops === 0;
    n.actualTotal = num('Actual Total Time') ?? 0;
    n.actualRows = num('Actual Rows') ?? 0;
    n.sharedHit = num('Shared Hit Blocks');
    n.sharedRead = num('Shared Read Blocks');
    const own = n.actualTotal * (n.loops || 0);
    const kids = children.reduce((t, c) => t + (c.actualTotal ?? 0) * (c.loops ?? 0), 0);
    n.selfMs = Math.max(0, own - kids);
    if (!n.neverRun) {
      const est = Math.max(n.planRows, 1);
      const act = Math.max(n.actualRows, 1);
      const ratio = est / act;
      if (ratio >= 10 || ratio <= 0.1) n.misestimate = ratio;
    }
  }
  return n;
}

const walk = (n: PlanNode, f: (n: PlanNode) => void) => {
  f(n);
  for (const c of n.children) walk(c, f);
};

/** The plan of EXPLAIN (FORMAT JSON) output: an array with one object holding Plan (and with ANALYZE the times). */
export function parsePlan(json: unknown, analyze: boolean): Plan {
  const top = (Array.isArray(json) ? json[0] : json) as Json;
  const root = node((top?.Plan ?? {}) as Json, analyze);
  if (analyze) {
    let slow: PlanNode | null = null;
    walk(root, (n) => {
      if (!slow || (n.selfMs ?? 0) > (slow.selfMs ?? 0)) slow = n;
    });
    if (slow && ((slow as PlanNode).selfMs ?? 0) > 0) (slow as PlanNode).slowest = true;
  }
  return {
    root,
    planningMs: typeof top?.['Planning Time'] === 'number' ? (top['Planning Time'] as number) : undefined,
    executionMs: typeof top?.['Execution Time'] === 'number' ? (top['Execution Time'] as number) : undefined,
    analyze,
  };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The plan as indented text, like psql's EXPLAIN output. */
export function planText(plan: Plan): string {
  const lines: string[] = [];
  const line = (n: PlanNode, depth: number) => {
    const pad = depth ? `${'      '.repeat(depth - 1)}  ->  ` : '';
    const actual = plan.analyze ? (n.neverRun ? ' (never executed)' : ` (actual time=${fmt(n.actualTotal ?? 0)} rows=${n.actualRows} loops=${n.loops})`) : '';
    lines.push(`${pad}${n.op}${n.target ? ` ${n.target}` : ''}  (cost=${fmt(n.startupCost)}..${fmt(n.totalCost)} rows=${n.planRows} width=${n.width})${actual}`);
    const ind = depth ? `${'      '.repeat(depth - 1)}        ` : '  ';
    for (const [k, v] of n.details) lines.push(`${ind}${k}: ${v}`);
    if (plan.analyze && (n.sharedHit || n.sharedRead)) lines.push(`${ind}Buffers: shared hit=${n.sharedHit ?? 0}${n.sharedRead ? ` read=${n.sharedRead}` : ''}`);
    for (const c of n.children) line(c, depth + 1);
  };
  line(plan.root, 0);
  if (plan.planningMs !== undefined) lines.push(`Planning Time: ${fmt(plan.planningMs)} ms`);
  if (plan.executionMs !== undefined) lines.push(`Execution Time: ${fmt(plan.executionMs)} ms`);
  return lines.join('\n');
}
