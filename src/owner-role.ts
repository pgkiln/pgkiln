// (sprint 232) pgkiln's database owner without SUPERUSER.
//
// DATABASE_URL (the owner connection: migrations, the builder) should not be a superuser: as one, migrations, the
// builder and an administrator's Owner connection could read files on the server, run programs and change every
// database of the PostgreSQL server (Instance settings → Lockout checks, "DATABASE_URL is a superuser"). This module,
// run on a *superuser* connection, makes the owner a role with LOGIN CREATEROLE NOSUPERUSER and does once what only a
// superuser can:
//
//   - creates the owner role (or takes the superuser attribute from it) and makes it own the database;
//   - moves every object of the old owner (the owner of schema meta, when that is another role) to it, object by
//     object: REASSIGN OWNED can't be used when the old owner is the bootstrap superuser (it owns the system
//     catalogs), which it is in the Docker image's bundled database of pgkiln 0.111.0 and older;
//   - (PostgreSQL 16+) gives it ADMIN OPTION on pgkiln's roles (its own, the workspaces' logins, the applications'
//     roles, the masking roles): a CREATEROLE role may only change, grant and set the password of those; and
//     re-records role memberships the old owner (or a superuser) granted in those roles as granted by the new owner,
//     so that it can revoke them later;
//   - repeats the old owner's default privileges (ALTER DEFAULT PRIVILEGES) for the new one;
//   - moves pg_cron jobs that ran as the old owner to the new one, creates pg_cron (and pg_stat_statements, when the
//     server loads them) and the extensions of PGKILN_EXTENSIONS, and grants the owner what Scheduling, Top SQL and
//     Sessions need;
//   - takes SUPERUSER (and LOGIN) from the old owner, unless it is the bootstrap superuser or the connection's own
//     role.
//
// planOwner() lists the statements (a dry run prints them); applyOwner() runs them in one transaction and checks the
// result before committing: it refuses (rolls back) when pgkiln would be locked out. Running it again changes
// nothing. Used by scripts/docker-start.ts (SUPERUSER_DATABASE_URL) and `pgkiln admin demote-owner`.
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import pg from 'pg';

export interface OwnerStep {
  sql: string;
  /** shown instead of sql (the password is left out) */
  shown?: string;
  why: string;
}

export interface OwnerPlan {
  owner: string;
  /** the role that owned schema meta before, when it isn't the owner */
  oldOwner: string | null;
  steps: OwnerStep[];
  /** reasons the plan can't be applied */
  problems: string[];
  /** what stays as it is, for the log */
  notes: string[];
}

export interface OwnerOptions {
  /** the role DATABASE_URL signs in as */
  owner: string;
  /** its password (from DATABASE_URL): set when given */
  password?: string | null;
  /** extensions to create as the superuser (PGKILN_EXTENSIONS), when the server has them */
  extensions?: string[];
  /**
   * only the role (SUPERUSER for now), its password and the database: for a migration run that needs a superuser
   * (installing: see needsSuperuser); the plan without it takes SUPERUSER away again afterwards
   */
  elevated?: boolean;
}

type Q = Pick<pg.Client, 'query'>;
const id = (s: string) => pg.escapeIdentifier(s);
const lit = (s: string) => pg.escapeLiteral(s);

/** The roles pgkiln makes and manages, other than the owner (a CREATEROLE owner needs ADMIN OPTION on them). */
const pgkilnRolesSql = (meta: boolean) => `
  select r.rolname from pg_roles r
   where not r.rolsuper and r.oid <> 10 and r.rolname !~ '^pg_' and r.rolname <> $1 and r.rolname <> session_user
     and (r.rolname in ('pgkiln_runtime', 'pgkiln_app_code', 'pgkiln_authenticator', 'pgkiln_anon')
          or r.rolname ~ '^pgkiln_ws[0-9]+_(run|dev)_'
          or r.rolname ~ '_masking$'
          ${meta ? `or r.rolname in (select db_role from meta.app where db_role is not null)
          or r.rolname in (select role_name from meta.workspace_role)` : ''})`;
