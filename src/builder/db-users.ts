import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner, runtimeUrl } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  checkPassword, checkRole, dropSql, emptyRole, maskSql, reviewDigest, roleSql, scramVerifier, withVerifier,
  type DefaultPriv, type ExistingPriv, type RoleContext, type RoleSpec, type SchemaGrant,
} from '../dbroles.ts';
import { administrator, back, BASE, csrf, flash, region, send, shell, type Body, type Req } from './ui.ts';

// (sprint 99, Database Actions DA-13) Administration → Database Users: the PostgreSQL roles of this cluster with
// their sign-in, attributes, expiry, memberships and what they own; create, change and drop roles. Administrators
// only. Every change is shown as SQL first (the password masked) and applied in one transaction. pgkiln's own roles
// (the owner and runtime connections, pgkiln_*, the bootstrap superuser) can't be changed or dropped here; roles
// applications and isolated workspaces use can be changed but not dropped. SQL generation: src/dbroles.ts.

const URL_BASE = `${BASE}/db-users`;
const TITLE = 'Database Users';
/** predefined roles that reach the server's files or programs: not granted from here */
const SERVER_ROLES = ['pg_database_owner', 'pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files'];
const roleUrl = (name: string) => `${URL_BASE}/role/${encodeURIComponent(name)}`;
const runtimeUser = (() => {
  try {
    return decodeURIComponent(new URL(runtimeUrl).username);
  } catch {
    return '';
  }
})();

interface RoleRow {
  oid: number;
  name: string;
  login: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  bypassrls: boolean;
  replication: boolean;
  conn_limit: number;
  valid_until: string | null;
  days_left: number | null;
  member_of: string[];
  schemas: string[];
  owned: number;
  owned_elsewhere: number;
  comment: string | null;
  pgkiln: boolean;
  used_by: string[];
}

const ROLES_SQL = `
  with here as (select oid from pg_database where datname = current_database()),
  own as (select d.refobjid as role, count(*) filter (where d.dbid = (select oid from here))::int as here,
                 count(*) filter (where d.dbid <> (select oid from here))::int as elsewhere
            from pg_shdepend d where d.refclassid = 'pg_authid'::regclass and d.deptype = 'o' group by 1)
  select r.oid::int as oid, r.rolname as name, r.rolcanlogin as login, r.rolsuper as superuser, r.rolcreatedb as createdb,
         r.rolcreaterole as createrole, r.rolbypassrls as bypassrls, r.rolreplication as replication, r.rolconnlimit as conn_limit,
         case when r.rolvaliduntil is null or r.rolvaliduntil = 'infinity' then null else to_char(r.rolvaliduntil, 'YYYY-MM-DD') end as valid_until,
         case when r.rolvaliduntil is null or r.rolvaliduntil = 'infinity' then null else floor(extract(epoch from r.rolvaliduntil - now()) / 86400)::int end as days_left,
         array(select distinct g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid order by 1) as member_of,
         array(select n.nspname::text from pg_namespace n where n.nspowner = r.oid order by 1) as schemas,
         coalesce(o.here, 0) as owned, coalesce(o.elsewhere, 0) as owned_elsewhere,
         shobj_description(r.oid, 'pg_authid') as comment,
         (r.oid = 10 or r.rolname ~* '^pgkiln' or r.rolname in (current_user, session_user, $1)
           or r.oid = (select nspowner from pg_namespace where nspname = 'meta')) as pgkiln,
         array(select 'application ' || a.alias || case when a.db_role = r.rolname then ' (parsing schema)' else ' (REST API)' end
                 from meta.app a where r.rolname in (a.db_role, a.api_role) order by a.alias)
           || array(select 'workspace ' || w.name from meta.workspace_role x join meta.workspace w on w.id = x.workspace_id
                     where x.role_name = r.rolname order by w.name) as used_by
    from pg_roles r left join own o on o.role = r.oid
   where r.rolname !~ '^pg_'`;

const listRoles = async () => (await owner.query<RoleRow>(`${ROLES_SQL} order by lower(r.rolname)`, [runtimeUser])).rows;
const oneRole = async (name: string) => (await owner.one<RoleRow>(`${ROLES_SQL} and r.rolname = $2`, [runtimeUser, name])) ?? null;

const context = async (): Promise<RoleContext> => (await owner.one<RoleContext>('select current_database() as database, current_user as creator'))!;

/** Schemas whose privileges the form changes: not the system's and not pgkiln's own. */
const grantSchemas = async () =>
  (await owner.query<{ n: string }>(`select nspname as n from pg_namespace
     where nspname !~ '^pg_' and nspname !~* '^pgkiln' and nspname not in ('information_schema', 'meta', 'api') order by 1`)).rows.map((r) => r.n);

