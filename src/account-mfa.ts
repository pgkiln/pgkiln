import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { owner } from './db.ts';
import {
  ACCOUNTS, storeAddPasskey, storeAddTotp, storeCheck, storeCodesLeft, storeConfirmCodes, storeHasFactor, storeNewCodes, storePasskeys,
  storeUsePasskey,
} from './mfa.ts';

// (sprint 130, SEC-3) Two-step sign-in for application users, beyond APEX (whose application authentication has no
// second factor). An account's authenticator apps and recovery codes (meta.account_factor, account_recovery_code,
// migration 132) serve every application it may use; each application decides whether it asks for them (meta.app.mfa):
// off, optional (users who added an app give a code), required, or required for some roles. The second step follows
// the user directory's passwords and LDAP directories; an identity provider decides on its own second factor (SEC-4).
// A remembered or shared sign-in carries its method: only one that ends in "+2fa" stands in for the second step.
// (sprint 131, SEC-3 part 2) Passkeys next to authenticator apps; a code by e-mail for users who have one of those
// (never someone's only factor, SEC-6); step-up: an authorization scheme with mfa_minutes passes only when the session's
// last second step (session state __MFA_AT) is that recent; and REST API tokens a user creates on My account.

export type AppMfa = 'off' | 'optional' | 'required' | 'roles';
export const APP_MFA: AppMfa[] = ['off', 'optional', 'required', 'roles'];

export interface MfaApp { authentication: string; mfa?: AppMfa | null; mfa_roles?: string[] | null }

/** Whether the application has a second step at all (its own accounts, and not "off"). */
export const mfaOn = (a: MfaApp) => a.authentication === 'app_users' && !!a.mfa && a.mfa !== 'off';

/** Whether the application requires a second step of a user with these roles. */
export function mfaRequired(a: MfaApp, roles: string[]): boolean {
  if (!mfaOn(a)) return false;
  if (a.mfa === 'required') return true;
  const need = new Set((a.mfa_roles ?? []).map((r) => r.toLowerCase()));
  return a.mfa === 'roles' && roles.some((r) => need.has(r.toLowerCase()));
}

/** The sign-in methods a second step follows (the directory's password, an LDAP directory). */
export const knowsPassword = (method: string | undefined) => !method || method.startsWith('password') || method.startsWith('ldap:');
export const MFA_SUFFIX = '+2fa';
export const withSecondStep = (method: string | undefined) => `${method ?? 'password'}${MFA_SUFFIX}`;

/** An active account's id by user name (accounts are matched without regard to case). */
export async function accountId(username: string): Promise<number | null> {
  return (await owner.one<{ id: number }>('select id from meta.account where lower(username) = lower($1) and active', [username]))?.id ?? null;
}

/**
 * What a password (or LDAP) sign-in to this application still needs: 'code' (the user has an authenticator app),
 * 'enrol' (required, and the user has none yet) or null (no second step).
 */
export async function secondStep(a: MfaApp, username: string, roles: string[]): Promise<'code' | 'enrol' | null> {
  if (!mfaOn(a)) return null;
  const id = await accountId(username);
  if (id === null) return null;
  if (await storeHasFactor(ACCOUNTS, id)) return 'code';
  return mfaRequired(a, roles) ? 'enrol' : null;
}

/**
 * Whether a remembered or shared sign-in may sign the user in here without a second step: one made with an identity
 * provider, one that had a second step, or a user this application asks nothing of.
 */
export async function carriesSecondStep(a: MfaApp, username: string, roles: string[], method: string | undefined): Promise<boolean> {
  if (!knowsPassword(method) || method?.endsWith(MFA_SUFFIX)) return true;
  return (await secondStep(a, username, roles)) === null;
}

export interface AccountFactor { id: number; kind: 'totp' | 'passkey'; name: string; created_at: string; last_used_at: string | null; rp_id: string | null }

export async function accountFactors(id: number): Promise<AccountFactor[]> {
  return (await owner.query<AccountFactor>(
    'select id, kind, name, created_at, last_used_at, rp_id from meta.account_factor where account_id = $1 order by kind desc, id', [id])).rows;
}

export const accountHasFactor = (id: number) => storeHasFactor(ACCOUNTS, id);
export const accountCodesLeft = (id: number) => storeCodesLeft(ACCOUNTS, id);
export const addAccountTotp = (id: number, name: string, secret: string, step: number) => storeAddTotp(ACCOUNTS, id, name, secret, step);
export const newAccountCodes = (id: number) => storeNewCodes(ACCOUNTS, id);
export const confirmAccountCodes = (id: number) => storeConfirmCodes(ACCOUNTS, id);
export const checkAccountCode = (id: number, code: string) => storeCheck(ACCOUNTS, id, code);
export const addAccountPasskey = (id: number, name: string, p: Parameters<typeof storeAddPasskey>[3]) => storeAddPasskey(ACCOUNTS, id, name, p);
export const accountPasskeys = (id: number, rpId: string) => storePasskeys(ACCOUNTS, id, rpId);
export const useAccountPasskey = (factorId: number, oldCount: string, newCount: number) => storeUsePasskey(ACCOUNTS, factorId, oldCount, newCount);
/** The user handle an account's passkeys carry: stable, and not the user name. */
export const accountUserHandle = (id: number) => createHash('sha256').update(`pgkiln-account:${id}`).digest().subarray(0, 16).toString('base64url');

// ---------------------------------------------------------------- step-up (sprint 131)

