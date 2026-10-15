// pgkiln builder: behaviour on top of the server-rendered builder pages,
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
//  - input[data-filter-list]: filters the rows it names as you type;
//  - the query builder's canvas: tables placed and dragged, joins drawn as lines.
(() => {
  'use strict';
  const store = {
    get(k) {
      try {
        return window.localStorage.getItem(`pgkiln.builder.${k}`);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null) window.localStorage.removeItem(`pgkiln.builder.${k}`);
        else window.localStorage.setItem(`pgkiln.builder.${k}`, v);
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
      box.dispatchEvent(new CustomEvent('pgkiln:tab', { detail: panels[i], bubbles: true }));
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

  // ---------------------------------------------------------------- the rendering tree's context menu (sprint 77)
  // Right-click (or Shift+F10 / the menu key) on a region, item or button: create in or below it, duplicate,
  // copy to another page, expand or collapse everything below, delete. Every entry is a link or a form post
  // the server also answers without JavaScript.
  function setupTreeMenu(tree) {
    const pid = tree.dataset.pageId;
    const base = `/builder/pages/${pid}`;
    const token = document.querySelector('input[name="__csrf"]')?.value ?? '';
    let menu = null;
    let opener = null;
    const close = (refocus = true) => {
      menu?.remove();
      menu = null;
      if (refocus) opener?.focus();
    };
    const submit = (action, fields, confirmText) => {
      if (confirmText && !window.confirm(confirmText)) return;
      const f = document.createElement('form');
      f.method = 'post';
      f.action = action;
      for (const [k, v] of Object.entries({ __csrf: token, ...fields })) {
        const i = document.createElement('input');
        i.type = 'hidden';
        i.name = k;
        i.value = v;
        f.appendChild(i);
      }
      document.body.appendChild(f);
      f.submit();
    };
    const setAll = (node, open) => {
      const li = node.closest('li');
      for (const sub of [li, ...li.querySelectorAll('li')]) {
        const n = sub.querySelector(':scope > .pd-node.has-kids');
        if (!n) continue;
        sub.toggleAttribute('data-collapsed', !open);
        n.setAttribute('aria-expanded', String(open));
      }
    };
    const entries = (node) => {
      const kind = node.dataset.kind;
      const id = node.dataset.id;
      const label = node.querySelector('.pd-label')?.textContent ?? '';
      const go = (q) => () => window.location.assign(`${base}?${q}`);
      const copyDialog = () => {
        const d = document.getElementById('pd-copy-dialog');
        if (!d) return;
        d.querySelector('input[name="kind"]').value = kind;
        d.querySelector('input[name="id"]').value = id;
        d.querySelector('[data-copy-what]').textContent = `${kind[0].toUpperCase()}${kind.slice(1)}: ${label}`;
        d.showModal();
      };
      const list = [];
      if (kind === 'region') {
        list.push(['Create page item', go(`new=item&region=${id}`)], ['Create button', go(`new=button&region=${id}`)],
          ['Create dynamic action', go('new=dynamic_action')],
          ['Create region below', () => submit(`${base}/layout/create`, { kind: 'region', type: 'static', position: node.dataset.position ?? '', before: node.dataset.next ?? '' })], null);
      }
      list.push(['Duplicate', () => submit(`${base}/layout/duplicate`, { kind, id })], ['Copy to other page…', copyDialog]);
      if (kind !== 'region') list.push(['Create dynamic action', go('new=dynamic_action')]);
      if (node.classList.contains('has-kids')) list.push(null, ['Expand all below', () => setAll(node, true)], ['Collapse all below', () => setAll(node, false)]);
      // (sprint 90; APEX: Comment Out) leave a component out of the page without deleting it (build option COMMENTED_OUT)
      if (['region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'computation', 'branch'].includes(kind))
        list.push(null, node.hasAttribute('data-commented')
          ? ['Uncomment', () => submit(`${base}/layout/comment`, { kind, id, on: 'false' })]
          : ['Comment out', () => submit(`${base}/layout/comment`, { kind, id, on: 'true' })]);
      list.push(null, ['Delete', () => submit(`${base}/c/${kind}/${id}/delete`, {}, `Delete ${kind} ${label}?`), 'danger']);
      return list;
    };
    const open = (node, x, y) => {
      close(false);
      opener = node;
      menu = document.createElement('div');
      menu.className = 'pd-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', `Actions: ${node.querySelector('.pd-label')?.textContent ?? ''}`);
      for (const e of entries(node)) {
        if (!e) {
          const sep = document.createElement('div');
          sep.setAttribute('role', 'separator');
          menu.appendChild(sep);
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        b.textContent = e[0];
        if (e[2]) b.classList.add(`is-${e[2]}`);
        b.addEventListener('click', () => {
          close(e[0] !== 'Copy to other page…');
          e[1]();
        });
        menu.appendChild(b);
      }
      document.body.appendChild(menu);
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
      menu.querySelector('[role=menuitem]')?.focus();
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('[role=menuitem]')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
        else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
        else if (e.key === 'Home') items[0].focus();
        else if (e.key === 'End') items[items.length - 1].focus();
        else if (e.key === 'Escape' || e.key === 'Tab') close();
        else return;
        e.preventDefault();
      });
    };
    tree.addEventListener('contextmenu', (e) => {
      const node = e.target.closest('.pd-node[data-kind][data-id]');
      if (!node || !['region', 'item', 'button'].includes(node.dataset.kind)) return;
      e.preventDefault();
      const r = node.getBoundingClientRect();
      // the keyboard's menu key has no pointer position
      open(node, e.clientX || r.left + 24, e.clientY || r.bottom);
    });
    document.addEventListener('pointerdown', (e) => {
      if (menu && !menu.contains(e.target)) close(false);
    });
    window.addEventListener('blur', () => close(false));
    const dialog = document.getElementById('pd-copy-dialog');
    dialog?.querySelector('[data-dialog-close]')?.addEventListener('click', () => {
      dialog.close();
      opener?.focus();
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
    // (sprint 77, APEX: Show Common / Show All, Go to Group) next to the filter
    if (row && groups.length) {
      const bar = document.createElement('div');
      bar.className = 'pe-view';
      if (pe.querySelector('[data-more]')) {
        const seg = document.createElement('div');
        seg.className = 'segmented pe-common';
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Properties shown');
        const showCommon = (on, remember) => {
          pe.classList.toggle('pe-show-common', on);
          for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.value === 'common') === on));
          for (const fs of groups) fs.classList.toggle('pe-group-more', on && !fs.querySelector('.field:not([data-more] .field), .options-field:not([data-more] .options-field)'));
          if (remember) store.set('pe.common', on ? '1' : null);
        };
        for (const [v, label] of [['common', 'Common'], ['all', 'All']]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.value = v;
          b.textContent = label;
          b.addEventListener('click', () => showCommon(v === 'common', true));
          seg.appendChild(b);
        }
        bar.appendChild(seg);
        showCommon(store.get('pe.common') === '1', false);
      }
      const named = groups.filter((fs) => fs.querySelector(':scope > legend'));
      if (named.length > 1) {
        const sel = document.createElement('select');
        sel.className = 'pe-goto';
        sel.setAttribute('aria-label', 'Go to group');
        sel.innerHTML = '<option value="">Go to group</option>';
        named.forEach((fs, i) => {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = fs.querySelector(':scope > legend').textContent.trim();
          sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
          const fs = named[Number(sel.value)];
          sel.value = '';
          if (!fs) return;
          // a group on another tab (a region's Attributes): open that tab first (tabify names its tab <panel id>-tab)
          const panel = fs.closest('[data-tab]');
          if (panel?.hidden) document.getElementById(`${panel.id}-tab`)?.click();
          const t = fs.querySelector('.pe-toggle');
          if (t?.getAttribute('aria-expanded') === 'false') t.click();
          fs.scrollIntoView({ block: 'start', behavior: 'smooth' });
          t?.focus({ preventScroll: true });
        });
        bar.appendChild(sel);
      }
      if (bar.children.length) row.after(bar);
    }
    // (sprint 77, APEX: the Template Options dialog) the checkboxes in a dialog, opened from a button that counts them.
    // The dialog is the body's (not inside the form or the property editor's wrappers, which Common hides); the
    // checkboxes belong to their form through the form attribute, so they are saved with it.
    let optionDialogs = 0;
    for (const fs of pe.querySelectorAll('fieldset.options-field')) {
      const form = fs.closest('form');
      if (!form) continue;
      if (!form.id) form.id = `pe-form-${++optionDialogs}`;
      const boxes = [...fs.querySelectorAll('input[type=checkbox]')];
      for (const x of boxes) x.setAttribute('form', form.id);
      const legend = fs.querySelector('legend')?.textContent.trim() ?? 'Options';
      const holder = document.createElement('div');
      holder.className = 'field pe-options-open';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm';
      const count = () => {
        const n = boxes.filter((x) => x.checked).length;
        b.textContent = `${legend}${n ? ` (${n})` : ''}…`;
      };
      const d = document.createElement('dialog');
      d.className = 'pd-dialog';
      d.setAttribute('aria-label', legend);
      fs.replaceWith(holder);
      holder.appendChild(b);
      d.appendChild(fs);
      const ok = document.createElement('div');
      ok.className = 'pd-dialog-buttons';
      ok.innerHTML = '<button type="button" class="btn btn-primary">OK</button>';
      d.appendChild(ok);
      document.body.appendChild(d);
      // the count follows every change (Escape closes the dialog without OK); a change is an unsaved change
      for (const x of boxes)
        x.addEventListener('change', () => {
          count();
          document.querySelector(`.tb-save[form="${form.id}"]`)?.classList.add('is-dirty');
        });
      ok.querySelector('button').addEventListener('click', () => d.close());
      d.addEventListener('close', () => b.focus());
      b.addEventListener('click', () => d.showModal());
      count();
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
      // (sprint 77) empty display positions and button positions show while something can drop there
      canvas.classList.add(`pd-dragging-${drag.kind}`);
    });
    document.addEventListener('dragend', () => {
      for (const el of document.querySelectorAll('.is-dragging')) el.classList.remove('is-dragging');
      canvas.classList.remove('pd-dragging-region', 'pd-dragging-item', 'pd-dragging-button');
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
      // a region's display position, a button's position in its region
      const place = d.kind === 'region' ? { position: t.zone.dataset.position ?? '' } : d.kind === 'button' ? { slot: t.zone.dataset.slot ?? '' } : {};
      if (d.isNew) post('create', { kind: d.kind, type: d.type, region, before, ...place });
      else if (before !== d.id || t.zone !== canvas.querySelector(`[data-kind="${d.kind}"][data-id="${d.id}"]`)?.closest('.pd-grid, .pd-slot')) post('move', { kind: d.kind, id: d.id, region, before, ...place });
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
    if (e.target.matches?.('select[data-autosubmit], input[type=checkbox][data-autosubmit]')) e.target.form?.submit();
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

  // icon picker (forms.ts iconPicker): the filter box narrows the grid; the summary shows the choice
  document.addEventListener('input', (e) => {
    const box = e.target;
    if (!box.matches?.('input[data-icon-filter]')) return;
    const q = box.value.trim().toLowerCase();
    const picker = box.closest('.icon-picker');
    for (const c of picker.querySelectorAll('.icon-grid .icon-choice')) c.hidden = !!q && !c.textContent.toLowerCase().includes(q);
    // (0.31) and the Lucide icons by name and search words, as more choices of the same radio group
    clearTimeout(box.pgkilnTimer);
    box.pgkilnTimer = setTimeout(() => moreIcons(box, picker, q), 250);
  });
  async function moreIcons(box, picker, q) {
    const more = picker.querySelector('[data-icon-more]');
    const name = picker.querySelector('.icon-grid input[type=radio]')?.name;
    if (!more || !name || !box.dataset.iconSearch) return;
    if (q.length < 2) {
      more.replaceChildren();
      more.hidden = true;
      return;
    }
    let found = { icons: [], version: '' };
    try {
      const res = await fetch(`${box.dataset.iconSearch}?q=${encodeURIComponent(q)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (res.ok) found = await res.json();
    } catch {}
    if (box.value.trim().toLowerCase() !== q) return;
    const NS = 'http://www.w3.org/2000/svg';
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'icon-grid';
    const legend = document.createElement('legend');
    legend.className = 'icon-more-legend';
    legend.textContent = found.icons.length ? `More icons (${found.icons.length})` : 'No more icons';
    fieldset.append(legend);
    for (const n of found.icons) {
      const label = document.createElement('label');
      label.className = 'icon-choice';
      label.title = n;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = n;
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(NS, 'use');
      use.setAttribute('href', `/static/icon/${n}.svg?v=${encodeURIComponent(found.version)}#i`);
      svg.append(use);
      const text = document.createElement('span');
      text.className = 'icon-name';
      text.textContent = n;
      label.append(radio, svg, text);
      fieldset.append(label);
    }
    more.replaceChildren(fieldset);
    more.hidden = false;
  }
  document.addEventListener('change', (e) => {
    const radio = e.target;
    const picker = radio.closest?.('.icon-picker');
    if (!picker || radio.type !== 'radio') return;
    const summary = picker.querySelector('summary');
    const choice = radio.closest('.icon-choice');
    const svg = choice.querySelector('svg');
    summary.replaceChildren();
    if (svg) summary.append(svg.cloneNode(true));
    const label = document.createElement('span');
    label.textContent = radio.value || '- none -';
    if (!radio.value) label.className = 'muted';
    summary.append(label);
    // a choice from the grid replaces what was typed under "any icon"
    const custom = picker.querySelector('[data-icon-custom]');
    if (custom) custom.value = '';
  });

  // Theme Roller: the style form's values on the preview (CSS variables through the CSSOM, which the CSP allows)
  function setupThemePreview() {
    const preview = document.querySelector('[data-tr-preview]');
    const form = document.querySelector('form[data-tr-form]');
    if (!preview || !form) return;
    let lists = {};
    try {
      lists = JSON.parse(preview.dataset.trPreview);
    } catch {}
    const own = (name) => form.elements[`${name}_own`]?.checked;
    const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : '');
    const from = (list, key) => (key && Object.prototype.hasOwnProperty.call(list || {}, key) ? list[key] : '');
    const set = (name, value) => (value ? preview.style.setProperty(name, value) : preview.style.removeProperty(name));
    const update = () => {
      const accent = own('accent') ? hex(form.elements.accent?.value) : '';
      set('--accent', accent);
      set('--accent-soft', accent ? `color-mix(in srgb, ${accent} 14%, #ffffff)` : '');
      set('--header', own('header') ? hex(form.elements.header?.value) : '');
      set('--font', from(lists.fonts, form.elements.font?.value));
      set('--font-size', from(lists.sizes, form.elements.font_size?.value));
      set('--radius', from(lists.radii, form.elements.radius?.value));
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
  }

  // ---------------------------------------------------------------- query builder canvas
  // (0.31) SQL Workshop → Query Builder: the chosen tables are boxes. On wider screens they are
  // placed where they were left (data-x/y; dragged by the handle, or moved with its arrow keys,
  // kept in hidden p=table:x,y inputs for the next Apply); on phones they stay stacked. The joins
  // are lines between their columns; dragging a column's dot onto a column of another table adds
  // a join (j=a=b) and applies the form. The Joins section's selects do the same without a mouse.
  function setupQueryCanvas() {
    const canvas = document.querySelector('.qb-canvas');
    if (!canvas) return;
    const form = canvas.closest('form');
    let joins = [];
    try {
      joins = JSON.parse(canvas.dataset.joins || '[]');
    } catch {}
    const free = window.matchMedia('(min-width: 641px)').matches;
    const boxes = [...canvas.querySelectorAll('.qb-table')];
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'qb-lines');
    svg.setAttribute('aria-hidden', 'true');
    canvas.style.position = 'relative';
    canvas.prepend(svg);
    const fit = () => {
      if (!free) return;
      const h = Math.max(0, ...boxes.map((b) => b.offsetTop + b.offsetHeight));
      canvas.style.height = `${h + 16}px`;
    };
    if (free) {
      canvas.classList.add('qb-free');
      for (const b of boxes) {
        b.style.left = `${Number(b.dataset.x) || 0}px`;
        b.style.top = `${Number(b.dataset.y) || 0}px`;
      }
      for (const m of canvas.querySelectorAll('.qb-move')) m.hidden = false;
      fit();
    }
    // a column's row on the canvas (inside its list's visible part), in canvas coordinates
    const anchor = (ref) => {
      const row = [...canvas.querySelectorAll('.qb-col')].find((r) => r.dataset.ref === ref);
      if (!row) return null;
      const c = canvas.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const list = row.parentElement.getBoundingClientRect();
      const y = Math.min(Math.max(r.top + r.height / 2, list.top), list.bottom);
      return { left: r.left - c.left + canvas.scrollLeft, right: r.right - c.left + canvas.scrollLeft, y: y - c.top + canvas.scrollTop };
    };
    const curve = (a, b) => {
      // leave from the sides that face each other (both right sides when they overlap)
      let x1 = a.right;
      let x2 = b.left;
      let bend = 40;
      if (b.right < a.left) [x1, x2] = [a.left, b.right];
      else if (!(a.right < b.left)) [x1, x2, bend] = [a.right, b.right, -40];
      const d1 = x1 === a.left ? -Math.abs(bend) : Math.abs(bend);
      const d2 = bend < 0 ? Math.abs(bend) : x2 === b.left ? -Math.abs(bend) : Math.abs(bend);
      return `M ${x1} ${a.y} C ${x1 + d1} ${a.y}, ${x2 + d2} ${b.y}, ${x2} ${b.y}`;
    };
    const path = (d, cls) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      if (cls) p.setAttribute('class', cls);
      svg.append(p);
      return p;
    };
    const draw = () => {
      svg.replaceChildren();
      svg.setAttribute('width', String(canvas.scrollWidth));
      svg.setAttribute('height', String(canvas.scrollHeight));
      for (const j of joins) {
        const a = anchor(j.a);
        const b = anchor(j.b);
        if (a && b) path(curve(a, b), j.custom ? 'qb-custom' : '');
      }
    };
    draw();
    window.addEventListener('resize', draw);
    canvas.addEventListener('scroll', draw, true);

    // moving a table
    const keep = (box) => {
      const value = `${box.dataset.table}:${Math.round(box.offsetLeft)},${Math.round(box.offsetTop)}`;
      let input = box.querySelector('input[name="p"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'p';
        box.prepend(input);
      }
      input.value = value;
    };
    const moveTo = (box, x, y) => {
      box.style.left = `${Math.max(0, Math.round(x))}px`;
      box.style.top = `${Math.max(0, Math.round(y))}px`;
      fit();
      draw();
    };
    for (const handle of canvas.querySelectorAll('.qb-move')) {
      const box = handle.closest('.qb-table');
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const start = { x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop };
        box.classList.add('qb-dragging');
        const move = (ev) => moveTo(box, start.left + ev.clientX - start.x, start.top + ev.clientY - start.y);
        const up = () => {
          handle.removeEventListener('pointermove', move);
          box.classList.remove('qb-dragging');
          keep(box);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up, { once: true });
        handle.addEventListener('pointercancel', up, { once: true });
      });
      handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 64 : 16;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        moveTo(box, box.offsetLeft + d[0], box.offsetTop + d[1]);
        keep(box);
      });
    }

    // drawing a join: from a column's dot to a column of another table
    for (const dot of canvas.querySelectorAll('.qb-link')) {
      dot.hidden = false;
      // the mouse gesture only; the Joins section's selects are the keyboard way
      dot.tabIndex = -1;
      dot.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dot.setPointerCapture(e.pointerId);
        const from = anchor(dot.dataset.ref);
        const table = dot.closest('.qb-table');
        const line = path('', 'qb-custom qb-drawing');
        let target = null;
        const move = (ev) => {
          const c = canvas.getBoundingClientRect();
          const x = ev.clientX - c.left + canvas.scrollLeft;
          const y = ev.clientY - c.top + canvas.scrollTop;
          line.setAttribute('d', `M ${x < from.left ? from.left : from.right} ${from.y} L ${x} ${y}`);
          const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.qb-col');
          const next = row && row.closest('.qb-table') !== table ? row : null;
          if (next !== target) {
            target?.classList.remove('qb-target');
            target = next;
            target?.classList.add('qb-target');
          }
        };
        const up = () => {
          dot.removeEventListener('pointermove', move);
          line.remove();
          if (!target) return;
          target.classList.remove('qb-target');
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'j';
          input.value = `${dot.dataset.ref}=${target.dataset.ref}`;
          form.append(input);
          for (const box of boxes) if (free) keep(box);
          form.requestSubmit();
        };
        dot.addEventListener('pointermove', move);
        dot.addEventListener('pointerup', up, { once: true });
        dot.addEventListener('pointercancel', () => {
          dot.removeEventListener('pointermove', move);
          line.remove();
          target?.classList.remove('qb-target');
        }, { once: true });
      });
    }
  }

  function init() {
    setupQueryCanvas();
    setupThemePreview();
    setupTabs();
    for (const tree of document.querySelectorAll('.pd-tree')) setupTree(tree);
    for (const tree of document.querySelectorAll('.pd-tree[data-tree-menu]')) setupTreeMenu(tree);
    setupProperties();
    setupCanvas();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// Mail services: Test connection and Send test mail answer in place, so the form keeps what was typed
// (the secret too). Without JavaScript the buttons post the form and the page comes back with the result.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('button[name="check"][formaction$="/mail/check"]');
  if (!btn || !btn.form) return;
  e.preventDefault();
  const form = btn.form;
  const out = form.querySelector('.mail-check-result');
  const data = new FormData(form);
  data.set('check', btn.value);
  const buttons = form.querySelectorAll('button[name="check"]');
  buttons.forEach((b) => (b.disabled = true));
  if (out) out.textContent = btn.value === 'send' ? 'Sending…' : 'Checking…';
  try {
    const res = await fetch(btn.formAction, { method: 'POST', body: new URLSearchParams(data), headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const json = await res.json();
    const div = document.createElement('div');
    div.className = `alert ${json.ok ? 'alert-success' : 'alert-error'}`;
    div.textContent = json.text || (json.ok ? 'OK' : 'The check failed.');
    out?.replaceChildren(div);
  } catch {
    if (out) out.textContent = 'The check could not be made (the session may have ended: reload the page).';
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// (sprint 59) The Page Designer's help pane (APEX: the Help tab of the property editor): the property
// that has the focus, its help, the column it is stored in and the guide section of the component type.
(() => {
  const pane = document.querySelector('[data-pe-help]');
  if (!pane) return;
  const guide = pane.closest('.pe-help')?.dataset.guide;
  let current = null;
  const show = (field) => {
    if (!field || field === current) return;
    current = field;
    const label = (field.querySelector('label.label, label.check, .label')?.textContent || field.dataset.prop).trim();
    const help = field.querySelector('.help');
    pane.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = label;
    pane.append(h);
    if (help) {
      const p = document.createElement('p');
      // the help is the server's own (escaped) markup: copy its nodes, links included
      p.append(...[...help.childNodes].map((n) => n.cloneNode(true)));
      pane.append(p);
    } else {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'This property has no help of its own: see the guide.';
      pane.append(p);
    }
    const meta = document.createElement('p');
    meta.className = 'small muted';
    const code = document.createElement('code');
    code.textContent = field.dataset.prop;
    meta.append('Stored as ', code, ' (in exports and application files).');
    pane.append(meta);
    if (guide) {
      const a = document.createElement('a');
      a.href = guide;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'This component in the guide ▸';
      pane.append(a);
    }
  };
  document.addEventListener('focusin', (e) => show(e.target.closest?.('.pe [data-prop]')));
  document.addEventListener('pointerover', (e) => {
    // pointing at a property shows its help too, unless another one has the focus
    if (document.activeElement?.closest?.('.pe [data-prop]')) return;
    show(e.target.closest?.('.pe [data-prop]'));
  });
})();

// (sprint 73) a proposed value is selected on the first focus, so typing replaces it (data-select-once)
document.querySelectorAll('input[data-select-once]').forEach((el) => {
  el.addEventListener('focus', () => {
    el.select();
    // the click that focused it would put the caret back: keep the selection
    el.addEventListener('mouseup', (e) => e.preventDefault(), { once: true });
  }, { once: true });
});

// (sprint 73) a form that takes a while (data-progress="Creating …"): an overlay with the message while the server works
document.addEventListener('submit', (e) => {
  const form = e.target.closest?.('form[data-progress]');
  if (!form || e.defaultPrevented || !form.checkValidity()) return;
  const overlay = document.createElement('div');
  overlay.className = 'progress-overlay';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  const box = document.createElement('div');
  box.className = 'progress-box';
  const spin = document.createElement('span');
  spin.className = 'progress-spinner';
  spin.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = form.dataset.progress;
  box.append(spin, text);
  overlay.append(box);
  document.body.append(overlay);
  // back from the browser's cache (the back button): no overlay
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) overlay.remove(); }, { once: true });
});

// (sprint 74) a search box that filters a list's rows while typing (data-filter-rows="tbody id"); the form still works without it
document.querySelectorAll('input[data-filter-rows]').forEach((el) => {
  const body = document.getElementById(el.dataset.filterRows);
  if (!body) return;
  el.addEventListener('input', () => {
    const q = el.value.trim().toLowerCase();
    body.querySelectorAll(':scope > tr, :scope > li').forEach((tr) => { tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q); });
  });
});