/** Roles a role may be made a member of: group roles, not superusers or pgkiln's own; predefined roles last. */
const grantableRoles = async () =>
  (await owner.query<{ n: string }>(
    `select r.rolname as n from pg_roles r
      where not r.rolcanlogin and not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole and r.rolname !~* '^pgkiln'
        and r.rolname <> all ($1) and r.oid <> (select nspowner from pg_namespace where nspname = 'meta')
      order by r.rolname ~ '^pg_', lower(r.rolname)`, [SERVER_ROLES])).rows.map((r) => r.n);

/** What the catalog says about a role, as the form shows it. */
async function readSpec(role: RoleRow, schemas: string[], creator: string): Promise<RoleSpec> {
  const path = await owner.one<{ v: string }>(
    `select substr(x, 13) as v from pg_db_role_setting s, unnest(s.setconfig) x
      where s.setrole = $1 and s.setdatabase = (select oid from pg_database where datname = current_database()) and x like 'search_path=%'`, [role.oid]);
  const grants = (await owner.query<{ schema: string; priv: string }>(
    `select n.nspname as schema, a.privilege_type as priv from pg_namespace n cross join aclexplode(n.nspacl) a where a.grantee = $1`, [role.oid])).rows;
  const defaults = (await owner.query<{ schema: string; priv: string }>(
    `select n.nspname as schema, a.privilege_type as priv
       from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join aclexplode(d.defaclacl) a
      where d.defaclrole = (select oid from pg_roles where rolname = $2) and d.defaclobjtype = 'r' and a.grantee = $1`, [role.oid, creator])).rows;
  const kind = (schema: string): DefaultPriv => {
    const p = defaults.filter((d) => d.schema === schema).map((d) => d.priv).sort().join(',');
    return p === '' ? 'none' : p === 'SELECT' ? 'read' : p === 'DELETE,INSERT,SELECT,UPDATE' ? 'write' : 'custom';
  };
  return {
    name: role.name,
    login: role.login,
    password: 'keep',
    validUntil: role.valid_until ?? '',
    connLimit: role.conn_limit,
    memberOf: role.member_of,
    searchPath: path?.v ?? '',
    comment: role.comment ?? '',
    schemas: schemas.map((schema) => ({
      schema,
      usage: grants.some((g) => g.schema === schema && g.priv === 'USAGE'),
      create: grants.some((g) => g.schema === schema && g.priv === 'CREATE'),
      defaults: kind(schema),
    })),
  };
}

const many = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));

/** The form's values (also the review's hidden fields). */
function specFromBody(b: Body, isNew: boolean, original: string): RoleSpec {
  const schemas: SchemaGrant[] = [];
  for (let i = 0; i < 1000 && b[`s.${i}.name`] !== undefined; i++) {
    schemas.push({
      schema: one(b[`s.${i}.name`]),
      usage: !!b[`s.${i}.usage`],
      create: !!b[`s.${i}.create`],
      defaults: one(b[`s.${i}.defaults`] ?? 'none') as DefaultPriv,
      existing: one(b[`s.${i}.existing`] ?? '') as ExistingPriv,
    });
  }
  const pw = one(b.password_mode);
  const limit = one(b.conn_limit).trim();
  return {
    name: isNew ? one(b.name).trim() : original,
    login: !!b.login,
    password: pw === 'set' ? 'set' : pw === 'remove' && !isNew ? 'remove' : 'keep',
    validUntil: one(b.valid_until).trim(),
    connLimit: limit === '' ? -1 : /^-?\d{1,6}$/.test(limit) ? Number(limit) : NaN,
    memberOf: [...new Set(many(b.member))],
    searchPath: one(b.search_path).trim(),
    comment: one(b.comment).trim(),
    schemas,
  };
}

const chk = (on: boolean) => (on ? raw(' checked') : '');
const sel = (on: boolean) => (on ? raw(' selected') : '');
const errorList = (errors: string[]) =>
  errors.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : '';

const DEFAULT_LABELS: [DefaultPriv, string][] = [['none', 'None'], ['read', 'Read (SELECT)'], ['write', 'Read and write']];
const EXISTING_LABELS: [ExistingPriv, string][] = [['', 'No change'], ['read', 'Grant read'], ['write', 'Grant read and write'], ['revoke', 'Revoke all']];

