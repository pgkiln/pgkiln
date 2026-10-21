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

export interface Factor { id: number; kind: 'totp'; name: string; created_at: string; last_used_at: string | null }

export async function factorsOf(username: string, db: Pick<pg.ClientBase, 'query'> = owner.pool): Promise<Factor[]> {
  return (await db.query<Factor>('select id, kind, name, created_at, last_used_at from meta.developer_factor where username = $1 order by id', [username])).rows;
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
 * A developer without a factor while the policy requires one: 'grace' until the grace period ends (a
 * banner), then 'enrol' (only the Security page and signing out until they enrol); null otherwise.
 */
export async function enrolmentDue(username: string, isAdmin: boolean): Promise<{ due: 'grace' | 'enrol'; until: Date } | null> {
  const { policy, since, graceDays } = await mfaPolicy();
  if (!requiredFor(policy, isAdmin) || (await hasFactor(username))) return null;
  const until = new Date((since ?? new Date()).getTime() + graceDays * 86_400_000);
  return { due: Date.now() < until.getTime() ? 'grace' : 'enrol', until };
}

/** Remove every second factor of a developer (an administrator, or the command line) and end their sessions. */
export async function resetFactors(username: string): Promise<boolean> {
  return owner.tx(async (c) => {
    const known = (await c.query('select 1 from meta.developer where username = $1', [username])).rowCount;
    if (!known) return false;
    await c.query('delete from meta.developer_factor where username = $1', [username]);
    await c.query('delete from meta.developer_recovery_code where username = $1', [username]);
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
