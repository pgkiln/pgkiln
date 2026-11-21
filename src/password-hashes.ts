// (sprint 248, MG-21) Password hashes of other systems, for custom authentication's hash query (src/customauth.ts):
// the application's query returns the stored hash, this module checks the password against it.
//   Django  pbkdf2_sha256$<iterations>$<salt>$<base64>, pbkdf2_sha1$…   Node's crypto.pbkdf2 (the thread pool)
//   bcrypt  $2a$ / $2b$ / $2y$<cost>$…  (PHP password_hash, Ruby, Node bcrypt; Django's bcrypt$… and bcrypt_sha256$…)
//           pgcrypto's crypt() in the database ($2b$ and $2y$ are the same algorithm as pgcrypto's $2a$)
// Comparisons are constant-time (timingSafeEqual). An unknown user or a hash that can't be read gets a dummy check
// of the same kind and cost as the application's last real one, so the time doesn't tell them apart. The password is
// never logged, never part of SQL text and never in a result: only "ok" and a reason without it.

import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

/** PBKDF2 iterations and bcrypt costs beyond these are refused (a check would take many seconds). */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
export const MAX_BCRYPT_COST = 16;

export type ParsedHash =
  | { kind: 'pbkdf2'; digest: 'sha256' | 'sha1'; iterations: number; salt: string; hash: Buffer }
  | { kind: 'bcrypt'; cost: number; hash: string; sha256: boolean }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'malformed'; reason: string };

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BCRYPT = /^\$(2[aby])\$(\d\d)\$([./A-Za-z0-9]{53})$/;

/** What a stored hash is (never throws). */
export function parseHash(stored: string): ParsedHash {
  const s = stored.trim();
  if (!s) return { kind: 'malformed', reason: 'the hash is empty' };
  if (s.length > 1000) return { kind: 'malformed', reason: 'the hash is longer than 1000 characters' };
  const pb = /^pbkdf2_(sha256|sha1)\$(\d{1,9})\$([^$]{1,200})\$([^$]+)$/.exec(s);
  if (pb) {
    const digest = pb[1] as 'sha256' | 'sha1';
    const iterations = Number(pb[2]);
    if (iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) return { kind: 'malformed', reason: `pbkdf2 iterations out of range (1 to ${MAX_PBKDF2_ITERATIONS})` };
    if (!B64.test(pb[4])) return { kind: 'malformed', reason: 'the pbkdf2 hash is not base64' };
    const hash = Buffer.from(pb[4], 'base64');
    if (hash.length !== (digest === 'sha256' ? 32 : 20)) return { kind: 'malformed', reason: `the pbkdf2 hash is not ${digest === 'sha256' ? 32 : 20} bytes` };
    return { kind: 'pbkdf2', digest, iterations, salt: pb[3], hash };
  }
  if (/^pbkdf2_/.test(s)) return { kind: 'malformed', reason: 'not a pbkdf2_sha256$ or pbkdf2_sha1$ hash with iterations, salt and hash' };
  // Django's bcrypt hashers put their name before the bcrypt hash; bcrypt_sha256 checks hex(sha256(password))
  const django = /^(bcrypt|bcrypt_sha256)\$(.*)$/.exec(s);
  const bc = BCRYPT.exec(django ? django[2] : s);
  if (bc) {
    const cost = Number(bc[2]);
    if (cost < 4 || cost > MAX_BCRYPT_COST) return { kind: 'malformed', reason: `bcrypt cost out of range (4 to ${MAX_BCRYPT_COST})` };
    // $2b$ (OpenBSD, Node, Python) and $2y$ (PHP) are $2a$ without its old bug; pgcrypto's $2a$ computes the same
    return { kind: 'bcrypt', cost, hash: `$2a$${bc[2]}$${bc[3]}`, sha256: django?.[1] === 'bcrypt_sha256' };
  }
  if (/^(argon2\$|\$)argon2(id|i|d)\$/.test(s)) return { kind: 'unsupported', reason: 'argon2 hashes are not supported (store bcrypt or pbkdf2_sha256: meta.make_password_hash)' };
  if (/^\$2x\$/.test(s)) return { kind: 'unsupported', reason: '$2x$ bcrypt hashes (crypt_blowfish\'s buggy variant) are not supported' };
  if (/^\$2/.test(s) || django) return { kind: 'malformed', reason: 'not a bcrypt hash ($2a$, $2b$ or $2y$, a cost of two digits and 53 characters)' };
  return { kind: 'unsupported', reason: 'unknown hash format (pbkdf2_sha256$, pbkdf2_sha1$ or bcrypt $2a$/$2b$/$2y$)' };
}

