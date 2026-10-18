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
//   - (sprint 92) Query Result: sort by a column, copy as tab-separated text, a cell's whole value in a dialog;
//     SQL History: search, filter by status, run again, copy
//   - (sprint 93) worksheets as tabs kept in this browser (unsaved text survives a reload), saved as SQL Scripts
//     (Ctrl+S), the Files list; bind and substitution values in a dialog; Format (Ctrl+F7), Convert case (Ctrl+B),
//     find and replace (Ctrl+F, Ctrl+H), go to line (Ctrl+G), comment lines (Ctrl+/), Help (F1)
//   - (sprint 107) transaction mode per worksheet tab: Autocommit / Transaction, Commit and Rollback, a badge with the
//     server's real state (fetched again after a reload and a tab switch, and when the idle timeout is due); leaving the
//     page with an open transaction asks first, closing the tab or switching to Autocommit rolls it back
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
  for (const el of form.querySelectorAll('[hidden]:not(.ws-busy):not(.ws-findbar)')) el.hidden = false;

  // ------------------------------------------------------------ runs
  const button = (mode) => form.querySelector(`button[name=mode][value=${mode}]`);
  const run = (mode) => form.requestSubmit(button(mode));
  form.addEventListener('submit', (e) => {
    const mode = e.submitter?.value;
    if (mode === 'nav' || mode === 'save' || mode === 'save_as' || mode === 'rename' || mode === 'download') return;
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
    } else if (e.key === 'Escape' && document.body.classList.contains('ws-fullscreen') && !document.querySelector('dialog[open]')) {
      fullscreen(false);
    } else if (handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  // (sprint 93) the editing keys; true: handled
  const handleKey = (e) => {
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    const inEditor = e.target === ta;
    if (e.key === 'F1' && !ctrl) { form.querySelector('[data-ws-help]')?.click(); return true; }
    const bar = form.querySelector('.ws-findbar');
    if (e.key === 'Escape' && !bar.hidden && inEditor) { bar.hidden = true; return true; }
    if (!ctrl) return false;
    const k = e.key.toLowerCase();
    if (k === 's' && !e.shiftKey) { save(); return true; }
    if (e.key === 'F7') { format(); return true; }
    if (e.key === 'F11' && button('chart')) { run('chart'); return true; }
    if (!inEditor && !e.target.closest?.('.ws-findbar')) return false;
    if (k === 'b' && inEditor) { convertCase(); return true; }
    if (k === 'f' || k === 'h' || k === 'g') { openFind(k); return true; }
    if (e.key === '/' && inEditor) { commentLines(); return true; }
    return false;
  };

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

  // ------------------------------------------------------------ (sprint 92) Query Result and SQL History
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      announce(`${what} copied.`);
    } catch {
      announce('Copying is not allowed here.');
    }
  };
  const announce = (msg) => {
    const last = form.querySelector('.ws-last');
    if (last) last.textContent = msg;
  };
  const grid = form.querySelector('[data-ws-grid]');
  if (grid) {
    const cellValue = (td) => (td.querySelector('.null') ? '' : td.textContent);
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-ws-copy]')) {
        const head = [...grid.tHead.rows[0].cells].slice(1).map((th) => th.textContent.trim());
        const rows = [...grid.tBodies[0].rows].map((tr) => [...tr.cells].slice(1).map((td) => cellValue(td).replace(/[\t\n]/g, ' ')));
        copy([head, ...rows].map((r) => r.join('\t')).join('\n'), `${rows.length} rows`);
      }
      const sort = e.target.closest('[data-ws-sort]');
      if (sort) {
        const k = Number(sort.dataset.wsSort) + 1;
        const th = sort.closest('th');
        const asc = th.getAttribute('aria-sort') !== 'ascending';
        for (const x of grid.tHead.rows[0].cells) x.removeAttribute('aria-sort');
        th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        const num = th.classList.contains('num');
        const key = (tr) => { const td = tr.cells[k]; return td.querySelector('.null') ? null : num ? Number(td.textContent) : td.textContent; };
        const rows = [...grid.tBodies[0].rows].sort((a, b) => {
          const x = key(a), y = key(b);
          if (x === y) return 0;
          if (x === null) return 1; // nulls last either way
          if (y === null) return -1;
          return (num ? x - y : String(x).localeCompare(String(y))) * (asc ? 1 : -1);
        });
        grid.tBodies[0].append(...rows);
      }
      const td = e.target.closest('[data-ws-grid] td:not(.ws-rownum)');
      const dlg = document.getElementById('ws-cell');
      if (td && dlg && !td.querySelector('.null')) {
        let v = td.textContent;
        if (/^\s*[[{]/.test(v)) { try { v = JSON.stringify(JSON.parse(v), null, 2); } catch { /* not JSON */ } }
        const col = grid.tHead.rows[0].cells[td.cellIndex].textContent.trim();
        dlg.querySelector('#ws-cell-title').textContent = `${col}, row ${td.parentElement.cells[0].textContent}`;
        dlg.querySelector('pre').textContent = v;
        dlg.showModal();
      }
      if (e.target.closest('[data-ws-cell-close]')) e.target.closest('dialog').close();
    });
  }
  const histQ = form.querySelector('[data-ws-hist-q]');
  const histS = form.querySelector('[data-ws-hist-s]');
  const filterHistory = () => {
    const q = histQ.value.trim().toLowerCase();
    for (const li of form.querySelectorAll('.ws-history li')) li.hidden = (!!q && !li.dataset.sql.includes(q)) || (!!histS.value && li.dataset.status !== histS.value);
  };
  histQ?.addEventListener('input', filterHistory);
  histQ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  histS?.addEventListener('change', filterHistory);
  form.addEventListener('click', (e) => {
    const again = e.target.closest('[data-ws-run]');
    if (again) {
      const before = ta.value.replace(/\s+$/, '');
      const start = before ? before.length + 2 : 0;
      ta.value = `${before}${before ? '\n\n' : ''}${again.dataset.wsRun};\n`;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.setSelectionRange(start, start + again.dataset.wsRun.length);
      run('statement');
    }
    const c = e.target.closest('[data-ws-copy-text]');
    if (c) copy(c.dataset.wsCopyText, 'The statement');
  });

  // ------------------------------------------------------------ (sprint 93) worksheets as tabs, kept in this browser
  const wtabs = form.querySelector('.ws-wtabs');
  const readTabs = () => { try { const v = JSON.parse(store.get('tabs') || 'null'); return v && Array.isArray(v.tabs) ? v : null; } catch { return null; } };
  const book = readTabs() || { active: '', tabs: [] };
  const newKey = () => Math.random().toString(36).slice(2, 10);
  const untitled = () => { let n = 1; while (book.tabs.some((t) => t.name === `Untitled ${n}`)) n++; return `Untitled ${n}`; };
  const src = form.dataset.source;
  const sid = form.dataset.scriptId ? Number(form.dataset.scriptId) : null;
  const sname = form.dataset.scriptName;
  const add = (tab) => { book.tabs.push(tab); if (book.tabs.length > 20) book.tabs.splice(0, book.tabs.length - 20); return tab; };
  let cur = form.dataset.tab ? book.tabs.find((t) => t.key === form.dataset.tab) : null;
  if (src === 'script') {
    cur = cur || book.tabs.find((t) => t.scriptId === sid);
    if (cur && cur.scriptId === sid && cur.text !== cur.saved && !form.dataset.tab) ta.value = cur.text; // unsaved edits of this script stay
    else if (cur) cur.saved = ta.value;
    cur = cur || add({ key: newKey(), name: sname, scriptId: sid, text: ta.value, saved: ta.value });
    cur.scriptId = sid;
    cur.name = sname;
    cur.text = ta.value;
  } else if (src === 'run') {
    cur = cur || add({ key: newKey(), name: sid ? sname : untitled(), scriptId: sid, text: ta.value, saved: sid ? '' : ta.value });
    cur.text = ta.value;
  } else if (src === 'insert') {
    cur = add({ key: newKey(), name: untitled(), scriptId: null, text: ta.value, saved: '' });
  } else {
    cur = book.tabs.find((t) => t.key === book.active) || book.tabs[0];
    if (cur) ta.value = cur.text;
    else cur = add({ key: newKey(), name: untitled(), scriptId: null, text: ta.value, saved: ta.value });
  }
  ta.dispatchEvent(new Event('input', { bubbles: true })); // the code editor redraws
  const dirty = (t) => t.text !== t.saved;
  let persistTimer = 0;
  const persistNow = () => { clearTimeout(persistTimer); cur.text = ta.value; store.set('tabs', JSON.stringify(book)); };
  const persist = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 250); };
  window.addEventListener('pagehide', persistNow);
  form.addEventListener('submit', persistNow);
  const drawTabs = () => {
    book.active = cur.key;
    form.elements.ws_tab.value = cur.key;
    form.elements.script_id.value = cur.scriptId ?? '';
    const name = form.elements.ws_name;
    if (document.activeElement !== name) name.value = cur.scriptId ? cur.name : '';
    form.querySelector('.ws-file-name').textContent = `${cur.name}${dirty(cur) ? '*' : ''}`;
    wtabs.replaceChildren(...book.tabs.map((t) => {
      const wrap = document.createElement('div');
      wrap.className = 'ws-wtab';
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t === cur));
      b.dataset.wsWtab = t.key;
      b.textContent = `${t.name}${dirty(t) ? '*' : ''}`;
      b.title = t.scriptId ? `Script “${t.name}”${dirty(t) ? ' (unsaved changes)' : ''}` : 'Not saved as a script';
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'ws-wtab-close';
      x.dataset.wsWclose = t.key;
      x.setAttribute('aria-label', `Close ${t.name}`);
      x.textContent = '×';
      wrap.append(b, x);
      return wrap;
    }), Object.assign(document.createElement('button'), { type: 'button', className: 'ws-wtab-new', title: 'New worksheet', textContent: '+' }));
    persist();
  };
  const switchTo = (t) => {
    cur.text = ta.value;
    cur = t;
    ta.value = t.text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    drawTabs();
    txnTabChanged();
    ta.focus();
  };
  const newTab = () => switchTo(add({ key: newKey(), name: untitled(), scriptId: null, text: '', saved: '' }));
  const closeTab = (t) => {
    const txnOpen = t === cur ? txnBox.dataset.state !== 'none' : !!t.txnOpen;
    if (txnOpen && !window.confirm(`“${t.name}” has an open transaction. Close it and roll the transaction back?`)) return;
    if (!txnOpen && dirty(t) && t.text.trim() && !window.confirm(`Close “${t.name}” without saving?`)) return;
    if (t.txn) txnPost(t.key, 'rollback'); // the server knows best whether one is open
    const i = book.tabs.indexOf(t);
    book.tabs.splice(i, 1);
    if (t === cur) {
      cur = { text: '' }; // gone: switchTo keeps nothing of it
      const next = book.tabs[Math.min(i, book.tabs.length - 1)];
      if (next) switchTo(next);
      else newTab();
    } else drawTabs();
  };
  ta.addEventListener('input', () => {
    cur.text = ta.value;
    const label = form.querySelector('.ws-file-name');
    const want = `${cur.name}${dirty(cur) ? '*' : ''}`;
    if (label.textContent !== want) drawTabs();
    else persist();
  });
  wtabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ws-wtab]');
    if (b) switchTo(book.tabs.find((t) => t.key === b.dataset.wsWtab));
    const x = e.target.closest('[data-ws-wclose]');
    if (x) closeTab(book.tabs.find((t) => t.key === x.dataset.wsWclose));
    if (e.target.closest('.ws-wtab-new')) newTab();
  });
  drawTabs();
  const fileMenu = form.querySelector('.ws-file');
  const save = () => {
    if (cur.scriptId) { form.requestSubmit(button('save')); return; }
    fileMenu.open = true;
    form.elements.ws_name.focus();
  };
  form.elements.ws_name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    form.requestSubmit(button(cur.scriptId && form.elements.ws_name.value.trim() !== cur.name ? 'rename' : 'save'));
  });
  form.querySelector('[data-ws-new]').addEventListener('click', (e) => { e.preventDefault(); fileMenu.open = false; newTab(); });
  form.querySelector('[data-ws-open]').addEventListener('click', (e) => { e.preventDefault(); fileMenu.open = false; navTab('files'); });
  // the navigator's Objects and Files
  const navTab = (key) => {
    for (const b of form.querySelectorAll('[data-ws-navtab]')) b.setAttribute('aria-selected', String(b.dataset.wsNavtab === key));
    form.querySelector('#ws-nav-objects').hidden = key !== 'objects';
    form.querySelector('#ws-files').hidden = key !== 'files';
    if (form.classList.contains('ws-nav-hidden')) toggleNav(false);
  };
  form.querySelector('.ws-nav-switch').addEventListener('click', (e) => { const b = e.target.closest('[data-ws-navtab]'); if (b) navTab(b.dataset.wsNavtab); });
  navTab(location.hash === '#ws-files' ? 'files' : 'objects');

  // ------------------------------------------------------------ (sprint 107) transaction mode
  function txnTabChanged() {
    modeSel.value = cur.txn ? 'on' : '';
    txnApply({ state: 'none', statements: 0, startedMs: null, note: null });
    txnFetch();
  }
  const txnBox = form.querySelector('[data-ws-txn]');
  const modeSel = txnBox.querySelector('[data-ws-txn-mode]');
  const badge = txnBox.querySelector('[data-ws-txn-badge]');
  const commitBtn = txnBox.querySelector('[data-ws-txn-commit]');
  const rollbackBtn = txnBox.querySelector('[data-ws-txn-rollback]');
  const commitNote = form.querySelector('[data-ws-commit-note]');
  const idleSeconds = Number(txnBox.dataset.idle) || 300;
  const idleWords = idleSeconds % 60 ? `${idleSeconds} seconds` : `${idleSeconds / 60} minute${idleSeconds === 60 ? '' : 's'}`;
  let txnInfo = { state: txnBox.dataset.state, statements: Number(txnBox.dataset.statements) || 0, startedMs: Number(txnBox.dataset.started) || null,
    lastMs: Number(txnBox.dataset.last) || null, note: txnBox.dataset.note || null };
  let clockSkew = Date.now() - (Number(txnBox.dataset.now) || Date.now());
  let txnTimer = 0;
  const badgeText = (i) => {
    if (i.state === 'none') return i.note || 'No open transaction';
    const min = i.startedMs ? Math.floor((Date.now() - clockSkew - i.startedMs) / 60000) : 0;
    return `${i.state === 'aborted' ? 'Transaction failed' : 'Transaction open'} · ${i.statements} statement${i.statements === 1 ? '' : 's'} · ${min < 1 ? 'under a minute' : `${min} min`}`;
  };
  const txnApply = (i) => {
    txnInfo = i;
    const on = modeSel.value === 'on';
    txnBox.dataset.state = i.state;
    badge.dataset.state = i.state;
    badge.textContent = badgeText(i);
    badge.hidden = !on && i.state === 'none' && !i.note;
    commitBtn.hidden = rollbackBtn.hidden = !on && i.state === 'none';
    commitBtn.disabled = i.state !== 'open';
    rollbackBtn.disabled = i.state === 'none';
    commitNote.textContent = on
      ? `The statements stay in one transaction until Commit or Rollback; it is rolled back after ${idleWords} without a run.`
      : 'Each statement commits on its own.';
    cur.txn = on;
    cur.txnOpen = i.state !== 'none';
    persist();
    clearTimeout(txnTimer);
    if (i.state !== 'none') {
      // the age once a minute; the server again when the idle timeout is due
      const due = i.lastMs ? i.lastMs + idleSeconds * 1000 + 2000 - (Date.now() - clockSkew) : 60000;
      txnTimer = setTimeout(() => (due <= 60000 ? txnFetch() : txnApply(txnInfo)), Math.max(1000, Math.min(due, 60000)));
    }
  };
  const fromServer = (j) => {
    clockSkew = Date.now() - j.now;
    txnApply({ state: j.state, statements: j.statements, startedMs: j.startedMs, lastMs: j.lastMs, note: j.note });
  };
  async function txnFetch() {
    const key = cur.key;
    try {
      const res = await fetch(`/builder/sql/worksheet/txn?tab=${encodeURIComponent(key)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      if (key !== cur.key) return; // switched meanwhile
      if (j.state !== 'none') modeSel.value = 'on';
      fromServer(j);
    } catch {
      badge.textContent = 'Transaction state unknown';
    }
  }
  async function txnPost(key, action) {
    try {
      const res = await fetch('/builder/sql/worksheet/txn', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' },
        body: new URLSearchParams({ __csrf: form.elements.__csrf.value, tab: key, action }) });
      const j = await res.json();
      if (key === cur.key) {
        fromServer(j);
        if (j.message) announce(j.message);
      }
      return j;
    } catch {
      announce('The transaction could not be ended: reload the page.');
      return null;
    }
  }
  modeSel.addEventListener('change', async () => {
    if (modeSel.value !== 'on' && txnInfo.state !== 'none') {
      if (!window.confirm('Switching to Autocommit rolls back the open transaction. Roll it back?')) { modeSel.value = 'on'; return; }
      await txnPost(cur.key, 'rollback');
      modeSel.value = '';
    }
    txnApply(txnInfo);
  });
  // a page post (a run, Commit, Rollback) is not leaving: the transaction stays
  let submitting = false;
  form.addEventListener('submit', () => {
    submitting = true;
    setTimeout(() => { submitting = false; }, 3000); // a download doesn't leave the page
  });
  window.addEventListener('pageshow', () => { submitting = false; });
  window.addEventListener('beforeunload', (e) => {
    if (submitting || txnInfo.state === 'none') return;
    e.preventDefault();
    e.returnValue = ''; // the browser asks "Leave site?"; an idle transaction is rolled back after the timeout
  });
  if (!form.dataset.tab || form.dataset.tab !== cur.key) txnTabChanged();
  else {
    if (txnInfo.state !== 'none') modeSel.value = 'on';
    else if (!form.querySelector('[data-ws-txn-mode] option[selected]')) modeSel.value = cur.txn ? 'on' : '';
    txnApply(txnInfo);
  }

  // ------------------------------------------------------------ (sprint 97) a chart's settings draw it again
  form.querySelector('.ch-controls')?.addEventListener('change', () => run('chart'));

  // ------------------------------------------------------------ (sprint 93) bind and substitution values
  const binds = form.querySelector('[data-ws-binds]');
  if (binds) {
    binds.close();
    binds.showModal();
    binds.querySelector('input:not([type=hidden])')?.select();
    const drop = () => binds.remove(); // its values must not go along with the next run
    binds.addEventListener('cancel', drop);
    binds.querySelector('[data-ws-binds-cancel]').addEventListener('click', (e) => { e.preventDefault(); binds.close(); drop(); ta.focus(); });
  }

  // ------------------------------------------------------------ (sprint 93) editing tools
  const replaceRange = (a, b, text, select = true) => {
    ta.focus();
    ta.setRangeText(text, a, b, select ? 'select' : 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const kwcase = form.querySelector('[data-ws-kwcase]');
  kwcase.value = store.get('kwcase') === 'upper' ? 'upper' : 'lower';
  kwcase.addEventListener('change', () => store.set('kwcase', kwcase.value));
  const format = async () => {
    const a = ta.selectionStart, b = ta.selectionEnd;
    const whole = a === b;
    const sql = whole ? ta.value : ta.value.slice(a, b);
    if (!sql.trim()) return;
    try {
      const res = await fetch('/builder/sql/worksheet/format', { method: 'POST', credentials: 'same-origin', body: new URLSearchParams({ __csrf: form.elements.__csrf.value, sql, case: kwcase.value }) });
      if (!res.ok) throw new Error(String(res.status));
      const out = (await res.json()).sql;
      if (whole) replaceRange(0, ta.value.length, out, false);
      else replaceRange(a, b, out);
      announce('Formatted.');
    } catch {
      announce('Formatting failed.');
    }
  };
  const convertCase = () => {
    let a = ta.selectionStart, b = ta.selectionEnd;
    if (a === b) {
      while (a > 0 && /\w/.test(ta.value[a - 1])) a--;
      while (b < ta.value.length && /\w/.test(ta.value[b])) b++;
    }
    const t = ta.value.slice(a, b);
    if (!t) return;
    const next = t === t.toUpperCase() ? t.toLowerCase() : t === t.toLowerCase() ? t.replace(/\b\w/g, (c) => c.toUpperCase()) : t.toUpperCase();
    replaceRange(a, b, next);
  };
  const commentLines = () => {
    const v = ta.value;
    const a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let b = v.indexOf('\n', Math.max(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0), a));
    if (b === -1) b = v.length;
    const lines = v.slice(a, b).split('\n');
    const all = lines.every((l) => !l.trim() || /^\s*--/.test(l));
    replaceRange(a, b, lines.map((l) => (!l.trim() ? l : all ? l.replace(/^(\s*)-- ?/, '$1') : `-- ${l}`)).join('\n'));
  };
  // find and replace
  const bar = form.querySelector('.ws-findbar');
  const fq = bar.querySelector('[data-ws-find-q]'), fr = bar.querySelector('[data-ws-find-r]');
  const fre = bar.querySelector('[data-ws-find-re]'), fcs = bar.querySelector('[data-ws-find-cs]');
  const fmsg = bar.querySelector('[data-ws-find-msg]');
  const pattern = () => {
    if (!fq.value) return null;
    try {
      return new RegExp(fre.checked ? fq.value : fq.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), `g${fcs.checked ? '' : 'i'}`);
    } catch (err) {
      fmsg.textContent = `Not a valid pattern: ${err.message}`;
      return null;
    }
  };
  const reveal = (a, b) => {
    const back = document.activeElement;
    ta.focus();
    ta.setSelectionRange(a, b);
    if (back && back !== ta && bar.contains(back)) back.focus();
  };
  const findNext = (from = ta.selectionEnd) => {
    const re = pattern();
    if (!re) return false;
    re.lastIndex = from;
    let m = re.exec(ta.value);
    if (!m) { re.lastIndex = 0; m = re.exec(ta.value); }
    if (!m || !m[0]) { fmsg.textContent = 'Not found.'; return false; }
    fmsg.textContent = '';
    reveal(m.index, m.index + m[0].length);
    return true;
  };
  const openFind = (k) => {
    bar.hidden = false;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n') && k !== 'g') fq.value = sel;
    (k === 'h' ? fr : k === 'g' ? bar.querySelector('[data-ws-goto]') : fq).focus();
  };
  form.querySelector('[data-ws-find]').addEventListener('click', () => openFind('f'));
  form.querySelector('[data-ws-format]').addEventListener('click', format);
  form.querySelector('[data-ws-case]').addEventListener('click', convertCase);
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); bar.hidden = true; ta.focus(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.target.matches('[data-ws-goto]')) {
      const n = Math.max(1, Number(e.target.value) || 1);
      const lines = ta.value.split('\n');
      const at = lines.slice(0, n - 1).reduce((x, l) => x + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(Math.min(at, ta.value.length), Math.min(at, ta.value.length));
    } else if (e.target === fr) bar.querySelector('[data-ws-find-replace]').click();
    else findNext(e.shiftKey ? 0 : ta.selectionEnd);
  });
  bar.addEventListener('click', (e) => {
    if (e.target.closest('[data-ws-find-next]')) findNext();
    if (e.target.closest('[data-ws-find-close]')) { bar.hidden = true; ta.focus(); }
    if (e.target.closest('[data-ws-find-replace]')) {
      const re = pattern();
      if (!re) return;
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      const one = new RegExp(`^(?:${re.source})$`, re.flags.replace('g', ''));
      if (sel && one.test(sel)) replaceRange(ta.selectionStart, ta.selectionEnd, sel.replace(one, fr.value), false);
      findNext();
    }
    if (e.target.closest('[data-ws-find-all]')) {
      const re = pattern();
      if (!re) return;
      const n = (ta.value.match(re) || []).length;
      if (n) replaceRange(0, ta.value.length, ta.value.replace(re, fr.value), false);
      fmsg.textContent = `${n} replaced.`;
    }
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

// (sprint 94) An object's ⋯ menu, in the worksheet's navigator and the Object Browser's tree: right-click an object
// to open it; Open shows the Object Browser's detail in a panel at the side (its tabs and pages load in the panel).
(() => {
  'use strict';
  document.addEventListener('contextmenu', (e) => {
    const item = e.target.closest?.('.ws-obj, .ob-item');
    const menu = item?.querySelector(':scope > .obj-menu');
    if (!menu || e.shiftKey) return; // Shift+right-click keeps the browser's own menu
    e.preventDefault();
    for (const d of document.querySelectorAll('.obj-menu[open]')) if (d !== menu) d.open = false;
    menu.open = true;
    menu.querySelector('a')?.focus();
  });
  let slide = null;
  const panel = () => {
    if (slide) return slide;
    slide = document.createElement('dialog');
    slide.className = 'obj-slide';
    slide.setAttribute('aria-labelledby', 'obj-slide-title');
    const head = document.createElement('div');
    head.className = 'obj-slide-head';
    const title = Object.assign(document.createElement('strong'), { id: 'obj-slide-title' });
    const full = Object.assign(document.createElement('a'), { className: 'btn btn-sm', textContent: 'Open in the Object Browser' });
    const close = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-sm', textContent: 'Close' });
    close.addEventListener('click', () => slide.close());
    const tools = document.createElement('div');
    tools.append(full, ' ', close);
    head.append(title, tools);
    const body = Object.assign(document.createElement('div'), { className: 'obj-slide-body' });
    slide.append(head, body);
    document.body.append(slide);
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="/builder/sql/objects/panel"]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      load(a.getAttribute('href'));
    });
    slide.addEventListener('click', (e) => { if (e.target === slide) slide.close(); }); // the backdrop
    return slide;
  };
  const load = async (url) => {
    const d = panel();
    const body = d.querySelector('.obj-slide-body');
    body.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      body.innerHTML = await res.text(); // server-rendered, escaped HTML of the same origin
      const root = body.querySelector('.obj-panel');
      d.querySelector('#obj-slide-title').textContent = root?.dataset.label ?? '';
      d.querySelector('.obj-slide-head a').href = url.replace('/sql/objects/panel', '/sql/objects');
    } catch {
      body.textContent = 'The object could not be opened.';
    } finally {
      body.removeAttribute('aria-busy');
    }
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('[data-obj-open]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    a.closest('details')?.removeAttribute('open');
    const d = panel();
    if (!d.open) d.showModal();
    load(a.dataset.objOpen);
  });
})();

// (sprint 95) Table Properties: sections as tabs, rows added, moved and removed without a round trip.
(() => {
  'use strict';
  const form = document.querySelector('form.te');
  if (!form) return;
  for (const el of form.querySelectorAll('[hidden]')) el.hidden = false;
  const show = (key) => {
    for (const b of form.querySelectorAll('[data-te-show]')) b.setAttribute('aria-selected', String(b.dataset.teShow === key));
    for (const sct of form.querySelectorAll('[data-te-section]')) sct.hidden = sct.dataset.teSection !== key;
  };
  show(form.dataset.teTab || 'columns');
  form.querySelector('.te-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-te-show]'); if (b) show(b.dataset.teShow); });
  // a preview opens on the DDL tab: Enter in a field previews instead of applying
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox])')) { e.preventDefault(); form.requestSubmit(form.querySelector('button[value=preview]')); }
  });
  // spare rows: one shows, the others come with Add
  for (const grid of form.querySelectorAll('[data-te-grid]')) {
    // an empty list keeps one empty row to fill in; the others wait for Add
    const real = grid.querySelectorAll('tr.te-row:not(.te-spare)').length;
    [...grid.querySelectorAll('tr.te-spare')].forEach((r, i) => { r.hidden = real > 0 || i > 0; });
    if (grid.dataset.teGrid !== 'col' && !grid.parentElement.parentElement.querySelector(`[data-te-add="${grid.dataset.teGrid}"]`)) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-sm', textContent: '+ Add' });
      b.dataset.teAdd = grid.dataset.teGrid;
      grid.closest('.table-wrap').after(b);
    }
  }
  const renumber = (row, prefix, i) => {
    for (const el of row.querySelectorAll('[name]')) el.name = el.name.replace(new RegExp(`^${prefix}\\.\\d+\\.`), `${prefix}.${i}.`);
    for (const el of row.querySelectorAll('[id]')) el.id = `${el.id.replace(/-n\d+$/, '')}-n${i}`;
    for (const el of row.querySelectorAll('label[for]')) el.htmlFor = `${el.htmlFor.replace(/-n\d+$/, '')}-n${i}`;
  };
  form.addEventListener('click', (e) => {
    const add = e.target.closest('[data-te-add]');
    if (add) {
      const grid = form.querySelector(`[data-te-grid="${add.dataset.teAdd}"]`);
      const hidden = grid.querySelector('tr.te-spare[hidden]');
      if (hidden) { hidden.hidden = false; hidden.querySelector('input:not([type=hidden])')?.focus(); return; }
      const rows = grid.tBodies[0].rows;
      const copy = rows[rows.length - 1].cloneNode(true);
      for (const el of copy.querySelectorAll('input')) { if (el.type === 'checkbox') el.checked = false; else el.value = ''; }
      renumber(copy, add.dataset.teAdd, rows.length);
      grid.tBodies[0].append(copy);
      copy.querySelector('input:not([type=hidden])')?.focus();
    }
    const up = e.target.closest('[data-te-up], [data-te-down]');
    if (up) {
      const row = up.closest('tr');
      const other = up.matches('[data-te-up]') ? row.previousElementSibling : row.nextElementSibling;
      if (!other) return;
      if (up.matches('[data-te-up]')) other.before(row); else other.after(row);
      // the order of the fields is the order of the columns: number the rows again
      [...row.parentElement.rows].forEach((r, i) => renumber(r, 'col', i));
      up.focus();
    }
    const drop = e.target.closest('.te-drop input');
    if (drop) drop.closest('tr').classList.toggle('te-removed', drop.checked);
  });
})();
