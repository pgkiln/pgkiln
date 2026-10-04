import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

// Outgoing HTTP requests to web services (REST data sources, web credential
// token endpoints, the Invoke API process), with the server-side request
// forgery protections in one place:
//
// - only http and https, no user name or password in the URL;
// - the host must be on the allow-list PGAPEX_REST_ALLOWED_HOSTS
//   (comma separated: "api.example.com", "*.example.com" for subdomains,
//   "host:8443" for one port, "*" for any public host); unset = no calls;
// - the addresses a host name resolves to are checked when the connection
//   is made (the checked address is the one connected to, so DNS rebinding
//   can't swap it): private, loopback, link-local, CGNAT, multicast and
//   other special ranges are refused unless the host is also listed in
//   PGAPEX_REST_PRIVATE_HOSTS (which implies allowed);
// - redirects are followed (at most 3) only to URLs that pass the same
//   checks, and request headers marked secret are dropped when a redirect
//   leaves the origin;
// - a time limit for the whole exchange and a size limit for the response
//   (PGAPEX_REST_MAX_BYTES, default 5 MB, also after decompression).
//
// node:http/https rather than fetch(): fetch can't pin the checked address.

export class WebError extends Error {
  /** "PGXWS": publicError() logs the details and shows the user a reference */
  readonly code = 'PGXWS';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface WebRequest {
  method?: string;
  headers?: Record<string, string>;
  /** header names (lower case) that carry secrets: dropped on a cross-origin redirect */
  secretHeaders?: string[];
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface WebResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** the URL that answered (after redirects) */
  url: string;
}

const list = (v: string | undefined) => (v ?? '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export const maxResponseBytes = () => {
  const n = Number(process.env.PGAPEX_REST_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 5_000_000;
};

/** Whether `url`'s host matches an allow-list entry. */
function matches(entries: string[], url: URL) {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return entries.some((e) => {
    if (e === '*') return true;
    let h = e;
    let p: string | null = null;
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(e);
    if (m) [h, p] = [m[1], m[2]];
    if (p && p !== port) return false;
    if (h.startsWith('*.')) return host.endsWith(h.slice(1)) && host.length > h.length - 1;
    return host === h;
  });
}

/** Why the URL may not be called (null: it may, so far as the host name goes). */
export function urlProblem(raw: string | URL): string | null {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return 'The URL is not valid.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https URLs can be called.';
  if (url.username || url.password) return 'The URL may not contain a user name or password: use a web credential.';
  const priv = list(process.env.PGAPEX_REST_PRIVATE_HOSTS);
  if (!matches([...list(process.env.PGAPEX_REST_ALLOWED_HOSTS), ...priv], url))
    return `The host ${url.host} is not on the server's allow-list (PGAPEX_REST_ALLOWED_HOSTS).`;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host) && !matches(priv, url))
    return `The address ${host} is private, loopback or link-local (allow it with PGAPEX_REST_PRIVATE_HOSTS).`;
  return null;
}

// ---------------------------------------------------------------- addresses

const blocked = new net.BlockList();
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 32],
] as const)
  blocked.addSubnet(a, bits, 'ipv6');

/** Private, loopback, link-local, multicast, documentation and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::a.b.c.d): check the IPv4 address
  const embedded = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return isPrivateAddress(embedded[1]);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  // 6to4 (2002:AABB:CCDD::) carries an IPv4 address too
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  if (sixToFour) {
    const n = (parseInt(sixToFour[1], 16) << 16) | parseInt(sixToFour[2], 16);
    if (isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'))) return true;
  }
  return blocked.check(ip, 'ipv6');
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup that refuses non-public addresses: the connection uses the address checked here. */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const list = addresses as dns.LookupAddress[];
      if (!list.length) return cb(Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }), '');
      const bad = allowPrivate ? undefined : list.find((a) => isPrivateAddress(a.address));
      if (bad)
        return cb(Object.assign(new WebError(`The host ${hostname} resolves to a private, loopback or link-local address (allow it with PGAPEX_REST_PRIVATE_HOSTS).`), { code: 'PGXWS' }) as never, '');
      if (options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
}

// ---------------------------------------------------------------- requests

function once(url: URL, req: WebRequest, deadline: number, maxBytes: number): Promise<WebResponse> {
  const allowPrivate = matches(list(process.env.PGAPEX_REST_PRIVATE_HOSTS), url);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new WebError('The web service did not answer in time.'));
    const r = lib.request(
      url,
      {
        method: req.method ?? 'GET',
        headers: req.headers,
        agent: false,
        lookup: guardedLookup(allowPrivate) as never,
      },
      (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return reject(new WebError(`The response is larger than ${maxBytes} bytes.`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new WebError(`The response is larger than ${maxBytes} bytes.`));
          } else chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          clearTimeout(timer);
          let body = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
          try {
            if (enc === 'gzip' || enc === 'x-gzip') body = zlib.gunzipSync(body, { maxOutputLength: maxBytes });
            else if (enc === 'deflate') body = zlib.inflateSync(body, { maxOutputLength: maxBytes });
            else if (enc === 'br') body = zlib.brotliDecompressSync(body, { maxOutputLength: maxBytes });
          } catch {
            return reject(new WebError(`The response could not be decompressed, or is larger than ${maxBytes} bytes.`));
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, url: url.toString() });
        });
      },
    );
    const timer = setTimeout(() => r.destroy(new WebError('The web service did not answer in time.')), left);
    r.on('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof WebError ? e : new WebError(`The web service could not be reached (${(e as NodeJS.ErrnoException).code ?? e.message}).`));
    });
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/** Call a web service with the server's protections (see the top of this file). */
export async function webRequest(raw: string, req: WebRequest = {}): Promise<WebResponse> {
  const maxBytes = Math.min(req.maxBytes ?? maxResponseBytes(), maxResponseBytes());
  const deadline = Date.now() + Math.min(Math.max(req.timeoutMs ?? 10_000, 100), 60_000);
  let url = new URL(raw);
  let headers: Record<string, string> = { 'user-agent': 'pgapex', 'accept-encoding': 'gzip, deflate', ...req.headers };
  let method = (req.method ?? 'GET').toUpperCase();
  let body = req.body;
  const origin = url.origin;
  for (let hop = 0; ; hop++) {
    const problem = urlProblem(url);
    if (problem) throw new WebError(problem);
    const res = await once(url, { ...req, method, headers, body }, deadline, maxBytes);
    const location = res.headers.location;
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
    if (hop >= 3) throw new WebError('The web service redirected too often.');
    url = new URL(location, url);
    // secrets stay with the origin they were meant for
    if (url.origin !== origin) {
      const drop = new Set((req.secretHeaders ?? []).map((h) => h.toLowerCase()));
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())));
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)));
    }
  }
}