/** bcrypt in the database: crypt(password, hash) as pgcrypto computes it (the caller runs the query). */
export type BcryptFn = (password: string, hash: string) => Promise<string>;

/** The kind and cost of a hash, for a dummy check that takes as long. */
export type HashShape = { kind: 'pbkdf2'; digest: 'sha256' | 'sha1'; iterations: number } | { kind: 'bcrypt'; cost: number };

/** Django's default: what an application that has had no real check yet gets for a dummy one. */
export const DEFAULT_SHAPE: HashShape = { kind: 'pbkdf2', digest: 'sha256', iterations: 1_000_000 };

export const shapeOf = (h: ParsedHash): HashShape | null =>
  h.kind === 'pbkdf2' ? { kind: 'pbkdf2', digest: h.digest, iterations: h.iterations } : h.kind === 'bcrypt' ? { kind: 'bcrypt', cost: h.cost } : null;

const BCRYPT_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const bcryptChars = (n: number) => [...randomBytes(n)].map((b) => BCRYPT_ALPHABET[b % 64]).join('');

/** Same-length constant-time comparison of two strings or buffers (different lengths: false, after a comparison all the same). */
function sameBytes(a: Buffer, b: Buffer) {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

async function checkPbkdf2(password: string, h: { digest: 'sha256' | 'sha1'; iterations: number; salt: string; hash: Buffer }) {
  const dk = await pbkdf2Async(Buffer.from(password, 'utf8'), Buffer.from(h.salt, 'utf8'), h.iterations, h.hash.length, h.digest);
  return sameBytes(dk, h.hash);
}

async function checkBcrypt(password: string, h: { hash: string; sha256: boolean }, bcrypt: BcryptFn) {
  // bcrypt_sha256 (Django): the hex digest is the password, so long passwords aren't cut at 72 bytes
  const pw = h.sha256 ? createHash('sha256').update(password, 'utf8').digest('hex') : password;
  const computed = await bcrypt(pw, h.hash);
  return sameBytes(Buffer.from(computed ?? '', 'utf8'), Buffer.from(h.hash, 'utf8'));
}

/** A check of the same kind and cost that never succeeds (an unknown user, a hash that can't be read). */
export async function dummyCheck(password: string, shape: HashShape, bcrypt: BcryptFn): Promise<void> {
  try {
    if (shape.kind === 'pbkdf2') {
      await checkPbkdf2(password, { digest: shape.digest, iterations: shape.iterations, salt: randomBytes(16).toString('hex'), hash: randomBytes(shape.digest === 'sha256' ? 32 : 20) });
    } else {
      await checkBcrypt(password, { hash: `$2a$${String(shape.cost).padStart(2, '0')}$${bcryptChars(53)}`, sha256: false }, bcrypt);
    }
  } catch {
    /* a dummy: only its time counts */
  }
}

export type HashCheck = { ok: true; shape: HashShape } | { ok: false; reason: string; shape: HashShape | null };

/** Check a password against a stored hash; an unreadable or unsupported hash gets a dummy check of `fallback`. */
export async function verifyPasswordHash(stored: string, password: string, bcrypt: BcryptFn, fallback: HashShape = DEFAULT_SHAPE): Promise<HashCheck> {
  const h = parseHash(stored);
  if (h.kind === 'unsupported' || h.kind === 'malformed') {
    await dummyCheck(password, fallback, bcrypt);
    return { ok: false, reason: h.reason, shape: null };
  }
  const shape = shapeOf(h)!;
  const ok = h.kind === 'pbkdf2' ? await checkPbkdf2(password, h) : await checkBcrypt(password, h, bcrypt);
  return ok ? { ok: true, shape } : { ok: false, reason: 'wrong password', shape };
}
