// Container entry point (Dockerfile, deploy/compose.yaml): prepares the
// database, then starts the server.
//
// 1. Refuses to start without the secrets a server on a network needs
//    (PGKILN_SECRET_KEY, a runtime password) instead of running on defaults.
// 2. Applies the migrations, holding an advisory lock so that several
//    containers starting together migrate once.
// 3. Gives the login roles the migrations create their own passwords: the
//    runtime role the one in RUNTIME_DATABASE_URL, the PostgREST role
//    pgkiln_authenticator PGKILN_AUTHENTICATOR_PASSWORD or else a random one.
//    A role this start created gets its password at once (it has a
//    well-known default). Roles belong to the whole server, so for an older
//    role the password is set only when the server refuses the configured
//    one: a password that works, or can't be checked, is left alone because
//    other databases on the server may use it. Whatever can't be checked or
//    set is logged.
// 4. Replaces the builder's admin / admin with PGKILN_ADMIN_PASSWORD; while
//    admin still has that password, the server doesn't start.
// 5. Installs an example application (PGKILN_EXAMPLE=hr) when asked.
//
// (sprint 232) With SUPERUSER_DATABASE_URL (deploy/compose.yaml sets it for the bundled database), DATABASE_URL's
// role is no superuser: before migrating, the start makes it one with LOGIN CREATEROLE NOSUPERUSER that owns the
// database (and pgkiln's objects, when an older install made a superuser their owner: src/owner-role.ts), does once
// what needs a superuser (pg_cron, PGKILN_EXTENSIONS) and migrates as the owner; installing pgkiln needs a
// superuser (migrate.ts needsSuperuser), so the owner is one during that run only. The superuser's URL and password
// never reach the server: `--prepare` stops after preparing, and the image's entry point starts the server without
// them (scripts/docker-entrypoint.sh); started without it, they are removed from the environment first.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { root } from '../src/env.ts';
import { connectWhenReady, migrate, needsSuperuser, pendingMigrations } from '../src/migrate.ts';
import { applyOwner, describePlan, extensionsSetting, planOwner } from '../src/owner-role.ts';

const say = (s: string) => console.log(`pgkiln: ${s}`);
const fail = (s: string): never => {
  console.error(`pgkiln: ${s}`);
  process.exit(1);
};

// every missing or bad setting at once, not one per restart
const problems: string[] = [];
function dbUrl(name: string, hint: string) {
  const v = process.env[name] ?? '';
  try {
    const u = new URL(v);
    if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push(`${name} must start with postgres://`);
    else if (!u.password) problems.push(`${name} has no password (${hint})`);
    return u;
  } catch {
    problems.push(`${name} is not a postgres:// URL (passwords in it must be URL-safe, e.g. \`openssl rand -hex 24\`)`);
    return new URL('postgres://invalid');
  }
}

if ((process.env.PGKILN_SECRET_KEY ?? '').length < 32)
  problems.push('PGKILN_SECRET_KEY needs at least 32 characters (e.g. `openssl rand -hex 24`); it encrypts stored secrets: keep it, and keep it out of database backups');
// the variables the server must not see
const SUPERUSER_ENV = ['SUPERUSER_DATABASE_URL', 'POSTGRES_PASSWORD'];
const superuser = (process.env.SUPERUSER_DATABASE_URL ?? '').trim();
const ownerUrl = dbUrl('DATABASE_URL', superuser ? 'set OWNER_PASSWORD, new in pgkiln 0.112.0: the password of pgkiln_owner, the database owner without SUPERUSER (e.g. `openssl rand -hex 24`)' : 'set POSTGRES_PASSWORD, or DATABASE_URL for your own server');
const runtimeUrl = dbUrl('RUNTIME_DATABASE_URL', 'set RUNTIME_PASSWORD, or RUNTIME_DATABASE_URL for your own server');
if (ownerUrl.username && runtimeUrl.username === ownerUrl.username) problems.push('RUNTIME_DATABASE_URL must use the runtime role (pgkiln_runtime), not the owner');
// the superuser connection: its server and role, DATABASE_URL's database
const suUrl = superuser ? dbUrl('SUPERUSER_DATABASE_URL', 'set POSTGRES_PASSWORD, the bundled database\'s superuser password') : null;
if (suUrl) {
  suUrl.pathname = ownerUrl.pathname;
  if (suUrl.username && suUrl.username === ownerUrl.username)
    problems.push(`DATABASE_URL and SUPERUSER_DATABASE_URL both sign in as ${decodeURIComponent(ownerUrl.username)}: pgkiln's owner is a role of its own without SUPERUSER (deploy/compose.yaml: pgkiln_owner, with OWNER_PASSWORD)`);
}
const adminPassword = process.env.PGKILN_ADMIN_PASSWORD ?? '';
if (adminPassword && (adminPassword.length < 12 || adminPassword === 'admin')) problems.push('PGKILN_ADMIN_PASSWORD needs at least 12 characters');
if (problems.length) fail(`can't start; fix these in .env (see deploy/.env.example):\n  - ${problems.join('\n  - ')}`);
const example = (process.env.PGKILN_EXAMPLE ?? '').trim();

