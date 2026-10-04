import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Secrets at rest (web credentials): AES-256-GCM with a key derived from
// PGAPEX_SECRET_KEY. Stored as "v1:" + base64(iv | tag | ciphertext). The
// key never reaches the database, so a database dump alone does not reveal
// the secrets. Read lazily, so a test (or an operator) can set the variable
// after start-up.

const VERSION = 'v1:';

export class SecretKeyMissing extends Error {
  constructor() {
    super('Secrets cannot be stored or used: set PGAPEX_SECRET_KEY (at least 32 characters, e.g. the output of `openssl rand -base64 32`) in the server\'s environment.');
  }
}

function key() {
  const k = process.env.PGAPEX_SECRET_KEY ?? '';
  if (k.length < 32) throw new SecretKeyMissing();
  return createHash('sha256').update(`pgapex-secret-v1\0${k}`).digest();
}

export const secretKeyConfigured = () => (process.env.PGAPEX_SECRET_KEY ?? '').length >= 32;

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return VERSION + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(VERSION)) throw new Error('Unknown secret format.');
  const buf = Buffer.from(stored.slice(VERSION.length), 'base64');
  if (buf.length < 28) throw new Error('Damaged secret.');
  const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  try {
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    // a different PGAPEX_SECRET_KEY than the one it was stored with
    throw new Error('A stored secret cannot be decrypted with the current PGAPEX_SECRET_KEY: enter it again in the builder.');
  }
}
