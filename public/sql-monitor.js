// pgkiln builder: the SQL Workshop's SQL Monitor (sprint 102, src/builder/sql-monitor.ts).
//
// Progressive enhancement of the Sessions view: the live part ([data-sm-live]: tiles, sessions, wait events,
// progress) is fetched again (?fragment=1) every 5, 15 or 60 seconds and swapped in place, with a Pause button.
// The interval and the pause are remembered in localStorage (pgkiln.sqlMonitor). No refresh while the tab is
// hidden or a session's confirmation is open; a failed or redirected fetch (signed out) stops it. Without
// JavaScript the page's Refresh link reloads it.
(() => {
  'use strict';
  const live = document.querySelector('[data-sm-live]');
  const controls = document.querySelector('[data-sm-controls]');
  if (!live || !controls) return;
  const select = controls.querySelector('[data-sm-interval]');
  const pause = controls.querySelector('[data-sm-pause]');
  const KEY = 'pgkiln.sqlMonitor';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { return {}; } };
  const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } };
  const pref = load();
  const allowed = [...select.options].map((o) => Number(o.value));
  let seconds = allowed.includes(Number(pref.seconds)) ? Number(pref.seconds) : allowed[0];
  let paused = pref.paused === true;
  let timer = 0;
  let busy = false;
  select.value = String(seconds);
  controls.hidden = false;

  const show = () => {
    pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
    pause.textContent = paused ? 'Resume' : 'Pause';
    live.classList.toggle('is-paused', paused);
  };
  const schedule = () => {
    window.clearTimeout(timer);
    if (!paused) timer = window.setTimeout(refresh, seconds * 1000);
  };
  async function refresh() {
    if (busy || paused) return;
    if (document.hidden) return schedule();
    busy = true;
    try {
      const res = await fetch(live.dataset.smLive, { credentials: 'same-origin', headers: { accept: 'text/html' }, cache: 'no-store' });
      if (!res.ok || res.redirected) throw new Error(String(res.status));
      const text = await res.text();
      // keep focus on a button that survives the swap (by its label)
      const focused = document.activeElement && live.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
      live.innerHTML = text;
      if (focused) live.querySelector(`[aria-label="${CSS.escape(focused)}"]`)?.focus();
      busy = false;
      schedule();
    } catch {
      busy = false;
      paused = true;
      show();
      const note = live.querySelector('[data-sm-updated]');
      if (note) note.textContent = 'Refresh stopped: the monitor could not be reached (signed out?). Reload the page.';
    }
  }
  select.addEventListener('change', () => {
    seconds = Number(select.value);
    save({ seconds, paused });
    schedule();
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    save({ seconds, paused });
    show();
    if (paused) window.clearTimeout(timer);
    else refresh();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !paused) refresh(); });
  show();
  schedule();
})();
