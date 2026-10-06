// Container entry point (Dockerfile, deploy/compose.yaml): prepares the
// database, then starts the server.
//
// 1. Refuses to start without the secrets a server on a network needs
//    (PGAPEX_SECRET_KEY, a runtime password) instead of running on defaults.
// 2. Applies the migrations, holding an advisory lock so that several
//    containers starting together migrate once.
// 3. Gives the login roles the migrations create their own passwords: the
//    runtime role the one in RUNTIME_DATABASE_URL; on a new install the
//    PostgREST role pgapex_authenticator a random one (or
//    PGAPEX_AUTHENTICATOR_PASSWORD).
// 4. Replaces the builder's admin / admin with PGAPEX_ADMIN_PASSWORD; while
//    admin still has that password, the server doesn't start.
// 5. Installs an example application (PGAPEX_EXAMPLE=hr) when asked.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { root } from '../src/env.ts';
import { migrate } from '../src/migrate.ts';

const say = (s: string) => console.log(`pgapex: ${s}`);
const fail = (s: string): never => {
  console.error(`pgapex: ${s}`);
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

const placeholders = ['POSTGRES_PASSWORD', 'RUNTIME_PASSWORD', 'PGAPEX_SECRET_KEY', 'PGAPEX_ADMIN_PASSWORD'].filter((k) => process.env[k] === 'change-me');
if (placeholders.length) problems.push(`replace "change-me": ${placeholders.join(', ')}`);
if ((process.env.PGAPEX_SECRET_KEY ?? '').length < 32)
  problems.push('PGAPEX_SECRET_KEY needs at least 32 characters (e.g. `openssl rand -hex 24`); it encrypts stored secrets: keep it, and keep it out of database backups');
const ownerUrl = dbUrl('DATABASE_URL', 'set POSTGRES_PASSWORD, or DATABASE_URL for your own server');
const runtimeUrl = dbUrl('RUNTIME_DATABASE_URL', 'set RUNTIME_PASSWORD, or RUNTIME_DATABASE_URL for your own server');
if (ownerUrl.username && runtimeUrl.username === ownerUrl.username) problems.push('RUNTIME_DATABASE_URL must use the runtime role (pgapex_runtime), not the owner');
const adminPassword = process.env.PGAPEX_ADMIN_PASSWORD ?? '';
if (adminPassword && (adminPassword.length < 12 || adminPassword === 'admin')) problems.push('PGAPEX_ADMIN_PASSWORD needs at least 12 characters');
if (problems.length) fail(`can't start; fix these in .env (see deploy/.env.example):\n  - ${problems.join('\n  - ')}`);
const example = (process.env.PGAPEX_EXAMPLE ?? '').trim();

// wait for the database (it may still be starting), then hold the lock while migrating
const lock = new pg.Client({ connectionString: ownerUrl.href, application_name: 'pgapex-start' });
for (let attempt = 1; ; attempt++) {
  try {
    await lock.connect();
    break;
  } catch (e) {
    if (attempt >= 60) fail(`can't reach the database: ${(e as Error).message}`);
    if (attempt === 1) say('waiting for the database …');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const q = (sql: string, params: unknown[] = []) => lock.query(sql, params);
await q(`select pg_advisory_lock(hashtext('pgapex-migrate'))`);
try {
  const applied = await migrate({ root, databaseUrl: ownerUrl.href, example: example || null, log: (s) => process.stdout.write(s) });
  const fresh = applied.some((f) => f.endsWith('/001_meta.sql'));
  say(applied.length ? `${applied.length} file(s) applied${fresh ? ' (new install)' : ''}` : 'the database is up to date');

  const setPassword = async (role: string, password: string, what: string) => {
    try {
      await q(`alter role ${pg.escapeIdentifier(role)} password ${pg.escapeLiteral(password)}`);
    } catch (e) {
      // e.g. an owner without CREATEROLE on a managed server: the administrator sets it
      say(`could not set the password of ${role} (${(e as Error).message}); ${what}`);
    }
  };
  await setPassword(runtimeUrl.username, decodeURIComponent(runtimeUrl.password), 'make sure it matches RUNTIME_DATABASE_URL.');
  if (fresh) {
    const api = process.env.PGAPEX_AUTHENTICATOR_PASSWORD || randomBytes(24).toString('hex');
    await setPassword('pgapex_authenticator', api, 'change it before using PostgREST.');
  }

  const admin = (await q(`select password_hash = crypt('admin', password_hash) as weak from meta.developer where username = 'admin'`)).rows[0];
  if (admin?.weak) {
    if (!adminPassword) fail('the builder account admin still has the password "admin": set PGAPEX_ADMIN_PASSWORD (12+ characters) and start again.');
    await q(`update meta.developer set password_hash = meta.hash_password($1) where username = 'admin'`, [adminPassword]);
    say('the builder account admin has the password from PGAPEX_ADMIN_PASSWORD now');
  }
  if (applied.some((f) => f.startsWith('examples/'))) say(`example "${example}" installed: its demo users have weak passwords, don't expose it`);
} finally {
  await q(`select pg_advisory_unlock(hashtext('pgapex-migrate'))`).catch(() => {});
  await lock.end();
}

await import('../src/server.ts');