const hasMeta = async (c: Q) => (await c.query(`select to_regclass('meta.workspace_role') is not null and to_regclass('meta.app') is not null as ok`)).rows[0].ok as boolean;

const SYSTEM_SCHEMA = `(n.nspname ~ '^pg_' or n.nspname = 'information_schema')`;
const IN_EXTENSION = (cls: string, oid: string) =>
  `exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;

/** The statements that make `o.owner` pgkiln's owner without SUPERUSER, on a superuser connection `c`. */
export async function planOwner(c: Q, o: OwnerOptions): Promise<OwnerPlan> {
  const steps: OwnerStep[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const X = o.owner;
  const plan: OwnerPlan = { owner: X, oldOwner: null, steps, problems, notes };
  const me = (await c.query(`select session_user as name, (select rolsuper from pg_roles where rolname = session_user) as superuser,
                                    current_database() as db, current_setting('server_version_num')::int as version`)).rows[0];
  if (!me.superuser) {
    problems.push(`${me.name} is not a superuser: making pgkiln's owner needs a superuser connection`);
    return plan;
  }
  if (X === me.name) {
    problems.push(`DATABASE_URL and the superuser connection both sign in as ${X}: pgkiln's owner needs a role of its own (e.g. pgkiln_owner)`);
    return plan;
  }
  const pg16 = me.version >= 160000;
  const role = (await c.query(`select oid, rolsuper, rolcanlogin, rolcreaterole, rolbypassrls, rolreplication from pg_roles where rolname = $1`, [X])).rows[0];
  if (role?.oid === 10) {
    problems.push(`${X} is the server's bootstrap superuser, which can't lose SUPERUSER: point DATABASE_URL at another role (e.g. pgkiln_owner); this moves pgkiln's objects to it`);
    return plan;
  }
  const pw = o.password ? ` password ${lit(o.password)}` : '';
  const pwShown = o.password ? ' password …' : '';
  const sup = o.elevated ? ' superuser' : '';
  if (!role) {
    steps.push({ sql: `create role ${id(X)} login createrole${sup}${pw}`, shown: `create role ${id(X)} login createrole${sup}${pwShown}`, why: o.elevated ? 'the owner role (a superuser while it installs pgkiln)' : 'the owner role' });
  } else {
    if (o.elevated) {
      if (!role.rolsuper || !role.rolcanlogin) steps.push({ sql: `alter role ${id(X)} login superuser`, why: 'the owner is a superuser while it runs these migrations' });
    } else if (role.rolsuper || !role.rolcanlogin || !role.rolcreaterole || role.rolbypassrls || role.rolreplication)
      steps.push({ sql: `alter role ${id(X)} login createrole nosuperuser nobypassrls noreplication`, why: role.rolsuper ? 'the owner is no superuser' : 'the owner signs in and creates roles' });
    if (o.password && !(await passwordMatches(c, X, o.password))) steps.push({ sql: `alter role ${id(X)}${pw}`, shown: `alter role ${id(X)}${pwShown}`, why: 'the password of DATABASE_URL' });
  }
  // (16+) roles the owner creates later: it may SET ROLE to them (create schema … authorization, alter … owner to)
  if (pg16) {
    const set = (await c.query(`select coalesce((select array_to_string(s.setconfig, ',') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                                                  where r.rolname = $1 and s.setdatabase = 0), '') ~ 'createrole_self_grant=set' as ok`, [X])).rows[0].ok;
    if (!set) steps.push({ sql: `alter role ${id(X)} set createrole_self_grant = 'set'`, why: 'it may switch to the roles it creates (application roles, schemas owned by them)' });
  }

  const db = (await c.query(`select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()`)).rows[0];
  if (db.owner !== X) steps.push({ sql: `alter database ${id(me.db)} owner to ${id(X)}`, why: `the owner owns the database (was ${db.owner})` });
  if (o.elevated) return plan;

  // the old owner: the owner of schema meta (absent in a new database)
  const meta = (await c.query(`select pg_get_userbyid(nspowner) as owner, nspowner = 10 as bootstrap from pg_namespace where nspname = 'meta'`)).rows[0];
  const Y: string | null = meta && meta.owner !== X ? meta.owner : null;
  plan.oldOwner = Y;
  if (Y) {
    const to = ` owner to ${id(X)}`;
    const add = (rows: { sql: string }[], why: string) => rows.forEach((r) => steps.push({ sql: r.sql + to, why }));
    add((await c.query(`select format('alter schema %I', n.nspname) as sql from pg_namespace n
                          where n.nspowner = $1::regrole and not ${SYSTEM_SCHEMA} and not ${IN_EXTENSION('pg_namespace', 'n.oid')}
                          order by n.nspname = 'meta' desc, n.nspname`, [Y])).rows, `schemas of ${Y}`);
    // tables, views, sequences (not those of a serial or identity column: they follow their table)
    add((await c.query(`select format('alter %s %I.%I', case k.relkind when 'v' then 'view' when 'm' then 'materialized view'
                                       when 'f' then 'foreign table' when 'S' then 'sequence' when 'c' then 'type' else 'table' end, n.nspname, k.relname) as sql
                          from pg_class k join pg_namespace n on n.oid = k.relnamespace
                         where k.relowner = $1::regrole and k.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c') and not ${SYSTEM_SCHEMA}
                           and not ${IN_EXTENSION('pg_class', 'k.oid')}
                           and not (k.relkind = 'S' and exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = k.oid
                                                                  and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')))
                         order by n.nspname, k.relkind, k.relname`, [Y])).rows, `tables, views and sequences of ${Y}`);
    add((await c.query(`select case p.prokind when 'p' then format('alter procedure %s', p.oid::regprocedure)
                                              when 'a' then format('alter aggregate %I.%I(%s)', n.nspname, p.proname, coalesce(nullif(pg_get_function_identity_arguments(p.oid), ''), '*'))
                                              else format('alter function %s', p.oid::regprocedure) end as sql
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where p.proowner = $1::regrole and not ${SYSTEM_SCHEMA} and not ${IN_EXTENSION('pg_proc', 'p.oid')}
                         order by n.nspname, p.proname, p.oid`, [Y])).rows, `functions and procedures of ${Y}`);
    // domains, enums, ranges, base types (not row types of tables, arrays or multiranges: they follow)
    add((await c.query(`select format('alter %s %I.%I', case t.typtype when 'd' then 'domain' else 'type' end, n.nspname, t.typname) as sql
                          from pg_type t join pg_namespace n on n.oid = t.typnamespace
                         where t.typowner = $1::regrole and t.typtype in ('d', 'e', 'r', 'b') and not ${SYSTEM_SCHEMA}
                           and not (t.typcategory = 'A' and t.typelem <> 0) and not ${IN_EXTENSION('pg_type', 't.oid')}
                         order by n.nspname, t.typname`, [Y])).rows, `types and domains of ${Y}`);
    add((await c.query(`select format('alter statistics %I.%I', n.nspname, s.stxname) as sql from pg_statistic_ext s join pg_namespace n on n.oid = s.stxnamespace
                         where s.stxowner = $1::regrole`, [Y])).rows, `statistics objects of ${Y}`);
    add((await c.query(`select format('alter collation %I.%I', n.nspname, k.collname) as sql from pg_collation k join pg_namespace n on n.oid = k.collnamespace
                         where k.collowner = $1::regrole and not ${SYSTEM_SCHEMA} and not ${IN_EXTENSION('pg_collation', 'k.oid')}`, [Y])).rows, `collations of ${Y}`);
    add((await c.query(`select format('alter text search configuration %I.%I', n.nspname, k.cfgname) as sql from pg_ts_config k join pg_namespace n on n.oid = k.cfgnamespace
                         where k.cfgowner = $1::regrole and not ${SYSTEM_SCHEMA} and not ${IN_EXTENSION('pg_ts_config', 'k.oid')}`, [Y])).rows, `text search configurations of ${Y}`);
    add((await c.query(`select format('alter text search dictionary %I.%I', n.nspname, k.dictname) as sql from pg_ts_dict k join pg_namespace n on n.oid = k.dictnamespace
                         where k.dictowner = $1::regrole and not ${SYSTEM_SCHEMA} and not ${IN_EXTENSION('pg_ts_dict', 'k.oid')}`, [Y])).rows, `text search dictionaries of ${Y}`);
    add((await c.query(`select format('alter server %I', srvname) as sql from pg_foreign_server where srvowner = $1::regrole`, [Y])).rows, `foreign servers of ${Y} (Remote databases)`);
    add((await c.query(`select format('alter large object %s', oid) as sql from pg_largeobject_metadata where lomowner = $1::regrole`, [Y])).rows, `large objects of ${Y}`);
    const evt = (await c.query(`select count(*)::int as n from pg_event_trigger where evtowner = $1::regrole`, [Y])).rows[0].n;
    if (evt) notes.push(`${evt} event trigger(s) stay ${Y}'s: an event trigger belongs to a superuser`);

    // default privileges: the old owner's, repeated for the new one (its own privileges and PUBLIC's defaults aside)
    const acl = (await c.query<{ schema: string | null; objtype: string; grantee: string | null; privs: string[]; grantable: boolean[] }>(
      `select case when d.defaclnamespace = 0 then null else d.defaclnamespace::regnamespace::text end as schema, d.defaclobjtype as objtype,
              case when a.grantee = 0 then null else pg_get_userbyid(a.grantee) end as grantee,
              array_agg(a.privilege_type order by a.privilege_type) as privs, array_agg(a.is_grantable order by a.privilege_type) as grantable
         from pg_default_acl d, aclexplode(d.defaclacl) a
        where d.defaclrole = $1::regrole and a.grantee <> d.defaclrole
        group by 1, 2, 3 order by 1 nulls first, 2, 3`, [Y])).rows;
    const kinds: Record<string, string> = { r: 'tables', S: 'sequences', f: 'functions', T: 'types', n: 'schemas' };
    for (const a of acl) {
      if (!kinds[a.objtype]) continue;
      const already = (await c.query(
        `select exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) x
                         where d.defaclrole = $1::regrole and d.defaclobjtype = $2
                           and d.defaclnamespace = coalesce(to_regnamespace($3), 0) and x.grantee = coalesce($4::regrole, 0)
                         group by d.oid having array_agg(x.privilege_type::text order by x.privilege_type) = $5::text[]) as ok`,
        [X, a.objtype, a.schema, a.grantee, a.privs])).rows[0].ok;
      if (already) continue;
      const plain = a.privs.filter((_, i) => !a.grantable[i]);
      const withGrant = a.privs.filter((_, i) => a.grantable[i]);
      const head = `alter default privileges for role ${id(X)}${a.schema ? ` in schema ${id(a.schema)}` : ''}`;
      const who = a.grantee ? id(a.grantee) : 'public';
      if (plain.length) steps.push({ sql: `${head} grant ${plain.join(', ')} on ${kinds[a.objtype]} to ${who}`, why: `default privileges of ${Y}` });
      if (withGrant.length) steps.push({ sql: `${head} grant ${withGrant.join(', ')} on ${kinds[a.objtype]} to ${who} with grant option`, why: `default privileges of ${Y}` });
    }
    // a global entry without PUBLIC's EXECUTE on functions or USAGE on types revoked it
    for (const g of (await c.query<{ objtype: string }>(
      `select d.defaclobjtype as objtype from pg_default_acl d where d.defaclrole = $1::regrole and d.defaclnamespace = 0 and d.defaclobjtype in ('f', 'T')
          and not exists (select 1 from aclexplode(d.defaclacl) a where a.grantee = 0)`, [Y])).rows) {
      const done = (await c.query(`select exists (select 1 from pg_default_acl d where d.defaclrole = $1::regrole and d.defaclnamespace = 0 and d.defaclobjtype = $2
                                     and not exists (select 1 from aclexplode(d.defaclacl) a where a.grantee = 0)) as ok`, [X, g.objtype])).rows[0].ok;
      if (!done) steps.push({ sql: `alter default privileges for role ${id(X)} revoke ${g.objtype === 'f' ? 'execute on functions' : 'usage on types'} from public`, why: `default privileges of ${Y}` });
    }
  }

  // (16+) ADMIN OPTION on pgkiln's roles, and memberships in them granted by the owner
  if (pg16) {
    const roles = (await c.query<{ rolname: string; admin: boolean; set: boolean }>(
      `select x.rolname,
              exists (select 1 from pg_auth_members m where m.roleid = x.rolname::regrole and m.member = (select oid from pg_roles where rolname = $1) and m.admin_option) as admin,
              exists (select 1 from pg_auth_members m where m.roleid = x.rolname::regrole and m.member = (select oid from pg_roles where rolname = $1) and m.set_option) as set
         from (${pgkilnRolesSql(await hasMeta(c))}) x order by 1`, [X])).rows;
    for (const r of roles) {
      if (r.admin && r.set) continue;
      steps.push({ sql: `grant ${id(r.rolname)} to ${id(X)} with admin option, inherit false, set true`, why: 'the owner manages pgkiln\'s roles (PostgreSQL 16+)' });
    }
    // memberships in those roles that another role granted: granted again by the owner, so that it can revoke them
    const names = roles.map((r) => r.rolname);
    if (names.length) {
      const m = (await c.query<{ role: string; member: string; grantor: string; admin: boolean; inherit: boolean; set: boolean }>(
        `select pg_get_userbyid(m.roleid) as role, pg_get_userbyid(m.member) as member, pg_get_userbyid(m.grantor) as grantor,
                m.admin_option as admin, m.inherit_option as inherit, m.set_option as set
           from pg_auth_members m
          where pg_get_userbyid(m.roleid) = any($1) and pg_get_userbyid(m.member) <> $2 and pg_get_userbyid(m.grantor) <> $2
            and not (select rolsuper from pg_roles where oid = m.member)
            and not exists (select 1 from pg_auth_members o where o.roleid = m.roleid and o.member = m.member and pg_get_userbyid(o.grantor) = $2)
          order by 1, 2`, [names, X])).rows;
      for (const g of m) {
        steps.push({ sql: `grant ${id(g.role)} to ${id(g.member)} with admin ${g.admin}, inherit ${g.inherit}, set ${g.set} granted by ${id(X)}`, why: `membership granted by ${g.grantor}, now by the owner` });
        steps.push({ sql: `revoke ${id(g.role)} from ${id(g.member)} granted by ${id(g.grantor)}`, why: `membership granted by ${g.grantor}, now by the owner` });
      }
    }
  }

  // Scheduling (pg_cron), Top SQL (pg_stat_statements), Sessions: what a superuser had without asking
  const cron = (await c.query(
    `select exists (select 1 from pg_available_extensions where name = 'pg_cron') as available,
            exists (select 1 from pg_extension where extname = 'pg_cron') as created,
            current_setting('shared_preload_libraries') ~ '(^|[\\s,])"?pg_cron"?($|[\\s,])' as loaded,
            coalesce(current_setting('cron.database_name', true), 'postgres') = current_database() as here,
            exists (select 1 from pg_available_extensions where name = 'pg_stat_statements') as pss_available,
            exists (select 1 from pg_extension where extname = 'pg_stat_statements') as pss_created,
            current_setting('shared_preload_libraries') ~ '(^|[\\s,])"?pg_stat_statements"?($|[\\s,])' as pss_loaded`)).rows[0];
  const cronThere = cron.created || (cron.available && cron.loaded && cron.here);
  if (!cron.created && cronThere) steps.push({ sql: 'create extension if not exists pg_cron', why: 'SQL Workshop › Scheduling (pg_cron is not a trusted extension)' });
  if (cronThere) {
    // explicit grants, not has_schema_privilege: a superuser (the owner while it installs) has every privilege
    const usage = !!role && cron.created && (await c.query(
      `select exists (select 1 from pg_namespace n where n.nspname = 'cron'
                        and (n.nspowner = $1::regrole or exists (select 1 from aclexplode(n.nspacl) a where a.grantee = $1::regrole and a.privilege_type = 'USAGE'))) as ok`, [X])).rows[0].ok;
    if (!usage) steps.push({ sql: `grant usage on schema cron to ${id(X)}`, why: 'Scheduling: the owner schedules jobs' });
    if (Y && cron.created) {
      const jobs = (await c.query(`select count(*)::int as n from cron.job where username = $1`, [Y])).rows[0].n;
      if (jobs) {
        steps.push({ sql: `update cron.job set username = ${lit(X)} where username = ${lit(Y)}`, why: `${jobs} pg_cron job(s) of ${Y} run as the owner now` });
        steps.push({ sql: `update cron.job_run_details set username = ${lit(X)} where username = ${lit(Y)}`, why: 'and their runs are shown to it' });
      }
    }
  }
  if (!cron.pss_created && cron.pss_available && cron.pss_loaded) steps.push({ sql: 'create extension if not exists pg_stat_statements', why: 'Top SQL' });
  if (cron.pss_created || (cron.pss_available && cron.pss_loaded)) {
    const resets = cron.pss_created
      ? (await c.query(`select p.oid::regprocedure::text as f from pg_proc p where p.proname = 'pg_stat_statements_reset'
                           and ($1::text is null or not (p.proowner = $1::regrole
                                or exists (select 1 from aclexplode(p.proacl) a where a.grantee = $1::regrole and a.privilege_type = 'EXECUTE')))`, [role ? X : null])).rows
      : [];
    for (const r of resets) steps.push({ sql: `grant execute on function ${r.f} to ${id(X)}`, why: 'Top SQL: Reset the statistics' });
    // created in this plan: the function's signature isn't known yet
    if (!cron.pss_created) steps.push({ sql: `do $g$ declare f regprocedure; begin for f in select oid from pg_proc where proname = 'pg_stat_statements_reset' loop execute format('grant execute on function %s to ${id(X).replace(/'/g, "''")}', f); end loop; end $g$`, why: 'Top SQL: Reset the statistics' });
  }
  for (const r of ['pg_read_all_stats', 'pg_signal_backend']) {
    const has = role && (await c.query(`select exists (select 1 from pg_auth_members where roleid = $2::regrole and member = $1::regrole) as ok`, [X, r])).rows[0].ok;
    if (!has) steps.push({ sql: `grant ${r} to ${id(X)}`, why: r === 'pg_read_all_stats' ? 'Top SQL and Sessions: other roles\' statements' : 'Sessions: end an application\'s session' });
  }
  for (const e of o.extensions ?? []) {
    const x = (await c.query(`select exists (select 1 from pg_available_extensions where name = $1) as available, exists (select 1 from pg_extension where extname = $1) as created`, [e])).rows[0];
    if (x.created) continue;
    if (!x.available) notes.push(`PGKILN_EXTENSIONS: ${e} is not installed on the database server`);
    else steps.push({ sql: `create extension if not exists ${id(e)}`, why: 'PGKILN_EXTENSIONS' });
  }

  // the old owner keeps no power
  if (Y) {
    const old = (await c.query(`select oid, rolsuper, rolcanlogin from pg_roles where rolname = $1`, [Y])).rows[0];
    if (old.oid === 10 || Y === me.name) notes.push(`${Y} stays a superuser: it is ${old.oid === 10 ? 'the server\'s bootstrap superuser' : 'the superuser connection\'s role'}; keep its password out of pgkiln's settings`);
    else if (old.rolsuper || old.rolcanlogin) steps.push({ sql: `alter role ${id(Y)} nosuperuser nologin`, why: `the old owner ${Y} keeps no power (drop it later: drop owned by ${Y}; drop role ${Y})` });
  }
  return plan;
}

