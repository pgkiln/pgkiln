import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { owner } from './db.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';

// (sprint 126, SEC-2 and SEC-6) Two-factor sign-in for developers: authenticator apps (TOTP, RFC 6238:
// HMAC-SHA1, 30-second steps, 6 digits; one step either side is accepted for clock drift, and a step is
// accepted only once) and one-time recovery codes. The policy (off, administrators, all developers) is a
// setting; it can only be required while two administrators (or every administrator, when there are fewer)
// have a working second factor, so it never locks the instance out. The command line resets a developer's
// factors and turns the policy off without signing in (src/cli/main.ts, `pgkiln admin`).
// (sprint 127) Passkeys and security keys (WebAuthn, src/webauthn.ts) are the second kind of factor, and a
// developer may trust a browser for a number of days (meta.setting mfa_trust_days; 0 = never).
// (sprint 128) A passkey the authenticator verified the developer with may stand in for both the password and
// the second factor (mfa_passkey_signin), and a workspace may require a second factor of its developers.

export const TOTP_STEP = 30;
export const TOTP_DIGITS = 6;
export const RECOVERY_CODES = 10;
export type MfaPolicy = 'off' | 'admins' | 'all';
export const MFA_POLICIES: MfaPolicy[] = ['off', 'admins', 'all'];

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new authenticator secret: 160 random bits, base32 (what apps expect). */
export const newTotpSecret = () => base32(randomBytes(20));

/** The code of one 30-second step (RFC 4226 dynamic truncation). */
export function totpAt(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

export const stepNow = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_STEP);

/** The step a code matches (now, or one step either side), newer than `after`; null otherwise. */
export function matchTotp(secret: Buffer, code: string, after: number | null, now = stepNow()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  let found: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (after !== null && step <= after) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), given)) found = step;
  }
  return found;
}

/** The otpauth URI an authenticator app reads from the QR code. */
export const otpauthUri = (secret: string, account: string, issuer = 'pgkiln') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;

// ---------------------------------------------------------------- recovery codes

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
/** A recovery code: ten characters in two groups (xxxxx-xxxxx), about 50 bits. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
export const normaliseCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashCode = (code: string) => createHash('sha256').update(normaliseCode(code)).digest('hex');

// ---------------------------------------------------------------- the developer's factors

export interface Factor { id: number; kind: 'totp' | 'passkey'; name: string; created_at: string; last_used_at: string | null; rp_id: string | null }

export async function factorsOf(username: string, db: Pick<pg.ClientBase, 'query'> = owner.pool): Promise<Factor[]> {
  return (await db.query<Factor>('select id, kind, name, created_at, last_used_at, rp_id from meta.developer_factor where username = $1 order by kind desc, id', [username])).rows;
}

/** Recovery codes left (confirmed, unused). */
export async function codesLeft(username: string): Promise<number> {
  return (await owner.one<{ n: number }>('select count(*)::int as n from meta.developer_recovery_code where username = $1 and confirmed and used_at is null', [username]))!.n;
}

/** Whether the developer has a working second factor (an authenticator app; recovery codes back it up). */
export async function hasFactor(username: string): Promise<boolean> {
  return !!(await owner.one('select 1 as ok from meta.developer_factor where username = $1', [username]));
}

/** Add an authenticator app (after the developer confirmed a code from it). */
export async function addTotp(username: string, name: string, secret: string, step: number) {
  await owner.query(
    `insert into meta.developer_factor (username, kind, name, secret_enc, last_step, last_used_at) values ($1, 'totp', $2, $3, $4, now())`,
    [username, name.trim().slice(0, 60) || 'Authenticator', encryptSecret(secret), step],
  );
}

// ---------------------------------------------------------------- passkeys (sprint 127)

export interface Passkey { id: number; name: string; credential_id: string; public_key: Record<string, string>; alg: number; sign_count: string; transports: string[] }

/** Add a passkey (after src/webauthn.ts checked the browser's answer). */
export async function addPasskey(username: string, name: string, p: { credentialId: string; jwk: Record<string, string>; alg: number; signCount: number; rpId: string; transports: string[] }) {
  await owner.query(
    `insert into meta.developer_factor (username, kind, name, credential_id, public_key, alg, sign_count, rp_id, transports, last_used_at)
     values ($1, 'passkey', $2, $3, $4, $5, $6, $7, $8, now())`,
    [username, name.trim().slice(0, 60) || 'Passkey', p.credentialId, JSON.stringify(p.jwk), p.alg, p.signCount, p.rpId,
     p.transports.filter((t) => /^[a-z-]{1,20}$/.test(t)).slice(0, 8)],
  );
}

