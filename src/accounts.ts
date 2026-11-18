import { runtime } from './db.ts';
import { english, type Translate } from './i18n.ts';

// Instance-wide account settings (meta.setting) and the password policy,
// like APEX's account login controls and password complexity rules.

export interface AccountSettings {
  minLength: number;
  requireMixed: boolean;
  lifetimeDays: number;
  /** (sprint 204, SEC-3) look new passwords up in Have I Been Pwned's range API (src/breached-passwords.ts) */
  breachCheck: boolean;
}

let cache: { at: number; value: AccountSettings } | undefined;

export async function accountSettings(): Promise<AccountSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const rows = (await runtime.query<{ name: string; value: string }>('select name, value from meta.setting')).rows;
  const get = (n: string) => rows.find((r) => r.name === n)?.value;
  const value = {
    minLength: Math.max(1, Number(get('password_min_length') ?? 8) || 8),
    requireMixed: get('password_require_mixed') === 'true',
    lifetimeDays: Math.max(0, Number(get('password_lifetime_days') ?? 0) || 0),
    breachCheck: get('password_breach_check') === 'true',
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Forget cached settings (after the builder saved them). */
export const clearAccountSettings = () => {
  cache = undefined;
  appControls.clear();
};

/**
 * (sprint 223, migration 185) The account login controls of an application's workspace (APEX: Account Login
 * Control in the workspace preferences): stricter than the installation's, never looser. Null: the installation's.
 */
export interface LoginControls {
  maxFailures: number | null;
  lifetimeDays: number | null;
  minLength: number | null;
}
const appControls = new Map<number, { at: number; value: LoginControls }>();
const NONE: LoginControls = { maxFailures: null, lifetimeDays: null, minLength: null };

export async function appLoginControls(appId: number | null | undefined): Promise<LoginControls> {
  if (appId == null) return NONE;
  const hit = appControls.get(appId);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const r = await runtime.one<{ login_max_failures: number | null; password_lifetime_days: number | null; password_min_length: number | null }>(
    'select * from meta.app_login_controls($1)', [appId]);
  const value = r ? { maxFailures: r.login_max_failures, lifetimeDays: r.password_lifetime_days, minLength: r.password_min_length } : NONE;
  appControls.set(appId, { at: Date.now(), value });
  return value;
}

/**
 * Why a new password is not acceptable, or null. For every password set or changed (developers and application users),
 * never at sign-in.
 */
export async function passwordProblem(password: string | undefined, { username, t = english, appId }: { username?: string | null; t?: Translate; appId?: number | null } = {}) {
  const s = await accountSettings();
  // (sprint 223) an application's workspace may ask for longer passwords
  const min = Math.max(s.minLength, (await appLoginControls(appId)).minLength ?? 0);
  if (!password || password.length < min) return t('password.too_short', { min });
  if (s.requireMixed && !(/\p{L}/u.test(password) && /\d/.test(password))) return t('password.needs_mixed');
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) return t('password.contains_username');
  return breachedPasswordProblem(password, s, t);
}

/** (sprint 204, SEC-3) A password seen in data breaches, when the instance checks that; the service unreachable: none. */
export async function breachedPasswordProblem(password: string, s: Pick<AccountSettings, 'breachCheck'>, t: Translate = english) {
  if (!s.breachCheck) return null;
  const { breachCount } = await import('./breached-passwords.ts');
  return ((await breachCount(password)) ?? 0) > 0 ? t('password.breached') : null;
}

/**
 * (sprint 201, SEC-3) A builder developer's password: at least this many characters, also when the application
 * users' policy (password_min_length, Users → Account settings) allows fewer. Applied when one is set or changed;
 * existing passwords keep working.
 */
export const DEVELOPER_PASSWORD_MIN = 12;

/** The minimum length of a developer's new password: the users' policy, but never under DEVELOPER_PASSWORD_MIN. */
export const developerPasswordMin = async () => Math.max(DEVELOPER_PASSWORD_MIN, (await accountSettings()).minLength);

/** Why a developer's new password is not acceptable, or null (the users' policy, with at least 12 characters). */
export async function developerPasswordProblem(password: string | undefined, { username, t = english }: { username?: string | null; t?: Translate } = {}) {
  const min = await developerPasswordMin();
  if (!password || password.length < min) return t('password.too_short', { min });
  return passwordProblem(password, { username, t });
}

/** Days until the account's password expires: 0 = must change now, null = never. (sprint 223) For an application: its workspace's lifetime too. */
export async function passwordDaysLeft(username: string, appId?: number | null) {
  if (appId != null) return (await runtime.one<{ d: number | null }>('select meta.password_days_left($1, $2) as d', [username, appId]))?.d ?? null;
  return (await runtime.one<{ d: number | null }>('select meta.password_days_left($1) as d', [username]))?.d ?? null;
}
