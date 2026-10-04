// HTTP-header authentication (APEX: HTTP Header Variable). A reverse proxy or
// single sign-on gateway in front of pgapex authenticates the user and passes
// the user name in a request header (by default X-Remote-User). Anyone can
// send that header, so it is trusted only when the direct peer of the TCP
// connection (the socket address, never X-Forwarded-For) is one of the proxy
// addresses in PGAPEX_AUTH_HEADER_PROXIES (comma separated IPs and CIDRs).
// Unset: header authentication is refused.

import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { owner } from './db.ts';
import type { App } from './metadata.ts';
import type { MessageKey } from './i18n.ts';

export const DEFAULT_HEADER = 'X-Remote-User';
/** printable ASCII without spaces and colons (meta.account.username allows no whitespace or colon) */
const VALUE = /^[\x21-\x39\x3b-\x7e]{1,100}$/;

let cached: { spec: string; list: BlockList | null } | undefined;

/** The proxies from PGAPEX_AUTH_HEADER_PROXIES; null when unset or empty. Invalid entries are ignored. */
function proxies(): BlockList | null {
  const spec = process.env.PGAPEX_AUTH_HEADER_PROXIES ?? '';
  if (cached?.spec === spec) return cached.list;
  const list = new BlockList();
  let n = 0;
  for (const entry of spec.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [addr, bits] = entry.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : isIP(addr) === 4 ? 'ipv4' : null;
    if (!type) continue;
    if (bits === undefined) list.addAddress(addr, type);
    else if (/^\d{1,3}$/.test(bits) && Number(bits) <= (type === 'ipv4' ? 32 : 128)) list.addSubnet(addr, Number(bits), type);
    else continue;
    n++;
  }
  cached = { spec, list: n ? list : null };
  return cached.list;
}

export const headerProxiesConfigured = () => proxies() !== null;

/** Whether the socket peer is a configured proxy (IPv4-mapped IPv6 addresses count as IPv4). */
export function trustedPeer(addr: string | undefined) {
  const list = proxies();
  if (!list || !addr) return false;
  const v4 = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4) return list.check(v4, 'ipv4');
  const type = isIP(addr);
  return type === 4 ? list.check(addr, 'ipv4') : type === 6 ? list.check(addr, 'ipv6') : false;
}

/** The direct peer of the connection; X-Forwarded-For and TRUST_PROXY play no part. */
export const peerAddress = (req: FastifyRequest) => req.raw.socket?.remoteAddress;

/** The header value: undefined when absent or empty, null when invalid (repeated, too long, odd characters). */
export function headerValue(req: FastifyRequest, a: Pick<App, 'header_name'>): string | null | undefined {
  const raw = req.headers[(a.header_name || DEFAULT_HEADER).toLowerCase()];
  if (raw === undefined || raw === '') return undefined;
  if (Array.isArray(raw)) return null;
  const v = raw.trim();
  if (!v) return undefined;
  return VALUE.test(v) ? v : null;
}

export class HeaderAuthError extends Error {
  constructor(public key: MessageKey) {
    super(key);
  }
}

/**
 * The account for a header value: an existing active account (case-insensitive),
 * or, when the app creates accounts automatically, a new account with access to the app.
 */
export async function resolveHeaderAccount(a: Pick<App, 'id' | 'header_auto_create'>, value: string) {
  return owner.tx(async (c) => {
    let acc = (await c.query<{ id: number; username: string; active: boolean }>(
      'select id, username, active from meta.account where lower(username) = lower($1)', [value])).rows[0];
    if (!acc) {
      if (!a.header_auto_create) throw new HeaderAuthError('login.no_account');
      acc = (await c.query<{ id: number; username: string; active: boolean }>(
        `insert into meta.account (username) values ($1)
           on conflict do nothing returning id, username, active`, [value])).rows[0]
        ?? (await c.query<{ id: number; username: string; active: boolean }>(
          'select id, username, active from meta.account where lower(username) = lower($1)', [value])).rows[0];
      await c.query('insert into meta.app_access (app_id, account_id) values ($1, $2) on conflict do nothing', [a.id, acc.id]);
    }
    if (!acc.active) throw new HeaderAuthError('login.account_disabled');
    await c.query('update meta.account set last_login_at = now() where id = $1', [acc.id]);
    return acc.username;
  });
}