/** Session state: when (ms) the session last had a second step (signing in with one, or asked again). */
export const MFA_AT = '__MFA_AT';
export const markSecondStep = (state: Record<string, unknown>) => { state[MFA_AT] = Date.now(); };
/** Whether the session had a second step at most `minutes` ago. */
export function secondStepWithin(state: Record<string, unknown>, minutes: number): boolean {
  const at = Number(state[MFA_AT]);
  return Number.isFinite(at) && at > 0 && Date.now() - at <= minutes * 60_000;
}

// ---------------------------------------------------------------- e-mail codes (sprint 131)

export const EMAIL_CODE_MINUTES = 10;
/** Codes one account may get by e-mail per hour (every application together). */
export const EMAIL_CODES_PER_HOUR = 5;
export const newEmailCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const emailCodeHash = (code: string) => createHash('sha256').update(`pgkiln-mail-code:${code}`).digest('hex');
export function emailCodeMatches(hash: string | undefined, code: string): boolean {
  const digits = code.replace(/\s/g, '');
  if (!hash || !/^\d{6}$/.test(digits)) return false;
  return timingSafeEqual(Buffer.from(emailCodeHash(digits)), Buffer.from(hash));
}

/**
 * Where an e-mail code would go for this account in this application: the account's address and the application's
 * mail service, or null (not offered). Only for an application that allows it and an account with another factor.
 */
export async function emailCodeTarget(a: { id: number; mfa_email?: boolean | null }, accountIdValue: number): Promise<{ to: string; from: string } | null> {
  if (!a.mfa_email || !(await storeHasFactor(ACCOUNTS, accountIdValue))) return null;
  const r = await owner.one<{ email: string | null; from_address: string | null; ok: boolean }>(
    `select ac.email, ams.from_address, coalesce(s.enabled and meta.mail_sender_allowed(s.senders, ams.from_address), false) as ok
       from meta.account ac
       left join meta.app_mail_service ams on ams.app_id = $2
       left join meta.mail_service s on s.id = ams.service_id
      where ac.id = $1 and ac.active`, [accountIdValue, a.id]);
  const to = r?.email?.trim();
  return r?.ok && to && r.from_address?.trim() ? { to, from: r.from_address.trim() } : null;
}

/**
 * Queue a sign-in code mail (the application's mail service, its daily limit). Returns false when the account had
 * too many this hour or the limit is reached; the caller says nothing more specific (no hint about the address).
 */
export async function queueEmailCode(a: { id: number }, username: string, target: { to: string; from: string }, subject: string, text: string): Promise<boolean> {
  return owner.tx(async (c) => {
    const recent = (await c.query<{ n: number }>(
      `select count(*)::int as n from meta.mail_queue where template = 'SIGNIN_CODE' and lower(username) = lower($1) and created_at > now() - interval '1 hour'`,
      [username])).rows[0].n;
    if (recent >= EMAIL_CODES_PER_HOUR) return false;
    const over = (await c.query<{ over: boolean }>(
      `select ams.max_per_day is not null and (select count(*) from meta.mail_queue q where q.app_id = $1
                 and q.created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' and q.status <> 'cancelled') >= ams.max_per_day as over
         from meta.app_mail_service ams where ams.app_id = $1`, [a.id])).rows[0]?.over;
    if (over) return false;
    const id = (await c.query<{ id: string }>(
      `insert into meta.mail_queue (app_id, username, from_address, to_addresses, subject, body_text, template)
       values ($1, $2, $3, array[$4], left($5, 998), $6, 'SIGNIN_CODE') returning id`,
      [a.id, username, target.from, target.to, subject.replace(/[\r\n]+/g, ' '), text])).rows[0].id;
    await c.query(`select pg_notify('pgkiln_mail', $1)`, [String(id)]);
    return true;
  });
}

// ---------------------------------------------------------------- REST API tokens (sprint 131)

/** Minutes a second step may be old for a user to create their own API token (when the app requires one of them). */
export const TOKEN_STEP_MINUTES = 15;

/** Whether the application requires a second step of this account (by its roles in the application). */
export async function accountMustUseMfa(a: MfaApp & { id: number }, username: string): Promise<boolean> {
  if (!mfaOn(a)) return false;
  const roles = (await owner.query<{ roles: string[] }>(
    `select aa.roles from meta.app_access aa join meta.account ac on ac.id = aa.account_id where aa.app_id = $1 and lower(ac.username) = lower($2)`,
    [a.id, username])).rows[0]?.roles ?? [];
  return mfaRequired(a, roles);
}

/** Remove one of the account's authenticator apps (and the recovery codes with the last one). */
export async function removeAccountFactor(id: number, factorId: number): Promise<boolean> {
  return owner.tx(async (c) => {
    const gone = (await c.query('delete from meta.account_factor where id = $1 and account_id = $2', [factorId, id])).rowCount;
    if (gone && !(await c.query('select 1 from meta.account_factor where account_id = $1', [id])).rowCount)
      await c.query('delete from meta.account_recovery_code where account_id = $1', [id]);
    return !!gone;
  });
}

/** (Manage users) Remove every second factor of an account and end its sessions and remembered sign-ins. */
export async function resetAccountFactors(id: number): Promise<boolean> {
  return owner.tx(async (c) => {
    const acc = (await c.query<{ username: string }>('select username from meta.account where id = $1', [id])).rows[0];
    if (!acc) return false;
    await c.query('delete from meta.account_factor where account_id = $1', [id]);
    await c.query('delete from meta.account_recovery_code where account_id = $1', [id]);
    await c.query('delete from meta.persistent_login where account_id = $1', [id]);
    await c.query('delete from meta.shared_login where account_id = $1', [id]);
    await c.query('delete from meta.session where app_id is not null and lower(username) = lower($1)', [acc.username]);
    return true;
  });
}
