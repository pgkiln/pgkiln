// (sprint 244, MG-29) OneDrive / SharePoint as object storage for file items: the provider "graph" of
// config.object_store (src/objectstore.ts has the S3 one and dispatches here). The files go to a folder of a
// drive through Microsoft Graph, so they stay where the office reads them:
//
//   {"object_store": {"provider": "graph", "drive": "b!…", "folder": "HR/Documents", "credential": "GRAPH_HR"}}
//
// - drive: a drive id (/drives/{id}: a OneDrive or a document library), or site: a SharePoint site id
//   (/sites/{id}/drive: its default document library); url: the Graph base (default
//   https://graph.microsoft.com/v1.0; a national cloud, or a stub in tests).
// - credential: a web credential of type oauth2 (client credentials app-only with Files.ReadWrite.All or
//   Sites.Selected, or a delegated authorization code / refresh token) or bearer. Every request goes through
//   websources.call() / webupload.sendBinary(): the host allow-list, the private-address checks, the workspace's
//   network access list and the credential's "valid for" URLs apply.
// - A file of at most 4 MiB is PUT to …/root:/{folder}/{name}:/content; a larger one through an upload session
//   (createUploadSession, then ranges of 3 MiB PUT to its upload URL without the credential, as Graph wants).
//   Names that exist already get a number (conflictBehavior rename).
// - The item's source column holds the drive item's id, so a file the office renames or moves within the folder is
//   still found. Before a download or a delete the item must lie in the configured folder (or below it): a key
//   written into the table some other way can't reach the rest of the drive.
// - Downloads go through pgkiln (…/items/{id}/content; Graph's pre-authenticated download URL is followed by the
//   server, never handed to the browser, and the credential is not sent to it).
import { WebError, type WebResponse } from './webclient.ts';
import { call, loadCredential, type WebCredential } from './websources.ts';
import { sendBinary } from './webupload.ts';
import { staticPart, SUBST } from './objectstore.ts';

export interface GraphStoreConfig {
  provider: 'graph';
  /** a web credential of type oauth2 or bearer */
  credential: string;
  /** a drive id: /drives/{drive} */
  drive?: string;
  /** a SharePoint site id (host,site-guid,web-guid): /sites/{site}/drive, used when there is no drive */
  site?: string;
  /** the folder in the drive, e.g. "HR/Documents" (default: the drive's root) */
  folder?: string;
  /** the Graph base URL (default https://graph.microsoft.com/v1.0) */
  url?: string;
}

export const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
/** Files up to this size are sent in one PUT (Graph: simple upload for files up to 4 MB). */
export const GRAPH_SIMPLE_MAX = 4 * 1024 * 1024;
/** Ranges of an upload session: a multiple of 320 KiB, as Graph requires. */
export const GRAPH_CHUNK = 10 * 327_680;