/** The developer's passkeys for this relying party (a passkey only works on the domain it was made for). */
export async function passkeysOf(username: string, rpId: string): Promise<Passkey[]> {
  return (await owner.query<Passkey>(
    `select id, name, credential_id, public_key, alg, sign_count, transports from meta.developer_factor
      where username = $1 and kind = 'passkey' and rp_id = $2 order by id`, [username, rpId])).rows;
}

/** (sprint 128) The passkey with this credential id for this relying party, and whose it is (sign-in without a user name). */
export async function passkeyByCredential(credentialId: string, rpId: string): Promise<(Passkey & { username: string }) | null> {
  if (!credentialId || credentialId.length > 1400) return null;
  return (await owner.one<Passkey & { username: string }>(
    `select id, username, name, credential_id, public_key, alg, sign_count, transports from meta.developer_factor
      where kind = 'passkey' and credential_id = $1 and rp_id = $2`, [credentialId, rpId])) ?? null;
}

/** The user handle a developer's passkeys carry: stable, and not the user name. */
export const userHandle = (username: string) => createHash('sha256').update(`pgkiln-developer:${username}`).digest().subarray(0, 16).toString('base64url');

/** (sprint 128) Whether a passkey alone (user verified) may sign a developer in. */
export async function passkeySignin(): Promise<boolean> {
  return (await owner.one<{ value: string }>(`select value from meta.setting where name = 'mfa_passkey_signin'`))?.value !== 'off';
}

export async function setPasskeySignin(on: boolean) {
  await owner.query(`insert into meta.setting (name, value) values ('mfa_passkey_signin', $1) on conflict (name) do update set value = excluded.value`, [on ? 'on' : 'off']);
}

/** Record a sign-in with a passkey; false when another sign-in moved the counter first (a replay or a clone). */
export async function usePasskey(id: number, oldCount: string, newCount: number): Promise<boolean> {
  return !!(await owner.query(
    'update meta.developer_factor set sign_count = $3, last_used_at = now() where id = $1 and sign_count = $2::bigint',
    [id, oldCount, newCount])).rowCount;
}

// ---------------------------------------------------------------- trusted browsers (sprint 127)

/** Days a browser may skip the second step after one (0 = never). */
export async function trustDays(): Promise<number> {
  const v = Number((await owner.one<{ value: string }>(`select value from meta.setting where name = 'mfa_trust_days'`))?.value);
  return Number.isInteger(v) && v >= 0 && v <= 90 ? v : 0;
}

export async function setTrustDays(days: number) {
  await owner.query(`insert into meta.setting (name, value) values ('mfa_trust_days', $1) on conflict (name) do update set value = excluded.value`, [String(days)]);
  if (days === 0) await owner.query('delete from meta.developer_trusted_browser');
  else await owner.query(`delete from meta.developer_trusted_browser where expires_at > now() + make_interval(days => $1)`, [days]);
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Trust this browser: a random token for the cookie (only its hash is stored). */
export async function trustBrowser(username: string, days: number, userAgent: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await owner.query(
    `insert into meta.developer_trusted_browser (token_hash, username, expires_at, user_agent) values ($1, $2, now() + make_interval(days => $3), $4)`,
    [tokenHash(token), username, days, userAgent.slice(0, 200)]);
  return token;
}

/** Whether this browser's token is trusted for this developer (and trusting is still on). */
export async function isTrustedBrowser(username: string, token: string | undefined): Promise<boolean> {
  if (!token || token.length > 100) return false;
  return !!(await owner.one(
    `select 1 as ok from meta.developer_trusted_browser t where token_hash = $1 and username = $2 and expires_at > now()
        and exists (select 1 from meta.setting where name = 'mfa_trust_days' and value <> '0')`,
    [tokenHash(token), username]));
}

export async function trustedBrowsers(username: string): Promise<number> {
  return (await owner.one<{ n: number }>('select count(*)::int as n from meta.developer_trusted_browser where username = $1 and expires_at > now()', [username]))!.n;
}

export async function forgetBrowsers(username: string) {
  await owner.query('delete from meta.developer_trusted_browser where username = $1', [username]);
}

/** New recovery codes (the old ones stop working); shown once, counted only when confirmed. */
export async function newRecoveryCodes(username: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await owner.tx(async (c) => {
    await c.query('delete from meta.developer_recovery_code where username = $1', [username]);
    for (const code of codes) await c.query('insert into meta.developer_recovery_code (username, code_hash) values ($1, $2)', [username, hashCode(code)]);
  });
  return codes;
}

export async function confirmRecoveryCodes(username: string) {
  await owner.query('update meta.developer_recovery_code set confirmed = true where username = $1 and used_at is null', [username]);
}

/**
 * Check a second-factor code at sign-in: an authenticator code (each step once) or a confirmed, unused
 * recovery code (then used up). Returns what matched, or null.
 */
export async function checkSecondFactor(username: string, code: string): Promise<{ kind: 'totp' | 'recovery'; name?: string } | null> {
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const rows = (await owner.query<{ id: number; name: string; secret_enc: string; last_step: string | null }>(
      'select id, name, secret_enc, last_step from meta.developer_factor where username = $1 and kind = $2', [username, 'totp'])).rows;
    for (const f of rows) {
      let secret: Buffer;
      try {
        secret = unbase32(decryptSecret(f.secret_enc));
      } catch {
        continue; // the instance key changed: recovery codes still work
      }
      const step = matchTotp(secret, digits, f.last_step === null ? null : Number(f.last_step));
      // the update only wins once per step, also with two requests at the same time
      if (step !== null && (await owner.query('update meta.developer_factor set last_step = $2, last_used_at = now() where id = $1 and (last_step is null or last_step < $2)', [f.id, step])).rowCount)
        return { kind: 'totp', name: f.name };
    }
    return null;
  }
  if (normaliseCode(code).length !== 10) return null;
  const used = await owner.query(
    'update meta.developer_recovery_code set used_at = now() where username = $1 and code_hash = $2 and confirmed and used_at is null',
    [username, hashCode(code)]);
  return used.rowCount ? { kind: 'recovery' } : null;
}

