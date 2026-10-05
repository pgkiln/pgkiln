// Application types and subscriptions (migration 056; APEX 26.1 theme,
// library and boilerplate applications, and subscribed shared components).
//
// A subscription makes a component of one application a copy of the
// component with the same name in a *master* application (a library app for
// shared components, a theme app for its theme and template components).
// Refreshing copies the master's definition over the subscriber's: every
// column but the id and the application, for a list also its entries.
// Publishing refreshes every subscriber of a master component. The subscriber
// may still change its copy; the next refresh overwrites that.
import pg from 'pg';
import { owner } from './db.ts';

export const APP_TYPES = ['standard', 'theme', 'library', 'boilerplate'] as const;
export type AppType = (typeof APP_TYPES)[number];

export const APP_TYPE_LABELS: Record<AppType, string> = {
  standard: 'Standard',
  theme: 'Theme application',
  library: 'Library application',
  boilerplate: 'Boilerplate application',
};

/** What can be subscribed to: table, key column, label; and the master types that offer it. */
export const KINDS = {
  theme: { table: null, key: null, label: 'Theme', from: ['theme'] },
  lov: { table: 'meta.lov', key: 'name', label: 'List of values', from: ['library'] },
  authz_scheme: { table: 'meta.authz_scheme', key: 'name', label: 'Authorization scheme', from: ['library'] },
  build_option: { table: 'meta.build_option', key: 'name', label: 'Build option', from: ['library'] },
  template_component: { table: 'meta.template_component', key: 'static_id', label: 'Template component', from: ['library', 'theme'] },
  list: { table: 'meta.list', key: 'name', label: 'List', from: ['library'] },
} as const;
export type Kind = keyof typeof KINDS;
export const isKind = (k: unknown): k is Kind => typeof k === 'string' && Object.hasOwn(KINDS, k);

export interface Subscription {
  app_id: number;
  kind: Kind;
  name: string;
  master_app_id: number;
  master_name: string;
  master_alias: string;
  created_by: string;
  created_at: string;
  refreshed_at: string | null;
  refreshed_by: string | null;
}

export class SubscriptionError extends Error {}

/** A client in a transaction, or the owner pool. */
type Db = { query: <T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<T>> };

const columnCache = new Map<string, string[]>();
/** The columns a refresh copies: all but id and app_id. */
async function columns(db: Db, table: string) {
  if (!columnCache.has(table)) {
    const [schema, name] = table.split('.');
    const r = await db.query<{ c: string }>(
      `select column_name as c from information_schema.columns where table_schema = $1 and table_name = $2 and column_name not in ('id', 'app_id') order by ordinal_position`,
      [schema, name],
    );
    columnCache.set(table, r.rows.map((x) => x.c));
  }
  return columnCache.get(table)!;
}

/** Components of master applications that `appId` can subscribe to. */
export async function offers(appId: number) {
  const masters = (
    await owner.query<{ id: number; name: string; app_type: AppType }>(
      `select id, name, app_type from meta.app
        where app_type in ('theme', 'library') and id <> $1 and meta.app_workspace(id) = meta.app_workspace($1)
        order by lower(name), id`,
      [appId],
    )
  ).rows;
  const out: { master: (typeof masters)[number]; kind: Kind; name: string }[] = [];
  for (const m of masters) {
    for (const [kind, k] of Object.entries(KINDS) as [Kind, (typeof KINDS)[Kind]][]) {
      if (!(k.from as readonly string[]).includes(m.app_type)) continue;
      if (kind === 'theme') out.push({ master: m, kind, name: '' });
      else
        for (const r of (await owner.query(`select ${k.key} as n from ${k.table} where app_id = $1 order by 1`, [m.id])).rows) out.push({ master: m, kind, name: r.n });
    }
  }
  return out;
}

const SELECT = `select s.app_id, s.kind, s.name, s.master_app_id, m.name as master_name, m.alias as master_alias, s.created_by,
                       s.created_at::text, s.refreshed_at::text, s.refreshed_by
                  from meta.subscription s join meta.app m on m.id = s.master_app_id`;

export const subscriptionsOf = async (appId: number) =>
  (await owner.query<Subscription>(`${SELECT} where s.app_id = $1 order by s.kind, s.name`, [appId])).rows;

