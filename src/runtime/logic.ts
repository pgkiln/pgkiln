import { randomBytes } from 'node:crypto';
import { applyBinds } from '../binds.ts';
import { runtime, savepoint } from '../db.ts';
import type { Branch, Computation, Condition } from '../metadata.ts';
import { isAuthorized, sqlTrue } from './authz.ts';
import { bindValues, dbg, publicError, stripSemicolon, substitute, timed, toState, type PageContext } from './context.ts';
import { pageHref } from './links.ts';
import { urlChecksum } from '../security.ts';
import { logActivity } from '../session.ts';

// Declarative page logic (migration 029): conditions, computations and
// branches. Everything runs inside the request's transaction as the
// application's database role (appTx), each piece of developer SQL in its
// own savepoint.

const list = (s: string | null | undefined) => (s ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

/** Does a computation's or branch's condition hold? Broken SQL counts as false (and shows a message). */
export async function conditionHolds(ctx: PageContext, cond: Condition, where: string): Promise<boolean> {
  const value = (name: string | null) => {
    const v = name ? bindValues(ctx)[name.toUpperCase()] : null;
    return v === undefined || v === null ? '' : v;
  };
  switch (cond.condition_type) {
    case null:
    case undefined:
      return true;
    case 'sql':
      return sqlTrue(ctx, cond.condition_expr, where);
    case 'exists':
    case 'not_exists': {
      const c = ctx.client!;
      const sql = `select exists (${stripSemicolon(applyBinds(cond.condition_expr ?? '', bindValues(ctx)))}) as ok`;
      try {
        const found = (await savepoint(c, () => c.query(sql))).rows[0]?.ok === true;
        return cond.condition_type === 'exists' ? found : !found;
      } catch (e) {
        ctx.errors.page.push(await publicError(ctx, e, where));
        return false; // fail closed either way
      }
    }
    case 'item_null':
      return value(cond.condition_expr) === '';
    case 'item_not_null':
      return value(cond.condition_expr) !== '';
    case 'item_equals':
      return value(cond.condition_expr) === (cond.condition_value ?? '');
    case 'item_not_equals':
      return value(cond.condition_expr) !== (cond.condition_value ?? '');
    case 'request_in':
      return list(cond.condition_value).includes(ctx.request);
    default:
      return false; // unknown type: fail closed
  }
}

/**
 * Run a PL/pgSQL function body and return its value as text. The body
 * ("return …;", or a block with declare/begin … end) becomes a temporary
 * function of this session, created and dropped inside the caller's
 * savepoint, as the application's role (binds are substituted first, as
 * escaped literals). It never outlives the transaction's savepoint.
 */
async function functionBody(ctx: PageContext, body: string): Promise<string | null> {
  const c = ctx.client!;
  const code = applyBinds(body, bindValues(ctx)).trim();
  const block = /^(declare|begin)\b/i.test(code) ? code : `begin\n${code}\nend`;
  const id = randomBytes(8).toString('hex');
  const tag = `$pgkiln_${id}$`;
  if (block.includes(tag)) throw new Error('The function body contains the generated quote tag.');
  const fn = `pg_temp.pgkiln_computation_${id}`;
  await c.query(`create function ${fn}() returns text language plpgsql as ${tag}\n${block}\n${tag}`);
  const res = await c.query(`select ${fn}() as v`);
  await c.query(`drop function ${fn}()`);
  return toState(res.rows[0]?.v);
}

/** The value of a computation. */
export async function computeValue(ctx: PageContext, comp: Pick<Computation, 'type' | 'expression'>): Promise<string | null> {
  const c = ctx.client!;
  const expr = comp.expression ?? '';
  switch (comp.type) {
    case 'static': {
      const v = substitute(expr, ctx, (x) => x);
      return v === '' ? null : v;
    }
    case 'item': {
      const v = bindValues(ctx)[expr.trim().toUpperCase()];
      return v === undefined || v === '' ? null : v;
    }
    case 'sql_query': {
      const sql = stripSemicolon(applyBinds(expr, bindValues(ctx)));
      const res = await savepoint(c, () => c.query({ text: sql, rowMode: 'array' }));
      return toState(res.rows[0]?.[0]);
    }
    case 'sql_expression': {
      const sql = `select (${stripSemicolon(applyBinds(expr, bindValues(ctx)))}) as v`;
      const res = await savepoint(c, () => c.query(sql));
      return toState(res.rows[0]?.v);
    }
    case 'function_body':
      return savepoint(c, () => functionBody(ctx, expr));
    default:
      throw new Error(`Unknown computation type ${comp.type as string}`);
  }
}

export class ComputationFailed extends Error {}

/**
 * Computations of a point, in sequence. They set page items and application
 * items only. Before the page is shown, an error becomes a message on the
 * page; after a submit, it stops the submit (ComputationFailed).
 */
export async function runComputations(ctx: PageContext, point: Computation['point']) {
  const names = new Set([...ctx.app.app_items, ...ctx.page.items.map((i) => i.name)]);
  for (const comp of ctx.page.computations ?? []) {
    if (comp.point !== point) continue;
    const where = `computation of ${comp.item_name}`;
    if (!names.has(comp.item_name)) {
      ctx.errors.page.push(ctx.locale.t('logic.unknown_item', { item: comp.item_name }));
      continue;
    }
    if (!(await isAuthorized(ctx, comp.authz))) continue;
    if (!(await conditionHolds(ctx, comp, `condition of the ${where}`))) continue;
    try {
      ctx.session.state[comp.item_name] = await timed(ctx, 6, 'computation', `computation of ${comp.item_name} (${comp.type})`, () => computeValue(ctx, comp));
      dbg(ctx, 9, 'computation', () => `${comp.item_name} := ${ctx.page.items.some((i) => i.name === comp.item_name && i.type === 'password') ? '(password, not shown)' : JSON.stringify((ctx.session.state[comp.item_name] ?? '').slice(0, 200))}`);
    } catch (e) {
      const message = await publicError(ctx, e, where);
      if (point === 'after_submit') throw new ComputationFailed(message);
      ctx.errors.page.push(message);
    }
  }
}

/** The page number a path inside the application starts with ("10?x=1" → 10). */
const leadingPage = (path: string) => {
  const m = /^(\d+)(?:[?#]|$)/.exec(path);
  return m ? Number(m[1]) : null;
};

/**
 * Where the first branch of a point whose button, authorization and condition
 * match sends the browser, or null. A page target is a signed URL (items get
 * the checksum); a URL target is a path inside the application, with &ITEM.
 * values URL-encoded. A before_header branch to the page itself is ignored
 * (it would loop).
 */
export async function branchTarget(ctx: PageContext, point: Branch['point']): Promise<string | null> {
  for (const b of ctx.page.branches ?? []) {
    if (b.point !== point) continue;
    if (point === 'after_processing' && b.when_button && b.when_button !== ctx.request) continue;
    if (!(await isAuthorized(ctx, b.authz))) continue;
    if (!(await conditionHolds(ctx, b, `condition of branch "${b.name}"`))) continue;
    if (b.target_type === 'function') {
      const path = await branchFunction(ctx, b);
      if (path === null || (point === 'before_header' && leadingPage(path) === ctx.page.page_no)) continue;
      return `${ctx.base}/${path}`;
    }
    if (b.target_type === 'app') {
      const href = await otherApp(ctx, b);
      if (href === null) continue;
      return href;
    }
    if (b.target_type === 'url') {
      const path = substitute(b.target_url ?? '', ctx, encodeURIComponent);
      if (point === 'before_header' && leadingPage(path) === ctx.page.page_no) continue;
      // the database refuses schemes, "//", "\" and ".." in target_url; a substituted value is encoded
      return `${ctx.base}/${path}`;
    }
    const target = b.target_page ?? ctx.page.page_no;
    if (point === 'before_header' && target === ctx.page.page_no) continue;
    const items = b.target_items ?? {};
    return pageHref(ctx, target, items);
  }
  return null;
}

/**
 * A "function returning a URL" branch: its PL/pgSQL body (as the app's role,
 * binds as literals) returns a path inside the application, checked like a
 * branch's target_url (meta.branch_path_ok). null or an empty result: the
 * branch doesn't apply. A failing body or a path that isn't allowed shows a
 * message (before the page is shown) and the next branch is tried.
 */
async function branchFunction(ctx: PageContext, b: Branch): Promise<string | null> {
  const c = ctx.client!;
  let path: string | null;
  try {
    path = await savepoint(c, () => functionBody(ctx, b.target_function ?? ''));
  } catch (e) {
    ctx.errors.page.push(await publicError(ctx, e, `branch "${b.name}"`));
    return null;
  }
  path = path?.trim() || null;
  if (path === null) return null;
  const ok = (await c.query('select meta.branch_path_ok($1) as ok', [path])).rows[0]?.ok === true;
  if (ok) return path;
  ctx.errors.page.push(ctx.locale.t('logic.branch_bad_url', { name: b.name }));
  logActivity({ appId: ctx.app.id, pageNo: ctx.page.page_no, username: ctx.user, event: 'forbidden', ip: ctx.ip, detail: `branch "${b.name}" returned a URL outside the application` });
  return null;
}

/**
 * A branch to a page of another application of this installation. The
 * application and page must exist (and the page's build option be included);
 * item values are signed for that application, page and user, so a page with
 * checksum protection there accepts them. That application's own
 * authentication and authorization apply when the browser gets there.
 */
async function otherApp(ctx: PageContext, b: Branch): Promise<string | null> {
  const alias = b.target_app ?? '';
  const page = b.target_page;
  // pgkiln's runtime connection reads the metadata (the app's role may not)
  const row = page
    ? await runtime.one<{ id: number; alias: string }>(
        `select a.id, a.alias from meta.app a join meta.page p on p.app_id = a.id
          where a.alias = $1 and p.page_no = $2 and meta.build_option_on(a.id, p.build_option)`,
        [alias, page],
      )
    : undefined;
  if (!row || !page) {
    ctx.errors.page.push(ctx.locale.t('logic.branch_no_app', { name: b.name, app: alias, page: String(page ?? '') }));
    return null;
  }
  const values = Object.fromEntries(Object.entries(b.target_items ?? {}).map(([k, v]) => [k.toUpperCase(), substitute(String(v), ctx, (x) => x)]));
  const params = new URLSearchParams();
  for (const k of Object.keys(values).sort()) params.set(k, values[k]);
  if (Object.keys(values).length) params.set('cs', urlChecksum(row.id, page, ctx.user, values));
  const q = params.toString();
  return `/a/${encodeURIComponent(row.alias)}/${page}${q ? `?${q}` : ''}`;
}