// (sprint 74) Settings tabs without a reload; the form remembers the tab for the redirect after Save.
// The authentication type shows only its own fields.
(() => {
  const links = [...document.querySelectorAll('[data-tab-link]')];
  if (!links.length) return;
  const show = (tab) => {
    document.querySelectorAll('.settings-panel').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
    links.forEach((l) => (l.dataset.tabLink === tab ? l.setAttribute('aria-current', 'page') : l.removeAttribute('aria-current')));
    document.querySelectorAll('[data-settings-tab]').forEach((i) => { i.value = tab; });
    const save = document.querySelector('.settings-save');
    if (save) save.hidden = tab === 'errors' || tab === 'pwa';
    history.replaceState(null, '', `?tab=${tab}`);
  };
  links.forEach((l) => l.addEventListener('click', (e) => { e.preventDefault(); show(l.dataset.tabLink); }));
  const auth = document.querySelector('.settings-form select[name="authentication"]');
  auth?.addEventListener('change', () => {
    document.querySelectorAll('.auth-part').forEach((p) => { p.hidden = p.dataset.auth !== auth.value; });
  });
})();

// (sprint 75) the Object Browser's filter: objects whose name holds the text; folders without any are hidden
document.querySelectorAll('input[data-filter-tree]').forEach((el) => {
  const tree = document.getElementById(el.dataset.filterTree);
  if (!tree) return;
  el.addEventListener('input', () => {
    const q = el.value.trim().toLowerCase();
    tree.querySelectorAll('details.ob-folder').forEach((folder) => {
      let n = 0;
      folder.querySelectorAll('li').forEach((li) => {
        const hit = !q || li.textContent.toLowerCase().includes(q);
        li.hidden = !hit;
        if (hit) n++;
      });
      folder.hidden = !!q && n === 0;
      if (q && n) folder.open = true;
    });
  });
});

