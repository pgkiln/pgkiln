// A software authenticator for the passkey tests (sprint 127; shared with app-passkeys.test.ts in sprint 131): an EC
// P-256 or Ed25519 key made here answers the server's WebAuthn options the way a browser would.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const ORIGIN = 'http://localhost:80';

// ------------------------------------------------------------------ a small CBOR encoder (for the test only)

export function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('unsupported');
}

export const b64u = (b: Buffer) => b.toString('base64url');
export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

export class Authenticator {
  readonly id: Buffer;
  readonly priv: KeyObject;
  readonly pub: KeyObject;
  count = 0;
  constructor(readonly kind: 'es256' | 'ed25519' = 'es256', readonly counts = true) {
    this.id = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
    const k = kind === 'es256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
    this.priv = k.privateKey;
    this.pub = k.publicKey;
  }
  cose() {
    const j = this.pub.export({ format: 'jwk' });
    return this.kind === 'es256'
      ? new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x!, 'base64url')], [-3, Buffer.from(j.y!, 'base64url')]])
      : new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(j.x!, 'base64url')]]);
  }
  authData(rpId: string, attested: boolean, flags = 0x05) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counts ? ++this.count : 0);
    const parts: Buffer[] = [sha(rpId), Buffer.from([flags | (attested ? 0x40 : 0)]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), len, this.id, cbor(this.cose()));
    }
    return Buffer.concat(parts);
  }
  create(challenge: string, origin = ORIGIN, rpId = 'localhost') {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(rpId, true)]]));
    return { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject) };
  }
  get(challenge: string, origin = ORIGIN, rpId = 'localhost', flags = 0x05) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const authenticatorData = this.authData(rpId, false, flags);
    const data = Buffer.concat([authenticatorData, sha(clientDataJSON)]);
    const signature = this.kind === 'es256' ? sign('sha256', data, this.priv) : sign(null, data, this.priv);
    return { credentialId: b64u(this.id), clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) };
  }
}
