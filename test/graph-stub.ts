// (sprint 244, MG-29) A tiny Microsoft Graph for the OneDrive / SharePoint object store tests: an OAuth2 token
// endpoint (client credentials), drives addressed as /drives/{id} or /sites/{id}/drive, simple uploads
// (…/root:/{path}:/content), upload sessions (createUploadSession, then ranges PUT to an upload URL on another
// origin), item metadata, downloads (a redirect to a pre-authenticated URL on that other origin) and deletes.
// Every request is logged with whether it carried an Authorization header.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubItem {
  id: string;
  drive: string;
  /** the folder below the root ("HR/Documents") */
  folder: string;
  name: string;
  body: Buffer;
  mime: string;
}

export interface GraphStub {
  /** the Graph base URL, http://127.0.0.1:<port>/v1.0 */
  url: string;
  tokenUrl: string;
  /** the other origin: upload sessions and download URLs */
  filesOrigin: string;
  items: Map<string, StubItem>;
  log: { method: string; path: string; auth: boolean; range?: string }[];
  /** an upload URL to hand out instead of the stub's own (an address the server must refuse) */
  uploadUrlOverride: string | null;
  tokensIssued: number;
  close(): Promise<void>;
}

export const STUB_CLIENT_ID = 'stub-client-id';
export const STUB_CLIENT_SECRET = 'stub-client-secret-do-not-leak';
export const STUB_TOKEN = 'stub-access-token-do-not-leak';

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