// (sprint 87) The create application wizard:
// - an alias follows its name (data-derive-from) until the developer types in it, like aliasFor() on the server;
// - choosing a schema under Data reloads the Pages list (and the proposed name and alias, while untouched)
//   without leaving the page; without JavaScript, "Show its tables" does the same with a reload;
// - First user and Password are hidden while Authentication is None (the server ignores them then).
(() => {
  const slug = (v) => {
    let a = v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (a && !/^[a-z]/.test(a)) a = `app-${a}`;
    return a;
  };
  document.querySelectorAll('input[data-derive-from]').forEach((alias) => {
    const name = document.getElementById(alias.dataset.deriveFrom);
    if (!name) return;
    alias.addEventListener('input', () => alias.setAttribute('data-edited', ''));
    name.addEventListener('input', () => {
      if (!alias.hasAttribute('data-edited')) alias.value = slug(name.value);
    });
  });

  document.querySelectorAll('select[name="authentication"]').forEach((auth) => {
    const form = auth.form;
    const fields = ['admin_user', 'admin_password'].map((n) => form?.elements.namedItem(n)?.closest?.('.field')).filter(Boolean);
    if (!fields.length) return;
    const sync = () => fields.forEach((f) => (f.hidden = auth.value === 'none'));
    auth.addEventListener('change', sync);
    sync();
  });

  const picker = document.querySelector('form.create-schema select[name="schema"]');
  const pages = document.getElementById('aw-pages');
  const hidden = document.getElementById('aw-schema-fields');
  if (!picker || !pages || !hidden) return;
  const name = document.getElementById('f_name');
  let nameTouched = false;
  name?.addEventListener('input', () => (nameTouched = true));
  picker.addEventListener('change', async () => {
    const url = `${picker.form.action}?schema=${encodeURIComponent(picker.value)}`;
    pages.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(url, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const nextPages = doc.getElementById('aw-pages');
      const nextHidden = doc.getElementById('aw-schema-fields');
      if (!nextPages || !nextHidden) throw new Error('unexpected page');
      pages.replaceWith(nextPages);
      hidden.replaceWith(nextHidden);
      // the proposals for the new schema, unless the developer already typed a name or alias
      const alias = document.querySelector('input[data-derive-from]');
      if (!nameTouched && name) name.value = doc.getElementById('f_name')?.value ?? name.value;
      if (alias && !alias.hasAttribute('data-edited')) alias.value = doc.getElementById('f_alias')?.value ?? alias.value;
      history.replaceState(null, '', url);
      document.getElementById('aw-pages')?.removeAttribute('aria-busy');
    } catch {
      picker.form.submit();
    }
  });
  // the button is for pages without JavaScript
  picker.form.querySelector('button')?.setAttribute('hidden', '');
})();
