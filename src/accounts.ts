import { runtime } from './db.ts';
import { english, type Translate } from './i18n.ts';

// Instance-wide account settings (meta.setting) and the password policy,
// like APEX's account login controls and password complexity rules.

export interface AccountSettings {
  minLength: number;
  requireMixed: boolean;
  lifetimeDays: number;
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
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Forget cached settings (after the builder saved them). */
export const clearAccountSettings = () => {
  cache = undefined;
};

/** Why a new password is not acceptable, or null. */
export async function passwordProblem(password: string | undefined, { username, t = english }: { username?: string | null; t?: Translate } = {}) {
  const s = await accountSettings();
  if (!password || password.length < s.minLength) return t('password.too_short', { min: s.minLength });
  if (s.requireMixed && !(/\p{L}/u.test(password) && /\d/.test(password))) return t('password.needs_mixed');
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) return t('password.contains_username');
  return null;
}

/** Days until the account's password expires: 0 = must change now, null = never. */
export async function passwordDaysLeft(username: string) {
  return (await runtime.one<{ d: number | null }>('select meta.password_days_left($1) as d', [username]))?.d ?? null;
}
