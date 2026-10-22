import { owner } from './db.ts';
import { ACCOUNTS, storeAddTotp, storeCheck, storeCodesLeft, storeConfirmCodes, storeHasFactor, storeNewCodes } from './mfa.ts';

// (sprint 130, SEC-3) Two-step sign-in for application users, beyond APEX (whose application authentication has no
// second factor). An account's authenticator apps and recovery codes (meta.account_factor, account_recovery_code,
// migration 132) serve every application it may use; each application decides whether it asks for them (meta.app.mfa):
// off, optional (users who added an app give a code), required, or required for some roles. The second step follows
// the user directory's passwords and LDAP directories; an identity provider decides on its own second factor (SEC-4).
// A remembered or shared sign-in carries its method: only one that ends in "+2fa" stands in for the second step.

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

export interface AccountFactor { id: number; name: string; created_at: string; last_used_at: string | null }

export async function accountFactors(id: number): Promise<AccountFactor[]> {
  return (await owner.query<AccountFactor>('select id, name, created_at, last_used_at from meta.account_factor where account_id = $1 order by id', [id])).rows;
}

export const accountHasFactor = (id: number) => storeHasFactor(ACCOUNTS, id);
export const accountCodesLeft = (id: number) => storeCodesLeft(ACCOUNTS, id);
export const addAccountTotp = (id: number, name: string, secret: string, step: number) => storeAddTotp(ACCOUNTS, id, name, secret, step);
export const newAccountCodes = (id: number) => storeNewCodes(ACCOUNTS, id);
export const confirmAccountCodes = (id: number) => storeConfirmCodes(ACCOUNTS, id);
export const checkAccountCode = (id: number, code: string) => storeCheck(ACCOUNTS, id, code);

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