const DRIVE = /^(?!\.+$)[A-Za-z0-9!_.-]{1,200}$/;
const SITE = /^(?!\.+$)[A-Za-z0-9.,_-]{1,300}$/;
const ITEM = /^(?!\.+$)[A-Za-z0-9!_.-]{1,200}$/;
const SEGMENT = /^[\p{L}\p{N} _.()&'+,!#$%@=~-]{1,120}$/u;

/** The folder's segments ("/HR/Documents/" → ["HR", "Documents"]). */
const segments = (folder: string | undefined) => (folder ?? '').split('/').filter(Boolean);

/** What's wrong with a graph object_store configuration, or null. */
export function graphProblem(c: Record<string, unknown>): string | null {
  const shape = 'object_store: {"provider": "graph", "drive": "b!…" (or "site": "…"), "folder": "HR/Documents", "credential": "NAME"}.';
  if (c.url !== undefined) {
    try {
      const u = new URL(String(c.url));
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
    } catch {
      return 'object_store.url: the Graph base URL, e.g. https://graph.microsoft.com/v1.0 (http(s), without user, query or fragment).';
    }
  }
  if (typeof c.credential !== 'string' || !/^[A-Z][A-Z0-9_]{0,59}$/i.test(c.credential)) return 'object_store.credential: the name of a web credential of type OAuth2 (or bearer token).';
  if (c.drive === undefined && c.site === undefined) return `object_store: a graph store needs "drive" (a drive id) or "site" (a SharePoint site id). ${shape}`;
  if (c.drive !== undefined && (typeof c.drive !== 'string' || !DRIVE.test(c.drive))) return 'object_store.drive: a drive id (letters, digits and ! _ . -).';
  if (c.site !== undefined && (typeof c.site !== 'string' || !SITE.test(c.site))) return 'object_store.site: a site id, e.g. contoso.sharepoint.com,<site guid>,<web guid>.';
  if (c.folder !== undefined) {
    if (typeof c.folder !== 'string' || c.folder.length > 400) return 'object_store.folder: a folder path, e.g. "HR/Documents".';
    // (sprint 253, MG-31) &ITEM. substitutions are checked as a plain segment
    for (const s of segments(c.folder.replace(SUBST, 'x')))
      if (!SEGMENT.test(s) || /^\.+$/.test(s) || s !== s.trim() || s.endsWith('.'))
        return `object_store.folder: "${s}" is not a folder name (no .., no " * : < > ? \\ |, no leading or trailing spaces or dots).`;
  }
  for (const k of Object.keys(c)) if (!['provider', 'credential', 'drive', 'site', 'folder', 'url'].includes(k)) return `object_store: unknown key "${k}". ${shape}`;
  return null;
}

/** A file name Graph and SharePoint accept: letters, digits, _ . -, never a path; reserved names get a prefix. */
export function graphFileName(filename: string) {
  let s = filename.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^[.~]+/, '').replace(/\.+$/, '').slice(-100) || 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s) || /_vti_/i.test(s) || /^desktop\.ini$/i.test(s) || /\.lock$/i.test(s)) s = `file_${s}`;
  return s;
}

const base = (o: GraphStoreConfig) => (o.url ?? GRAPH_URL).replace(/\/+$/, '');
/** The drive's URL: /drives/{drive} or /sites/{site}/drive. */
export const driveUrl = (o: GraphStoreConfig) =>
  // (sprint 253) "drive": "me": the signed-in user's OneDrive (a delegated credential)
  o.drive === 'me' ? `${base(o)}/me/drive` : o.drive ? `${base(o)}/drives/${o.drive}` : `${base(o)}/sites/${o.site}/drive`;
/** The URL of a path below the folder: …/root:/HR/Documents/a.pdf: (each segment encoded). */
export const pathUrl = (o: GraphStoreConfig, name: string) => `${driveUrl(o)}/root:/${[...segments(o.folder), name].map(encodeURIComponent).join('/')}:`;

function checked(o: GraphStoreConfig) {
  // checked here too: a configuration may have come in through SQL or an import
  const problem = graphProblem(o as unknown as Record<string, unknown>);
  if (problem) throw new WebError(problem);
}

async function credentialFor(appId: number, name: string) {
  const c = await loadCredential(appId, name);
  if (c.type !== 'oauth2' && c.type !== 'bearer') throw new WebError(`Web credential ${c.name} is not of type OAuth2 or bearer token (a OneDrive / SharePoint store needs one).`);
  return c;
}

