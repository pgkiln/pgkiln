// pgkiln service worker for one application (served as /a/<alias>/sw.js with PGKILN = {base, offlinePages, offlineSubmit, version}).
//   static files (app.css, app.js, icons) and the offline page: cached at install, served from the cache
//   pages (navigations): network first; offline, the cached copy (only when the app keeps pages) or the offline page
//   signing in or out empties the page cache, so the next person on the device doesn't see them
//   push notifications (migration 074): shown as they arrive, a click opens their page of the app;
//   signing out turns them off on this device
/* global PGKILN */
const STATIC = `pgkiln-static-${PGKILN.version}`;
const PAGES = `pgkiln-pages-${PGKILN.base}`;
const SHELL = ['/static/app.css', '/static/app.js', '/static/icons.svg', `${PGKILN.base}/offline`];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pgkiln-static-') && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isPage = (req) => req.mode === 'navigate' && req.method === 'GET';
const signInOrOut = (url) => url.pathname === `${PGKILN.base}/login` || url.pathname === `${PGKILN.base}/logout`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'POST' && signInOrOut(url)) {
    const signOut = url.pathname === `${PGKILN.base}/logout`;
    const copy = signOut ? req.clone() : null;
    event.respondWith(Promise.all([caches.delete(PAGES), signOut ? endPush(copy) : null]).then(() => fetch(req)));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.pathname.startsWith('/static/')) {
    event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
    return;
  }

  if (isPage(req) && url.pathname.startsWith(`${PGKILN.base}/`)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // keep successful pages of this app (not the sign-in page, not downloads)
          if (PGKILN.offlinePages && res.ok && !res.redirected && (res.headers.get('content-type') || '').startsWith('text/html') && !signInOrOut(url)) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = PGKILN.offlinePages
            ? (await caches.match(req, { cacheName: PAGES })) || (await caches.match(req, { cacheName: PAGES, ignoreSearch: true }))
            : undefined;
          return cached || (await caches.match(`${PGKILN.base}/offline`)) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
        }),
    );
  }
});

// the offline page lists the pages kept on this device
self.addEventListener('message', (event) => {
  if (event.data === 'pgkiln:pages') {
    caches
      .open(PAGES)
      .then((c) => c.keys())
      .then((keys) => event.source.postMessage({ type: 'pgkiln:pages', pages: keys.map((k) => k.url) }));
  }
});

// ------------------------------------------------------------------ offline form queue (PGKILN.offlineSubmit)
// A form posted while the network is down is kept on the device (IndexedDB, files included) and the
// browser shows the page again with ?queued=1. It is sent later (on "online", when a page of the app
// opens, or by Background Sync): with a fresh CSRF token, under the same user only. The form's
// submission id (__submit_id) makes a resend that already reached the server a no-op.
const QDB = 'pgkiln-queue';
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
const queued = () => qrun('forms', 'readonly', (s) => s.getAll()).then((all) => all.filter((f) => f.base === PGKILN.base));
const currentUser = () => qrun('meta', 'readonly', (s) => s.get(`user:${PGKILN.base}`));

async function tellClients() {
  const items = (await queued()).map((f) => ({ id: f.id, url: f.url, title: f.title, at: f.at, user: f.user, status: f.status, error: f.error }));
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'pgkiln:queue', items });
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
  if (!PGKILN.offlineSubmit || req.method !== 'POST' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`${PGKILN.base}/`) || signInOrOut(url)) return;
  const copy = req.clone();
  event.respondWith(
    fetch(req).catch(async () => {
      const form = await copy.formData();
      const entries = [];
      for (const [k, v] of form.entries()) entries.push([k, v]);
      const user = await currentUser();
      const client = event.clientId ? await self.clients.get(event.clientId) : null;
      await qrun('forms', 'readwrite', (s) => s.add({ base: PGKILN.base, url: url.pathname, title: client ? client.url : url.pathname, entries, user, at: Date.now(), status: 'waiting', error: null }));
      if (self.registration.sync) self.registration.sync.register('pgkiln-queue').catch(() => {});
      await tellClients();
      return Response.redirect(`${url.pathname}?queued=1`, 303);
    }),
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'pgkiln-queue') event.waitUntil(replay());
});

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'pgkiln:user') event.waitUntil(qrun('meta', 'readwrite', (s) => s.put(m.user, `user:${PGKILN.base}`)).then(tellClients));
  if (m.type === 'pgkiln:replay') event.waitUntil(replay());
  if (m.type === 'pgkiln:queue') event.waitUntil(tellClients());
  if (m.type === 'pgkiln:discard') event.waitUntil(qrun('forms', 'readwrite', (s) => s.delete(m.id)).then(tellClients));
});

// ------------------------------------------------------------------ push notifications (074)
// The server sends {title, body, url, tag}, encrypted for this device (RFC 8291). Only pages of
// this app open from a notification.
const appUrl = (u) => {
  try {
    const url = new URL(u || '', self.location.origin);
    return url.origin === self.location.origin && url.pathname.startsWith(`${PGKILN.base}/`) ? url.href : null;
  } catch {
    return null;
  }
};

self.addEventListener('push', (event) => {
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {
    m = { title: event.data ? event.data.text() : '' };
  }
  const options = {
    body: typeof m.body === 'string' ? m.body : '',
    icon: `${PGKILN.base}/icon-192.png`,
    badge: `${PGKILN.base}/icon-192.png`,
    data: { url: appUrl(m.url) || appUrl(`${PGKILN.base}/`) },
  };
  if (typeof m.tag === 'string' && m.tag) Object.assign(options, { tag: m.tag, renotify: true });
  event.waitUntil(self.registration.showNotification(typeof m.title === 'string' && m.title ? m.title : 'Notification', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = appUrl(event.notification.data && event.notification.data.url) || `${self.location.origin}${PGKILN.base}/`;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => w.url === target);
      if (same) return same.focus();
      const mine = wins.find((w) => appUrl(w.url));
      if (mine && 'navigate' in mine) return mine.focus().then(() => mine.navigate(target));
      return self.clients.openWindow(target);
    }),
  );
});

// signing out: the server forgets this device (with the sign-out form's CSRF token), the browser ends the subscription
async function endPush(signOutRequest) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    const form = await signOutRequest.formData();
    const body = new URLSearchParams({ endpoint: sub.endpoint, __csrf: String(form.get('__csrf') || '') });
    await fetch(`${PGKILN.base}/push/unsubscribe`, { method: 'POST', body, headers: { accept: 'application/json' }, credentials: 'same-origin' }).catch(() => {});
    await sub.unsubscribe();
  } catch {
    /* the sign-out goes on */
  }
}
