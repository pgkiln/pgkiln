import { createHash } from 'node:crypto';
import { logActivity } from './session.ts';
import { webRequest, type WebRequest, type WebResponse } from './webclient.ts';

// (sprint 204, SEC-3) Breached passwords: an instance setting (Users → Password policy, meta.setting
// 'password_breach_check', off by default). When it is on, a password a developer or an application user sets or
// changes is looked up in Have I Been Pwned's Pwned Passwords with its k-anonymity range API: only the first 5
// hexadecimal characters of the password's SHA-1 go out (GET https://api.pwnedpasswords.com/range/<prefix>, with
// Add-Padding: true so the answer's size says nothing either), and the server compares the suffixes it gets back
// itself. The password and its full hash never leave the server. Sign-ins are never checked.
//
// The request goes through webRequest (src/webclient.ts) with an allow-list of that one host: the address checks at
// connect time (no private, loopback or link-local address), no redirect elsewhere, a short time limit and a size
// limit. When the service can't be reached, is slow or answers with something else than a range, the password is
// accepted (fail open) and a warning is logged (the server's log and the activity log, event password_check_failed).
// Test runs never reach the network: setBreachTransport() replaces the request, and without one a test process
// fails open.

export const PWNED_HOST = 'api.pwnedpasswords.com';
export const PWNED_RANGE_URL = `https://${PWNED_HOST}/range/`;
/** The whole exchange; a password form doesn't wait longer. */
export const BREACH_TIMEOUT_MS = 3000;
/** A padded range answer is some 30–40 kB. */
const MAX_BYTES = 1_000_000;

export type BreachTransport = (url: string, req: WebRequest) => Promise<WebResponse>;

let transport: BreachTransport | null = null;

/** Replace the request (tests); null: the real one. */
export function setBreachTransport(t: BreachTransport | null) {
  transport = t;
}

const send: BreachTransport = (url, req) => {
  if (transport) return transport(url, req);
  // node --test sets NODE_TEST_CONTEXT in its test processes: never the real service from a test run
  if (process.env.NODE_TEST_CONTEXT) return Promise.reject(new Error('no network in tests'));
  return webRequest(url, req);
};

/** The password's SHA-1 in upper-case hexadecimal, split as the range API wants it. */
export function rangeKey(password: string) {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: sha1.slice(0, 5), suffix: sha1.slice(5) };
}

/** How often the suffix occurs in a range answer ("SUFFIX:COUNT" lines; padding lines have count 0). */
export function countIn(body: string, suffix: string): number {
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i !== 35) continue;
    if (line.slice(0, 35).toUpperCase() === suffix) return Number(line.slice(36).trim()) || 0;
  }
  return 0;
}

/** In how many breaches the password was seen (0: none), or null when the service could not tell. */
export async function breachCount(password: string): Promise<number | null> {
  const { prefix, suffix } = rangeKey(password);
  try {
    const res = await send(PWNED_RANGE_URL + prefix, {
      headers: { 'Add-Padding': 'true', accept: 'text/plain' },
      timeoutMs: BREACH_TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      // this host only, with the address checks of every outgoing request
      hosts: { allowed: [PWNED_HOST], private: [] },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = res.body.toString('utf8');
    // a range answer has lines of 35 hexadecimal characters, a colon and a count
    if (!/^[0-9A-Fa-f]{35}:\d+\s*$/m.test(body)) throw new Error('not a range answer');
    return countIn(body, suffix);
  } catch (e) {
    const why = (e as Error).message?.slice(0, 200) || 'failed';
    console.warn(`pgkiln: breached-password check unavailable, password accepted: ${why}`);
    await logActivity({ event: 'password_check_failed', detail: `breached-password check (${PWNED_HOST}) unavailable, password accepted: ${why}` });
    return null;
  }
}