export const subscribersOf = async (masterId: number) =>
  (
    await owner.query<Subscription & { app_name: string }>(
      `select x.*, a.name as app_name from (${SELECT} where s.master_app_id = $1) x join meta.app a on a.id = x.app_id order by x.kind, x.name, lower(a.name)`,
      [masterId],
    )
  ).rows;

export const subscriptionOf = async (appId: number, kind: string, name: string) =>
  isKind(kind) ? owner.one<Subscription>(`${SELECT} where s.app_id = $1 and s.kind = $2 and s.name = $3`, [appId, kind, name]) : undefined;

/** Copy the master's definition of one component into the subscriber (inside c). */
async function copyComponent(c: Db, kind: Kind, name: string, masterId: number, appId: number) {
  if (kind === 'theme') {
    const r = await c.query('update meta.app a set theme = m.theme, updated_at = now() from meta.app m where m.id = $2 and a.id = $1', [appId, masterId]);
    if (!r.rowCount) throw new SubscriptionError('The master application no longer exists.');
    return;
  }
  const k = KINDS[kind];
  const cols = await columns(c, k.table);
  const list = cols.map((x) => pg.escapeIdentifier(x)).join(', ');
  const master = (await c.query(`select ${list} from ${k.table} where app_id = $1 and ${k.key} = $2`, [masterId, name])).rows[0];
  if (!master) throw new SubscriptionError(`${k.label} ${name} no longer exists in the master application.`);
  const own = (await c.query(`select id from ${k.table} where app_id = $1 and ${k.key} = $2 for update`, [appId, name])).rows[0];
  if (own)
    await c.query(`update ${k.table} t set (${list}) = (select ${list} from ${k.table} m where m.app_id = $2 and m.${k.key} = $3) where t.id = $1`, [own.id, masterId, name]);
  else await c.query(`insert into ${k.table} (app_id, ${list}) select $1, ${list} from ${k.table} where app_id = $2 and ${k.key} = $3`, [appId, masterId, name]);
  if (kind === 'list') {
    // the entries follow their list: replaced, parents mapped to the new ids
    const ecols = (await columns(c, 'meta.list_entry')).filter((x) => x !== 'parent_id');
    const elist = ecols.map((x) => pg.escapeIdentifier(x)).join(', ');
    await c.query('delete from meta.list_entry where app_id = $1 and list_name = $2', [appId, name]);
    const entries = (await c.query(`select id, parent_id from meta.list_entry where app_id = $1 and list_name = $2 order by id`, [masterId, name])).rows;
    const ids = new Map<number, number>();
    let left = entries;
    while (left.length) {
      const ready = left.filter((e) => e.parent_id == null || ids.has(e.parent_id) || !entries.some((x) => x.id === e.parent_id));
      if (!ready.length) break; // a cycle: leave the rest out
      for (const e of ready) {
        const r = await c.query(`insert into meta.list_entry (app_id, parent_id, ${elist}) select $1, $2, ${elist} from meta.list_entry where id = $3 returning id`, [appId, e.parent_id == null ? null : (ids.get(e.parent_id) ?? null), e.id]);
        ids.set(e.id, r.rows[0].id);
      }
      left = left.filter((e) => !ids.has(e.id));
    }
  }
}

/** Whether the subscriber's copy equals the master's definition. */
export async function inSync(sub: Pick<Subscription, 'app_id' | 'kind' | 'name' | 'master_app_id'>) {
  if (sub.kind === 'theme') {
    const r = await owner.one<{ same: boolean }>('select a.theme = m.theme as same from meta.app a, meta.app m where a.id = $1 and m.id = $2', [sub.app_id, sub.master_app_id]);
    return !!r?.same;
  }
  const k = KINDS[sub.kind];
  const cols = (await columns(owner, k.table)).map((x) => pg.escapeIdentifier(x)).join(', ');
  const row = (appId: number) => `(select jsonb_build_array(${cols}) from ${k.table} where app_id = ${Number(appId)} and ${k.key} = $1)`;
  const same = `${row(sub.app_id)} is not distinct from ${row(sub.master_app_id)}`;
  if (sub.kind !== 'list') return !!(await owner.one<{ same: boolean }>(`select ${same} as same`, [sub.name]))?.same;
  const ecols = (await columns(owner, 'meta.list_entry')).filter((x) => x !== 'parent_id' && x !== 'list_name').map((x) => pg.escapeIdentifier(x)).join(', ');
  const entries = (appId: number) =>
    `(select coalesce(jsonb_agg(jsonb_build_array(${ecols}, parent_id is null) order by seq, label), '[]') from meta.list_entry where app_id = ${Number(appId)} and list_name = $1)`;
  return !!(await owner.one<{ same: boolean }>(`select ${same} and ${entries(sub.app_id)} = ${entries(sub.master_app_id)} as same`, [sub.name]))?.same;
}

