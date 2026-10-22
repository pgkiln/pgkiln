import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

// (sprint 127, SEC-2) Passkeys and security keys (WebAuthn level 2) for developers, without a library: the
// server makes a one-time challenge, the browser asks the authenticator (navigator.credentials), and the
// server checks what comes back. Registration takes attestation "none": pgkiln stores the credential's public
// key (as a JWK) and trusts the authenticator the developer chose, as most sites do. Sign-in checks the
// challenge, the origin, the relying party (RP ID hash), user presence, the signature over authenticatorData
// and the hash of clientDataJSON, and the signature counter (a clone gives itself away when it goes back).
// Algorithms: ES256 (-7), EdDSA (-8) and RS256 (-257).

export const ALGORITHMS = [-7, -8, -257];

export class WebAuthnError extends Error {}

export const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
export const unb64url = (s: string) => Buffer.from(String(s ?? ''), 'base64url');
export const newChallenge = () => b64url(randomBytes(32));

// ------------------------------------------------------------------ CBOR (RFC 8949), only what WebAuthn uses

type Cbor = number | bigint | string | Buffer | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

/** Decode one CBOR item from `buf` at `pos`; returns the item and the position after it. */
export function cborDecode(buf: Buffer, pos = 0, depth = 0): [Cbor, number] {
  if (depth > 16) throw new WebAuthnError('CBOR nested too deep');
  if (pos >= buf.length) throw new WebAuthnError('CBOR ends early');
  const first = buf[pos++];
  const major = first >> 5;
  const info = first & 31;
  let len: number | bigint;
  if (info < 24) len = info;
  else if (info === 24) len = buf.readUInt8(pos), pos += 1;
  else if (info === 25) len = buf.readUInt16BE(pos), pos += 2;
  else if (info === 26) len = buf.readUInt32BE(pos), pos += 4;
  else if (info === 27) len = buf.readBigUInt64BE(pos), pos += 8;
  else throw new WebAuthnError('CBOR: indefinite lengths are not used by WebAuthn');
  const n = () => {
    if (typeof len === 'bigint') throw new WebAuthnError('CBOR length too large');
    if (pos + len > buf.length && (major === 2 || major === 3)) throw new WebAuthnError('CBOR ends early');
    return len;
  };
  switch (major) {
    case 0: return [typeof len === 'bigint' ? len : len, pos];
    case 1: return [typeof len === 'bigint' ? -1n - len : -1 - len, pos];
    case 2: { const l = n(); return [buf.subarray(pos, pos + l), pos + l]; }
    case 3: { const l = n(); return [buf.subarray(pos, pos + l).toString('utf8'), pos + l]; }
    case 4: {
      const l = n();
      if (l > 1000) throw new WebAuthnError('CBOR array too long');
      const out: Cbor[] = [];
      for (let i = 0; i < l; i++) { const [v, p] = cborDecode(buf, pos, depth + 1); out.push(v); pos = p; }
      return [out, pos];
    }
    case 5: {
      const l = n();
      if (l > 1000) throw new WebAuthnError('CBOR map too long');
      const out = new Map<Cbor, Cbor>();
      for (let i = 0; i < l; i++) {
        const [k, p1] = cborDecode(buf, pos, depth + 1);
        const [v, p2] = cborDecode(buf, p1, depth + 1);
        out.set(k, v); pos = p2;
      }
      return [out, pos];
    }
    case 7:
      if (info === 20) return [false, pos];
      if (info === 21) return [true, pos];
      if (info === 22) return [null, pos];
      if (info === 23) return [undefined, pos];
      throw new WebAuthnError('CBOR: floats are not used by WebAuthn');
    default:
      throw new WebAuthnError('CBOR: tags are not used by WebAuthn');
  }
}

// ------------------------------------------------------------------ COSE keys (RFC 9053) → Node key objects

/** A credential public key (COSE_Key) as a JWK, with its algorithm. */
export function coseToJwk(cose: Map<Cbor, Cbor>): { alg: number; jwk: Record<string, string> } {
  const kty = cose.get(1);
  const alg = Number(cose.get(3));
  const bytes = (k: number) => {
    const v = cose.get(k);
    if (!Buffer.isBuffer(v)) throw new WebAuthnError('the key is missing a part');
    return b64url(v);
  };
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) } };
  if (kty === 1 && alg === -8 && cose.get(-1) === 6) return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) } };
  throw new WebAuthnError(`unsupported key type or algorithm (${String(kty)}, ${alg})`);
}

const keyOf = (jwk: Record<string, string>): KeyObject => createPublicKey({ key: jwk, format: 'jwk' });

// ------------------------------------------------------------------ authenticator data

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  publicKey?: Map<Cbor, Cbor>;
}