// The connection URL of DATABASE_URL's server and database for another role.
function as(role: string, password: string) {
  const u = new URL(ownerUrl.href);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  return u;
}

// Whether the server accepts this URL's password: 'yes', 'no' (a wrong
// password), 'any' (it signed in without asking for one, e.g. trust) or
// 'unknown' (it refuses the role for another reason, e.g. pg_hba.conf).
async function signsIn(url: URL): Promise<'yes' | 'no' | 'any' | 'unknown'> {
  const c = new pg.Client({ connectionString: url.href, application_name: 'pgkiln-start', connectionTimeoutMillis: 5_000 });
  let asked = false;
  for (const m of ['authenticationCleartextPassword', 'authenticationMD5Password', 'authenticationSASL']) c.connection.once(m, () => (asked = true));
  try {
    await c.connect();
    return asked ? 'yes' : 'any';
  } catch (e) {
    return (e as { code?: string }).code === '28P01' ? 'no' : 'unknown';
  } finally {
    await c.end().catch(() => {});
  }
}

// wait for the database (it may still be starting); the bundled database of pgkiln 0.111.0 and older has no role
// postgres: its superuser is pgkiln (POSTGRES_USER then), with the same password
async function connectSuperuser(url: URL): Promise<pg.Client> {
  try {
    return await connectWhenReady(url.href, 'pgkiln-start', 120, () => say('waiting for the database …'));
  } catch (e) {
    if ((e as { code?: string }).code !== '28P01' || url.username !== 'postgres' || url.hostname !== 'db') throw e;
    const old = new URL(url.href);
    old.username = 'pgkiln';
    const c = await connectWhenReady(old.href, 'pgkiln-start', 5).catch(() => {
      throw e;
    });
    say('the bundled database was made by pgkiln 0.111.0 or older: its superuser is pgkiln (POSTGRES_SUPERUSER=pgkiln in .env skips the first try)');
    return c;
  }
}
const connectFailed = (e: unknown, url: URL, name: string) =>
  fail(
    (e as { code?: string }).code === '28P01'
      ? url.hostname === 'db'
        ? `the database refused the password in ${name}. The bundled database keeps the POSTGRES_PASSWORD of its first start (in the volume pgdata): put that one back, or change it inside the database first (docs/guide/01-installation.md, "Docker").`
        : `the database at ${url.hostname} refused the user or password in ${name}.`
      : `can't connect to the database: ${(e as Error).message}`,
  );
const lock = suUrl
  ? await connectSuperuser(suUrl).catch((e) => connectFailed(e, suUrl, 'SUPERUSER_DATABASE_URL'))
  : await connectWhenReady(ownerUrl.href, 'pgkiln-start', 120, () => say('waiting for the database …')).catch((e) => connectFailed(e, ownerUrl, 'DATABASE_URL'));
