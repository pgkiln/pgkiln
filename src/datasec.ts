import pg from 'pg';

// (sprint 119, WS-13: data security per table, pgkiln's answer to Deep Data Security) A table's rows, columns and
// values in one place. PostgreSQL has row level security but no column masking, so a table's security here is three
// layers, all of them ordinary database objects that every client (pages, REST handlers, AutoREST, AI tools, MCP,
// psql) meets in the same way:
//
//   rows     row level security policies (shown here; written in the worksheet; switched on in Table Properties);
//   columns  column privileges per database role: GRANT/REVOKE SELECT (c, …) and UPDATE (c, …). A column a role may
//            not read is refused by PostgreSQL ("permission denied"), whoever sends the query;
//   values   a masking view per table: the table's columns, a masked column as
//              case when (select meta.has_role('manager')) or … then sal end
//            for the signed-in user's application roles (meta.has_role). The view runs with its owner's rights, and
//            its owner is a separate role per schema (<schema>_masking) that is no owner, superuser or BYPASSRLS
//            role and is a member of the database roles that read the view: so the table's row level security still
//            applies inside the view (policies use meta.app_user() / meta.has_role(), the caller's settings), and a
//            database role can read the masked values while its own SELECT on the raw column is revoked.
//
// The mask only holds when the database roles of the matrix cannot read the raw column on the table (the second
// layer): checkSecurity() allows it (an application whose pages still read the table needs it), but the preview
// says so. The configuration lives in the view's comment ("pgkiln masking view of <table>: {json}"), so it travels
// with the schema (pg_dump, Generate DDL, the change log) and needs no meta table. Pure apart from readSecurity.

export const MASKS = ['null', 'stars', 'partial'] as const;
export type Mask = (typeof MASKS)[number];
export const MASK_LABELS: Record<Mask, string> = { null: 'empty (null)', stars: '***', partial: '*** + last 4' };
export const MARK = 'pgkiln masking view of ';
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/** An application role (meta.has_role): letters, digits and a few separators; compared in lower case. */
export const APP_ROLE_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ .:@-]{0,62}$/u;
const PRIVS = ['SELECT', 'UPDATE'] as const;

export interface SecColumn { name: string; type: string }
export interface Policy { name: string; command: string; permissive: string; roles: string; using: string | null; check: string | null }
/** A database role's privileges on the table: table-wide or on some columns. */
export interface DbGrant {
  role: string;
  tableSelect: boolean;
  tableUpdate: boolean;
  colSelect: string[];
  colUpdate: string[];
  /** applications that run as this role */
  apps: string[];
}
export interface ColumnMask { see: string[]; others: boolean; mask: Mask }
export interface MaskConfig { table: string; roles: string[]; cols: Record<string, ColumnMask> }
export interface TableSecurity {
  oid: number;
  schema: string;
  table: string;
  owner: string;
  rls: boolean;
  forceRls: boolean;
  columns: SecColumn[];
  policies: Policy[];
  grants: DbGrant[];
  /** roles with privileges that the matrix cannot restrict, and why */
  excluded: { role: string; why: string }[];
  /** application roles the applications reading this table check (users.ts roleHints) */
  appRoles: string[];
  view: { name: string; config: MaskConfig; columns: string[] } | null;
  maskRole: string;
  maskRoleExists: boolean;
  /** the roles the masking role is a member of */
  maskMembers: string[];
}
export interface SecurityDef {
  grants: { role: string; select: string[]; update: string[] }[];
  view: { enabled: boolean; name: string; roles: string[]; cols: Record<string, ColumnMask> };
}

export const ident = (n: string) => pg.escapeIdentifier(n);
const lit = (s: string) => pg.escapeLiteral(s);
const roleIdent = (r: string) => (r === 'PUBLIC' ? 'public' : ident(r));

/** The masking role of a schema: <schema>_masking (cut, with a hash, when the name would be too long). */
export function maskRoleName(schema: string) {
  const name = `${schema}_masking`;
  if (Buffer.byteLength(name) <= 63) return name;
  let h = 0;
  for (const ch of schema) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `${schema.slice(0, 40)}_${h.toString(36)}_masking`;
}