export const FLAG_UP = 0x01; // user present
export const FLAG_UV = 0x04; // user verified
const FLAG_AT = 0x40; // attested credential data included

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new WebAuthnError('authenticator data too short');
  const out: AuthData = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (buf.length < 55) throw new WebAuthnError('authenticator data too short');
    const idLen = buf.readUInt16BE(53);
    if (idLen > 1023 || buf.length < 55 + idLen) throw new WebAuthnError('bad credential id');
    out.credentialId = buf.subarray(55, 55 + idLen);
    const [key] = cborDecode(buf, 55 + idLen);
    if (!(key instanceof Map)) throw new WebAuthnError('bad credential public key');
    out.publicKey = key;
  }
  return out;
}

// ------------------------------------------------------------------ checks

export interface Expected { challenge: string; origin: string; rpId: string }

function checkClientData(clientDataJSON: Buffer, type: string, exp: Expected) {
  let c: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try {
    c = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    throw new WebAuthnError('client data is not JSON');
  }
  if (c.type !== type) throw new WebAuthnError(`expected ${type}`);
  const a = Buffer.from(String(c.challenge ?? ''));
  const b = Buffer.from(exp.challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebAuthnError('the challenge does not match');
  if (c.origin !== exp.origin) throw new WebAuthnError(`the origin ${c.origin} is not ${exp.origin}`);
  if (c.crossOrigin) throw new WebAuthnError('cross-origin use is not allowed');
}

const rpHash = (rpId: string) => createHash('sha256').update(rpId).digest();

/** A new passkey from navigator.credentials.create(): the credential to store. */
export function verifyRegistration(input: { clientDataJSON: string; attestationObject: string }, exp: Expected) {
  const clientData = unb64url(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.create', exp);
  const [att] = cborDecode(unb64url(input.attestationObject));
  if (!(att instanceof Map)) throw new WebAuthnError('bad attestation object');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError('bad attestation object');
  const a = parseAuthData(authData);
  if (!a.rpIdHash.equals(rpHash(exp.rpId))) throw new WebAuthnError('the passkey is for another site');
  if (!(a.flags & FLAG_UP)) throw new WebAuthnError('the user was not present');
  if (!a.credentialId || !a.publicKey) throw new WebAuthnError('no credential in the response');
  const { alg, jwk } = coseToJwk(a.publicKey);
  keyOf(jwk); // a key Node can read
  return { credentialId: b64url(a.credentialId), alg, jwk, signCount: a.signCount, userVerified: !!(a.flags & FLAG_UV) };
}

/** A sign-in from navigator.credentials.get(): the new signature counter, or an error. */
export function verifyAssertion(
  input: { clientDataJSON: string; authenticatorData: string; signature: string },
  stored: { alg: number; jwk: Record<string, string>; signCount: number },
  exp: Expected,
) {
  const clientData = unb64url(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', exp);
  const authData = unb64url(input.authenticatorData);
  const a = parseAuthData(authData);
  if (!a.rpIdHash.equals(rpHash(exp.rpId))) throw new WebAuthnError('the passkey is for another site');
  if (!(a.flags & FLAG_UP)) throw new WebAuthnError('the user was not present');
  const data = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
  const sig = unb64url(input.signature);
  const ok = stored.alg === -8 ? verify(null, data, keyOf(stored.jwk), sig) : verify('sha256', data, keyOf(stored.jwk), sig);
  if (!ok) throw new WebAuthnError('the signature does not match');
  // counters only go up; 0 and 0 means the authenticator keeps none (synced passkeys)
  if ((a.signCount !== 0 || stored.signCount !== 0) && a.signCount <= stored.signCount) throw new WebAuthnError('the signature counter went back (a cloned key?)');
  return { signCount: a.signCount, userVerified: !!(a.flags & FLAG_UV) };
}

// ------------------------------------------------------------------ the relying party

/**
 * The relying party a passkey belongs to and the origin the browser must report. With PUBLIC_URL set (a
 * production server), that address; otherwise the address the browser used (development, tests).
 * PGKILN_RP_ID may widen the RP ID to a parent domain (builder.example.com → example.com), which must be a
 * suffix of the origin's host; passkeys made for one RP ID don't work for another, so changing the domain
 * means adding them again (authenticator apps and recovery codes keep working).
 */
export function relyingParty(req: { protocol: string; host: string }): { rpId: string; origin: string } {
  let origin = `${req.protocol}://${req.host}`;
  if (process.env.PUBLIC_URL) {
    try {
      origin = new URL(process.env.PUBLIC_URL).origin;
    } catch {
      // a bad PUBLIC_URL: the browser's address
    }
  }
  const host = new URL(origin).hostname;
  const wanted = (process.env.PGKILN_RP_ID ?? '').trim().toLowerCase();
  const rpId = wanted && (host === wanted || host.endsWith(`.${wanted}`)) ? wanted : host;
  return { rpId, origin };
}