const what = (c: WebCredential) => `object storage (web credential ${c.name})`;
const ok = (r: WebResponse) => r.status >= 200 && r.status < 300;
const json = (r: WebResponse): Record<string, any> | null => {
  try {
    const v = JSON.parse(r.body.toString('utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

/** The id of the drive item an upload answered with. */
function itemId(r: WebResponse) {
  const id = json(r)?.id;
  if (typeof id !== 'string' || !ITEM.test(id)) throw new WebError('Microsoft Graph did not answer the upload with the item\'s id.');
  return id;
}

/** Store a file in the folder; returns the drive item's id. */
export async function putGraph(appId: number, o: GraphStoreConfig, filename: string, content: Buffer, mime: string) {
  checked(o);
  const cred = await credentialFor(appId, o.credential);
  const target = pathUrl(o, graphFileName(filename));
  if (content.length <= GRAPH_SIMPLE_MAX) {
    const res = await sendBinary({ appId, what: what(cred), credential: cred, method: 'PUT', url: `${target}/content?@microsoft.graph.conflictBehavior=rename`, body: content, contentType: mime || 'application/octet-stream', timeoutMs: 60_000 });
    if (!ok(res)) throw new WebError(`Microsoft Graph refused the file (HTTP ${res.status}).`, res.status);
    return itemId(res);
  }
  const session = await call({
    appId, what: what(cred), credential: cred, method: 'POST', url: `${target}/createUploadSession`, timeoutMs: 60_000,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
  });
  if (!ok(session)) throw new WebError(`Microsoft Graph refused the upload session (HTTP ${session.status}).`, session.status);
  const uploadUrl = json(session)?.uploadUrl;
  if (typeof uploadUrl !== 'string' || !/^https?:\/\//i.test(uploadUrl)) throw new WebError('Microsoft Graph did not answer with an upload URL.');
  // the upload URL is pre-authenticated: no credential (Graph refuses an Authorization header there); the
  // allow-list and address checks still apply to its host
  const res = await sendBinary({ appId, what: what(cred), credential: null, url: uploadUrl, body: content, chunkBytes: GRAPH_CHUNK, timeoutMs: 60_000 }).catch(async (e) => {
    await call({ appId, what: what(cred), method: 'DELETE', url: uploadUrl }).catch(() => {});
    throw e;
  });
  if (!ok(res)) {
    await call({ appId, what: what(cred), method: 'DELETE', url: uploadUrl }).catch(() => {});
    throw new WebError(`Microsoft Graph refused the file (HTTP ${res.status}).`, res.status);
  }
  return itemId(res);
}

/**
 * Whether the item lies in the configured folder (or below it): true, false, or null when it is not there. The
 * key comes from the application's table; this keeps a key that was written there some other way from reaching
 * files elsewhere in the drive.
 */
async function inFolder(appId: number, o: GraphStoreConfig, cred: WebCredential, id: string): Promise<boolean | null> {
  if (!ITEM.test(id)) return false;
  const res = await call({ appId, what: what(cred), credential: cred, url: `${driveUrl(o)}/items/${id}?$select=id,parentReference`, timeoutMs: 60_000 });
  if (res.status === 404) return null;
  if (!ok(res)) throw new WebError(`Microsoft Graph did not find the file (HTTP ${res.status}).`, res.status);
  const path = json(res)?.parentReference?.path;
  if (typeof path !== 'string') return false;
  const at = path.indexOf('root:');
  if (at < 0) return false;
  let parent: string;
  try {
    parent = decodeURIComponent(path.slice(at + 5));
  } catch {
    return false;
  }
  // (sprint 253, MG-31) a folder with &ITEM. substitutions: anywhere below its static part (any record's subfolder)
  const want = segments(staticPart(o.folder)).join('/').toLowerCase();
  const have = segments(parent);
  if (have.some((s) => s === '..' || s === '.')) return false;
  const p = have.join('/').toLowerCase();
  return !want || p === want || p.startsWith(`${want}/`);
}

const maxDownload = () => Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024 + 1024;

/** A stored file's content, or null when it is not there. */
export async function getGraph(appId: number, o: GraphStoreConfig, id: string) {
  checked(o);
  const cred = await credentialFor(appId, o.credential);
  const where = await inFolder(appId, o, cred, id);
  if (where === null) return null;
  if (!where) throw new WebError(`The file ${id} is not in the folder of the OneDrive / SharePoint store.`);
  // Graph answers with a redirect to a pre-authenticated download URL: followed here (secret headers are dropped
  // when it leaves Graph's origin), never sent to the browser
  const res = await call({ appId, what: what(cred), credential: cred, url: `${driveUrl(o)}/items/${id}/content`, headers: { accept: '*/*', 'accept-encoding': 'identity' }, timeoutMs: 60_000, maxBytes: maxDownload(), allowLarge: true });
  if (res.status === 404) return null;
  if (!ok(res)) throw new WebError(`Microsoft Graph did not return the file (HTTP ${res.status}).`, res.status);
  return res.body;
}

/** Remove a stored file (a missing one is fine; one outside the folder is refused). */
export async function deleteGraph(appId: number, o: GraphStoreConfig, id: string) {
  checked(o);
  const cred = await credentialFor(appId, o.credential);
  const where = await inFolder(appId, o, cred, id);
  if (where === null) return;
  if (!where) throw new WebError(`The file ${id} is not in the folder of the OneDrive / SharePoint store: not removed.`);
  const res = await call({ appId, what: what(cred), credential: cred, method: 'DELETE', url: `${driveUrl(o)}/items/${id}`, timeoutMs: 60_000 });
  if (res.status !== 404 && !ok(res)) throw new WebError(`Microsoft Graph did not remove the file (HTTP ${res.status}).`, res.status);
}