// ---------------------------------------------------------------- policy

export async function mfaPolicy(): Promise<{ policy: MfaPolicy; since: Date | null; graceDays: number }> {
  const rows = (await owner.query<{ name: string; value: string }>(`select name, value from meta.setting where name in ('mfa_required', 'mfa_required_since', 'mfa_grace_days')`)).rows;
  const get = (n: string) => rows.find((r) => r.name === n)?.value;
  const p = get('mfa_required');
  const since = get('mfa_required_since');
  const grace = Number(get('mfa_grace_days'));
  return { policy: MFA_POLICIES.includes(p as MfaPolicy) ? (p as MfaPolicy) : 'off', since: since ? new Date(since) : null, graceDays: Number.isInteger(grace) && grace >= 0 && grace <= 90 ? grace : 7 };
}

/** Does the policy require a second factor of this developer? */
export const requiredFor = (policy: MfaPolicy, isAdmin: boolean) => policy === 'all' || (policy === 'admins' && isAdmin);

/** The administrators, and how many of them have a working second factor. */
export async function adminFactors(): Promise<{ admins: number; enrolled: number }> {
  return (await owner.one<{ admins: number; enrolled: number }>(
    `select count(*)::int as admins,
            count(*) filter (where exists (select 1 from meta.developer_factor f where f.username = d.username))::int as enrolled
       from meta.developer d where d.is_admin`))!;
}

/** Why the policy can't be required now (two administrators with a factor, or every one when fewer), or null. */
export async function policyProblem(policy: MfaPolicy): Promise<'admins' | null> {
  if (policy === 'off') return null;
  const { admins, enrolled } = await adminFactors();
  return enrolled >= Math.min(2, admins) && enrolled > 0 ? null : 'admins';
}

/** (SEC-6) Would taking `username` out of the administrators (a role change, removal) break the rule above? */
export async function leavesTooFewAdmins(username: string): Promise<boolean> {
  const { policy } = await mfaPolicy();
  if (policy === 'off') return false;
  const r = (await owner.one<{ admins: number; enrolled: number }>(
    `select count(*)::int as admins,
            count(*) filter (where exists (select 1 from meta.developer_factor f where f.username = d.username))::int as enrolled
       from meta.developer d where d.is_admin and d.username <> $1`, [username]))!;
  return !(r.enrolled >= Math.min(2, r.admins) && r.enrolled > 0);
}

