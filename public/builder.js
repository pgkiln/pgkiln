// pgapex builder: behaviour on top of the server-rendered builder pages,
// loaded only by builder pages after app.js (the runtime never loads it).
// Everything here is an enhancement: without script the panes are stacked
// sections, every component is a link and the Arrange buttons are plain forms.
//
//  - [data-tabs]: the .tab-panel[data-tab] children become tabs (optionally
//    only while data-tabs-media matches, e.g. the designer's panes on phones);
//  - .pd-tree: an ARIA tree with collapsible folders and arrow-key navigation;
//  - the property editor: a filter box and collapsible property groups;
//  - the layout canvas: drag and drop to move / create / resize components,
//    Alt+arrow keys as the keyboard alternative, zoom and maximize;
//  - input[data-filter-list]: filters the rows it names as you type.
(() => {
  'use strict';
  const store = {
    get(k) {
      try {
        return window.localStorage.getItem(`pgapex.builder.${k}`);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null) window.localStorage.removeItem(`pgapex.builder.${k}`);
        else window.localStorage.setItem(`pgapex.builder.${k}`, v);
      } catch {}
    },
  };

  // ---------------------------------------------------------------- tabs
  function tabify(box) {
    const panels = [...box.children].filter((c) => c.matches('.tab-panel[data-tab]'));
    if (!panels.length) return;
    const key = box.dataset.tabs;
    const list = document.createElement('div');
    list.className = 'tablist';
    list.setAttribute('role', 'tablist');
    if (box.getAttribute('aria-label')) list.setAttribute('aria-label', box.getAttribute('aria-label'));
    const tabs = panels.map((panel) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.id = `${panel.id}-tab`;
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-controls', panel.id);
      const title = panel.querySelector(':scope > .tab-title');
      t.innerHTML = title ? title.innerHTML : panel.id;
      if (title) t.title = title.textContent.trim();
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', t.id);
      list.appendChild(t);
      return t;
    });
    const select = (i, focus) => {
      tabs.forEach((t, j) => {
        const on = i === j;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
      });
      if (focus) tabs[i].focus();
      box.dispatchEvent(new CustomEvent('pgapex:tab', { detail: panels[i], bubbles: true }));
    };
    list.addEventListener('click', (e) => {
      const t = e.target.closest('[role=tab]');
      if (t) {
        select(tabs.indexOf(t), false);
        if (box.hasAttribute('data-tabs-remember')) store.set(`tab.${key}`, t.getAttribute('aria-controls'));
      }
    });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (n === undefined) return;
      e.preventDefault();
      select((n + tabs.length) % tabs.length, true);
    });
    box.insertBefore(list, panels[0]);
    box.classList.add('tabs-on');
    let active = panels.findIndex((p) => p.hasAttribute('data-tab-active'));
    // boxes marked data-tabs-remember reopen the tab used last (the gallery, the centre tabs)
    const remembered = box.hasAttribute('data-tabs-remember') && store.get(`tab.${key}`);
    const r = remembered ? panels.findIndex((p) => p.id === remembered) : -1;
    if (r >= 0) active = r;
    select(Math.max(0, active), false);
    box._untab = () => {
      list.remove();
      box.classList.remove('tabs-on');
      for (const p of panels) {
        p.hidden = false;
        p.removeAttribute('role');
        p.removeAttribute('aria-labelledby');
      }
    };
  }
  function setupTabs(root = document) {
    for (const box of root.querySelectorAll('[data-tabs]')) {
      const media = box.dataset.tabsMedia && window.matchMedia(box.dataset.tabsMedia);
      if (!media) {
        tabify(box);
        continue;
      }
      const apply = () => {
        if (media.matches && !box.classList.contains('tabs-on')) tabify(box);
        else if (!media.matches && box._untab) {
          box._untab();
          box._untab = null;
        }
      };
      media.addEventListener('change', apply);
      apply();
    }
  }

  // ---------------------------------------------------------------- component tree
  function setupTree(tree) {
    tree.setAttribute('role', 'tree');
    const nodes = [];
    for (const li of tree.querySelectorAll('li')) {
      li.setAttribute('role', 'none');
      const node = li.querySelector(':scope > .pd-node');
      const sub = li.querySelector(':scope > ul');
      if (!node) continue;
      node.setAttribute('role', 'treeitem');
      node.tabIndex = -1;
      if (node.hasAttribute('aria-current')) node.setAttribute('aria-selected', 'true');
      if (sub) {
        sub.setAttribute('role', 'group');
        node.classList.add('has-kids');
        const label = node.textContent.trim();
        const saved = store.get(`tree.${label}`);
        if (saved === 'closed') li.setAttribute('data-collapsed', '');
        else if (saved === 'open') li.removeAttribute('data-collapsed');
        // the selected component is always visible
        if (li.querySelector('[aria-current]') && li.querySelector(':scope > ul [aria-current]')) li.removeAttribute('data-collapsed');
        node.setAttribute('aria-expanded', String(!li.hasAttribute('data-collapsed')));
      }
      nodes.push(node);
    }
    for (const ul of tree.querySelectorAll('ul')) if (!ul.getAttribute('role')) ul.setAttribute('role', 'group');
    const first = tree.querySelector('[role=treeitem][aria-current]') || nodes[0];
    if (first) first.tabIndex = 0;
    const visible = () => nodes.filter((n) => !n.closest('li[data-collapsed] > ul'));
    const toggle = (node, open) => {
      const li = node.closest('li');
      const now = !li.hasAttribute('data-collapsed');
      const next = open === undefined ? !now : open;
      li.toggleAttribute('data-collapsed', !next);
      node.setAttribute('aria-expanded', String(next));
      store.set(`tree.${node.textContent.trim()}`, next ? 'open' : 'closed');
    };
    const focus = (node) => {
      for (const n of nodes) n.tabIndex = -1;
      node.tabIndex = 0;
      node.focus();
    };
    tree.addEventListener('click', (e) => {
      const node = e.target.closest('.pd-node.has-kids');
      if (!node) return;
      // folders toggle; component nodes toggle only from the twisty
      if (node.matches('.pd-folder') || e.clientX - node.getBoundingClientRect().left < 20) {
        e.preventDefault();
        toggle(node);
      }
    });
    tree.addEventListener('keydown', (e) => {
      const node = e.target.closest('[role=treeitem]');
      if (!node) return;
      const list = visible();
      const i = list.indexOf(node);
      const kids = node.classList.contains('has-kids');
      const open = node.getAttribute('aria-expanded') === 'true';
      switch (e.key) {
        case 'ArrowDown':
          if (list[i + 1]) focus(list[i + 1]);
          break;
        case 'ArrowUp':
          if (list[i - 1]) focus(list[i - 1]);
          break;
        case 'Home':
          focus(list[0]);
          break;
        case 'End':
          focus(list[list.length - 1]);
          break;
        case 'ArrowRight':
          if (kids && !open) toggle(node, true);
          else if (kids && list[i + 1]) focus(list[i + 1]);
          break;
        case 'ArrowLeft':
          if (kids && open) toggle(node, false);
          else {
            const parent = node.closest('li').parentElement.closest('li')?.querySelector(':scope > .pd-node');
            if (parent) focus(parent);
          }
          break;
        case 'Enter':
        case ' ':
          if (node.matches('.pd-folder')) toggle(node);
          else if (e.key === ' ') node.click();
          else return;
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  // ---------------------------------------------------------------- property editor
  function setupProperties() {
    const pe = document.querySelector('.pe');
    const head = document.querySelector('.pe-head');
    if (!pe) return;
    const groups = [...pe.querySelectorAll('fieldset.prop-group')];
    for (const fs of groups) {
      const legend = fs.querySelector(':scope > legend');
      if (!legend) continue;
      const name = legend.textContent.trim();
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pe-toggle';
      b.textContent = name;
      legend.textContent = '';
      legend.appendChild(b);
      const set = (open, remember) => {
        fs.classList.toggle('is-collapsed', !open);
        b.setAttribute('aria-expanded', String(open));
        if (remember) store.set(`group.${name}`, open ? null : 'closed');
      };
      set(store.get(`group.${name}`) !== 'closed', false);
      b.addEventListener('click', () => set(fs.classList.contains('is-collapsed'), true));
    }
    const row = document.querySelector('.pe-filter-row');
    const input = document.getElementById('pe-filter');
    if (row && input && pe.querySelector('.field')) {
      row.hidden = false;
      const none = document.createElement('p');
      none.className = 'pe-empty-filter';
      none.hidden = true;
      none.textContent = 'No property matches the filter.';
      pe.prepend(none);
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        let hits = 0;
        for (const f of pe.querySelectorAll('.field')) {
          const label = f.querySelector('.label, label')?.textContent.toLowerCase() ?? '';
          const name = [...f.querySelectorAll('[name]')].map((x) => x.name.toLowerCase()).join(' ');
          const hit = !q || label.includes(q) || name.includes(q);
          f.hidden = !hit;
          f.classList.toggle('pe-hit', Boolean(q) && hit);
          if (hit) hits++;
        }
        for (const fs of groups) {
          const any = [...fs.querySelectorAll('.field')].some((f) => !f.hidden);
          fs.hidden = Boolean(q) && !any;
          // while filtering every matching group is open
          if (q) fs.classList.toggle('is-collapsed', false);
          else fs.classList.toggle('is-collapsed', fs.querySelector('.pe-toggle')?.getAttribute('aria-expanded') === 'false');
        }
        none.hidden = !q || hits > 0;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) {
          input.value = '';
          input.dispatchEvent(new Event('input'));
        }
      });
    }
    if (head) {
      const h = () => pe.style.setProperty('--pe-head-h', `${head.offsetHeight}px`);
      h();
      window.addEventListener('resize', h);
    }
    // the toolbar's Save shows unsaved changes
    const save = document.querySelector('.tb-save');
    const form = save && document.getElementById(save.getAttribute('form'));
    if (form) {
      const dirty = () => save.classList.add('is-dirty');
      form.addEventListener('input', dirty);
      form.addEventListener('change', dirty);
    }
  }

  // ---------------------------------------------------------------- layout canvas
  function setupCanvas() {
    const canvas = document.getElementById('pd-layout');
    if (!canvas) return;
    const pid = canvas.dataset.pageId;
    const token = document.querySelector('input[name="__csrf"]')?.value ?? '';
    const zoomEl = canvas;

    // zoom and maximize
    let zoom = Number(store.get('zoom')) || 1;
    const setZoom = (z) => {
      zoom = Math.min(1.5, Math.max(0.6, Math.round(z * 10) / 10));
      zoomEl.style.setProperty('--zoom', String(zoom));
      store.set('zoom', zoom === 1 ? null : String(zoom));
    };
    setZoom(zoom);
    for (const b of document.querySelectorAll('[data-zoom]')) {
      b.hidden = false;
      b.addEventListener('click', () => setZoom(zoom + Number(b.dataset.zoom) * 0.1));
    }
    const max = document.querySelector('[data-maximize]');
    if (max) {
      max.hidden = false;
      const setMax = (on) => {
        document.body.classList.toggle('pd-max', on);
        max.setAttribute('aria-pressed', String(on));
        store.set('max', on ? '1' : null);
      };
      setMax(store.get('max') === '1');
      max.addEventListener('click', () => setMax(!document.body.classList.contains('pd-max')));
    }

    const toast = (message) => {
      document.querySelector('.pd-toast')?.remove();
      const t = document.createElement('div');
      t.className = 'pd-toast';
      t.setAttribute('role', 'alert');
      t.textContent = message;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 6000);
    };
    // every change is the same form post the Arrange buttons make; the answer says where to go
    let busy = false;
    async function post(op, data) {
      if (busy) return;
      busy = true;
      canvas.classList.add('pd-busy');
      try {
        const res = await fetch(`/builder/pages/${pid}/layout/${op}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ __csrf: token, ...data }),
        });
        const out = await res.json().catch(() => ({ ok: false, error: `The change was refused (${res.status}).` }));
        if (!out.ok) throw new Error(out.error || 'The change was refused.');
        window.location.assign(out.location);
      } catch (e) {
        toast(e.message);
        canvas.classList.remove('pd-busy');
        busy = false;
      }
    }

    // ------------------------------------------------ drag and drop
    let drag = null; // { kind, id } or { kind, type, isNew }
    const clear = () => {
      for (const el of canvas.querySelectorAll('.pd-drop-on, .pd-drop-before, .pd-drop-end')) el.classList.remove('pd-drop-on', 'pd-drop-before', 'pd-drop-end');
    };
    document.addEventListener('dragstart', (e) => {
      const src = e.target.closest?.('[data-kind][draggable], [data-new][draggable]');
      if (!src) return;
      drag = src.dataset.new ? { kind: src.dataset.new, type: src.dataset.type, isNew: true } : { kind: src.dataset.kind, id: src.dataset.id };
      e.dataTransfer.effectAllowed = drag.isNew ? 'copy' : 'move';
      e.dataTransfer.setData('text/plain', drag.isNew ? `new ${drag.kind} ${drag.type}` : `${drag.kind} ${drag.id}`);
      (drag.kind === 'region' && !drag.isNew ? src.closest('.pd-region') : src).classList.add('is-dragging');
    });
    document.addEventListener('dragend', () => {
      for (const el of document.querySelectorAll('.is-dragging')) el.classList.remove('is-dragging');
      clear();
      drag = null;
    });
    // where a drop would go: { zone, before (element or null) }
    const target = (e) => {
      if (!drag || !(e.target instanceof Element)) return null;
      if (drag.kind === 'region') {
        const grid = e.target.closest('.pd-grid');
        if (!grid || !canvas.contains(grid)) return null;
        const over = e.target.closest('.pd-region');
        if (over) {
          const r = over.getBoundingClientRect();
          // the right half of a region drops after it
          const after = e.clientX > r.left + r.width / 2;
          const next = after ? over.nextElementSibling : over;
          return { zone: grid, before: next && next.matches('.pd-region') ? next : null };
        }
        return { zone: grid, before: null };
      }
      const slot = e.target.closest(`.pd-slot[data-drop="${drag.kind}"]`);
      if (!slot) return null;
      const chip = e.target.closest('.pd-chip');
      if (chip) {
        const r = chip.getBoundingClientRect();
        const after = drag.kind === 'button' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
        const next = after ? chip.nextElementSibling : chip;
        return { zone: slot, before: next && next.matches('.pd-chip') ? next : null };
      }
      return { zone: slot, before: null };
    };
    document.addEventListener('dragover', (e) => {
      const t = target(e);
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = drag.isNew ? 'copy' : 'move';
      clear();
      t.zone.classList.add('pd-drop-on');
      if (t.before) t.before.classList.add('pd-drop-before');
      else t.zone.classList.add('pd-drop-end');
    });
    document.addEventListener('drop', (e) => {
      const t = target(e);
      if (!t) return;
      e.preventDefault();
      const d = drag;
      clear();
      const before = t.before ? t.before.dataset.id : '';
      const region = d.kind === 'region' ? '' : t.zone.dataset.region;
      if (d.isNew) post('create', { kind: d.kind, type: d.type, region, before });
      else if (before !== d.id) post('move', { kind: d.kind, id: d.id, region, before });
    });

    // ------------------------------------------------ resizing a region (drag its right edge)
    canvas.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.pd-resize');
      if (!handle || e.button !== 0) return;
      e.preventDefault();
      const block = handle.closest('.pd-region');
      const grid = block.closest('.pd-grid');
      const col = (grid.getBoundingClientRect().width + 8) / 12;
      const left = block.getBoundingClientRect().left;
      const start = Number(block.dataset.span);
      let span = start;
      block.classList.add('is-resizing');
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const n = Math.min(12, Math.max(1, Math.round((ev.clientX - left + 4) / col)));
        if (n === span) return;
        block.classList.replace(`pd-span-${span}`, `pd-span-${n}`);
        span = n;
        block.querySelector('.pd-region-meta').textContent = `${n}/12`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        block.classList.remove('is-resizing');
        if (span !== start) post('span', { id: block.dataset.id, columns: String(span) });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });

    // ------------------------------------------------ keyboard: Alt+↑/↓ moves, Alt+Shift+←/→ resizes
    canvas.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target.closest('.pd-chip, .pd-region-link');
      if (!el) return;
      const block = el.closest('.pd-region');
      const kind = el.matches('.pd-chip') ? el.dataset.kind : 'region';
      const id = el.matches('.pd-chip') ? el.dataset.id : block.dataset.id;
      if (!e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        post('move', { kind, id, dir: e.key === 'ArrowUp' ? 'up' : 'down' });
      } else if (e.shiftKey && kind === 'region' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const n = Number(block.dataset.span) + (e.key === 'ArrowRight' ? 1 : -1);
        if (n >= 1 && n <= 12) post('span', { id, columns: String(n) });
      }
    });
    // after a reload the moved component keeps the focus
    const selected = canvas.querySelector('.pd-chip[aria-current], .pd-region-link[aria-current]');
    if (selected && store.get('kbd') === '1') selected.focus({ preventScroll: false });
    store.set('kbd', null);
    canvas.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.startsWith('Arrow')) store.set('kbd', '1');
    }, true);
  }

  // ---------------------------------------------------------------- small things
  // a select that navigates (the toolbar's page switcher)
  document.addEventListener('change', (e) => {
    if (e.target.matches?.('select[data-autosubmit]')) e.target.form?.submit();
  });

  // a search box that filters a list as you type (the App Builder's applications);
  // without script the form searches on the server
  document.addEventListener('input', (e) => {
    const box = e.target;
    if (!box.matches?.('input[data-filter-list]')) return;
    const words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [...document.querySelectorAll(box.dataset.filterList)];
    let shown = 0;
    for (const row of rows) {
      const text = row.textContent.toLowerCase();
      row.hidden = !words.every((w) => text.includes(w));
      if (!row.hidden) shown++;
    }
    const count = document.querySelector('.ab-count');
    if (count) count.textContent = shown === rows.length ? `${rows.length} application${rows.length === 1 ? '' : 's'}` : `${shown} of ${rows.length}`;
  });

  function init() {
    setupTabs();
    for (const tree of document.querySelectorAll('.pd-tree')) setupTree(tree);
    setupProperties();
    setupCanvas();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
