import { owner } from './db.ts';
import { breakGlassAdmins } from './devsso.ts';
import { mfaPolicy } from './mfa.ts';
import { remoteClockOffset } from './release-check.ts';
import { rpIdOf } from './webauthn.ts';
import { decryptSecret, encryptSecret, keyFingerprint, secretKeyConfigured } from './secrets.ts';

// (sprint 133, SEC-6) Lockout checks of the instance: what could keep developers or application users out
// later, found before it happens. Shown on Instance settings (administrators), counted on the Workspace home
// and printed by `pgkiln admin check`.
//
//  - Instance key: secrets stored without PGKILN_SECRET_KEY, secrets the current key can't decrypt (the key
//    changed), and whether an administrator confirmed a backup of this key (meta.setting secret_key_backup,
//    by fingerprint, so a new key asks again). Authenticator apps are encrypted with it; passkeys and the
//    hashed recovery codes are not.
//  - Clock: TOTP codes allow one 30-second step either side, so the server's clock is compared with the
//    database's and, when the release check is on, with GitHub's.
//  - Passkey domain: passkeys made for another RP ID than the one PUBLIC_URL (or the given address) gives,
//    and how many people have no other factor left. `pgkiln admin check --url` asks before a move.
//  - Break-glass: a workspace that requires single sign-on needs a break-glass administrator, and one with
//    a second factor when the policy requires it.
//
// rotateKey() re-encrypts every stored secret from an old key to a new one in one transaction.

export type Level = 'ok' | 'info' | 'warning' | 'error';

export interface Check {
  key: 'secret_key' | 'key_backup' | 'clock' | 'passkey_domain' | 'break_glass';
  level: Level;
  title: string;
  detail: string;
}

/** Every column that holds a secret encrypted with the instance key ("v1:…"). */
export interface SecretColumn {
  schema: string;
  table: string;
  column: string;
}

