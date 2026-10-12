import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './env.ts';

// The version of pgkiln's own static files (app.css, app.js, icons.svg, sw.js): a hash of
// their contents, in their URLs (?v=…) and in each application's service worker. The files'
// sizes and modification times are looked at again at most once a second, so a changed file
// gets a new URL and a new service worker even when the server wasn't restarted; a browser
// (or a service worker cache) never keeps an old copy under the new URL.

const FILES = ['app.css', 'app.js', 'icons.svg', 'sw.js'].map((f) => join(root, 'public', f));
let checked = 0;
let stamp = '';
let version = '';

export function staticVersion() {
  const now = Date.now();
  if (version && now - checked < 1000) return version;
  checked = now;
  const s = FILES.map((f) => {
    const st = statSync(f);
    return `${st.size}:${st.mtimeMs}`;
  }).join('|');
  if (s !== stamp) {
    let h = 0;
    for (const f of FILES) for (const ch of readFileSync(f, 'utf8')) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    stamp = s;
    version = (h >>> 0).toString(36);
  }
  return version;
}

/** /static/<file>?v=<version> for app.css, app.js and icons.svg. */
export const staticUrl = (file: 'app.css' | 'app.js' | 'icons.svg') => `/static/${file}?v=${staticVersion()}`;
