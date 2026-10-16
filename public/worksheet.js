// pgkiln builder: the SQL Worksheet (sprint 91, src/builder/worksheet.ts).
//
// Progressive enhancement of one form: without JavaScript its buttons post it and the panes stack.
//   - Run Statement (Ctrl+Enter), Run Script (F5), Explain Plan (F10), Autotrace (F6): the cursor or the
//     selection goes along (sel_start / sel_end), so the server runs the statement at the cursor
//   - after a run the statement that ran is selected again; an error puts the cursor on its line
//   - output tabs, the navigator's schema / type (swapped in without a reload) and search
//   - tables and views: drag into the editor for a SELECT, or the SELECT / INSERT / UPDATE / DELETE buttons
//   - resizable panes (mouse, touch or arrow keys on the splitters), a navigator that hides, fullscreen;
//     sizes and the hidden navigator are remembered in this browser
// Strict CSP: no inline styles; sizes are set through the CSSOM.
(() => {
  'use strict';
  const form = document.getElementById('ws');
  if (!form) return;
  const ta = form.querySelector('textarea[name=sql]');
  const out = form.querySelector('.ws-output');
  const store = {
    get(k) { try { return localStorage.getItem(`pgkiln.ws.${k}`); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`pgkiln.ws.${k}`, v); } catch { /* private mode */ } },
  };
  for (const el of form.querySelectorAll('[hidden]:not(.ws-busy)')) el.hidden = false;

  // ------------------------------------------------------------ runs
  const button = (mode) => form.querySelector(`button[name=mode][value=${mode}]`);
  const run = (mode) => form.requestSubmit(button(mode));
  form.addEventListener('submit', (e) => {
    const mode = e.submitter?.value;
    if (mode === 'nav') return;
    form.elements.sel_start.value = String(ta.selectionStart);
    form.elements.sel_end.value = String(ta.selectionEnd);
    const busy = form.querySelector('.ws-busy');
    if (busy) busy.hidden = false;
  });
  const KEYS = { F5: 'script', F10: 'explain', F6: 'autotrace' };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && (e.target === ta || form.contains(e.target))) {
      e.preventDefault();
      e.stopPropagation();
      run('statement');
    } else if (KEYS[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      run(KEYS[e.key]);
    } else if (e.key === 'Escape' && document.body.classList.contains('ws-fullscreen')) {
      fullscreen(false);
    }
  }, true);

  // the statement that ran, or the line of the first error
  const ran = (form.dataset.ran || '').split(',').map(Number);
  const errLine = Number(form.dataset.errorLine);
  if (errLine > 0) {
    const lines = ta.value.split('\n');
    const at = lines.slice(0, errLine - 1).reduce((n, l) => n + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(at, at + (lines[errLine - 1] || '').length);
  } else if (ran.length === 2 && ran[1] > ran[0]) {
    ta.focus();
    ta.setSelectionRange(ran[0], ran[1]);
  }

  // ------------------------------------------------------------ output tabs
  const tabs = [...out.querySelectorAll('[role=tab]')];
  const show = (key, focus) => {
    for (const t of tabs) {
      const on = t.dataset.wsTab === key;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    for (const p of out.querySelectorAll('.ws-pane')) p.hidden = p.dataset.pane !== key;
    out.dataset.active = key;
  };
  show(out.dataset.active || 'result');
  out.querySelector('[role=tablist]').addEventListener('click', (e) => {
    const t = e.target.closest('[role=tab]');
    if (t) show(t.dataset.wsTab);
  });
  out.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
    const k = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const next = { ArrowRight: k + 1, ArrowLeft: k - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    show(tabs[(next + tabs.length) % tabs.length].dataset.wsTab, true);
  });

  // ------------------------------------------------------------ inserting text into the editor
  const insert = (text) => {
    ta.focus();
    const s = ta.selectionStart, en = ta.selectionEnd;
    const before = ta.value.slice(0, s);
    const pad = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    ta.setRangeText(`${pad}${text};\n`, s, en, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ws-insert]');
    if (b) insert(b.dataset.wsInsert);
    const h = e.target.closest('[data-ws-history]');
    if (h && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      insert(h.dataset.wsHistory);
    }
    if (e.target.closest('[data-ws-clear]')) {
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    }
    if (e.target.closest('[data-ws-toggle-nav]')) toggleNav();
    if (e.target.closest('[data-ws-fullscreen]')) fullscreen(!document.body.classList.contains('ws-fullscreen'));
  });
  form.addEventListener('dragstart', (e) => {
    const sum = e.target.closest?.('[data-ws-sql]');
    if (!sum) return;
    e.dataTransfer.setData('text/plain', `${sum.dataset.wsSql};\n`);
    e.dataTransfer.effectAllowed = 'copy';
  });

  // ------------------------------------------------------------ navigator
  const navBody = document.getElementById('ws-nav-body');
  const filter = form.querySelector('[data-ws-filter]');
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    for (const li of navBody.querySelectorAll('.ws-obj')) li.hidden = !!q && !li.dataset.name.includes(q);
  };
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  for (const sel of form.querySelectorAll('select[data-ws-nav]')) {
    sel.addEventListener('change', async () => {
      const q = new URLSearchParams({ schema: form.elements.nav_schema.value, type: form.elements.nav_type.value });
      navBody.setAttribute('aria-busy', 'true');
      try {
        const res = await fetch(`/builder/sql/worksheet/navigator?${q}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        navBody.innerHTML = await res.text(); // server-rendered, escaped HTML of the same origin
        for (const el of navBody.querySelectorAll('[hidden]')) el.hidden = false;
        applyFilter();
      } catch {
        form.requestSubmit(button('nav'));
      } finally {
        navBody.removeAttribute('aria-busy');
      }
    });
  }

  // ------------------------------------------------------------ panes
  const toggleNav = (hide = !form.classList.contains('ws-nav-hidden')) => {
    form.classList.toggle('ws-nav-hidden', hide);
    store.set('nav', hide ? 'hidden' : '');
  };
  if (store.get('nav') === 'hidden') toggleNav(true);
  const fullscreen = (on) => {
    document.body.classList.toggle('ws-fullscreen', on);
    form.querySelector('[data-ws-fullscreen]')?.setAttribute('aria-pressed', String(on));
    if (on) ta.focus();
  };
  const size = (key, px) => {
    const v = key === 'nav' ? Math.max(160, Math.min(px, window.innerWidth * 0.5)) : Math.max(80, Math.min(px, window.innerHeight * 0.75));
    form.style.setProperty(key === 'nav' ? '--ws-nav' : '--ws-out', `${Math.round(v)}px`);
    store.set(key, String(Math.round(v)));
    return v;
  };
  for (const key of ['nav', 'out']) if (Number(store.get(key)) > 0) size(key, Number(store.get(key)));
  for (const sp of form.querySelectorAll('[data-ws-split]')) {
    const key = sp.dataset.wsSplit;
    const current = () => (key === 'nav' ? form.querySelector('.ws-nav').getBoundingClientRect().width : out.getBoundingClientRect().height);
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      const start = key === 'nav' ? e.clientX : e.clientY;
      const from = current();
      const move = (ev) => size(key, key === 'nav' ? from + ev.clientX - start : from - (ev.clientY - start));
      const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      const d = key === 'nav' ? { ArrowLeft: -step, ArrowRight: step }[e.key] : { ArrowUp: step, ArrowDown: -step }[e.key];
      if (!d) return;
      e.preventDefault();
      size(key, current() + d);
    });
  }
})();