export async function encryptedColumns(): Promise<SecretColumn[]> {
  return (await owner.query<SecretColumn>(
    `select table_schema as schema, table_name as table, column_name as column from information_schema.columns
      where table_schema = 'meta' and data_type = 'text'
        and (column_name like '%\\_enc' or (table_name = 'push_key' and column_name = 'private_key'))
      order by 2, 3`)).rows;
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const tableOf = (c: SecretColumn) => `${quoteIdent(c.schema)}.${quoteIdent(c.table)}`;

/** Stored secrets per column, and how many the given key (default: the server's) can't decrypt. */
export async function secretStatus(withKey?: string) {
  const out: (SecretColumn & { stored: number; unreadable: number })[] = [];
  const usable = (withKey ?? process.env.PGKILN_SECRET_KEY ?? '').length >= 32;
  for (const c of await encryptedColumns()) {
    const rows = (await owner.query<{ v: string }>(`select ${quoteIdent(c.column)} as v from ${tableOf(c)} where ${quoteIdent(c.column)} is not null`)).rows;
    let unreadable = 0;
    for (const r of rows) {
      try {
        if (!usable) throw new Error();
        decryptSecret(r.v, withKey);
      } catch {
        unreadable++;
      }
    }
    if (rows.length) out.push({ ...c, stored: rows.length, unreadable });
  }
  return out;
}

export interface KeyBackup {
  fingerprint: string;
  by: string;
  at: string;
}

export async function keyBackup(): Promise<KeyBackup | null> {
  const v = (await owner.one<{ value: string }>(`select value from meta.setting where name = 'secret_key_backup'`))?.value;
  try {
    const b = v ? JSON.parse(v) : null;
    return b && typeof b.fingerprint === 'string' ? (b as KeyBackup) : null;
  } catch {
    return null;
  }
}

/** An administrator says the current key is kept somewhere safe (false: no key configured). */
export async function confirmKeyBackup(by: string) {
  const fingerprint = keyFingerprint();
  if (!fingerprint) return false;
  const value = JSON.stringify({ fingerprint, by, at: new Date().toISOString() });
  await owner.query(`insert into meta.setting (name, value) values ('secret_key_backup', $1) on conflict (name) do update set value = excluded.value`, [value]);
  return true;
}

/** Milliseconds this server's clock is ahead of the database's (half the round trip taken off). */
export async function databaseClockOffset() {
  const t0 = Date.now();
  const r = await owner.one<{ ms: string }>(`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`);
  const t1 = Date.now();
  return Math.round((t0 + t1) / 2 - Number(r!.ms));
}

export const CLOCK_WARN_MS = 10_000;
export const CLOCK_ERROR_MS = 30_000;

export interface PasskeyDomain {
  rpId: string;
  who: 'developers' | 'app users';
  passkeys: number;
  people: number;
  /** people with no authenticator app and no passkey for the current RP ID */
  stranded: number;
}

/** Passkeys made for another RP ID than rpId. */
export async function passkeysElsewhere(rpId: string): Promise<PasskeyDomain[]> {
  const part = (table: string, key: string, who: string) => `
    select '${who}'::text as who, coalesce(f.rp_id, '(unknown)') as "rpId", count(*)::int as passkeys, count(distinct f.${key})::int as people,
           count(distinct f.${key}) filter (where not exists (select 1 from meta.${table} o where o.${key} = f.${key}
             and (o.kind = 'totp' or (o.kind = 'passkey' and o.rp_id = $1))))::int as stranded
      from meta.${table} f where f.kind = 'passkey' and f.rp_id is distinct from $1 group by f.rp_id`;
  return (await owner.query<PasskeyDomain>(`${part('developer_factor', 'username', 'developers')} union all ${part('account_factor', 'account_id', 'app users')} order by 2, 1`, [rpId])).rows;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** All checks; rpId: the RP ID passkeys must have (from PUBLIC_URL or the request; null skips that check). */
export async function instanceChecks(rpId: string | null): Promise<Check[]> {
  const checks: Check[] = [];

  // the instance key
  const status = await secretStatus();
  const stored = status.reduce((n, s) => n + s.stored, 0);
  const unreadable = status.filter((s) => s.unreadable);
  if (!secretKeyConfigured())
    checks.push(stored
      ? { key: 'secret_key', level: 'error', title: 'Instance key missing', detail: `${plural(stored, 'secret')} are stored (${status.map((s) => `${s.table}.${s.column}`).join(', ')}), but PGKILN_SECRET_KEY is not set: authenticator apps, web credentials and mail passwords don't work. Set the key they were stored with.` }
      : { key: 'secret_key', level: 'info', title: 'No instance key', detail: 'PGKILN_SECRET_KEY is not set, so nothing can be stored encrypted (authenticator apps, web credentials, mail and AI keys). Set one of at least 32 characters, e.g. the output of openssl rand -base64 32.' });
  else if (unreadable.length)
    checks.push({ key: 'secret_key', level: 'error', title: 'Secrets the instance key can\'t decrypt', detail: `${unreadable.map((s) => `${s.table}.${s.column}: ${s.unreadable} of ${s.stored}`).join('; ')}. PGKILN_SECRET_KEY changed without pgkiln admin rotate-key: set the old key again and rotate, or enter those secrets again (developers set up their authenticator app again after a reset).` });
  else checks.push({ key: 'secret_key', level: 'ok', title: 'Instance key', detail: stored ? `PGKILN_SECRET_KEY decrypts all ${plural(stored, 'stored secret')}.` : 'PGKILN_SECRET_KEY is set; no secrets are stored yet.' });

  if (secretKeyConfigured()) {
    const backup = await keyBackup();
    const fp = keyFingerprint()!;
    checks.push(backup?.fingerprint === fp
      ? { key: 'key_backup', level: 'ok', title: 'Instance key backed up', detail: `${backup.by} confirmed a copy of the key with fingerprint ${fp} on ${backup.at.slice(0, 10)}.` }
      : { key: 'key_backup', level: 'warning', title: 'Instance key not confirmed as backed up', detail: `${backup ? 'The key changed since the last confirmation. ' : ''}Keep a copy of PGKILN_SECRET_KEY (fingerprint ${fp}) outside this server, e.g. in a password manager: without it the authenticator apps and stored credentials are lost. Passkeys and recovery codes keep working.` });
  }

  // the clock
  const db = await databaseClockOffset();
  const remote = remoteClockOffset();
  const worst = Math.max(Math.abs(db), Math.abs(remote?.offsetMs ?? 0));
  const s = (ms: number) => (Math.abs(ms) < 50 ? '0.0 s' : `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(1)} s`);
  const seen = `database (${s(db)})${remote ? ` and GitHub's (${s(remote.offsetMs)}, at the release check)` : ''}`;
  checks.push(worst >= CLOCK_ERROR_MS
    ? { key: 'clock', level: 'error', title: 'Server clock is off', detail: `This server's clock differs from the ${seen}. Authenticator codes fail beyond about 30 seconds: synchronise the clock (NTP, e.g. systemd-timesyncd or chrony).` }
    : worst >= CLOCK_WARN_MS
      ? { key: 'clock', level: 'warning', title: 'Server clock drifts', detail: `This server's clock differs from the ${seen}. Authenticator codes fail beyond about 30 seconds: check the time synchronisation (NTP).` }
      : { key: 'clock', level: 'ok', title: 'Clock', detail: `This server's clock agrees with the ${seen}.` });

  // passkeys of another domain
  if (rpId) {
    const away = await passkeysElsewhere(rpId);
    const strandedTotal = away.reduce((n, a) => n + a.stranded, 0);
    checks.push(away.length
      ? { key: 'passkey_domain', level: strandedTotal ? 'warning' : 'info', title: `Passkeys for another domain than ${rpId}`,
          detail: `${away.map((a) => `${a.rpId}: ${plural(a.passkeys, 'passkey')} of ${plural(a.people, a.who === 'developers' ? 'developer' : 'app user')}${a.stranded ? `, ${a.stranded} with no other factor` : ''}`).join('; ')}. Passkeys work only on the domain they were made for${strandedTotal ? ': people with no other factor need a recovery code or a reset' : ''}. Set PUBLIC_URL (or PGKILN_RP_ID) back, or have them add passkeys again.` }
      : { key: 'passkey_domain', level: 'ok', title: 'Passkey domain', detail: `Every passkey is for ${rpId}.` });
  }

  // break-glass administrators
  const ssoOnly = (await owner.query<{ name: string }>(`select name from meta.workspace where sso_only order by name`)).rows.map((r) => r.name);
  if (ssoOnly.length) {
    const glass = await breakGlassAdmins();
    const policy = (await mfaPolicy()).policy;
    const withFactor = glass.length
      ? (await owner.query<{ username: string }>(`select distinct username from meta.developer_factor where username = any($1)`, [glass])).rows.map((r) => r.username)
      : [];
    checks.push(!glass.length
      ? { key: 'break_glass', level: 'error', title: 'No break-glass administrator', detail: `${ssoOnly.join(', ')} require${ssoOnly.length === 1 ? 's' : ''} single sign-on and no administrator may use the pgkiln password: when the identity provider fails, only pgkiln admin builder-sign-in password on the server gets anyone in. Mark an administrator as break-glass on Developers.` }
      : policy !== 'off' && withFactor.length < glass.length
        ? { key: 'break_glass', level: 'warning', title: 'Break-glass administrator without a second factor', detail: `${glass.filter((g) => !withFactor.includes(g)).join(', ')} must use two-factor sign-in but has no authenticator app or passkey: add one on Security before it is needed.` }
        : { key: 'break_glass', level: 'ok', title: 'Break-glass administrators', detail: `${glass.join(', ')} may sign in with the pgkiln password when the identity provider fails (${ssoOnly.join(', ')} require${ssoOnly.length === 1 ? 's' : ''} single sign-on).` });
  }
  return checks;
}

/** How many checks need attention (warnings and errors). */
export const attention = (checks: Check[]) => checks.filter((c) => c.level === 'warning' || c.level === 'error').length;

let cached: { at: number; count: number } | null = null;

/** (Workspace home) how many checks need attention, at most five minutes old; never throws. */
export async function attentionCount(): Promise<number> {
  if (cached && Date.now() - cached.at < 300_000) return cached.count;
  try {
    const pub = process.env.PUBLIC_URL;
    const rpId = pub && URL.canParse(pub) ? rpIdOf(new URL(pub).origin) : null;
    cached = { at: Date.now(), count: attention(await instanceChecks(rpId)) };
  } catch {
    return cached?.count ?? 0;
  }
  return cached.count;
}

/** Forget the cached count (after a change on Instance settings, and in tests). */
export const forgetAttention = () => {
  cached = null;
};

export class RotateError extends Error {}

/**
 * Re-encrypt every stored secret from oldKey to newKey, in one transaction. A value the new key already
 * decrypts is left alone (a second run after a partial restart changes nothing); a value neither key
 * decrypts stops the rotation and nothing is changed. dryRun: count only.
 */
export async function rotateKey(oldKey: string, newKey: string, { dryRun = false, columns }: { dryRun?: boolean; columns?: SecretColumn[] } = {}) {
  if (oldKey.length < 32 || newKey.length < 32) throw new RotateError('both keys need at least 32 characters');
  if (oldKey === newKey) throw new RotateError('the new key is the old key');
  const cols = columns ?? (await encryptedColumns());
  return owner.tx(async (c) => {
    const counts: (SecretColumn & { rotated: number; already: number })[] = [];
    const failed: string[] = [];
    for (const col of cols) {
      const rows = (await c.query<{ ctid: string; v: string }>(
        `select ctid::text as ctid, ${quoteIdent(col.column)} as v from ${tableOf(col)} where ${quoteIdent(col.column)} is not null for update`)).rows;
      let rotated = 0;
      let already = 0;
      for (const r of rows) {
        let plain: string;
        try {
          decryptSecret(r.v, newKey);
          already++;
          continue;
        } catch {
          // not yet rotated
        }
        try {
          plain = decryptSecret(r.v, oldKey);
        } catch {
          failed.push(`${col.schema}.${col.table}.${col.column}`);
          continue;
        }
        if (!dryRun) await c.query(`update ${tableOf(col)} set ${quoteIdent(col.column)} = $1 where ctid = $2::tid`, [encryptSecret(plain, newKey), r.ctid]);
        rotated++;
      }
      if (rows.length) counts.push({ ...col, rotated, already });
    }
    if (failed.length) {
      const by = [...new Set(failed)].map((f) => `${f} (${failed.filter((x) => x === f).length})`).join(', ');
      throw new RotateError(`secrets that neither key decrypts: ${by}; nothing was changed`);
    }
    return counts;
  });
}