/** The comment's configuration, checked; null when it is not one of ours or is broken. */
export function parseConfig(comment: string | null, table: string): MaskConfig | null {
  if (!comment?.startsWith(MARK)) return null;
  const colon = comment.indexOf(': {');
  if (colon < 0 || comment.slice(MARK.length, colon) !== table) return null;
  try {
    const x = JSON.parse(comment.slice(colon + 2));
    if (x?.table !== table || !Array.isArray(x.roles) || typeof x.cols !== 'object' || !x.cols) return null;
    const roles = (x.roles as unknown[]).filter((r): r is string => typeof r === 'string' && APP_ROLE_RE.test(r)).map((r) => r.toLowerCase());
    const cols: Record<string, ColumnMask> = {};
    for (const [c, m] of Object.entries(x.cols as Record<string, any>)) {
      if (!m || !Array.isArray(m.see)) continue;
      cols[c] = {
        see: m.see.filter((r: unknown): r is string => typeof r === 'string' && roles.includes(r)),
        others: m.others === true,
        mask: MASKS.includes(m.mask) ? m.mask : 'null',
      };
    }
    return { table, roles, cols };
  } catch {
    return null;
  }
}

/** The comment that marks a masking view (and holds its configuration). */
export const configComment = (c: MaskConfig) => `${MARK}${c.table}: ${JSON.stringify({ table: c.table, roles: c.roles, cols: c.cols })}`;

type Q = { query: <T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<T>> };

/**
 * A table's security as the catalog has it. `appDbRoles`: the database roles of the workspace's applications
 * (shown as matrix rows even without privileges); `appRoles`: the application roles they check.
 */
