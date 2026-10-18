import { readFileSync } from 'node:fs';
import { owner } from './db.ts';

// (sprint 109, WS-1) The Workspace home's system message: "pgkiln X is
// available". Off by default: an administrator turns it on (on the Workspace
// home, stored as meta.setting 'release_check') or the server's environment
// does (PGKILN_RELEASE_CHECK=on). Only then does the server ask GitHub's
// releases API for the latest release, server-side, with a timeout and a
// size limit, at most once a day per server process (an hour after a
// failure). Pages never wait for it: they show what is cached and start a
// refresh in the background. The release's texts are data: the page escapes
// them, and only a plain version number and an https link are kept.

/** The running version (package.json). */
export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export const RELEASE_API = 'https://api.github.com/repos/pgkiln/pgkiln/releases/latest';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1_000_000;
const FRESH_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;

export interface Release {
  version: string;
  name: string;
  url: string;
  publishedAt: string | null;
}

let cache: { at: number; release: Release | null; error: string | null } | null = null;
let inflight: Promise<void> | null = null;

/** The address asked (PGKILN_RELEASE_URL for tests and mirrors; http(s) only). */
function releaseUrl() {
  const u = process.env.PGKILN_RELEASE_URL?.trim();
  return u && /^https?:\/\/[^\s]+$/.test(u) && URL.canParse(u) ? u : RELEASE_API;
}

/**
 * Never ask the real GitHub from a test run (node --test sets NODE_TEST_CONTEXT in its test processes; CI has no
 * outbound network guarantee): there only a PGKILN_RELEASE_URL (a local mock) is asked.
 */
function networkAllowed() {
  return !process.env.NODE_TEST_CONTEXT || !!process.env.PGKILN_RELEASE_URL;
}

/** Is the check on? The builder's setting, else the environment variable; off by default. */
export async function releaseCheckEnabled(): Promise<{ on: boolean; from: 'builder' | 'environment' | 'default' }> {
  const row = await owner.one<{ value: string }>(`select value from meta.setting where name = 'release_check'`).catch(() => null);
  if (row?.value === 'on' || row?.value === 'off') return { on: row.value === 'on', from: 'builder' };
  const env = (process.env.PGKILN_RELEASE_CHECK ?? '').trim().toLowerCase();
  if (env) return { on: ['on', 'true', '1', 'yes'].includes(env), from: 'environment' };
  return { on: false, from: 'default' };
}

/** Turn the check on or off ('' = back to the environment variable or the default). */
export async function setReleaseCheck(value: 'on' | 'off' | '') {
  if (value === '') await owner.query(`delete from meta.setting where name = 'release_check'`);
  else await owner.query(`insert into meta.setting (name, value) values ('release_check', $1) on conflict (name) do update set value = excluded.value`, [value]);
  if (value !== 'on') cache = null;
}

const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** Is version a newer than b (plain x.y.z; anything else is not newer)? */
export function newerVersion(a: string, b: string) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b.replace(/[-+].*$/, ''));
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

/** The parts of a GitHub release the page uses, checked; null when it doesn't look like a release. */
export function parseRelease(doc: unknown): Release | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const m = typeof d.tag_name === 'string' ? SEMVER.exec(d.tag_name.trim()) : null;
  if (!m) return null;
  const version = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 200) : `pgkiln ${version}`;
  const url = typeof d.html_url === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(d.html_url) && URL.canParse(d.html_url)
    ? d.html_url : `https://github.com/pgkiln/pgkiln/releases/tag/v${version}`;
  const publishedAt = typeof d.published_at === 'string' && !Number.isNaN(Date.parse(d.published_at)) ? new Date(d.published_at).toISOString() : null;
  return { version, name, url, publishedAt };
}

async function fetchLatest(): Promise<Release | null> {
  const res = await fetch(releaseUrl(), {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `pgkiln/${VERSION}` },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return parseRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/**
 * Ask for the latest release when the check is on and the cache is stale (force: now). Never throws;
 * concurrent calls share one request.
 */
export async function refreshRelease(force = false): Promise<void> {
  if (!networkAllowed() || !(await releaseCheckEnabled()).on) return;
  if (!force && cache && Date.now() - cache.at < (cache.error ? RETRY_MS : FRESH_MS)) return;
  inflight ??= fetchLatest()
    .then((release) => {
      cache = { at: Date.now(), release, error: release ? null : 'not a release' };
    })
    .catch((e: Error) => {
      cache = { at: Date.now(), release: cache?.release ?? null, error: e.name === 'TimeoutError' ? 'timed out' : e.message.slice(0, 200) };
    })
    .finally(() => {
      inflight = null;
    });
  await inflight;
}

/** What is cached (the page shows it; it never waits for a request). */
export function cachedRelease() {
  return cache;
}

/** Forget the cache (tests). */
export function resetReleaseCache() {
  cache = null;
}