/** The create / edit form. */
function roleForm(s: Session, spec: RoleSpec, o: { isNew: boolean; before: RoleSpec | null; grantable: string[]; errors: string[] }) {
  const options = [...new Set([...o.grantable, ...(o.before?.memberOf ?? []), ...spec.memberOf])];
  const pwModes: [string, string][] = o.isNew ? [['keep', 'No password'], ['set', 'Set a password']] : [['keep', 'Keep the password'], ['set', 'Set a new password'], ['remove', 'Remove the password']];
  return html`${errorList(o.errors)}
    <form method="post" action="${URL_BASE}/save" class="dbu-form">${csrf(s)}
      <input type="hidden" name="original" value="${o.isNew ? '' : spec.name}">
      ${region('Role', html`<div class="form-grid">
        ${o.isNew ? html`<div class="field"><label class="label" for="f_name">Name</label>
          <input id="f_name" name="name" value="${spec.name}" required maxlength="63" pattern="[A-Za-z_][A-Za-z0-9_$]*" autocomplete="off" spellcheck="false">
          <small class="help">Letters, digits, _ and $; names starting with pg_ or pgkiln are reserved.</small></div>` : ''}
        <div class="field"><span class="label">Sign in</span><label class="check"><input type="checkbox" name="login" value="1"${chk(spec.login)}> Can sign in (LOGIN)</label>
          <small class="help">A role without it is a group role: others get its privileges by being members.</small></div>
        <fieldset class="field"><legend class="label">Password</legend><div class="radio-group">
          ${pwModes.map(([v, l]) => html`<label class="check"><input type="radio" name="password_mode" value="${v}"${chk(spec.password === v)}> ${l}</label>`)}
          </div><small class="help">You type the password on the next step, after reviewing the SQL. It is stored as a SCRAM-SHA-256 verifier and never shown.</small></fieldset>
        <div class="field"><label class="label" for="f_valid_until">Valid until</label>
          <input id="f_valid_until" name="valid_until" type="date" value="${spec.validUntil}">
          <small class="help">The password stops working after this date (VALID UNTIL). Empty: it doesn't expire.</small></div>
        <div class="field"><label class="label" for="f_conn_limit">Connection limit</label>
          <input id="f_conn_limit" name="conn_limit" type="number" min="-1" max="100000" step="1" value="${Number.isFinite(spec.connLimit) && spec.connLimit >= 0 ? String(spec.connLimit) : ''}">
          <small class="help">Empty: no limit.</small></div>
        <div class="field"><label class="label" for="f_search_path">Default schema (search path)</label>
          <input id="f_search_path" name="search_path" value="${spec.searchPath}" placeholder="sales, public" spellcheck="false" autocomplete="off">
          <small class="help">Schemas, comma separated, for this role's sessions in this database. Empty: the server's default.</small></div>
        <div class="field"><label class="label" for="f_comment">Comment</label>
          <input id="f_comment" name="comment" value="${spec.comment}" maxlength="1000"></div>
      </div>`)}
      ${region('Member of', html`<p class="muted u-mt0">The role gets the privileges of the roles it is a member of. pgkiln's own roles, superusers, login roles and the predefined roles that reach the server's files can't be granted here.</p>
        ${options.length ? html`<fieldset class="field"><legend class="sr-only">Member of</legend><div class="radio-group dbu-members">
          ${options.map((m) => html`<label class="check"><input type="checkbox" name="member" value="${m}"${chk(spec.memberOf.includes(m))}> ${m}</label>`)}
        </div></fieldset>` : html`<p class="muted">There are no group roles to grant.</p>`}`)}
      ${region('Schemas', html`<p class="muted u-mt0"><strong>Usage</strong> lets the role use a schema's objects (as far as their own privileges allow), <strong>Create</strong> make objects in it. <strong>Future tables</strong> are default privileges on the tables (and, for writing, sequences) pgkiln's owner connection creates there from now on; <strong>Existing tables</strong> grants or revokes once on the tables there now. pgkiln's own schemas aren't listed.</p>
        ${spec.schemas.length ? html`<div class="table-wrap"><table class="report dbu-schemas"><thead><tr><th>Schema</th><th class="te-c">Usage</th><th class="te-c">Create</th><th>Future tables</th><th>Existing tables</th></tr></thead>
        <tbody>${spec.schemas.map((x, i) => html`<tr><td><code>${x.schema}</code><input type="hidden" name="s.${i}.name" value="${x.schema}"></td>
          <td class="te-c"><input type="checkbox" name="s.${i}.usage" value="1" aria-label="Usage on ${x.schema}"${chk(x.usage)}></td>
          <td class="te-c"><input type="checkbox" name="s.${i}.create" value="1" aria-label="Create in ${x.schema}"${chk(x.create)}></td>
          <td><select name="s.${i}.defaults" aria-label="Future tables in ${x.schema}">${x.defaults === 'custom' ? html`<option value="custom" selected>As they are (custom)</option>` : ''}${DEFAULT_LABELS.map(([v, l]) => html`<option value="${v}"${sel(x.defaults === v)}>${l}</option>`)}</select></td>
          <td><select name="s.${i}.existing" aria-label="Existing tables in ${x.schema}">${EXISTING_LABELS.map(([v, l]) => html`<option value="${v}"${sel((x.existing ?? '') === v)}>${l}</option>`)}</select></td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No schemas.</p>`}`)}
      <div class="buttons"><button class="btn btn-hot" name="mode" value="review">${icon('eye')} Review SQL</button><a class="btn" href="${URL_BASE}">Cancel</a></div>
    </form>`;
}

/** The form's values as hidden fields (the review step carries them to Apply). */
const hiddenSpec = (spec: RoleSpec, isNew: boolean) => html`
  <input type="hidden" name="original" value="${isNew ? '' : spec.name}">
  ${isNew ? html`<input type="hidden" name="name" value="${spec.name}">` : ''}
  ${spec.login ? html`<input type="hidden" name="login" value="1">` : ''}
  <input type="hidden" name="password_mode" value="${spec.password}">
  <input type="hidden" name="valid_until" value="${spec.validUntil}">
  <input type="hidden" name="conn_limit" value="${spec.connLimit >= 0 ? String(spec.connLimit) : ''}">
  ${spec.memberOf.map((m) => html`<input type="hidden" name="member" value="${m}">`)}
  <input type="hidden" name="search_path" value="${spec.searchPath}">
  <input type="hidden" name="comment" value="${spec.comment}">
  ${spec.schemas.map((x, i) => html`<input type="hidden" name="s.${i}.name" value="${x.schema}">${x.usage ? html`<input type="hidden" name="s.${i}.usage" value="1">` : ''}${x.create ? html`<input type="hidden" name="s.${i}.create" value="1">` : ''}<input type="hidden" name="s.${i}.defaults" value="${x.defaults}"><input type="hidden" name="s.${i}.existing" value="${x.existing ?? ''}">`)}`;

/** The review step: the SQL (the password masked), the password fields when one is set, Apply. */
function reviewForm(s: Session, spec: RoleSpec, stmts: string[], o: { isNew: boolean; errors: string[]; output?: Raw | '' }) {
  return html`${errorList(o.errors)}${o.output ?? ''}
    ${region('SQL', stmts.length
      ? html`<p class="muted u-mt0">These statements run in one transaction when you apply them: all of them, or none.${spec.password === 'set' ? ' The password shows as \'********\': pgkiln sends PostgreSQL only its SCRAM-SHA-256 verifier.' : ''}</p>
        <pre class="source dbu-sql" aria-label="Generated SQL">${maskSql(stmts)}</pre>`
      : html`<p class="muted u-mt0">Nothing to change: the role is as the form says.</p>`)}
    <form method="post" action="${URL_BASE}/save" class="dbu-form">${csrf(s)}${hiddenSpec(spec, o.isNew)}
      <input type="hidden" name="reviewed" value="${reviewDigest(stmts)}">
      ${spec.password === 'set' ? region('Password', html`<div class="form-grid">
        <div class="field"><label class="label" for="f_password">Password</label><input id="f_password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></div>
        <div class="field"><label class="label" for="f_confirm">Confirm password</label><input id="f_confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></div>
      </div><small class="help">At least 8 characters. It is hashed by pgkiln before it reaches the database, and it is not kept.</small>`) : ''}
      <div class="buttons">${stmts.length ? html`<button class="btn btn-hot" name="mode" value="apply">${icon('check')} Apply</button>` : ''}
        <button class="btn" name="mode" value="edit" formnovalidate>${icon('back')} Back to the form</button></div>
    </form>`;
}

/** A role's attributes as tags. */
const attrTags = (r: RoleRow) => html`${r.pgkiln ? html`<span class="tag tag-info">pgkiln</span> ` : ''}${r.used_by.length ? html`<span class="tag" title="${r.used_by.join(', ')}">in use</span> ` : ''}${
  r.superuser ? html`<span class="tag tag-error">superuser</span> ` : ''}${r.bypassrls ? html`<span class="tag tag-warning">bypass RLS</span> ` : ''}${
  r.createrole ? html`<span class="tag tag-warning">create role</span> ` : ''}${r.createdb ? html`<span class="tag">create DB</span> ` : ''}${r.replication ? html`<span class="tag">replication</span>` : ''}`;

const expiry = (r: RoleRow) => r.valid_until === null ? html`<span class="muted">never</span>` : html`${r.valid_until}${
  r.days_left !== null && r.days_left < 0 ? html` <span class="tag tag-error">expired</span>` : r.days_left !== null && r.days_left <= 30 ? html` <span class="tag tag-warning">in ${String(r.days_left)} day${r.days_left === 1 ? '' : 's'}</span>` : ''}`;

const FILTERS: [string, string, (r: RoleRow) => boolean][] = [
  ['', 'All roles', () => true],
  ['login', 'Can sign in', (r) => r.login],
  ['expiring', 'Password expires within 30 days', (r) => r.login && r.days_left !== null && r.days_left >= 0 && r.days_left <= 30],
  ['bypassrls', 'Bypass row level security', (r) => r.bypassrls],
  ['owners', 'No sign-in, but own objects', (r) => !r.login && r.owned > 0],
  ['pgkiln', 'pgkiln\'s own', (r) => r.pgkiln],
];

async function listPage(req: Req, reply: FastifyReply, s: Session) {
  const roles = await listRoles();
  const f = FILTERS.find(([k]) => k === (req.query.f ?? '')) ?? FILTERS[0];
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
  const shown = roles.filter((r) => f[2](r) && (!q || r.name.toLowerCase().includes(q)));
  const main = html`<div class="ide-head-title u-mb1"><div><h1>${TITLE}</h1><span class="muted small">The PostgreSQL roles of this server (pg_roles), without the predefined pg_ roles.</span></div>
      <div class="buttons ide-head-actions"><a class="btn btn-hot" href="${URL_BASE}/new">${icon('plus')} Create database user</a></div></div>
    <nav class="stat-grid u-mb1 dbu-stats" aria-label="Filters">${FILTERS.map(([k, label, fn]) => html`<a class="stat" href="${URL_BASE}${k ? `?f=${k}` : ''}"${k === f[0] ? raw(' aria-current="page"') : ''}><b>${String(roles.filter(fn).length)}</b><span>${label}</span></a>`)}</nav>
    ${region(f[1], html`<form method="get" action="${URL_BASE}" class="dbu-search u-mb1" role="search">${f[0] ? html`<input type="hidden" name="f" value="${f[0]}">` : ''}
        <label class="sr-only" for="dbu-q">Search roles</label><input id="dbu-q" name="q" type="search" value="${q}" placeholder="Search roles" autocomplete="off"> <button class="btn btn-sm">${icon('search')} Search</button></form>
      <div class="table-wrap"><table class="report report-reflow dbu-list"><thead><tr><th>Role</th><th>Sign in</th><th>Attributes</th><th class="num">Connections</th><th>Valid until</th><th>Member of</th><th>Owns</th></tr></thead>
      <tbody>${shown.length ? shown.map((r) => html`<tr>
        <td data-label="Role" class="u-break"><a href="${roleUrl(r.name)}"><strong>${r.name}</strong></a>${r.comment ? html`<br><span class="muted small">${r.comment}</span>` : ''}</td>
        <td data-label="Sign in">${r.login ? 'Yes' : html`<span class="muted">No</span>`}</td>
        <td data-label="Attributes">${attrTags(r)}</td>
        <td data-label="Connections" class="num">${r.conn_limit < 0 ? html`<span class="muted">no limit</span>` : String(r.conn_limit)}</td>
        <td data-label="Valid until">${expiry(r)}</td>
        <td data-label="Member of" class="u-break">${r.member_of.join(', ')}</td>
        <td data-label="Owns" class="u-break">${r.schemas.length ? html`schemas ${r.schemas.join(', ')}; ` : ''}${r.owned ? `${r.owned} object${r.owned === 1 ? '' : 's'}` : r.schemas.length ? '' : html`<span class="muted">nothing</span>`}${r.owned_elsewhere ? html` <span class="muted">(+${String(r.owned_elsewhere)} elsewhere)</span>` : ''}</td></tr>`)
        : html`<tr><td colspan="7" class="empty">No roles.</td></tr>`}</tbody></table></div>
      <p class="muted small">PostgreSQL doesn't record when a role was created. <span class="tag tag-info">pgkiln</span> roles are pgkiln's own connections and roles: they are shown, not changed here. Roles <span class="tag">in use</span> by an application or an isolated workspace can be changed but not dropped.</p>`)}`;
  return send(reply, s, shell(s, TITLE, crumbs(), main, 'users'));
}

const crumbs = (...more: [string, string?][]): [string, string?][] => [['Workspace utilities', `${BASE}/utilities`], [TITLE, more.length ? URL_BASE : undefined], ...more];

/** A role's details: owned objects, members, users of it. */
async function details(r: RoleRow) {
  const owned = (await owner.query<{ what: string }>(
    `select pg_describe_object(d.classid, d.objid, d.objsubid) as what from pg_shdepend d
      where d.refobjid = $1 and d.refclassid = 'pg_authid'::regclass and d.deptype = 'o'
        and d.dbid = (select oid from pg_database where datname = current_database()) order by 1 limit 50`, [r.oid])).rows.map((x) => x.what);
  const members = (await owner.query<{ n: string }>(
    `select distinct m.member::regrole::text as n from pg_auth_members m where m.roleid = $1 order by 1`, [r.oid])).rows.map((x) => x.n);
  return { owned, members };
}

function detailRegion(r: RoleRow, d: { owned: string[]; members: string[] }) {
  return region('Details', html`<dl class="dbu-facts">
    <dt>Attributes</dt><dd>${r.login ? 'Can sign in' : 'No sign-in (a group role)'} ${attrTags(r)}</dd>
    <dt>Valid until</dt><dd>${expiry(r)}</dd>
    <dt>Connection limit</dt><dd>${r.conn_limit < 0 ? 'no limit' : String(r.conn_limit)}</dd>
    <dt>Member of</dt><dd class="u-break">${r.member_of.join(', ') || html`<span class="muted">none</span>`}</dd>
    <dt>Members</dt><dd class="u-break">${d.members.join(', ') || html`<span class="muted">none</span>`}</dd>
    ${r.used_by.length ? html`<dt>Used by</dt><dd class="u-break">${r.used_by.join(', ')}</dd>` : ''}
    <dt>Owns</dt><dd class="u-break">${d.owned.length ? html`${r.owned > d.owned.length ? `${r.owned} objects, the first ${d.owned.length}: ` : ''}${d.owned.join(', ')}` : html`<span class="muted">nothing in this database</span>`}${r.owned_elsewhere ? html` <span class="tag tag-warning">${String(r.owned_elsewhere)} in other databases or shared</span>` : ''}</dd>
  </dl>`);
}

/** Can this role be changed here? A message when not. */
const protectedMessage = (r: RoleRow) => r.pgkiln
  ? `${r.name} is one of pgkiln's own roles (its owner or runtime connection, a pgkiln_ role or the bootstrap superuser): pgkiln needs it as it is, so it isn't changed or dropped here.`
  : '';

async function rolePage(reply: FastifyReply, s: Session, name: string | null, o: { spec?: RoleSpec; errors?: string[] } = {}) {
  const [ctx, schemas, grantable] = await Promise.all([context(), grantSchemas(), grantableRoles()]);
  if (name === null) {
    const spec = o.spec ?? { ...emptyRole(), login: true, schemas: schemas.map((schema) => ({ schema, usage: false, create: false, defaults: 'none' as DefaultPriv })) };
    const main = html`<h1 class="u-mb1">Create database user</h1>${roleForm(s, spec, { isNew: true, before: null, grantable, errors: o.errors ?? [] })}`;
    return send(reply, s, shell(s, 'Create database user', crumbs(['Create']), main, 'users'));
  }
  const r = await oneRole(name);
  if (!r) return reply.code(404).send('Not found');
  const d = await details(r);
  const msg = protectedMessage(r);
  const before = msg ? null : await readSpec(r, schemas, ctx.creator);
  const main = html`<div class="ide-head-title u-mb1"><div><h1 class="u-break">Role ${r.name}</h1>${r.comment ? html`<span class="muted small">${r.comment}</span>` : ''}</div>
      ${msg || r.used_by.length ? '' : html`<div class="buttons ide-head-actions"><a class="btn btn-danger" href="${roleUrl(r.name)}/drop">${icon('trash')} Drop role…</a></div>`}</div>
    ${msg ? html`<div class="alert alert-info" role="status">${msg}</div>` : ''}
    ${!msg && r.used_by.length ? html`<div class="alert alert-info" role="status">${r.used_by.join(', ')} use${r.used_by.length === 1 ? 's' : ''} this role: it can be changed, not dropped.</div>` : ''}
    ${detailRegion(r, d)}
    ${before ? roleForm(s, o.spec ?? before, { isNew: false, before, grantable, errors: o.errors ?? [] }) : ''}`;
  return send(reply, s, shell(s, `Role ${r.name}`, crumbs([r.name]), main, 'users'));
}

async function save(req: Req, reply: FastifyReply, s: Session) {
  const b = req.body ?? {};
  const original = one(b.original);
  const isNew = !original;
  const [ctx, schemas, grantable] = await Promise.all([context(), grantSchemas(), grantableRoles()]);
  const r = isNew ? null : await oneRole(original);
  if (!isNew && !r) return reply.code(404).send('Not found');
  if (r && r.pgkiln) {
    const main = html`<h1 class="u-mb1">Role ${r.name}</h1><div class="alert alert-error" role="alert">${protectedMessage(r)}</div>`;
    return send(reply.code(403), s, shell(s, `Role ${r.name}`, crumbs([r.name]), main, 'users'));
  }
  const before = r ? await readSpec(r, schemas, ctx.creator) : null;
  const spec = specFromBody(b, isNew, original);
  const mode = one(b.mode);
  if (mode === 'edit') return rolePage(reply, s, isNew ? null : original, { spec });
  const errors = checkRole(spec, { isNew, grantable, schemas, before });
  if (isNew && !errors.length && (await owner.one('select 1 from pg_roles where lower(rolname) = lower($1)', [spec.name]))) errors.push(`A role named ${spec.name} exists already.`);
  if (errors.length) return rolePage(reply, s, isNew ? null : original, { spec, errors });
  const stmts = roleSql(before, spec, ctx);
  const title = isNew ? `Create database user ${spec.name}` : `Change role ${spec.name}`;
  const page = (errs: string[], output: Raw | '' = '') => {
    const main = html`<h1 class="u-mb1 u-break">${title}</h1>${reviewForm(s, spec, stmts, { isNew, errors: errs, output })}`;
    const trail: [string, string?][] = isNew ? [['Create', `${URL_BASE}/new`], ['Review']] : [[spec.name, roleUrl(spec.name)], ['Review']];
    return send(reply.code(errs.length || output ? 422 : 200), s, shell(s, title, crumbs(...trail), main, 'users'));
  };
  if (mode !== 'apply') return page([]);
  // Apply runs exactly what the review showed: a change in the form or the catalog since then shows the review again
  if (one(b.reviewed) !== reviewDigest(stmts)) return page(['The statements changed since you reviewed them (the role or the form changed): review them again.']);
  if (!stmts.length) return page(['Nothing to change.']);
  const password = one(b.password);
  if (spec.password === 'set') {
    const bad = checkPassword(password, one(b.confirm));
    if (bad.length) return page(bad);
  }
  const run = withVerifier(stmts, spec.password === 'set' ? scramVerifier(password) : null);
  let failed = '';
  let at = -1;
  try {
    await owner.tx(async (c) => {
      await c.query(`set local lock_timeout = '10s'`);
      for (let i = 0; i < run.length; i++) {
        at = i;
        await c.query(run[i]);
      }
    });
  } catch (e) {
    // PostgreSQL's message names the role or object, never the statement's literals
    failed = (e as Error).message;
  }
  await logActivity({ username: s.username, event: 'db_role', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${maskSql(stmts)}`.slice(0, 4000) });
  if (failed) {
    return page([], html`<div class="alert alert-error" role="alert"><p><strong>Nothing was changed</strong>: the statements ran in one transaction, which was rolled back.</p><p>${failed}</p>${at >= 0 ? html`<pre class="source">${maskSql([stmts[at]])}</pre>` : ''}</div>`);
  }
  flash(s, `${isNew ? 'Created' : 'Changed'} the role ${spec.name}: ${stmts.length} statement${stmts.length === 1 ? '' : 's'}.`);
  return back(reply, s, isNew ? URL_BASE : roleUrl(spec.name));
}