export async function readSecurity(db: Q, ref: string, appDbRoles: { role: string; alias: string }[], appRoles: string[]): Promise<TableSecurity | null> {
  const t = (await db.query(
    `select c.oid::int as oid, n.nspname as schema, c.relname as table, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = to_regclass($1) and c.relkind in ('r', 'p')`, [ref])).rows[0];
  if (!t) return null;
  const columns = (await db.query<SecColumn>(
    `select attname as name, format_type(atttypid, atttypmod) as type from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped order by attnum`, [t.oid])).rows;
  const policies = (await db.query<Policy>(
    `select policyname as name, cmd as command, permissive, array_to_string(roles, ', ') as roles, qual as using, with_check as check
       from pg_policies where schemaname = $1 and tablename = $2 order by policyname`, [t.schema, t.table])).rows;
  const tableAcl = (await db.query<{ role: string; priv: string }>(
    `select coalesce(r.rolname, 'PUBLIC') as role, a.privilege_type as priv
       from pg_class c cross join lateral aclexplode(c.relacl) a left join pg_roles r on r.oid = a.grantee
      where c.oid = $1 and a.privilege_type in ('SELECT', 'UPDATE')`, [t.oid])).rows;
  const colAcl = (await db.query<{ role: string; col: string; priv: string }>(
    `select coalesce(r.rolname, 'PUBLIC') as role, att.attname as col, a.privilege_type as priv
       from pg_attribute att cross join lateral aclexplode(att.attacl) a left join pg_roles r on r.oid = a.grantee
      where att.attrelid = $1 and att.attnum > 0 and not att.attisdropped and a.privilege_type in ('SELECT', 'UPDATE')
      order by att.attnum`, [t.oid])).rows;
  const maskRole = maskRoleName(t.schema);
  // roles the matrix cannot restrict: the owner and whoever has its privileges, superusers, BYPASSRLS roles
  const names = [...new Set([...tableAcl.map((r) => r.role), ...colAcl.map((r) => r.role), ...appDbRoles.map((a) => a.role)])].filter((r) => r !== 'PUBLIC');
  const special = new Map((await db.query<{ role: string; why: string | null }>(
    `select r.rolname as role,
            case when r.rolsuper then 'superuser' when r.rolbypassrls then 'bypasses row level security'
                 when pg_has_role(r.oid, $2::regrole, 'USAGE') then 'owns the table' end as why
       from pg_roles r where r.rolname = any ($1)`, [names, t.owner])).rows.map((r) => [r.role, r.why]));
  const excluded: { role: string; why: string }[] = [];
  const grants = new Map<string, DbGrant>();
  const row = (role: string) => {
    let g = grants.get(role);
    if (!g) grants.set(role, (g = { role, tableSelect: false, tableUpdate: false, colSelect: [], colUpdate: [], apps: [] }));
    return g;
  };
  const usable = (role: string) => {
    if (role === maskRole) return false;
    if (role === 'PUBLIC') return true;
    if (!special.has(role)) return false; // a dropped role
    const why = special.get(role);
    if (why) {
      if (!excluded.some((x) => x.role === role)) excluded.push({ role, why });
      return false;
    }
    return true;
  };
  for (const a of tableAcl) if (usable(a.role)) a.priv === 'SELECT' ? (row(a.role).tableSelect = true) : (row(a.role).tableUpdate = true);
  for (const a of colAcl) if (usable(a.role)) (a.priv === 'SELECT' ? row(a.role).colSelect : row(a.role).colUpdate).push(a.col);
  for (const a of appDbRoles) if (usable(a.role)) row(a.role).apps.push(a.alias);
  // the masking view: a view in the table's schema whose comment names this table
  let view: TableSecurity['view'] = null;
  for (const v of (await db.query<{ oid: number; name: string; comment: string | null }>(
    `select c.oid::int as oid, c.relname as name, obj_description(c.oid, 'pg_class') as comment from pg_class c
      where c.relnamespace = (select relnamespace from pg_class where oid = $1) and c.relkind = 'v'
        and obj_description(c.oid, 'pg_class') like $2 order by c.relname`, [t.oid, `${MARK.replace(/_/g, '\\_')}%`])).rows) {
    const config = parseConfig(v.comment, t.table);
    if (!config) continue;
    const cols = (await db.query<{ name: string }>(`select attname as name from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped order by attnum`, [v.oid])).rows.map((r) => r.name);
    view = { name: v.name, config, columns: cols };
    break;
  }
  const mr = (await db.query<{ exists: boolean; members: string[] | null }>(
    `select exists (select from pg_roles where rolname = $1) as exists,
            (select array_agg(g.rolname order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = $1) as members`,
    [maskRole])).rows[0];
  const order = (g: DbGrant) => (g.role === 'PUBLIC' ? 'zz' : g.apps.length ? `a${g.role}` : `b${g.role}`);
  return {
    oid: t.oid, schema: t.schema, table: t.table, owner: t.owner, rls: t.rls, forceRls: t.force, columns, policies,
    grants: [...grants.values()].sort((x, y) => order(x).localeCompare(order(y))), excluded,
    appRoles: [...new Set([...appRoles.map((r) => r.toLowerCase()), ...(view?.config.roles ?? [])])].sort(),
    view, maskRole, maskRoleExists: mr.exists, maskMembers: mr.members ?? [],
  };
}

/** The current state as a definition (what the matrix shows before a change). */
export function currentDef(cur: TableSecurity): SecurityDef {
  const all = cur.columns.map((c) => c.name);
  return {
    grants: cur.grants.map((g) => ({ role: g.role, select: g.tableSelect ? all : all.filter((c) => g.colSelect.includes(c)), update: g.tableUpdate ? all : all.filter((c) => g.colUpdate.includes(c)) })),
    view: {
      enabled: !!cur.view,
      name: cur.view?.name ?? `${cur.table}_masked`.slice(0, 63),
      roles: cur.appRoles,
      cols: Object.fromEntries(Object.entries(cur.view?.config.cols ?? {}).filter(([c]) => all.includes(c))),
    },
  };
}

/** Whether an application role sees a column's values (roles not in the configuration count as "others"). */
export function sees(def: SecurityDef['view'], col: string, role: string | null): boolean {
  const m = def.cols[col];
  if (!m) return true;
  if (role === null) return m.others;
  return m.see.includes(role) || (!def.roles.includes(role) && m.others);
}

