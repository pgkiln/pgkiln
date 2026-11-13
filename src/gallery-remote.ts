import { owner } from './db.ts';
import { isIcon } from './icons.ts';
import { webRequest, WebError, type OutboundScope } from './webclient.ts';

// (sprint 181, WS-8 leftover; migration 164) Remote catalogues for the App Gallery: an administrator adds the URL
// of a catalogue in the format of examples/gallery/gallery.json, with starter and utility apps whose `url` names
// their blueprint. The catalogue is fetched with the guarded web client (PGKILN_REST_ALLOWED_HOSTS, no private
// addresses, size and time limits) when it is added and on Refresh; only checked entries are kept. A blueprint is
// fetched when a developer installs it and opens in the blueprint review. Sample apps (SQL run as pgkiln's owner)
// are never taken from a remote catalogue.

export type RemoteKind = 'starters' | 'utilities';
export const REMOTE_KINDS: readonly RemoteKind[] = ['starters', 'utilities'];

export interface RemoteEntry {
  key: string;
  title: string;
  icon: string;
  description: string;
  version: string;
  /** the blueprint's absolute URL (resolved against the catalogue's) */
  url: string;
}

export interface GallerySource {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  catalogue: Partial<Record<RemoteKind, RemoteEntry[]>>;
  fetched_at: string | null;
  error: string | null;
}

export const CATALOGUE_MAX_BYTES = 1_000_000;
export const BLUEPRINT_MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 100;
export const MAX_SOURCES = 10;
const KEY = /^[a-z][a-z0-9-]{0,40}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Why a catalogue or blueprint URL is not one pgkiln fetches (null: it is, as far as its form goes). */
export function sourceUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'The URL is not valid.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http and https URLs can be fetched.';
  if (u.username || u.password) return 'The URL may not contain a user name or password.';
  if (raw.length > 2000) return 'The URL is too long.';
  return null;
}

/**
 * The checked entries of a catalogue document: starters and utilities only, at most 100 each, every field cut to
 * size, unknown icons replaced, keys unique, blueprint URLs resolved against the catalogue's URL and http(s) only.
 * Returns the problems that left entries out, so the administrator sees them.
 */
export function parseCatalogue(doc: unknown, base: string): { catalogue: Record<RemoteKind, RemoteEntry[]>; problems: string[] } {
  const catalogue: Record<RemoteKind, RemoteEntry[]> = { starters: [], utilities: [] };
  const problems: string[] = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { catalogue, problems: ['The catalogue is not a JSON object.'] };
  const d = doc as Record<string, unknown>;
  if (Array.isArray(d.samples) && d.samples.length) problems.push('Sample apps are left out: a remote catalogue can only list starter and utility apps (blueprints).');
  for (const kind of REMOTE_KINDS) {
    const list = Array.isArray(d[kind]) ? (d[kind] as unknown[]) : [];
    if (list.length > MAX_ENTRIES) problems.push(`Only the first ${MAX_ENTRIES} ${kind} are listed.`);
    const seen = new Set<string>();
    for (const raw of list.slice(0, MAX_ENTRIES)) {
      const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const key = typeof x.key === 'string' ? x.key : '';
      if (!KEY.test(key) || seen.has(key)) {
        problems.push(`A ${kind.slice(0, -1)} without a valid, unique key is left out.`);
        continue;
      }
      const title = text(x.title, 100);
      let url = '';
      try {
        url = typeof x.url === 'string' ? new URL(x.url, base).toString() : '';
      } catch {
        url = '';
      }
      const bad = url ? sourceUrlProblem(url) : 'it has no blueprint URL';
      if (!title || bad) {
        problems.push(`${key}: left out (${!title ? 'it has no title' : bad}).`);
        continue;
      }
      seen.add(key);
      const ic = typeof x.icon === 'string' && x.icon.length <= 60 && isIcon(x.icon) ? x.icon : 'package';
      catalogue[kind].push({ key, title, icon: ic, description: text(x.description, 500), version: typeof x.version === 'string' && VERSION.test(x.version) ? x.version : '', url });
    }
  }
  return { catalogue, problems };
}

async function fetchJson(url: string, maxBytes: number, scope: OutboundScope | null): Promise<{ json: unknown; url: string }> {
  const res = await webRequest(url, { headers: { accept: 'application/json' }, timeoutMs: TIMEOUT_MS, maxBytes, scope });
  if (res.status < 200 || res.status > 299) throw new WebError(`The server answered ${res.status}.`, res.status);
  try {
    return { json: JSON.parse(res.body.toString('utf8')), url: res.url };
  } catch {
    throw new WebError('The answer is not JSON.');
  }
}

/** Fetch a source's catalogue and keep its checked entries; a failure keeps the previous entries and records why. */
export async function refreshSource(id: number): Promise<{ ok: boolean; problems: string[]; count: number }> {
  const src = await owner.one<{ url: string }>('select url from meta.gallery_source where id = $1', [id]);
  if (!src) return { ok: false, problems: ['The catalogue no longer exists.'], count: 0 };
  try {
    const { json, url } = await fetchJson(src.url, CATALOGUE_MAX_BYTES, null);
    const { catalogue, problems } = parseCatalogue(json, url);
    await owner.query(`update meta.gallery_source set catalogue = $2, fetched_at = now(), error = $3 where id = $1`,
      [id, JSON.stringify(catalogue), problems.length ? problems.join(' ').slice(0, 2000) : null]);
    return { ok: true, problems, count: catalogue.starters.length + catalogue.utilities.length };
  } catch (e) {
    const message = (e as Error).message.slice(0, 2000);
    await owner.query('update meta.gallery_source set error = $2 where id = $1', [id, message]);
    return { ok: false, problems: [message], count: 0 };
  }
}

export async function gallerySources(enabledOnly: boolean): Promise<GallerySource[]> {
  return (await owner.query<GallerySource>(
    `select id, name, url, enabled, catalogue, to_char(fetched_at, 'YYYY-MM-DD HH24:MI') as fetched_at, error
       from meta.gallery_source ${enabledOnly ? 'where enabled' : ''} order by lower(name), id`)).rows;
}

/** A remote entry's blueprint as JSON text for the review (fetched now, through the workspace's network list). */
export async function remoteBlueprint(entry: RemoteEntry, scope: OutboundScope | null): Promise<string> {
  const { json } = await fetchJson(entry.url, BLUEPRINT_MAX_BYTES, scope);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new WebError('The blueprint is not a JSON object.');
  return JSON.stringify(json, null, 2);
}