/** Roles another role's objects can be given to. */
const reassignTargets = async (name: string) =>
  (await owner.query<{ n: string }>(`select rolname as n from pg_roles where rolname !~ '^pg_' and rolname <> $1 order by rolname <> current_user, lower(rolname)`, [name])).rows.map((x) => x.n);

async function dropPage(req: Req, reply: FastifyReply, s: Session, name: string, o: { to?: string; errors?: string[]; output?: Raw | '' } = {}) {
  const r = await oneRole(name);
  if (!r) return reply.code(404).send('Not found');
  const refusal = r.pgkiln ? protectedMessage(r) : r.used_by.length ? `${r.used_by.join(', ')} use${r.used_by.length === 1 ? 's' : ''} ${r.name}: it isn't dropped while they do.` : '';
  const d = await details(r);
  const targets = await reassignTargets(name);
  const to = o.to !== undefined && (o.to === '' || targets.includes(o.to)) ? o.to : r.owned ? targets[0] ?? '' : '';
  const stmts = dropSql(r.name, to || null);
  const main = html`<h1 class="u-mb1 u-break">Drop role ${r.name}</h1>
    ${refusal ? html`<div class="alert alert-error" role="alert">${refusal}</div>` : ''}${errorList(o.errors ?? [])}${o.output ?? ''}
    ${detailRegion(r, d)}
    ${refusal ? '' : html`
    ${r.owned || r.owned_elsewhere ? html`<div class="alert alert-error" role="alert"><p><strong>${r.name} owns ${String(r.owned)} object${r.owned === 1 ? '' : 's'} in this database${r.owned_elsewhere ? html` and ${String(r.owned_elsewhere)} in other databases or shared (databases, tablespaces)` : ''}.</strong>
      Reassign them to another role, or drop them with the role.${r.owned_elsewhere ? ' Objects in other databases must be reassigned or dropped there first, or DROP ROLE fails.' : ''}</p></div>` : ''}
    ${region('Owned objects', html`<form method="get" action="${roleUrl(r.name)}/drop" class="form-grid">
        <div class="field"><label class="label" for="f_to">Objects it owns</label><select id="f_to" name="to">
          ${targets.map((t) => html`<option value="${t}"${sel(t === to)}>Reassign to ${t}</option>`)}
          <option value=""${sel(to === '')}>${r.owned ? 'Drop them with the role (DROP OWNED)' : 'It owns nothing here: just revoke its privileges'}</option></select>
          <small class="help">DROP OWNED also revokes the privileges granted to the role in this database.</small></div>
        <div class="buttons"><button class="btn">${icon('eye')} Review SQL</button></div></form>`)}
    ${region('SQL', html`<pre class="source dbu-sql" aria-label="Generated SQL">${maskSql(stmts)}</pre>
      <form method="post" action="${URL_BASE}/drop" class="dbu-form">${csrf(s)}
        <input type="hidden" name="name" value="${r.name}"><input type="hidden" name="to" value="${to}"><input type="hidden" name="reviewed" value="${reviewDigest(stmts)}">
        ${!to && r.owned ? html`<label class="check u-mb1"><input type="checkbox" name="drop_objects" value="1" required> Drop the ${String(r.owned)} object${r.owned === 1 ? '' : 's'} ${r.name} owns, with their data</label>` : ''}
        <div class="buttons"><button class="btn btn-danger" data-confirm="Drop the role ${r.name}?">${icon('trash')} Drop role</button><a class="btn" href="${roleUrl(r.name)}">Cancel</a></div></form>`)}`}`;
  return send(reply.code(refusal ? 403 : o.errors?.length || o.output ? 422 : 200), s, shell(s, `Drop role ${r.name}`, crumbs([r.name, roleUrl(r.name)], ['Drop']), main, 'users'));
}