/** Subscribe appId to a master's component: the component is copied now (replacing one with the same name). */
export async function subscribe(appId: number, masterId: number, kind: string, name: string, username: string) {
  if (!isKind(kind)) throw new SubscriptionError('Unknown kind of component.');
  if (kind === 'theme') name = '';
  return owner.tx(async (c) => {
    const master = (await c.query<{ app_type: string; name: string }>('select app_type, name from meta.app where id = $1', [masterId])).rows[0];
    if (!master || masterId === appId) throw new SubscriptionError('Choose another application to subscribe to.');
    // (064) only applications of the same workspace
    if (!(await c.query('select 1 from meta.app where id = $1 and meta.app_workspace($1) = meta.app_workspace($2)', [masterId, appId])).rowCount)
      throw new SubscriptionError('Choose another application to subscribe to.');
    if (!(KINDS[kind].from as readonly string[]).includes(master.app_type))
      throw new SubscriptionError(`${master.name} is not a ${KINDS[kind].from.join(' or ')} application: it offers no ${KINDS[kind].label.toLowerCase()}.`);
    if (!(await c.query('select 1 from meta.app where id = $1', [appId])).rowCount) throw new SubscriptionError('Application not found.');
    await copyComponent(c, kind, name, masterId, appId);
    await c.query(
      `insert into meta.subscription (app_id, kind, name, master_app_id, created_by, refreshed_at, refreshed_by) values ($1, $2, $3, $4, $5, now(), $5)
       on conflict (app_id, kind, name) do update set master_app_id = excluded.master_app_id, refreshed_at = now(), refreshed_by = excluded.refreshed_by`,
      [appId, kind, name, masterId, username],
    );
  });
}

/** Refresh one subscription (or all of an application's when kind is null). Returns the number refreshed. */
export async function refresh(appId: number, kind: string | null, name: string | null, username: string) {
  return owner.tx(async (c) => {
    const subs = (
      await c.query<{ kind: Kind; name: string; master_app_id: number }>(
        `select kind, name, master_app_id from meta.subscription where app_id = $1 and ($2::text is null or (kind = $2 and name = $3)) order by kind, name for update`,
        [appId, kind, name ?? ''],
      )
    ).rows;
    if (kind && !subs.length) throw new SubscriptionError('Not subscribed.');
    for (const sub of subs) await copyComponent(c, sub.kind, sub.name, sub.master_app_id, appId);
    await c.query(
      `update meta.subscription set refreshed_at = now(), refreshed_by = $4 where app_id = $1 and ($2::text is null or (kind = $2 and name = $3))`,
      [appId, kind, name ?? '', username],
    );
    return subs.length;
  });
}

/**
 * Publish a master's component (kind/name) to its subscribers: refresh each.
 * `skip` names subscribers that may not be changed (locked by another developer).
 */
export async function publish(masterId: number, kind: string, name: string, username: string, skip: (appId: number) => Promise<boolean> = async () => false) {
  if (!isKind(kind)) throw new SubscriptionError('Unknown kind of component.');
  const subs = (await owner.query<{ app_id: number }>('select app_id from meta.subscription where master_app_id = $1 and kind = $2 and name = $3 order by app_id', [masterId, kind, kind === 'theme' ? '' : name])).rows;
  const done: number[] = [], skipped: number[] = [];
  for (const s of subs) {
    if (await skip(s.app_id)) skipped.push(s.app_id);
    else {
      await refresh(s.app_id, kind, kind === 'theme' ? '' : name, username);
      done.push(s.app_id);
    }
  }
  return { done, skipped };
}

export const unsubscribe = async (appId: number, kind: string, name: string) =>
  ((await owner.query('delete from meta.subscription where app_id = $1 and kind = $2 and name = $3', [appId, kind, name])).rowCount ?? 0) > 0;
