// pgkiln builder: the search (Ctrl+K) and the SQL Workshop Launchpad (sprint 96, src/builder/launchpad.ts).
//
//  - Ctrl+K (⌘K) on any builder page, or focusing the header's search field, opens a search dialog: tools,
//    applications, pages and database objects by name (GET /builder/palette?format=json), arrow keys and Enter
//    to open one. Without JavaScript the header's field posts to the results page.
//  - SQL Workshop pages are remembered as "Recently visited" in this browser and listed on the home page.
//  - The home page's tool groups (Development, Administration, Monitoring) become tabs.
// Results are built as text nodes, never parsed as HTML.
(() => {
  'use strict';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(`pgkiln.${k}`) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`pgkiln.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ------------------------------------------------------------ recently visited SQL Workshop pages
  const path = location.pathname;
  if (/^\/builder\/sql\/./.test(path) && !/\/(panel|navigator|action)$/.test(path)) {
    const title = document.title.replace(/ · Builder$/, '');
    const href = path + location.search;
    const list = (store.get('sw.recent') || []).filter((r) => r && r.href !== href);
    list.unshift({ href, title });
    store.set('sw.recent', list.slice(0, 8));
  }
  const recent = document.querySelector('[data-lp-recent]');
  if (recent) {
    const list = store.get('sw.recent') || [];
    for (const r of list) {
      if (typeof r?.href !== 'string' || !r.href.startsWith('/builder/')) continue;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = r.href;
      a.textContent = String(r.title || r.href);
      li.append(a);
      recent.append(li);
    }
    recent.hidden = !recent.children.length;
  }

  // ------------------------------------------------------------ the Launchpad's tabs
  const tabs = document.querySelector('.lp-tabs');
  if (tabs) {
    tabs.hidden = false;
    const show = (g) => {
      for (const b of tabs.querySelectorAll('[data-lp-tab]')) b.setAttribute('aria-selected', String(b.dataset.lpTab === g));
      for (const sct of document.querySelectorAll('[data-lp-group]')) sct.hidden = sct.dataset.lpGroup !== g;
      store.set('lp.tab', g);
    };
    show(store.get('lp.tab') || 'development');
    tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-lp-tab]'); if (b) show(b.dataset.lpTab); });
  }

  // ------------------------------------------------------------ the search dialog
  let dlg = null, input, listbox, status, items = [], active = -1, timer = 0, seq = 0;
  const build = () => {
    dlg = document.createElement('dialog');
    dlg.className = 'palette';
    dlg.setAttribute('aria-label', 'Search the builder');
    input = Object.assign(document.createElement('input'), { type: 'search', placeholder: 'Tables, views, functions, applications, pages, tools…', autocomplete: 'off', id: 'palette-q' });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'palette-list');
    input.setAttribute('aria-label', 'Search');
    listbox = Object.assign(document.createElement('ul'), { id: 'palette-list', className: 'palette-list' });
    listbox.setAttribute('role', 'listbox');
    status = Object.assign(document.createElement('p'), { className: 'palette-status muted small' });
    status.setAttribute('aria-live', 'polite');
    dlg.append(input, listbox, status);
    document.body.append(dlg);
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(query, 150); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) select((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = items[active] || items[0];
        if (r) location.href = r.href;
        else if (input.value.trim()) location.href = `/builder/palette?q=${encodeURIComponent(input.value.trim())}`;
      }
    });
    listbox.addEventListener('click', (e) => { const li = e.target.closest('[role=option]'); if (li) location.href = items[Number(li.dataset.i)].href; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  };
  const select = (i) => {
    active = i;
    for (const li of listbox.children) li.setAttribute('aria-selected', String(Number(li.dataset.i) === i));
    const li = listbox.children[i];
    if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  };
  const query = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) { listbox.replaceChildren(); items = []; status.textContent = 'Type to search.'; return; }
    try {
      const res = await fetch(`/builder/palette?format=json&q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (mine !== seq) return; // a later query is on its way
      items = data.results || [];
      listbox.replaceChildren(...items.map((r, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.id = `palette-${i}`;
        li.dataset.i = String(i);
        const label = Object.assign(document.createElement('strong'), { textContent: r.label });
        const detail = Object.assign(document.createElement('small'), { className: 'muted', textContent: ` ${r.kind}${r.detail ? ` · ${r.detail}` : ''}` });
        li.append(label, detail);
        return li;
      }));
      status.textContent = items.length ? `${items.length} found.` : 'Nothing found.';
      select(items.length ? 0 : -1);
    } catch {
      status.textContent = 'The search failed.';
    }
  };
  const open = (text = '') => {
    if (!dlg) build();
    if (!dlg.open) dlg.showModal();
    input.value = text;
    input.focus();
    query();
  };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open();
    }
  });
  const field = document.querySelector('form[data-palette] input[name=q]');
  field?.addEventListener('focus', () => { const v = field.value; field.blur(); open(v); });
  window.pgkilnPalette = { open };
})();
