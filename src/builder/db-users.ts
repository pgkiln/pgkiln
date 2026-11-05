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
import { tr, type BuilderTranslate } from './i18n.ts';

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
  const rows = Object.keys(b).map((k) => /^s\.(\d{1,4})\.name$/.exec(k)?.[1]).filter((i): i is string => !!i).sort((x, y) => Number(x) - Number(y));
  for (const i of rows) {
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

const DEFAULT_LABELS = (tx: BuilderTranslate): [DefaultPriv, string][] => [['none', tx('dbu.priv.none')], ['read', tx('dbu.priv.read')], ['write', tx('dbu.priv.write')]];
const EXISTING_LABELS = (tx: BuilderTranslate): [ExistingPriv, string][] => [['', tx('dbu.existing.none')], ['read', tx('dbu.existing.read')], ['write', tx('dbu.existing.write')], ['revoke', tx('dbu.existing.revoke')]];

/** The create / edit form. */
function roleForm(s: Session, spec: RoleSpec, o: { isNew: boolean; before: RoleSpec | null; grantable: string[]; errors: string[] }) {
  const tx = tr(s);
  const options = [...new Set([...o.grantable, ...(o.before?.memberOf ?? []), ...spec.memberOf])];
  const pwModes: [string, string][] = o.isNew ? [['keep', tx('dbu.pw.none')], ['set', tx('dbu.pw.set')]] : [['keep', tx('dbu.pw.keep')], ['set', tx('dbu.pw.new')], ['remove', tx('dbu.pw.remove')]];
  return html`${errorList(o.errors)}
    <form method="post" action="${URL_BASE}/save" class="dbu-form">${csrf(s)}
      <input type="hidden" name="original" value="${o.isNew ? '' : spec.name}">
      ${region(tx('dbu.role'), html`<div class="form-grid">
        ${o.isNew ? html`<div class="field"><label class="label" for="f_name">${tx('dbu.name')}</label>
          <input id="f_name" name="name" value="${spec.name}" required maxlength="63" pattern="[A-Za-z_][A-Za-z0-9_$]*" autocomplete="off" spellcheck="false">
          <small class="help">${tx('dbu.name_help')}</small></div>` : ''}
        <div class="field"><span class="label">${tx('dbu.sign_in')}</span><label class="check"><input type="checkbox" name="login" value="1"${chk(spec.login)}> ${tx('dbu.can_login')}</label>
          <small class="help">${tx('dbu.can_login_help')}</small></div>
        <fieldset class="field"><legend class="label">${tx('dbu.password')}</legend><div class="radio-group">
          ${pwModes.map(([v, l]) => html`<label class="check"><input type="radio" name="password_mode" value="${v}"${chk(spec.password === v)}> ${l}</label>`)}
          </div><small class="help">${tx('dbu.password_help')}</small></fieldset>
        <div class="field"><label class="label" for="f_valid_until">${tx('dbu.valid_until')}</label>
          <input id="f_valid_until" name="valid_until" type="date" value="${spec.validUntil}">
          <small class="help">${tx('dbu.valid_until_help')}</small></div>
        <div class="field"><label class="label" for="f_conn_limit">${tx('dbu.conn_limit')}</label>
          <input id="f_conn_limit" name="conn_limit" type="number" min="-1" max="100000" step="1" value="${Number.isFinite(spec.connLimit) && spec.connLimit >= 0 ? String(spec.connLimit) : ''}">
          <small class="help">${tx('dbu.conn_limit_help')}</small></div>
        <div class="field"><label class="label" for="f_search_path">${tx('dbu.search_path')}</label>
          <input id="f_search_path" name="search_path" value="${spec.searchPath}" placeholder="sales, public" spellcheck="false" autocomplete="off">
          <small class="help">${tx('dbu.search_path_help')}</small></div>
        <div class="field"><label class="label" for="f_comment">${tx('dbu.comment')}</label>
          <input id="f_comment" name="comment" value="${spec.comment}" maxlength="1000"></div>
      </div>`)}
      ${region(tx('dbu.member_of'), html`<p class="muted u-mt0">${tx('dbu.member_of_intro')}</p>
        ${options.length ? html`<fieldset class="field"><legend class="sr-only">${tx('dbu.member_of')}</legend><div class="radio-group dbu-members">
          ${options.map((m) => html`<label class="check"><input type="checkbox" name="member" value="${m}"${chk(spec.memberOf.includes(m))}> ${m}</label>`)}
        </div></fieldset>` : html`<p class="muted">${tx('dbu.no_groups')}</p>`}`)}
      ${region(tx('dbu.schemas'), html`<p class="muted u-mt0">${tx.rich('dbu.schemas_intro', { usage: html`<strong>${tx('dbu.col.usage')}</strong>`, create: html`<strong>${tx('dbu.col.create')}</strong>`, future: html`<strong>${tx('dbu.col.future')}</strong>`, existing: html`<strong>${tx('dbu.col.existing')}</strong>` })}</p>
        ${spec.schemas.length ? html`<div class="table-wrap"><table class="report dbu-schemas"><thead><tr><th>${tx('dbu.col.schema')}</th><th class="te-c">${tx('dbu.col.usage')}</th><th class="te-c">${tx('dbu.col.create')}</th><th>${tx('dbu.col.future')}</th><th>${tx('dbu.col.existing')}</th></tr></thead>
        <tbody>${spec.schemas.map((x, i) => html`<tr><td><code>${x.schema}</code><input type="hidden" name="s.${i}.name" value="${x.schema}"></td>
          <td class="te-c"><input type="checkbox" name="s.${i}.usage" value="1" aria-label="${tx('dbu.usage_on', { schema: x.schema })}"${chk(x.usage)}></td>
          <td class="te-c"><input type="checkbox" name="s.${i}.create" value="1" aria-label="${tx('dbu.create_in', { schema: x.schema })}"${chk(x.create)}></td>
          <td><select name="s.${i}.defaults" aria-label="${tx('dbu.future_in', { schema: x.schema })}">${x.defaults === 'custom' ? html`<option value="custom" selected>${tx('dbu.custom')}</option>` : ''}${DEFAULT_LABELS(tx).map(([v, l]) => html`<option value="${v}"${sel(x.defaults === v)}>${l}</option>`)}</select></td>
          <td><select name="s.${i}.existing" aria-label="${tx('dbu.existing_in', { schema: x.schema })}">${EXISTING_LABELS(tx).map(([v, l]) => html`<option value="${v}"${sel((x.existing ?? '') === v)}>${l}</option>`)}</select></td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">${tx('dbu.no_schemas')}</p>`}`)}
      <div class="buttons"><button class="btn btn-hot" name="mode" value="review">${icon('eye')} ${tx('dbu.review')}</button><a class="btn" href="${URL_BASE}">${tx('dbu.cancel')}</a></div>
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
  const tx = tr(s);
  return html`${errorList(o.errors)}${o.output ?? ''}
    ${region(tx('dbu.sql'), stmts.length
      ? html`<p class="muted u-mt0">${tx('dbu.sql_intro')}${spec.password === 'set' ? ` ${tx('dbu.sql_masked')}` : ''}</p>
        <pre class="source dbu-sql" data-code-view="sql" tabindex="0" aria-label="${tx('dbu.generated_sql')}">${maskSql(stmts)}</pre>`
      : html`<p class="muted u-mt0">${tx('dbu.nothing_sql')}</p>`)}
    <form method="post" action="${URL_BASE}/save" class="dbu-form">${csrf(s)}${hiddenSpec(spec, o.isNew)}
      <input type="hidden" name="reviewed" value="${reviewDigest(stmts)}">
      ${spec.password === 'set' ? region(tx('dbu.password'), html`<div class="form-grid">
        <div class="field"><label class="label" for="f_password">${tx('dbu.password')}</label><input id="f_password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></div>
        <div class="field"><label class="label" for="f_confirm">${tx('dbu.confirm_password')}</label><input id="f_confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></div>
      </div><small class="help">${tx('dbu.password_note')}</small>`) : ''}
      <div class="buttons">${stmts.length ? html`<button class="btn btn-hot" name="mode" value="apply">${icon('check')} ${tx('dbu.apply')}</button>` : ''}
        <button class="btn" name="mode" value="edit" formnovalidate>${tx('dbu.back_form')}</button></div>
    </form>`;
}

/** A role's attributes as tags. */
const attrTags = (tx: BuilderTranslate, r: RoleRow) => html`${r.pgkiln ? html`<span class="tag tag-info">pgkiln</span> ` : ''}${r.used_by.length ? html`<span class="tag" title="${r.used_by.join(', ')}">${tx('dbu.tag.in_use')}</span> ` : ''}${
  r.superuser ? html`<span class="tag tag-error">${tx('dbu.tag.superuser')}</span> ` : ''}${r.bypassrls ? html`<span class="tag tag-warning">${tx('dbu.tag.bypassrls')}</span> ` : ''}${
  r.createrole ? html`<span class="tag tag-warning">${tx('dbu.tag.createrole')}</span> ` : ''}${r.createdb ? html`<span class="tag">${tx('dbu.tag.createdb')}</span> ` : ''}${r.replication ? html`<span class="tag">${tx('dbu.tag.replication')}</span>` : ''}`;

const expiry = (tx: BuilderTranslate, r: RoleRow) => r.valid_until === null ? html`<span class="muted">${tx('dbu.never')}</span>` : html`${r.valid_until}${
  r.days_left !== null && r.days_left < 0 ? html` <span class="tag tag-error">${tx('dbu.expired')}</span>` : r.days_left !== null && r.days_left <= 30 ? html` <span class="tag tag-warning">${tx(r.days_left === 1 ? 'dbu.in_days_one' : 'dbu.in_days', { n: r.days_left })}</span>` : ''}`;

const FILTERS: [string, 'dbu.f.all', (r: RoleRow) => boolean][] = ([
  ['', 'dbu.f.all', () => true],
  ['login', 'dbu.f.login', (r) => r.login],
  ['expiring', 'dbu.f.expiring', (r) => r.login && r.days_left !== null && r.days_left >= 0 && r.days_left <= 30],
  ['bypassrls', 'dbu.f.bypassrls', (r) => r.bypassrls],
  ['owners', 'dbu.f.owners', (r) => !r.login && r.owned > 0],
  ['pgkiln', 'dbu.f.pgkiln', (r) => r.pgkiln],
] as [string, string, (r: RoleRow) => boolean][]) as [string, 'dbu.f.all', (r: RoleRow) => boolean][];

async function listPage(req: Req, reply: FastifyReply, s: Session) {
  const roles = await listRoles();
  const f = FILTERS.find(([k]) => k === (req.query.f ?? '')) ?? FILTERS[0];
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
  const shown = roles.filter((r) => f[2](r) && (!q || r.name.toLowerCase().includes(q)));
  const tx = tr(s);
  const main = html`<div class="ide-head-title u-mb1"><div><h1>${tx('dbu.title')}</h1><span class="muted small">${tx('dbu.list_intro')}</span></div>
      <div class="buttons ide-head-actions"><a class="btn btn-hot" href="${URL_BASE}/new">${icon('plus')} ${tx('dbu.create_user')}</a></div></div>
    <nav class="stat-grid u-mb1 dbu-stats" aria-label="${tx('dbu.filters')}">${FILTERS.map(([k, label, fn]) => html`<a class="stat" href="${URL_BASE}${k ? `?f=${k}` : ''}"${k === f[0] ? raw(' aria-current="page"') : ''}><b>${String(roles.filter(fn).length)}</b><span>${tx(label)}</span></a>`)}</nav>
    ${region(tx(f[1]), html`<form method="get" action="${URL_BASE}" class="dbu-search u-mb1" role="search">${f[0] ? html`<input type="hidden" name="f" value="${f[0]}">` : ''}
        <label class="sr-only" for="dbu-q">${tx('dbu.search_roles')}</label><input id="dbu-q" name="q" type="search" value="${q}" placeholder="${tx('dbu.search_roles')}" autocomplete="off"> <button class="btn btn-sm">${icon('search')} ${tx('dbu.search')}</button></form>
      <div class="table-wrap"><table class="report report-reflow dbu-list"><thead><tr><th>${tx('dbu.role')}</th><th>${tx('dbu.sign_in')}</th><th>${tx('dbu.col.attributes')}</th><th class="num">${tx('dbu.col.connections')}</th><th>${tx('dbu.valid_until')}</th><th>${tx('dbu.member_of')}</th><th>${tx('dbu.col.owns')}</th></tr></thead>
      <tbody>${shown.length ? shown.map((r) => html`<tr>
        <td data-label="${tx('dbu.role')}" class="u-break"><a href="${roleUrl(r.name)}"><strong>${r.name}</strong></a>${r.comment ? html`<br><span class="muted small">${r.comment}</span>` : ''}</td>
        <td data-label="${tx('dbu.sign_in')}">${r.login ? tx('dbu.yes') : html`<span class="muted">${tx('dbu.no')}</span>`}</td>
        <td data-label="${tx('dbu.col.attributes')}">${attrTags(tx, r)}</td>
        <td data-label="${tx('dbu.col.connections')}" class="num">${r.conn_limit < 0 ? html`<span class="muted">${tx('dbu.no_limit')}</span>` : String(r.conn_limit)}</td>
        <td data-label="${tx('dbu.valid_until')}">${expiry(tx, r)}</td>
        <td data-label="${tx('dbu.member_of')}" class="u-break">${r.member_of.join(', ')}</td>
        <td data-label="${tx('dbu.col.owns')}" class="u-break">${r.schemas.length ? html`${tx('dbu.owns_schemas', { list: r.schemas.join(', ') })}; ` : ''}${r.owned ? tx(r.owned === 1 ? 'dbu.n_objects_one' : 'dbu.n_objects', { n: r.owned }) : r.schemas.length ? '' : html`<span class="muted">${tx('dbu.nothing')}</span>`}${r.owned_elsewhere ? html` <span class="muted">${tx('dbu.elsewhere', { n: r.owned_elsewhere })}</span>` : ''}</td></tr>`)
        : html`<tr><td colspan="7" class="empty">${tx('dbu.no_roles')}</td></tr>`}</tbody></table></div>
      <p class="muted small">${tx.rich('dbu.list_note', { pgkiln: html`<span class="tag tag-info">pgkiln</span>`, in_use: html`<span class="tag">${tx('dbu.tag.in_use')}</span>` })}</p>`)}`;
  return send(reply, s, shell(s, tx('dbu.title'), crumbs(tx), main, 'users'));
}

const crumbs = (tx: BuilderTranslate, ...more: [string, string?][]): [string, string?][] => [[tx('admin.utilities'), `${BASE}/utilities`], [tx('dbu.title'), more.length ? URL_BASE : undefined], ...more];

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

function detailRegion(tx: BuilderTranslate, r: RoleRow, d: { owned: string[]; members: string[] }) {
  return region(tx('dbu.details'), html`<dl class="dbu-facts">
    <dt>${tx('dbu.col.attributes')}</dt><dd>${r.login ? tx('dbu.f.login') : tx('dbu.no_login')} ${attrTags(tx, r)}</dd>
    <dt>${tx('dbu.valid_until')}</dt><dd>${expiry(tx, r)}</dd>
    <dt>${tx('dbu.conn_limit')}</dt><dd>${r.conn_limit < 0 ? tx('dbu.no_limit') : String(r.conn_limit)}</dd>
    <dt>${tx('dbu.member_of')}</dt><dd class="u-break">${r.member_of.join(', ') || html`<span class="muted">${tx('dbu.none')}</span>`}</dd>
    <dt>${tx('dbu.members')}</dt><dd class="u-break">${d.members.join(', ') || html`<span class="muted">${tx('dbu.none')}</span>`}</dd>
    ${r.used_by.length ? html`<dt>${tx('dbu.used_by')}</dt><dd class="u-break">${r.used_by.join(', ')}</dd>` : ''}
    <dt>${tx('dbu.col.owns')}</dt><dd class="u-break">${d.owned.length ? html`${r.owned > d.owned.length ? `${tx('dbu.owned_first', { n: r.owned, first: d.owned.length })} ` : ''}${d.owned.join(', ')}` : html`<span class="muted">${tx('dbu.nothing_here')}</span>`}${r.owned_elsewhere ? html` <span class="tag tag-warning">${tx('dbu.owned_other', { n: r.owned_elsewhere })}</span>` : ''}</dd>
  </dl>`);
}

/** Can this role be changed here? A message when not. */
const protectedMessage = (tx: BuilderTranslate, r: RoleRow) => r.pgkiln ? tx('dbu.protected', { name: r.name }) : '';

async function rolePage(reply: FastifyReply, s: Session, name: string | null, o: { spec?: RoleSpec; errors?: string[] } = {}) {
  const tx = tr(s);
  const [ctx, schemas, grantable] = await Promise.all([context(), grantSchemas(), grantableRoles()]);
  if (name === null) {
    const spec = o.spec ?? { ...emptyRole(), login: true, schemas: schemas.map((schema) => ({ schema, usage: false, create: false, defaults: 'none' as DefaultPriv })) };
    const main = html`<h1 class="u-mb1">${tx('dbu.create_user')}</h1>${roleForm(s, spec, { isNew: true, before: null, grantable, errors: o.errors ?? [] })}`;
    return send(reply, s, shell(s, tx('dbu.create_user'), crumbs(tx, [tx('dbu.crumb.create')]), main, 'users'));
  }
  const r = await oneRole(name);
  if (!r) return reply.code(404).send('Not found');
  const d = await details(r);
  const msg = protectedMessage(tx, r);
  const before = msg ? null : await readSpec(r, schemas, ctx.creator);
  const main = html`<div class="ide-head-title u-mb1"><div><h1 class="u-break">${tx('dbu.role_title', { name: r.name })}</h1>${r.comment ? html`<span class="muted small">${r.comment}</span>` : ''}</div>
      ${msg || r.used_by.length ? '' : html`<div class="buttons ide-head-actions"><a class="btn btn-danger" href="${roleUrl(r.name)}/drop">${icon('trash')} ${tx('dbu.drop_role_link')}</a></div>`}</div>
    ${msg ? html`<div class="alert alert-info" role="status">${msg}</div>` : ''}
    ${!msg && r.used_by.length ? html`<div class="alert alert-info" role="status">${tx(r.used_by.length === 1 ? 'dbu.used_change_only_one' : 'dbu.used_change_only', { users: r.used_by.join(', ') })}</div>` : ''}
    ${detailRegion(tx, r, d)}
    ${before ? roleForm(s, o.spec ?? before, { isNew: false, before, grantable, errors: o.errors ?? [] }) : ''}`;
  return send(reply, s, shell(s, tx('dbu.role_title', { name: r.name }), crumbs(tx, [r.name]), main, 'users'));
}

async function save(req: Req, reply: FastifyReply, s: Session) {
  const b = req.body ?? {};
  const tx = tr(s);
  const original = one(b.original);
  const isNew = !original;
  const [ctx, schemas, grantable] = await Promise.all([context(), grantSchemas(), grantableRoles()]);
  const r = isNew ? null : await oneRole(original);
  if (!isNew && !r) return reply.code(404).send('Not found');
  if (r && r.pgkiln) {
    const main = html`<h1 class="u-mb1">${tx('dbu.role_title', { name: r.name })}</h1><div class="alert alert-error" role="alert">${protectedMessage(tx, r)}</div>`;
    return send(reply.code(403), s, shell(s, tx('dbu.role_title', { name: r.name }), crumbs(tx, [r.name]), main, 'users'));
  }
  const before = r ? await readSpec(r, schemas, ctx.creator) : null;
  const spec = specFromBody(b, isNew, original);
  const mode = one(b.mode);
  if (mode === 'edit') return rolePage(reply, s, isNew ? null : original, { spec });
  const errors = checkRole(spec, { isNew, grantable, schemas, before });
  if (isNew && !errors.length && (await owner.one('select 1 from pg_roles where lower(rolname) = lower($1)', [spec.name]))) errors.push(tx('dbu.exists', { name: spec.name }));
  if (errors.length) return rolePage(reply, s, isNew ? null : original, { spec, errors });
  const stmts = roleSql(before, spec, ctx);
  const title = isNew ? tx('dbu.create_title', { name: spec.name }) : tx('dbu.change_title', { name: spec.name });
  const page = (errs: string[], output: Raw | '' = '') => {
    const main = html`<h1 class="u-mb1 u-break">${title}</h1>${reviewForm(s, spec, stmts, { isNew, errors: errs, output })}`;
    const trail: [string, string?][] = isNew ? [[tx('dbu.crumb.create'), `${URL_BASE}/new`], [tx('dbu.crumb.review')]] : [[spec.name, roleUrl(spec.name)], [tx('dbu.crumb.review')]];
    return send(reply.code(errs.length || output ? 422 : 200), s, shell(s, title, crumbs(tx, ...trail), main, 'users'));
  };
  if (mode !== 'apply') return page([]);
  // Apply runs exactly what the review showed: a change in the form or the catalog since then shows the review again
  if (one(b.reviewed) !== reviewDigest(stmts)) return page([tx('dbu.changed_since')]);
  if (!stmts.length) return page([tx('dbu.nothing_change')]);
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
    return page([], html`<div class="alert alert-error" role="alert"><p>${tx.rich('dbu.rolled_back', { nothing: html`<strong>${tx('dbu.nothing_changed')}</strong>` })}</p><p>${failed}</p>${at >= 0 ? html`<pre class="source">${maskSql([stmts[at]])}</pre>` : ''}</div>`);
  }
  flash(s, tx(isNew ? (stmts.length === 1 ? 'dbu.created_one' : 'dbu.created') : (stmts.length === 1 ? 'dbu.changed_one' : 'dbu.changed'), { name: spec.name, n: stmts.length }));
  return back(reply, s, isNew ? URL_BASE : roleUrl(spec.name));
}

/** Roles another role's objects can be given to. */
const reassignTargets = async (name: string) =>
  (await owner.query<{ n: string }>(`select rolname as n from pg_roles where rolname !~ '^pg_' and rolname <> $1 order by rolname <> current_user, lower(rolname)`, [name])).rows.map((x) => x.n);

async function dropPage(req: Req, reply: FastifyReply, s: Session, name: string, o: { to?: string; errors?: string[]; output?: Raw | '' } = {}) {
  const r = await oneRole(name);
  if (!r) return reply.code(404).send('Not found');
  const tx = tr(s);
  const refusal = r.pgkiln ? protectedMessage(tx, r) : r.used_by.length ? tx(r.used_by.length === 1 ? 'dbu.drop_refused_one' : 'dbu.drop_refused', { users: r.used_by.join(', '), name: r.name }) : '';
  const d = await details(r);
  const targets = await reassignTargets(name);
  const to = o.to !== undefined && (o.to === '' || targets.includes(o.to)) ? o.to : r.owned ? targets[0] ?? '' : '';
  const stmts = dropSql(r.name, to || null);
  const main = html`<h1 class="u-mb1 u-break">${tx('dbu.drop_title', { name: r.name })}</h1>
    ${refusal ? html`<div class="alert alert-error" role="alert">${refusal}</div>` : ''}${errorList(o.errors ?? [])}${o.output ?? ''}
    ${detailRegion(tx, r, d)}
    ${refusal ? '' : html`
    ${r.owned || r.owned_elsewhere ? html`<div class="alert alert-error" role="alert"><p><strong>${tx(r.owned === 1 ? 'dbu.owns_here_one' : 'dbu.owns_here', { name: r.name, n: r.owned })}${r.owned_elsewhere ? ` ${tx('dbu.owns_elsewhere', { n: r.owned_elsewhere })}` : ''}.</strong>
      ${tx('dbu.reassign_note')}${r.owned_elsewhere ? ` ${tx('dbu.elsewhere_note')}` : ''}</p></div>` : ''}
    ${region(tx('dbu.owned_objects'), html`<form method="get" action="${roleUrl(r.name)}/drop" class="form-grid">
        <div class="field"><label class="label" for="f_to">${tx('dbu.objects_it_owns')}</label><select id="f_to" name="to">
          ${targets.map((t) => html`<option value="${t}"${sel(t === to)}>${tx('dbu.reassign_to', { name: t })}</option>`)}
          <option value=""${sel(to === '')}>${r.owned ? tx('dbu.drop_owned') : tx('dbu.owns_nothing')}</option></select>
          <small class="help">${tx('dbu.drop_owned_help')}</small></div>
        <div class="buttons"><button class="btn">${icon('eye')} ${tx('dbu.review')}</button></div></form>`)}
    ${region(tx('dbu.sql'), html`<pre class="source dbu-sql" data-code-view="sql" tabindex="0" aria-label="${tx('dbu.generated_sql')}">${maskSql(stmts)}</pre>
      <form method="post" action="${URL_BASE}/drop" class="dbu-form">${csrf(s)}
        <input type="hidden" name="name" value="${r.name}"><input type="hidden" name="to" value="${to}"><input type="hidden" name="reviewed" value="${reviewDigest(stmts)}">
        ${!to && r.owned ? html`<label class="check u-mb1"><input type="checkbox" name="drop_objects" value="1" required> ${tx(r.owned === 1 ? 'dbu.drop_objects_one' : 'dbu.drop_objects', { n: r.owned, name: r.name })}</label>` : ''}
        <div class="buttons"><button class="btn btn-danger" data-confirm="${tx('dbu.drop_confirm', { name: r.name })}">${icon('trash')} ${tx('dbu.drop_btn')}</button><a class="btn" href="${roleUrl(r.name)}">${tx('dbu.cancel')}</a></div></form>`)}`}`;
  return send(reply.code(refusal ? 403 : o.errors?.length || o.output ? 422 : 200), s, shell(s, tx('dbu.drop_title', { name: r.name }), crumbs(tx, [r.name, roleUrl(r.name)], [tx('dbu.crumb.drop')]), main, 'users'));
}

async function drop(req: Req, reply: FastifyReply, s: Session) {
  const b = req.body ?? {};
  const tx = tr(s);
  const name = one(b.name);
  const to = one(b.to);
  const r = await oneRole(name);
  if (!r) return reply.code(404).send('Not found');
  if (r.pgkiln || r.used_by.length) return dropPage(req, reply, s, name, { to });
  const targets = await reassignTargets(name);
  if (to && !targets.includes(to)) return dropPage(req, reply, s, name, { errors: [tx('dbu.choose_target')] });
  const stmts = dropSql(r.name, to || null);
  if (one(b.reviewed) !== reviewDigest(stmts)) return dropPage(req, reply, s, name, { to, errors: [tx('dbu.changed_since_drop')] });
  if (!to && r.owned && !b.drop_objects) return dropPage(req, reply, s, name, { to, errors: [tx('dbu.tick_box', { name: r.name })] });
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
  if (failed) return dropPage(req, reply, s, name, { to, output: html`<div class="alert alert-error" role="alert"><p>${tx.rich('dbu.rolled_back', { nothing: html`<strong>${tx('dbu.nothing_changed')}</strong>` })}</p><p>${failed}</p></div>` });
  flash(s, tx('dbu.dropped', { name: r.name }));
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