/** Set the policy; `force` skips the two-administrator rule (only the command line uses it, to turn it off). */
export async function setPolicy(policy: MfaPolicy, graceDays: number) {
  await owner.tx(async (c) => {
    const cur = (await c.query<{ value: string }>(`select value from meta.setting where name = 'mfa_required'`)).rows[0]?.value ?? 'off';
    await c.query(`insert into meta.setting (name, value) values ('mfa_required', $1), ('mfa_grace_days', $2) on conflict (name) do update set value = excluded.value`, [policy, String(graceDays)]);
    // the grace period counts from when a stricter policy was turned on
    if (policy !== 'off' && (cur === 'off' || (cur === 'admins' && policy === 'all')))
      await c.query(`insert into meta.setting (name, value) values ('mfa_required_since', now()::text) on conflict (name) do update set value = excluded.value`);
    if (policy === 'off') await c.query(`delete from meta.setting where name = 'mfa_required_since'`);
  });
}

/**
 * (sprint 128) Whether a second factor is required of this developer, by the instance's policy or by one of
 * their workspaces, and since when (the grace period counts from the earliest).
 */
export async function requirement(username: string, isAdmin: boolean): Promise<{ required: boolean; since: Date | null; graceDays: number; workspaces: string[] }> {
  const [{ policy, since, graceDays }, ws] = await Promise.all([
    mfaPolicy(),
    owner.query<{ name: string; since: Date }>(
      `select w.name, w.mfa_required_since as since from meta.workspace w join meta.workspace_member m on m.workspace_id = w.id
        where m.username = $1 and w.mfa_required_since is not null order by w.mfa_required_since`, [username]),
  ]);
  const byInstance = requiredFor(policy, isAdmin);
  const times = [...(byInstance ? [since ?? new Date()] : []), ...ws.rows.map((r) => new Date(r.since))];
  return {
    required: times.length > 0,
    since: times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null,
    graceDays,
    workspaces: ws.rows.map((r) => r.name),
  };
}

/** (sprint 128) Require a second factor of a workspace's developers (from now), or stop requiring it. */
export async function setWorkspaceRequired(workspaceId: number, on: boolean): Promise<boolean> {
  return !!(await owner.query(
    `update meta.workspace set mfa_required_since = case when $2 then coalesce(mfa_required_since, now()) end where id = $1`,
    [workspaceId, on])).rowCount;
}

/** The command line's "off": no workspace requires a second factor either. */
export async function clearWorkspaceRequirements(): Promise<number> {
  return (await owner.query('update meta.workspace set mfa_required_since = null where mfa_required_since is not null')).rowCount ?? 0;
}

/**
 * A developer without a factor while the policy requires one: 'grace' until the grace period ends (a
 * banner), then 'enrol' (only the Security page and signing out until they enrol); null otherwise.
 */
export async function enrolmentDue(username: string, isAdmin: boolean): Promise<{ due: 'grace' | 'enrol'; until: Date } | null> {
  const r = await requirement(username, isAdmin);
  if (!r.required || (await hasFactor(username))) return null;
  const until = new Date((r.since ?? new Date()).getTime() + r.graceDays * 86_400_000);
  return { due: Date.now() < until.getTime() ? 'grace' : 'enrol', until };
}

/** Remove every second factor of a developer (an administrator, or the command line) and end their sessions. */
export async function resetFactors(username: string): Promise<boolean> {
  return owner.tx(async (c) => {
    const known = (await c.query('select 1 from meta.developer where username = $1', [username])).rowCount;
    if (!known) return false;
    await c.query('delete from meta.developer_factor where username = $1', [username]);
    await c.query('delete from meta.developer_recovery_code where username = $1', [username]);
    await c.query('delete from meta.developer_trusted_browser where username = $1', [username]);
    await c.query('delete from meta.session where app_id is null and username = $1', [username]);
    return true;
  });
}

/** The e-mail addresses of the administrators (to tell them about a reset or a policy change). */
export async function adminEmails(): Promise<string[]> {
  return (await owner.query<{ email: string }>(`select email from meta.developer where is_admin and email is not null`)).rows.map((r) => r.email);
}

/** Tell people about a reset or a policy change by mail, when the builder has a mail service (best effort). */
export async function notifyMfa(to: string[], subject: string, text: string): Promise<number> {
  const list = [...new Set(to.filter(Boolean))];
  if (!list.length) return 0;
  const { builderMail } = await import('./builder/find-workspace.ts');
  const { sendWith } = await import('./mail/mail.ts');
  const mail = await builderMail().catch(() => null);
  if (!mail) return 0;
  let sent = 0;
  for (const address of list)
    try {
      await sendWith(mail.service, { from: mail.from, to: [address], cc: [], bcc: [], replyTo: null, subject, text, html: null, attachments: [] });
      sent++;
    } catch {
      // the activity log has the event; a mail that fails doesn't undo it
    }
  return sent;
}
