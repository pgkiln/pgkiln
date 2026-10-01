// pgapex service worker for one application (served as /a/<alias>/sw.js with PGAPEX = {base, offlinePages, offlineSubmit, version}).
//   static files (app.css, app.js, icons) and the offline page: cached at install, served from the cache
//   pages (navigations): network first; offline, the cached copy (only when the app keeps pages) or the offline page
//   signing in or out empties the page cache, so the next person on the device doesn't see them
/* global PGAPEX */
const STATIC = `pgapex-static-${PGAPEX.version}`;
const PAGES = `pgapex-pages-${PGAPEX.base}`;
const SHELL = ['/static/app.css', '/static/app.js', '/static/icons.svg', `${PGAPEX.base}/offline`];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pgapex-static-') && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isPage = (req) => req.mode === 'navigate' && req.method === 'GET';
const signInOrOut = (url) => url.pathname === `${PGAPEX.base}/login` || url.pathname === `${PGAPEX.base}/logout`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'POST' && signInOrOut(url)) {
    event.respondWith(caches.delete(PAGES).then(() => fetch(req)));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.pathname.startsWith('/static/')) {
    event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
    return;
  }

  if (isPage(req) && url.pathname.startsWith(`${PGAPEX.base}/`)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // keep successful pages of this app (not the sign-in page, not downloads)
          if (PGAPEX.offlinePages && res.ok && !res.redirected && (res.headers.get('content-type') || '').startsWith('text/html') && !signInOrOut(url)) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = PGAPEX.offlinePages
            ? (await caches.match(req, { cacheName: PAGES })) || (await caches.match(req, { cacheName: PAGES, ignoreSearch: true }))
            : undefined;
          return cached || (await caches.match(`${PGAPEX.base}/offline`)) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
        }),
    );
  }
});

// the offline page lists the pages kept on this device
self.addEventListener('message', (event) => {
  if (event.data === 'pgapex:pages') {
    caches
      .open(PAGES)
      .then((c) => c.keys())
      .then((keys) => event.source.postMessage({ type: 'pgapex:pages', pages: keys.map((k) => k.url) }));
  }
});

// ------------------------------------------------------------------ offline form queue (PGAPEX.offlineSubmit)
// A form posted while the network is down is kept on the device (IndexedDB, files included) and the
// browser shows the page again with ?queued=1. It is sent later (on "online", when a page of the app
// opens, or by Background Sync): with a fresh CSRF token, under the same user only. The form's
// submission id (__submit_id) makes a resend that already reached the server a no-op.
const QDB = 'pgapex-queue';
function qdb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(QDB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('forms', { keyPath: 'id', autoIncrement: true });
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function qrun(store, mode, fn) {
  const db = await qdb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const queued = () => qrun('forms', 'readonly', (s) => s.getAll()).then((all) => all.filter((f) => f.base === PGAPEX.base));
const currentUser = () => qrun('meta', 'readonly', (s) => s.get(`user:${PGAPEX.base}`));

async function tellClients() {
  const items = (await queued()).map((f) => ({ id: f.id, url: f.url, title: f.title, at: f.at, user: f.user, status: f.status, error: f.error }));
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'pgapex:queue', items });
}

let replaying = false;
async function replay() {
  if (replaying) return;
  replaying = true;
  try {
    const user = await currentUser();
    for (const f of await queued()) {
      if (f.user !== user) continue;
      try {
        // a fresh CSRF token (and a check that the session is still signed in)
        const page = await fetch(f.url, { credentials: 'same-origin' });
        if (page.redirected && /\/login(\?|$)/.test(new URL(page.url).pathname + new URL(page.url).search)) {
          await qrun('forms', 'readwrite', (s) => s.put({ ...f, status: 'signin', error: null }));
          continue;
        }
        const token = /name="__csrf" value="([^"]+)"/.exec(await page.text());
        if (!token) {
          await qrun('forms', 'readwrite', (s) => s.put({ ...f, status: 'error', error: `HTTP ${page.status}` }));
          continue;
        }
        const files = f.entries.some(([, v]) => typeof v !== 'string');
        const body = files ? new FormData() : new URLSearchParams();
        for (const [k, v] of f.entries) body.append(k, k === '__csrf' ? token[1] : v);
        const res = await fetch(f.url, { method: 'POST', body, redirect: 'manual', credentials: 'same-origin' });
        if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) await qrun('forms', 'readwrite', (s) => s.delete(f.id));
        else await qrun('forms', 'readwrite', (s) => s.put({ ...f, status: res.status === 422 ? 'invalid' : 'error', error: `HTTP ${res.status}` }));
      } catch {
        break; // still offline
      }
    }
  } finally {
    replaying = false;
    await tellClients();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!PGAPEX.offlineSubmit || req.method !== 'POST' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`${PGAPEX.base}/`) || signInOrOut(url)) return;
  const copy = req.clone();
  event.respondWith(
    fetch(req).catch(async () => {
      const form = await copy.formData();
      const entries = [];
      for (const [k, v] of form.entries()) entries.push([k, v]);
      const user = await currentUser();
      const client = event.clientId ? await self.clients.get(event.clientId) : null;
      await qrun('forms', 'readwrite', (s) => s.add({ base: PGAPEX.base, url: url.pathname, title: client ? client.url : url.pathname, entries, user, at: Date.now(), status: 'waiting', error: null }));
      if (self.registration.sync) self.registration.sync.register('pgapex-queue').catch(() => {});
      await tellClients();
      return Response.redirect(`${url.pathname}?queued=1`, 303);
    }),
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'pgapex-queue') event.waitUntil(replay());
});

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'pgapex:user') event.waitUntil(qrun('meta', 'readwrite', (s) => s.put(m.user, `user:${PGAPEX.base}`)).then(tellClients));
  if (m.type === 'pgapex:replay') event.waitUntil(replay());
  if (m.type === 'pgapex:queue') event.waitUntil(tellClients());
  if (m.type === 'pgapex:discard') event.waitUntil(qrun('forms', 'readwrite', (s) => s.delete(m.id)).then(tellClients));
});