/** Whether the role signs in with this password already (SCRAM-SHA-256 or MD5, read from pg_authid). */
async function passwordMatches(c: Q, role: string, password: string): Promise<boolean> {
  const stored: string | null = (await c.query(`select rolpassword from pg_authid where rolname = $1`, [role])).rows[0]?.rolpassword ?? null;
  if (!stored) return false;
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(stored);
  if (m) {
    // RFC 5802/7677: StoredKey = H(HMAC(SaltedPassword, "Client Key")); PostgreSQL uses the password as is (SASLprep
    // only changes non-ASCII input: such a password is simply set again)
    const salted = pbkdf2Sync(password, Buffer.from(m[2], 'base64'), Number(m[1]), 32, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    return createHash('sha256').update(clientKey).digest('base64') === m[3];
  }
  if (stored.startsWith('md5')) return stored === `md5${createHash('md5').update(password + role).digest('hex')}`;
  return false;
}

/** What would lock pgkiln out after the plan, checked inside its transaction: empty when all is well. */
export async function ownerProblems(c: Q, owner: string, elevated = false): Promise<string[]> {
  const out: string[] = [];
  const r = (await c.query(
    `select r.rolcanlogin as login, r.rolsuper as super, r.rolcreaterole as createrole, a.rolpassword is not null as password,
            (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) as db_owner,
            (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'meta') as meta_owner,
            (select count(*)::int from pg_class k join pg_namespace n on n.oid = k.relnamespace
              where n.nspname = 'meta' and k.relkind in ('r', 'p', 'v', 'm', 'S') and k.relowner <> r.oid) as foreign_meta,
            current_setting('server_version_num')::int >= 160000 as pg16
       from pg_roles r join pg_authid a on a.oid = r.oid where r.rolname = $1`, [owner])).rows[0];
  if (!r) return [`the role ${owner} doesn't exist`];
  if (!r.login) out.push(`${owner} can't sign in`);
  if (r.super && !elevated) out.push(`${owner} is still a superuser`);
  if (!r.createrole) out.push(`${owner} can't create roles`);
  if (!r.password) out.push(`${owner} has no password`);
  if (r.db_owner !== owner) out.push(`the database belongs to ${r.db_owner}, not ${owner}`);
  if (r.meta_owner && r.meta_owner !== owner) out.push(`schema meta belongs to ${r.meta_owner}, not ${owner}`);
  if (r.foreign_meta) out.push(`${r.foreign_meta} of meta's tables don't belong to ${owner}`);
  if (r.pg16 && r.meta_owner && !elevated) {
    const missing = (await c.query(`select x.rolname from (${pgkilnRolesSql(await hasMeta(c))}) x
                                     where not exists (select 1 from pg_auth_members m where m.roleid = x.rolname::regrole and m.member = $1::text::regrole and m.admin_option)
                                     order by 1 limit 5`, [owner])).rows.map((x) => x.rolname);
    if (missing.length) out.push(`${owner} has no ADMIN OPTION on ${missing.join(', ')}`);
  }
  return out;
}

/** Run the plan in one transaction; rolls back and throws when pgkiln would be locked out. */
export async function applyOwner(c: Q, plan: OwnerPlan, elevated = false): Promise<void> {
  if (plan.problems.length) throw new Error(plan.problems.join('; '));
  if (!plan.steps.length) return;
  await c.query('begin');
  try {
    for (const s of plan.steps) {
      try {
        await c.query(s.sql);
      } catch (e) {
        throw new Error(`${s.shown ?? s.sql}: ${(e as Error).message}`);
      }
    }
    const problems = await ownerProblems(c, plan.owner, elevated);
    if (problems.length) throw new Error(`nothing changed, pgkiln would be locked out: ${problems.join('; ')}`);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  }
}

/** The plan as lines for a log or a dry run; brief: a group of more than five statements as their count. */
export function describePlan(plan: OwnerPlan, o: { brief?: boolean } = {}): string[] {
  const lines: string[] = [];
  const groups: { why: string; sql: string[] }[] = [];
  for (const s of plan.steps) {
    if (groups.at(-1)?.why !== s.why) groups.push({ why: s.why, sql: [] });
    groups.at(-1)!.sql.push(`${s.shown ?? s.sql};`);
  }
  for (const g of groups) {
    if (o.brief && g.sql.length > 5) lines.push(`-- ${g.why}: ${g.sql.length} statements`);
    else lines.push(`-- ${g.why}`, ...g.sql);
  }
  for (const n of plan.notes) lines.push(`-- note: ${n}`);
  return lines;
}

/** PGKILN_EXTENSIONS: a comma-separated list of extension names. */
export function extensionsSetting(v = process.env.PGKILN_EXTENSIONS ?? ''): string[] {
  return v.split(',').map((s) => s.trim()).filter((s) => /^[a-z_][a-z0-9_-]*$/i.test(s));
}

/**
 * The superuser connection for pgkiln's database: SUPERUSER_DATABASE_URL's server and role, DATABASE_URL's database
 * (so both always mean the same database).
 */
export function superuserUrl(ownerUrl: string, su: string): URL {
  const o = new URL(ownerUrl);
  const u = new URL(su);
  u.pathname = o.pathname;
  return u;
}

/** Make DATABASE_URL's role pgkiln's owner without SUPERUSER, on the superuser connection su. */
export async function demoteOwner(o: { ownerUrl: string; superuserUrl: string; dryRun?: boolean; extensions?: string[]; log?: (s: string) => void }) {
  const log = o.log ?? ((s: string) => process.stdout.write(`${s}\n`));
  const owner = new URL(o.ownerUrl);
  const c = new pg.Client({ connectionString: superuserUrl(o.ownerUrl, o.superuserUrl).href, application_name: 'pgkiln-owner' });
  await c.connect();
  try {
    const plan = await planOwner(c, { owner: decodeURIComponent(owner.username), password: owner.password ? decodeURIComponent(owner.password) : null, extensions: o.extensions });
    if (plan.problems.length) throw new Error(plan.problems.join('; '));
    if (!o.dryRun) await applyOwner(c, plan);
    return plan;
  } finally {
    await c.end();
  }
}

/** Whether DATABASE_URL signs in and owns pgkiln (after demoteOwner): null when it does, else the reason. */
export async function ownerSignsIn(ownerUrl: string): Promise<string | null> {
  const c = new pg.Client({ connectionString: ownerUrl, application_name: 'pgkiln-owner', connectionTimeoutMillis: 10_000 });
  try {
    await c.connect();
    const r = (await c.query(`select (select rolsuper from pg_roles where rolname = session_user) as super,
                                     coalesce((select nspowner = (select oid from pg_roles where rolname = session_user) from pg_namespace where nspname = 'meta'), true) as owns`)).rows[0];
    return r.super ? 'it is still a superuser' : r.owns ? null : "it doesn't own schema meta";
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.end().catch(() => {});
  }
}