export async function startGraphStub(): Promise<GraphStub> {
  const sessions = new Map<string, { drive: string; folder: string; name: string; chunks: Buffer[]; got: number }>();
  const stub: GraphStub = { url: '', tokenUrl: '', filesOrigin: '', items: new Map(), log: [], uploadUrlOverride: null, tokensIssued: 0, close: async () => {} };

  const newId = () => `01STUB${randomBytes(8).toString('hex').toUpperCase()}`;
  const itemJson = (i: StubItem) => ({ id: i.id, name: i.name, size: i.body.length, parentReference: { driveId: i.drive, path: `/drives/${i.drive}/root:${i.folder ? `/${encodeURI(i.folder)}` : ''}` } });
  /** a new item; a name in use gets a number (conflictBehavior rename) */
  const create = (drive: string, folder: string, name: string, body: Buffer, mime: string) => {
    const taken = (n: string) => [...stub.items.values()].some((i) => i.drive === drive && i.folder === folder && i.name === n);
    let n = name;
    for (let k = 1; taken(n); k++) n = name.replace(/(\.[^.]*)?$/, (ext) => ` ${k}${ext}`);
    const item = { id: newId(), drive, folder, name: n, body, mime };
    stub.items.set(item.id, item);
    return item;
  };
  const send = (res: http.ServerResponse, status: number, json?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }).end(json !== undefined ? JSON.stringify(json) : undefined);
  };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const path = url.pathname;
      stub.log.push({ method: req.method!, path, auth: !!req.headers.authorization, range: req.headers['content-range'] as string | undefined });

      // the token endpoint
      if (path === '/oauth/token' && req.method === 'POST') {
        const f = new URLSearchParams(body.toString('utf8'));
        const basic = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''));
        const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString('utf8').split(':') : [f.get('client_id'), f.get('client_secret')];
        if (f.get('grant_type') !== 'client_credentials' || id !== STUB_CLIENT_ID || secret !== STUB_CLIENT_SECRET) return send(res, 401, { error: 'invalid_client' });
        stub.tokensIssued++;
        return send(res, 200, { access_token: STUB_TOKEN, token_type: 'Bearer', expires_in: 3600 });
      }

      // the other origin: upload sessions and download URLs (pre-authenticated: no Authorization expected)
      let m = /^\/upload\/([0-9a-f]+)$/.exec(path);
      if (m) {
        const s = sessions.get(m[1]);
        if (!s) return send(res, 404, { error: { code: 'itemNotFound' } });
        if (req.method === 'DELETE') {
          sessions.delete(m[1]);
          return send(res, 204);
        }
        const r = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
        if (req.method !== 'PUT' || !r || Number(r[1]) !== s.got || Number(r[2]) - Number(r[1]) + 1 !== body.length) return send(res, 416, { error: { code: 'invalidRange' } });
        s.chunks.push(body);
        s.got += body.length;
        if (s.got < Number(r[3])) return send(res, 202, { nextExpectedRanges: [`${s.got}-`] });
        sessions.delete(m[1]);
        return send(res, 201, itemJson(create(s.drive, s.folder, s.name, Buffer.concat(s.chunks), 'application/octet-stream')));
      }
      m = /^\/dl\/([A-Z0-9]+)$/.exec(path);
      if (m) {
        const i = stub.items.get(m[1]);
        if (!i || url.searchParams.get('tempauth') !== `t-${i.id}`) return send(res, 401);
        res.writeHead(200, { 'content-type': i.mime, 'content-length': String(i.body.length) }).end(i.body);
        return;
      }

      // Graph itself: the bearer token is required
      if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return send(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
      m = /^\/v1\.0\/(?:drives\/([^/]+)|sites\/([^/]+)\/drive)(\/.*)$/.exec(path);
      if (!m) return send(res, 400, { error: { code: 'invalidRequest' } });
      const drive = m[1] ? decodeURIComponent(m[1]) : `site:${decodeURIComponent(m[2])}`;
      const rest = m[3];
      m = /^\/root:\/(.+):\/(content|createUploadSession)$/.exec(rest);
      if (m) {
        const parts = m[1].split('/').map(decodeURIComponent);
        const name = parts.pop()!;
        const folder = parts.join('/');
        if (parts.some((p) => p === '..' || p === '.') || name === '..' || name.includes('/')) return send(res, 400, { error: { code: 'invalidRequest' } });
        if (m[2] === 'content' && req.method === 'PUT') {
          if (body.length > 4 * 1024 * 1024) return send(res, 413, { error: { code: 'requestTooLarge' } });
          return send(res, 201, itemJson(create(drive, folder, name, body, String(req.headers['content-type'] ?? 'application/octet-stream'))));
        }
        if (m[2] === 'createUploadSession' && req.method === 'POST') {
          const sid = randomBytes(8).toString('hex');
          sessions.set(sid, { drive, folder, name, chunks: [], got: 0 });
          return send(res, 200, { uploadUrl: stub.uploadUrlOverride ?? `${stub.filesOrigin}/upload/${sid}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
        }
      }
      m = /^\/items\/([^/]+)(\/content)?$/.exec(rest);
      if (m) {
        const i = stub.items.get(decodeURIComponent(m[1]));
        if (!i || i.drive !== drive) return send(res, 404, { error: { code: 'itemNotFound' } });
        if (m[2] && req.method === 'GET') return send(res, 302, undefined, { location: `${stub.filesOrigin}/dl/${i.id}?tempauth=t-${i.id}` });
        if (!m[2] && req.method === 'GET') return send(res, 200, itemJson(i));
        if (!m[2] && req.method === 'DELETE') {
          stub.items.delete(i.id);
          return send(res, 204);
        }
      }
      return send(res, 400, { error: { code: 'invalidRequest' } });
    });
  };

  const graph = http.createServer(handler);
  const files = http.createServer(handler);
  const gp = await listen(graph);
  const fp = await listen(files);
  stub.url = `http://127.0.0.1:${gp}/v1.0`;
  stub.tokenUrl = `http://127.0.0.1:${gp}/oauth/token`;
  stub.filesOrigin = `http://127.0.0.1:${fp}`;
  stub.close = async () => {
    await new Promise((r) => graph.close(r));
    await new Promise((r) => files.close(r));
  };
  return stub;
}

/** An item the stub holds already (a file the office put elsewhere in the drive). */
export function stubItem(stub: GraphStub, drive: string, folder: string, name: string, text: string) {
  const id = `01STUB${randomBytes(8).toString('hex').toUpperCase()}`;
  stub.items.set(id, { id, drive, folder, name, body: Buffer.from(text), mime: 'text/plain' });
  return id;
}