/** Columns with a mask: some listed role or the others do not see them. */
export function maskedColumns(v: SecurityDef['view']) {
  return Object.entries(v.cols).filter(([, m]) => !m.others || v.roles.some((r) => !m.see.includes(r))).map(([c]) => c);
}

const hasRole = (r: string) => `(select meta.has_role(${lit(r)}))`;

/** The condition under which the signed-in user sees a column: one of the roles that see it, or none of the listed roles. */
export function seesSql(roles: string[], m: ColumnMask): string {
  const parts = roles.filter((r) => m.see.includes(r)).map(hasRole);
  if (m.others) parts.push(roles.length ? `not (${roles.map(hasRole).join(' or ')})` : 'true');
  return parts.length ? parts.join(' or ') : 'false';
}

/** The view's SELECT list entry for a column. */
export function columnSql(col: string, roles: string[], m: ColumnMask | undefined): string {
  const c = `t.${ident(col)}`;
  if (!m || (m.others && roles.every((r) => m.see.includes(r)))) return c;
  const cond = seesSql(roles, m);
  if (m.mask === 'stars') return `case when ${cond} then ${c}::text else '***' end as ${ident(col)}`;
  if (m.mask === 'partial') return `case when ${cond} then ${c}::text else '***' || right(${c}::text, 4) end as ${ident(col)}`;
  return `case when ${cond} then ${c} end as ${ident(col)}`;
}

/** What is wrong with a definition (against the catalog's state); `taken`: relation names in the schema. */
export function checkSecurity(def: SecurityDef, cur: TableSecurity, taken: string[]): string[] {
  const errors: string[] = [];
  const cols = new Set(cur.columns.map((c) => c.name));
  const roles = new Set(cur.grants.map((g) => g.role));
  for (const g of def.grants) {
    if (!roles.has(g.role)) errors.push(`${g.role} is not a database role this page can change.`);
    if ([...g.select, ...g.update].some((c) => !cols.has(c))) errors.push(`A column of ${g.role} is not in the table.`);
  }
  const v = def.view;
  for (const r of v.roles) if (!APP_ROLE_RE.test(r) || r !== r.toLowerCase()) errors.push(`"${r}" is not a valid application role (letters, digits, _ . : @ - and spaces; lower case).`);
  for (const [c, m] of Object.entries(v.cols)) {
    if (!cols.has(c)) errors.push(`${c} is not a column of the table.`);
    if (!MASKS.includes(m.mask)) errors.push(`Unknown mask for ${c}.`);
    if (m.see.some((r) => !v.roles.includes(r))) errors.push(`A role that sees ${c} is not in the list.`);
  }
  if (v.enabled) {
    if (!NAME_RE.test(v.name)) errors.push('The masking view needs a name of letters, digits, _ and $ (at most 63).');
    else if (v.name === cur.table) errors.push('The masking view needs a name other than the table\'s.');
    else if (taken.includes(v.name) && v.name !== cur.view?.name) errors.push(`${cur.schema}.${v.name} already exists.`);
  }
  return errors;
}

/** The roles that read through the view: database roles that may read some column of the table (after the change). */
const viewReaders = (def: SecurityDef) => def.grants.filter((g) => g.select.length).map((g) => g.role);

/**
 * The statements that turn the catalog's state into the definition, and warnings about what they leave open.
 * Order: the table's column privileges, then the masking view (dropped first, so a script starts with schema DDL).
 */