const q = (sql: string, params: unknown[] = []) => lock.query(sql, params);
await q(`select pg_advisory_lock(hashtext('pgkiln-migrate'))`);
try {
  const runtimeRole = decodeURIComponent(runtimeUrl.username);
  const roles = [runtimeRole, 'pgkiln_authenticator'];
  const existing = async () => new Set<string>((await q(`select rolname from pg_roles where rolname = any($1)`, [roles])).rows.map((r) => r.rolname));
  const before = await existing();
  // (232) the owner without SUPERUSER, made by the superuser connection; a superuser only while it installs
  const owner = { owner: decodeURIComponent(ownerUrl.username), password: decodeURIComponent(ownerUrl.password), extensions: extensionsSetting() };
  const ownerStep = async (elevated: boolean) => {
    const plan = await planOwner(lock, { ...owner, elevated });
    if (plan.problems.length) fail(`can't make ${owner.owner} pgkiln's owner: ${plan.problems.join('; ')}`);
    try {
      await applyOwner(lock, plan, elevated);
    } catch (e) {
      fail(`can't make ${owner.owner} pgkiln's owner: ${(e as Error).message}`);
    }
    if (plan.steps.length || plan.notes.length) say(`database owner ${owner.owner}:\n  ${describePlan(plan, { brief: true }).join('\n  ')}`);
  };
  let elevated = false;
  if (suUrl) {
    if (!(await q(`select rolsuper from pg_roles where rolname = session_user`)).rows[0].rolsuper)
      fail(`SUPERUSER_DATABASE_URL signs in as ${decodeURIComponent(suUrl.username)}, which is not a superuser`);
    elevated = needsSuperuser(await pendingMigrations(root, suUrl.href));
    await ownerStep(elevated);
  }
  const applied = await migrate({ root, databaseUrl: ownerUrl.href, example: example || null, log: (s) => process.stdout.write(s) });
  const fresh = applied.some((f) => f.endsWith('/001_meta.sql'));
  say(applied.length ? `${applied.length} file(s) applied${fresh ? ' (new install)' : ''}` : 'the database is up to date');
  if (suUrl) await ownerStep(false);
  else if ((await q(`select rolsuper from pg_roles where rolname = session_user`)).rows[0].rolsuper)
    say('DATABASE_URL signs in as a superuser: give pgkiln an owner without SUPERUSER (SUPERUSER_DATABASE_URL, or pgkiln admin demote-owner; docs/guide/01-installation.md, "A non-superuser owner")');

  const setPassword = async (role: string, password: string, done: string, what: string) => {
    try {
      await q(`alter role ${pg.escapeIdentifier(role)} password ${pg.escapeLiteral(password)}`);
      say(done);
    } catch (e) {
      // e.g. an owner without CREATEROLE on a managed server: the administrator sets it
      say(`could not set the password of ${role} (${(e as Error).message}); ${what}`);
    }
  };
  const after = await existing();
  const created = (role: string) => after.has(role) && !before.has(role);
  const shared = 'roles belong to the whole server: other databases on it that use this role need the new password too';
  const api = process.env.PGKILN_AUTHENTICATOR_PASSWORD;
  // both checks at once: each waits up to 5 seconds for an unreachable server
  const [runtimeCheck, apiCheck] = await Promise.all([
    created(runtimeRole) ? ('new' as const) : signsIn(runtimeUrl),
    created('pgkiln_authenticator') ? ('new' as const) : signsIn(as('pgkiln_authenticator', api ?? 'pgkiln_authenticator')),
  ]);
  const unchecked = (role: string, check: string) =>
    check === 'any' ? `the server lets ${role} sign in here without a password, so its password can't be checked` : `${role} can't sign in here to check its password`;

  // the password the app is configured with: set it for a new role or one that
  // refuses it; when the check is inconclusive (trust, a transient error), leave
  // an older role alone: other databases may use its password
  if (runtimeCheck === 'new' || runtimeCheck === 'no') {
    await setPassword(runtimeRole, decodeURIComponent(runtimeUrl.password), `${runtimeRole} has the password from RUNTIME_DATABASE_URL now${runtimeCheck === 'new' ? '' : ` (${shared})`}`, 'make sure it matches RUNTIME_DATABASE_URL.');
  } else if (runtimeCheck !== 'yes') {
    say(`${unchecked(runtimeRole, runtimeCheck)}; leaving its password alone. If the app can't sign in, set it to the one in RUNTIME_DATABASE_URL yourself.`);
  }
  if (api) {
    if (apiCheck === 'new' || apiCheck === 'no') {
      await setPassword('pgkiln_authenticator', api, `pgkiln_authenticator has the password from PGKILN_AUTHENTICATOR_PASSWORD now${apiCheck === 'new' ? '' : ` (${shared})`}`, 'set it before using PostgREST.');
    } else if (apiCheck !== 'yes') {
      say(`${unchecked('pgkiln_authenticator', apiCheck)}; leaving its password alone. If PostgREST can't sign in, set it to PGKILN_AUTHENTICATOR_PASSWORD yourself.`);
    }
  } else if (apiCheck === 'new' || apiCheck === 'yes') {
    // apiCheck checked the well-known default
    await setPassword('pgkiln_authenticator', randomBytes(24).toString('hex'), 'pgkiln_authenticator had its default password; it has a random one now (PGKILN_AUTHENTICATOR_PASSWORD chooses one for PostgREST)', 'change it before using PostgREST.');
  } else if (apiCheck !== 'no') {
    say(`${unchecked('pgkiln_authenticator', apiCheck)}. If it still has its default password "pgkiln_authenticator", anyone can sign in as it where the server does check: set PGKILN_AUTHENTICATOR_PASSWORD, or change it yourself.`);
  }

  const admin = (await q(`select password_hash = crypt('admin', password_hash) as weak from meta.developer where username = 'admin'`)).rows[0];
  if (admin?.weak) {
    if (!adminPassword) fail('the builder account admin still has the password "admin": set PGKILN_ADMIN_PASSWORD (12+ characters) and start again.');
    await q(`update meta.developer set password_hash = meta.hash_password($1) where username = 'admin'`, [adminPassword]);
    say('the builder account admin has the password from PGKILN_ADMIN_PASSWORD now');
  }
  if (applied.some((f) => f.startsWith('examples/'))) say(`example "${example}" installed: its demo users have weak passwords, don't expose it`);
} finally {
  await q(`select pg_advisory_unlock(hashtext('pgkiln-migrate'))`).catch(() => {});
  await lock.end();
}

if (process.argv.includes('--prepare')) process.exit(0);
// (232) the server never sees the superuser's password
for (const k of SUPERUSER_ENV) delete process.env[k];
await import('../src/server.ts');