async function drop(req: Req, reply: FastifyReply, s: Session) {
  const b = req.body ?? {};
  const name = one(b.name);
  const to = one(b.to);
  const r = await oneRole(name);
  if (!r) return reply.code(404).send('Not found');
  if (r.pgkiln || r.used_by.length) return dropPage(req, reply, s, name, { to });
  const targets = await reassignTargets(name);
  if (to && !targets.includes(to)) return dropPage(req, reply, s, name, { errors: ['Choose a role to reassign the objects to.'] });
  const stmts = dropSql(r.name, to || null);
  if (one(b.reviewed) !== reviewDigest(stmts)) return dropPage(req, reply, s, name, { to, errors: ['The statements changed since you reviewed them: review them again.'] });
  if (!to && r.owned && !b.drop_objects) return dropPage(req, reply, s, name, { to, errors: [`Tick the box to drop the objects ${r.name} owns, or reassign them.`] });
  let failed = '';
  try {
    await owner.tx(async (c) => {
      await c.query(`set local lock_timeout = '10s'`);
      for (const x of stmts) await c.query(x);
    });
  } catch (e) {
    failed = (e as Error).message;
  }
  await logActivity({ username: s.username, event: 'db_role', ip: clientIp(req), detail: `${failed ? 'failed: ' : ''}${maskSql(stmts)}`.slice(0, 4000) });
  if (failed) return dropPage(req, reply, s, name, { to, output: html`<div class="alert alert-error" role="alert"><p><strong>Nothing was changed</strong>: the statements ran in one transaction, which was rolled back.</p><p>${failed}</p></div>` });
  flash(s, `Dropped the role ${r.name}.`);
  return back(reply, s, URL_BASE);
}

export async function dbUserRoutes(app: FastifyInstance) {
  app.get(URL_BASE, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (s) return listPage(req, reply, s);
  });
  app.get(`${URL_BASE}/new`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (s) return rolePage(reply, s, null);
  });
  app.get(`${URL_BASE}/role/:name`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (s) return rolePage(reply, s, req.params.name);
  });
  app.post(`${URL_BASE}/save`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (s) return save(req, reply, s);
  });
  app.get(`${URL_BASE}/role/:name/drop`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (s) return dropPage(req, reply, s, req.params.name, { to: req.query.to });
  });
  app.post(`${URL_BASE}/drop`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (s) return drop(req, reply, s);
  });
}