export function securitySql(def: SecurityDef, cur: TableSecurity): { statements: string[]; warnings: string[] } {
  const out: string[] = [];
  const warnings: string[] = [];
  const T = `${ident(cur.schema)}.${ident(cur.table)}`;
  const all = cur.columns.map((c) => c.name);
  const list = (cs: string[]) => cs.map(ident).join(', ');
  for (const want of def.grants) {
    const g = cur.grants.find((x) => x.role === want.role)!;
    for (const p of PRIVS) {
      const w = new Set(p === 'SELECT' ? want.select : want.update);
      const tableWide = p === 'SELECT' ? g.tableSelect : g.tableUpdate;
      const have = new Set(tableWide ? all : p === 'SELECT' ? g.colSelect : g.colUpdate);
      const R = roleIdent(want.role);
      if (all.every((c) => w.has(c))) {
        if (!tableWide && !all.every((c) => have.has(c))) out.push(`grant ${p.toLowerCase()} on ${T} to ${R}`);
        continue;
      }
      if (tableWide) {
        // revoking the table-wide privilege revokes the column privileges too
        out.push(`revoke ${p.toLowerCase()} on ${T} from ${R}`);
        if (w.size) out.push(`grant ${p.toLowerCase()} (${list(all.filter((c) => w.has(c)))}) on ${T} to ${R}`);
        continue;
      }
      const off = all.filter((c) => have.has(c) && !w.has(c));
      const on = all.filter((c) => w.has(c) && !have.has(c));
      if (off.length) out.push(`revoke ${p.toLowerCase()} (${list(off)}) on ${T} from ${R}`);
      if (on.length) out.push(`grant ${p.toLowerCase()} (${list(on)}) on ${T} to ${R}`);
    }
  }
  const v = def.view;
  const masked = maskedColumns(v);
  const readers = viewReaders(def);
  if (!v.enabled) {
    if (cur.view) out.push(`drop view ${ident(cur.schema)}.${ident(cur.view.name)}`);
    else if (masked.length) warnings.push('Masks only apply through the masking view: switch it on.');
    return { statements: out, warnings };
  }
  const config: MaskConfig = { table: cur.table, roles: v.roles, cols: Object.fromEntries(masked.map((c) => [c, v.cols[c]])) };
  const V = `${ident(cur.schema)}.${ident(v.name)}`;
  const M = ident(cur.maskRole);
  const sameView = cur.view && cur.view.name === v.name && cur.view.columns.join('\0') === all.join('\0') && configComment(cur.view.config) === configComment(config);
  const newMembers = readers.filter((r) => r !== 'PUBLIC' && !cur.maskMembers.includes(r));
  if (!sameView || newMembers.length || !cur.maskRoleExists) {
    if (cur.view) out.push(`drop view ${ident(cur.schema)}.${ident(cur.view.name)}`);
    else out.push(`drop view if exists ${V}`);
    if (!cur.maskRoleExists) {
      out.push(`create role ${M} nologin`);
      out.push(`grant ${M} to current_user`);
    }
    out.push(`grant usage on schema ${ident(cur.schema)} to ${M}`);
    out.push(`grant select on ${T} to ${M}`);
    // a member of the readers: their policies (to <role>) and the functions those policies call apply in the view
    for (const r of newMembers) out.push(`grant ${ident(r)} to ${M}`);
    out.push(`create view ${V} with (security_barrier) as\nselect ${all.map((c) => columnSql(c, v.roles, v.cols[c])).join(',\n       ')}\n  from ${T} t`);
    out.push(`alter view ${V} owner to ${M}`);
    out.push(`comment on view ${V} is ${lit(configComment(config))}`);
    for (const r of readers) out.push(`grant select on ${V} to ${roleIdent(r)}`);
    // the view runs as the masking role: it must stay under row level security
    out.push(`do $check$ begin
  if exists (select from pg_roles r where r.rolname = ${lit(cur.maskRole)}
              and (r.rolsuper or r.rolbypassrls or pg_has_role(r.oid, ${lit(cur.owner)}::regrole, 'USAGE'))) then
    raise exception 'the masking role ${cur.maskRole.replace(/'/g, "''")} would bypass row level security on ${cur.schema.replace(/'/g, "''")}.${cur.table.replace(/'/g, "''")}';
  end if;
end $check$`);
  }
  for (const c of masked) {
    const raw = def.grants.filter((g) => g.select.includes(c)).map((g) => g.role);
    if (raw.length) warnings.push(`${raw.join(', ')} can still read ${cur.table}.${c} on the table itself: the mask holds only where ${raw.length > 1 ? 'they read' : 'it reads'} ${v.name}. Untick "read" of ${c} to make it hold everywhere.`);
  }
  if (masked.length && !readers.length) warnings.push('No database role reads the table, so no role gets the masking view.');
  return { statements: out, warnings };
}
