// pgapex client runtime. Progressive enhancement only: every page works
// without JavaScript (dialogs become normal pages, dynamic actions do nothing).
// No inline handlers anywhere, so the Content-Security-Policy can forbid
// inline scripts.
document.documentElement.classList.add('js');

(() => {
  const body = document.body;
  const base = body.dataset.base;
  const pageNo = body.dataset.page;
  const metaEl = document.getElementById('pgapex-meta');
  const meta = metaEl ? JSON.parse(metaEl.textContent) : { das: [], csrf: '' };
  const form = document.querySelector('form.page-form');

  // ------------------------------------------------------------ items
  const fieldsNamed = (name) => [...document.getElementsByName(name)].filter((el) => el.form === form || !el.form);
  const wrapperOf = (name) => document.querySelector(`[data-item="${CSS.escape(name)}"]`);

  function itemValue(name) {
    const els = fieldsNamed(name);
    if (!els.length) return '';
    const el = els[0];
    // a date range item: two date inputs with the same name, "from:to"
    if (el.closest('[data-range]')) return els.some((e) => e.value) ? els.slice(0, 2).map((e) => e.value).join(':') : '';
    if (el.type === 'radio') return (els.find((e) => e.checked) || {}).value || '';
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    return el.value;
  }

  let depth = 0;
  function setItemValue(name, value) {
    const els = fieldsNamed(name);
    if (!els.length) {
      const display = document.getElementById(name);
      if (display && display.classList.contains('display-value')) display.textContent = value || ' ';
      return;
    }
    const el = els[0];
    if (el.closest('[data-range]')) {
      const parts = String(value ?? '').split(':');
      els.slice(0, 2).forEach((e, i) => (e.value = parts[i] || ''));
    } else if (el.type === 'radio') els.forEach((e) => (e.checked = e.value === value));
    else if (el.type === 'checkbox') el.checked = ['true', 't', 'on', '1', 'yes', 'y'].includes(String(value).toLowerCase());
    else el.value = value ?? '';
    if (depth < 5) {
      depth++;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      depth--;
    }
  }

  async function post(path, data) {
    const params = new URLSearchParams(data);
    params.set('__csrf', meta.csrf);
    params.set('__url_params', location.search.slice(1));
    const res = await fetch(`${base}/${pageNo}${path}`, {
      method: 'POST',
      body: params,
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  function showError(message) {
    const box = document.querySelector('.messages');
    if (!box) return window.alert(message);
    const div = document.createElement('div');
    div.className = 'alert alert-error';
    div.setAttribute('role', 'alert');
    div.textContent = message;
    box.replaceChildren(div);
  }

  function replaceHtml(el, markup) {
    const tpl = document.createElement('template');
    tpl.innerHTML = markup.trim();
    const node = tpl.content.firstElementChild;
    if (node) {
      el.replaceWith(node);
      document.dispatchEvent(new CustomEvent('pgapex:replaced', { detail: node }));
    }
    return node;
  }

  // ------------------------------------------------------------ dynamic actions
  function conditionHolds(da) {
    if (!da.cond) return true;
    const v = da.trigger.length ? itemValue(da.trigger[0]) : '';
    switch (da.cond.type) {
      case 'equals': return v === da.cond.value;
      case 'not_equals': return v !== da.cond.value;
      case 'in_list': return da.cond.value.split(',').map((s) => s.trim()).includes(v);
      case 'is_null': return v === '';
      case 'is_not_null': return v !== '';
      default: return true;
    }
  }

  // ------------------------------------------------------------ messages and errors (dynamic actions)
  // class names a dynamic action may add or remove (the database checks the same pattern)
  const CLASS_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

  function showMessage(message, kind) {
    const box = document.querySelector('.messages');
    if (!box) return window.alert(message);
    const div = document.createElement('div');
    div.className = `alert alert-${kind}`;
    div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    div.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'alert-close';
    close.setAttribute('aria-label', (meta.texts && meta.texts['common.dismiss']) || 'Dismiss');
    close.textContent = '×';
    div.append(close);
    box.append(div);
  }

  /** An error shown on an item, like the server's validation errors. */
  function itemError(name, message) {
    const w = wrapperOf(name);
    if (!w) return showMessage(message, 'error');
    w.classList.add('has-error');
    let small = w.querySelector(':scope > small.error');
    if (!small) {
      small = document.createElement('small');
      small.className = 'error';
      small.id = `${name}_error`;
      w.append(small);
    }
    small.textContent = message;
    for (const c of w.querySelectorAll('input, select, textarea')) {
      c.setAttribute('aria-invalid', 'true');
      const ids = (c.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      if (!ids.includes(small.id)) c.setAttribute('aria-describedby', [...ids, small.id].join(' '));
    }
  }

  /** Remove error messages: of the given items, or all of them (page and items). */
  function clearErrors(items) {
    const wrappers = items.length ? items.map(wrapperOf).filter(Boolean) : [...document.querySelectorAll('[data-item].has-error')];
    if (!items.length) document.querySelectorAll('.messages .alert-error').forEach((el) => el.remove());
    for (const w of wrappers) {
      w.classList.remove('has-error');
      const small = w.querySelector(':scope > small.error');
      if (small) small.remove();
      for (const c of w.querySelectorAll('[aria-invalid]')) {
        c.removeAttribute('aria-invalid');
        const ids = (c.getAttribute('aria-describedby') || '').split(' ').filter((id) => id && id !== `${w.dataset.item}_error`);
        if (ids.length) c.setAttribute('aria-describedby', ids.join(' '));
        else c.removeAttribute('aria-describedby');
      }
    }
  }

  function focusTarget(el) {
    if (!el) return;
    const control = el.matches('input, select, textarea, button, a[href]') ? el : el.querySelector('input:not([type=hidden]), select, textarea, button, a[href]');
    if (control) return control.focus();
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus();
  }

  const targets = (da) => [
    ...da.items.map(wrapperOf).filter(Boolean),
    ...(da.region ? [document.getElementById(`R${da.region}`)].filter(Boolean) : []),
  ];

  async function runDa(da, initial) {
    const holds = conditionHolds(da);
    switch (da.action) {
      case 'show':
      case 'hide': {
        const show = (da.action === 'show') === holds;
        targets(da).forEach((el) => (el.hidden = !show));
        return;
      }
      case 'enable':
      case 'disable': {
        const enable = (da.action === 'enable') === holds;
        targets(da).forEach((el) => el.querySelectorAll('input, select, textarea, button').forEach((c) => (c.disabled = !enable)));
        return;
      }
    }
    if (initial || !holds) return;
    switch (da.action) {
      case 'alert':
        window.alert(da.message || '');
        return;
      case 'set_focus':
        focusTarget(targets(da)[0]);
        return;
      case 'add_class':
      case 'remove_class': {
        const names = (da.classes || []).filter((c) => CLASS_NAME.test(c));
        targets(da).forEach((el) => (da.action === 'add_class' ? el.classList.add(...names) : el.classList.remove(...names)));
        return;
      }
      case 'show_success':
        showMessage(da.message || '', 'success');
        return;
      case 'show_error':
        if (da.items.length) da.items.forEach((n) => itemError(n, da.message || ''));
        else showMessage(da.message || '', 'error');
        return;
      case 'clear_errors':
        clearErrors(da.items);
        return;
      case 'submit':
        form && form.requestSubmit();
        return;
    }
    const data = {};
    for (const n of da.submit) data[n] = itemValue(n);
    const busy = targets(da);
    busy.forEach((el) => el.setAttribute('aria-busy', 'true'));
    try {
      const res = await post(`/da/${da.id}`, data);
      for (const [name, markup] of Object.entries(res.itemsHtml || {})) {
        const w = wrapperOf(name);
        if (w) replaceHtml(w, markup);
      }
      // a refreshed region's styles (chart geometry) go into the page's own stylesheet:
      // the CSP refuses inline styles, but not rules added through the CSSOM
      const sheet = document.getElementById('pgapex-css')?.sheet;
      if (sheet && res.css) for (const rule of res.css.split('\n')) if (rule) sheet.insertRule(rule, sheet.cssRules.length);
      for (const [id, markup] of Object.entries(res.regions || {})) {
        const r = document.getElementById(`R${id}`);
        if (r) replaceHtml(r, markup);
      }
      if (da.action === 'set_value' || da.action === 'execute_sql')
        for (const [name, value] of Object.entries(res.items || {})) setItemValue(name, value);
    } catch (e) {
      showError(e.message);
    } finally {
      busy.forEach((el) => el.removeAttribute('aria-busy'));
    }
  }

  const das = meta.das || [];
  document.addEventListener('change', (e) => {
    const name = e.target.name;
    if (!name) return;
    for (const da of das) if (da.event === 'change' && da.trigger.includes(name)) runDa(da, false);
    cascade(name);
    if (e.target.closest('[data-submit-on-change]') && e.target.form === form && depth === 0) form.requestSubmit();
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-button]');
    if (!btn) return;
    for (const da of das) if (da.event === 'click' && da.trigger.includes(btn.dataset.button)) runDa(da, false);
  });
  for (const da of das) {
    if (['show', 'hide', 'enable', 'disable'].includes(da.action)) runDa(da, true);
    if (da.event === 'load') runDa(da, false);
  }

  // ------------------------------------------------------------ cascading lists of values
  async function cascade(parent) {
    for (const w of document.querySelectorAll('[data-cascade]')) {
      const parents = w.dataset.cascade.split(',');
      if (!parents.includes(parent)) continue;
      const data = {};
      for (const p of parents) data[p] = itemValue(p);
      w.setAttribute('aria-busy', 'true');
      try {
        const res = await post(`/lov/${encodeURIComponent(w.dataset.item)}`, data);
        const node = replaceHtml(w, res.html);
        if (node) cascade(node.dataset.item);
      } catch (err) {
        showError(err.message);
        w.removeAttribute('aria-busy');
      }
    }
  }

  // ------------------------------------------------------------ file → textarea (imports)
  document.addEventListener('change', async (e) => {
    const input = e.target.closest('input[type=file][data-fill]');
    const target = input && document.getElementById(input.dataset.fill);
    if (target && input.files[0]) target.value = await input.files[0].text();
  });

  // ------------------------------------------------------------ confirmations, menus, alerts
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-confirm]');
    if (el && el.dataset.confirm && !window.confirm(el.dataset.confirm)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false;
    const close = e.target.closest('.alert-close');
    if (close) close.parentElement.remove();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const d of document.querySelectorAll('details.menu[open]')) {
      d.open = false;
      d.querySelector('summary')?.focus();
    }
    // Ctrl/Cmd+Enter submits code editors (SQL Workshop, page designer).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('textarea.code')) {
      e.preventDefault();
      e.target.form?.requestSubmit();
    }
  });

  // ------------------------------------------------------------ navigation
  // Desktop: docked menu that can be collapsed (remembered). Tablet/phone: a
  // drawer over the content, closed by the backdrop, Escape or navigating.
  const toggle = document.querySelector('.t-nav-toggle');
  const drawer = window.matchMedia('(max-width: 1023px)');
  const navOpen = () => (drawer.matches ? body.classList.contains('nav-open') : !body.classList.contains('nav-collapsed'));
  const setNav = (open) => {
    if (drawer.matches) body.classList.toggle('nav-open', open);
    else body.classList.toggle('nav-collapsed', !open);
    toggle?.setAttribute('aria-expanded', String(open));
  };
  if (toggle) {
    let stored = null;
    try { stored = localStorage.getItem('pgapex.nav'); } catch {}
    if (stored === 'closed') body.classList.add('nav-collapsed');
    toggle.setAttribute('aria-expanded', String(navOpen()));
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const open = !navOpen();
      setNav(open);
      if (!drawer.matches) try { localStorage.setItem('pgapex.nav', open ? 'open' : 'closed'); } catch {}
      if (open && drawer.matches) document.querySelector('#t-nav a, #t-nav summary')?.focus();
    });
    document.querySelector('.t-nav-backdrop')?.addEventListener('click', (e) => {
      e.preventDefault();
      setNav(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.matches && navOpen()) {
        setNav(false);
        toggle.focus();
      }
    });
    drawer.addEventListener('change', () => toggle.setAttribute('aria-expanded', String(navOpen())));
  }

  // ------------------------------------------------------------ modal dialogs
  function openDialog(url) {
    let dlg = document.getElementById('t-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 't-dialog';
      dlg.className = 't-dialog';
      dlg.setAttribute('aria-labelledby', 't-dialog-title');
      dlg.innerHTML = '<div class="t-dialog-head"><h2 id="t-dialog-title"></h2><button type="button" class="icon-button t-dialog-x" aria-label="Close">×</button></div><iframe title="Dialog"></iframe>';
      document.body.appendChild(dlg);
      dlg.querySelector('.t-dialog-x').addEventListener('click', () => dlg.close());
      dlg.addEventListener('close', () => (dlg.querySelector('iframe').src = 'about:blank'));
    }
    const frame = dlg.querySelector('iframe');
    const title = dlg.querySelector('h2');
    title.textContent = '';
    frame.onload = () => {
      try {
        const doc = frame.contentDocument;
        title.textContent = (doc.title || '').split(' · ')[0];
      } catch {}
    };
    frame.src = url + (url.includes('?') ? '&' : '?') + 'dialog=1';
    dlg.showModal();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-dialog]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || body.dataset.dialog === '1') return;
    e.preventDefault();
    openDialog(a.href);
  });

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'pgapex:close') return;
    const dlg = document.getElementById('t-dialog');
    if (dlg) dlg.close();
    if (e.data.reload) location.reload();
  });

  // ------------------------------------------------------------ calendar
  // Create on click: a click on an empty day or hour slot follows its "+" link.
  document.addEventListener('click', (e) => {
    const cell = e.target.closest?.('.calendar [data-add]');
    if (!cell || e.target.closest('a, button')) return;
    cell.querySelector(':scope > .cal-add')?.click();
  });
  // Drag and drop (mouse): drop an event on a day or hour slot; the server moves it
  // and sends the calendar back. Without JS (and from the keyboard) the event's
  // edit link changes its dates.
  let dragged = null;
  document.addEventListener('dragstart', (e) => {
    const ev = e.target.closest?.('.calendar[data-calendar] [data-move]');
    if (!ev) return;
    dragged = ev;
    ev.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ev.title || ev.textContent.trim());
  });
  document.addEventListener('dragend', () => {
    dragged?.classList.remove('dragging');
    dragged = null;
    document.querySelectorAll('.calendar .drop-over').forEach((el) => el.classList.remove('drop-over'));
  });
  const dropCell = (e) => {
    const cell = dragged && e.target.closest?.('[data-drop]');
    return cell && cell.closest('.calendar') === dragged.closest('.calendar') ? cell : null;
  };
  document.addEventListener('dragover', (e) => {
    const cell = dropCell(e);
    if (!cell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.calendar .drop-over').forEach((el) => el !== cell && el.classList.remove('drop-over'));
    cell.classList.add('drop-over');
  });
  document.addEventListener('drop', async (e) => {
    const cell = dropCell(e);
    if (!cell) return;
    e.preventDefault();
    const cal = cell.closest('.calendar');
    const region = cal.closest('.region');
    const key = dragged.dataset.move;
    cal.setAttribute('aria-busy', 'true');
    try {
      const res = await post(`/calendar/${cal.dataset.calendar}/move`, { key, to: cell.dataset.drop });
      const sheet = document.getElementById('pgapex-css')?.sheet;
      if (sheet && res.css) for (const rule of res.css.split('\n')) if (rule) sheet.insertRule(rule, sheet.cssRules.length);
      const node = region ? replaceHtml(region, res.region) : null;
      const status = node?.querySelector('.cal-status');
      if (status) status.textContent = res.message;
    } catch (err) {
      cal.removeAttribute('aria-busy');
      showError(err.message);
    }
  });

  // ------------------------------------------------------------ lazy regions
  // A lazy region arrives as a placeholder with a "Show" link (which works
  // without JavaScript); fetch the region now and put it in place, with its
  // styles and the forms that live outside the page form (report search).
  async function loadLazy(holder) {
    const region = holder.closest('.region');
    const link = holder.querySelector('.region-lazy-link');
    const loading = holder.querySelector('.region-loading');
    if (link) link.hidden = true;
    if (loading) loading.hidden = false;
    region?.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(holder.dataset.lazy, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const json = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(json.error || res.statusText);
      const sheet = document.getElementById('pgapex-css')?.sheet;
      if (sheet && json.css) for (const rule of json.css.split('\n')) if (rule) sheet.insertRule(rule, sheet.cssRules.length);
      if (json.detached) {
        const tpl = document.createElement('template');
        tpl.innerHTML = json.detached;
        for (const f of [...tpl.content.children]) if (!f.id || !document.getElementById(f.id)) (form || document.querySelector('main') || body).after(f);
      }
      const wasHidden = region?.hidden;
      const classes = region ? [...region.classList] : [];
      const node = region ? replaceHtml(region, json.html) : null;
      // keep what scripts set on the placeholder's region (hidden, a display selector's classes)
      if (node && wasHidden) node.hidden = true;
      if (node) for (const c of classes) node.classList.add(c);
    } catch (e) {
      region?.removeAttribute('aria-busy');
      if (loading) loading.hidden = true;
      if (link) link.hidden = false;
      showError(e.message);
    }
  }
  document.querySelectorAll('[data-lazy]').forEach(loadLazy);

  // Inside a dialog: close on success or cancel.
  if (window.parent !== window) {
    const tell = (reload) => window.parent.postMessage({ type: 'pgapex:close', reload }, location.origin);
    if (body.dataset.dialogClose) tell(true);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-dialog-cancel]')) return;
      e.preventDefault();
      tell(false);
    });
  }
})();

// Chart tooltips: any element with data-tip, on hover or keyboard focus.
(() => {
  let tipEl = null;
  const show = (el, x, y) => {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = el.dataset.tip;
    tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    tipEl.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - r.width - 8))}px`;
    tipEl.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  const hide = () => tipEl && (tipEl.hidden = true);
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('.chart [data-tip]');
    el ? show(el, e.clientX, e.clientY) : hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('.chart [data-tip]');
    if (!el) return hide();
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, { passive: true });
})();

// Interactive grid: add and duplicate rows, track unsaved changes, row
// action menus, master-detail without reloading, moving and resizing
// columns, copy and paste of cell ranges. Everything here has a server-side
// path that works without JavaScript (links, labels and the Columns form);
// pasted values are saved by the normal, validated grid save.
(() => {
  const body = document.body;
  const base = body.dataset.base;
  const pageNo = body.dataset.page;
  const metaEl = document.getElementById('pgapex-meta');
  const csrf = metaEl ? JSON.parse(metaEl.textContent).csrf : '';
  let dirty = false;

  // With JS the blank template row is hidden and must not be submitted (its
  // clones are); without JS it stays visible as the "new row".
  const disableTemplates = (root) => root.querySelectorAll('.grid-template [name]').forEach((el) => (el.disabled = true));
  disableTemplates(document);

  // ------------------------------------------------------------ rows
  function addRow(grid) {
    const g = grid.dataset.grid;
    const tpl = grid.querySelector('.grid-template tr');
    if (!tpl) return null;
    const rows = grid.querySelector('tbody:not(.grid-template)');
    const used = [...grid.querySelectorAll('tbody:not(.grid-template) [data-new-row]')].map((r) => Number(r.dataset.newRow));
    const next = Math.max(Number(tpl.dataset.newRow), ...used.map((n) => n + 1));
    const row = tpl.cloneNode(true);
    row.dataset.newRow = String(next);
    row.querySelectorAll('[name]').forEach((el) => ((el.disabled = false), (el.name = el.name.replace(new RegExp(`^${g}_n\\d+_`), `${g}_n${next}_`))));
    rows.appendChild(row);
    dirty = true;
    return row;
  }

  /** The editable control of a cell, if any. */
  const control = (td) => td?.querySelector('input:not([type=hidden]), select');

  function setCell(td, text) {
    const el = control(td);
    if (!el || el.disabled) return false;
    const v = String(text ?? '').trim();
    if (el.type === 'checkbox') el.checked = /^(true|t|yes|y|1|on|x|✓)$/i.test(v);
    else if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value === v) || [...el.options].find((o) => o.text.trim().toLowerCase() === v.toLowerCase());
      el.value = opt ? opt.value : '';
    } else if (el.type === 'number') {
      let n = v.replace(/[\s ']/g, '');
      n = n.includes('.') ? n.replace(/,/g, '') : n.replace(',', '.');
      el.value = n;
    } else if (el.type === 'datetime-local') el.value = v.replace(' ', 'T').slice(0, 16);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function cellText(td) {
    const el = control(td);
    if (!el) return td.textContent.trim();
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    if (el.tagName === 'SELECT') return el.selectedIndex > 0 ? el.options[el.selectedIndex].text.trim() : '';
    return el.value;
  }

  function closeMenus(target) {
    const d = target.closest('details');
    if (d) d.open = false;
  }

  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-grid-add]');
    if (add) {
      const row = addRow(add.closest('[data-grid]'));
      row?.querySelector('input:not([type=hidden]), select')?.focus();
      return;
    }
    // Duplicate: the row's values in a new row (without JS a link does it on the server)
    const dup = e.target.closest('[data-grid-dup]');
    if (dup) {
      const grid = dup.closest('[data-grid]');
      const src = dup.closest('tr');
      const row = grid.querySelector('.grid-template') ? addRow(grid) : null;
      if (!row) return;
      e.preventDefault();
      closeMenus(dup);
      for (const td of row.querySelectorAll('td[data-col]')) {
        const from = src.querySelector(`td[data-col="${td.dataset.col}"]`);
        if (from && control(td) && control(from)) setCell(td, control(from).tagName === 'SELECT' ? control(from).value : cellText(from));
      }
      control(row.querySelector('td[data-col]:not([hidden])'))?.focus();
      return;
    }
    if (e.target.closest('[data-grid-del]')) {
      // the label toggles the row's delete checkbox; close the menu after it
      setTimeout(() => closeMenus(e.target), 0);
      return;
    }
    // A master row: refresh its detail regions in place
    const pick = e.target.closest('a[data-grid-select]');
    if (pick && pick.dataset.gridSelect) {
      e.preventDefault();
      selectMaster(pick);
      return;
    }
    const leave = e.target.closest('[data-grid-leave]');
    if (leave && dirty && !window.confirm('You have unsaved changes in the grid. Leave anyway?')) e.preventDefault();
  });
  document.addEventListener('input', (e) => {
    const row = e.target.closest?.('[data-grid] table.grid-table > tbody > tr');
    if (!row) return;
    row.classList.add('dirty');
    dirty = true;
  });
  document.addEventListener('change', (e) => {
    const del = e.target.closest?.('[data-grid] .grid-sel input');
    if (del) del.closest('tr').classList.toggle('deleted', del.checked);
  });
  document.addEventListener('submit', () => (dirty = false));
  window.addEventListener('beforeunload', (e) => {
    if (dirty && document.querySelector('[data-grid]')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // A row's actions menu sits in a scrolling table: show its panel over the page instead.
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('.row-menu') || !d.open) return;
    const panel = d.querySelector('.menu-panel');
    const r = d.querySelector('summary').getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${Math.round(r.bottom + 4)}px`;
    panel.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8)))}px`;
  }, true);
  window.addEventListener('scroll', () => document.querySelectorAll('.row-menu[open]').forEach((d) => (d.open = false)), { passive: true });

  // ------------------------------------------------------------ master-detail
  async function selectMaster(link) {
    const master = link.closest('[data-grid]');
    const ids = link.dataset.gridSelect.split(',').filter(Boolean);
    const dirtyDetail = ids.some((id) => document.querySelector(`#R${id} [data-grid] tr.dirty, #R${id} [data-grid] tbody:not(.grid-template) tr.grid-new`));
    if (dirtyDetail && !window.confirm('You have unsaved changes in the grid. Leave anyway?')) return;
    const query = new URL(link.href, location.href).search.slice(1);
    for (const id of ids) {
      const region = document.getElementById(`R${id}`);
      region?.setAttribute('aria-busy', 'true');
      try {
        const res = await fetch(`${base}/${pageNo}/region/${id}?${query}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
        const json = await res.json().catch(() => ({ error: res.statusText }));
        if (!res.ok) throw new Error(json.error || res.statusText);
        const sheet = document.getElementById('pgapex-css')?.sheet;
        if (sheet && json.css) for (const rule of json.css.split('\n')) if (rule) sheet.insertRule(rule, sheet.cssRules.length);
        if (json.detached) {
          const tpl = document.createElement('template');
          tpl.innerHTML = json.detached;
          const page = document.querySelector('form.page-form') || document.querySelector('main') || body;
          for (const f of [...tpl.content.children]) {
            const old = f.id && document.getElementById(f.id);
            if (old) old.replaceWith(f);
            else page.after(f);
          }
        }
        const tpl = document.createElement('template');
        tpl.innerHTML = json.html.trim();
        const node = tpl.content.firstElementChild;
        if (region && node) {
          region.replaceWith(node);
          document.dispatchEvent(new CustomEvent('pgapex:replaced', { detail: node }));
        }
      } catch (err) {
        region?.removeAttribute('aria-busy');
        window.alert(err.message);
        return;
      }
    }
    // mark the row, and make the page's other links and forms carry the new selection
    for (const a of master.querySelectorAll('a[data-grid-select]')) {
      const on = a === link;
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
      a.closest('tr').classList.toggle('is-selected', on);
    }
    const sel = new URL(link.href, location.href).searchParams;
    const rid = master.dataset.region;
    const keys = [`r${rid}_sel`, `r${rid}_selcs`];
    for (const a of document.querySelectorAll(`a[href*="r${rid}_sel="]`)) {
      if (a.closest(`[data-grid="${master.dataset.grid}"]`) && a.dataset.gridSelect !== undefined) continue;
      const u = new URL(a.href, location.href);
      for (const k of keys) u.searchParams.set(k, sel.get(k));
      a.href = u.pathname + u.search + u.hash;
    }
    for (const k of keys) for (const input of document.querySelectorAll(`input[type=hidden][name="${k}"]`)) input.value = sel.get(k);
    for (const input of document.querySelectorAll('input[type=hidden][name="params"]')) {
      const p = new URLSearchParams(input.value);
      if (!p.has(keys[0])) continue;
      for (const k of keys) p.set(k, sel.get(k));
      input.value = p.toString();
    }
    history.replaceState(history.state, '', link.href);
  }

  // ------------------------------------------------------------ columns: move, resize, freeze
  const tableOf = (grid) => grid.querySelector('table.grid-table');
  const heads = (table) => [...table.tHead.rows[0].querySelectorAll('th[data-col]')];
  const cellsOf = (table, col) => [...table.querySelectorAll(`tr > [data-col="${col}"]`)];

  /** Frozen columns after a move or resize: the first N shown columns, each left of the next. */
  function refreeze(table) {
    const n = Number(table.dataset.frozen) || 0;
    const leads = [...table.tHead.rows[0].querySelectorAll('th.grid-lead')];
    let left = leads.reduce((w, th) => w + th.offsetWidth, 0);
    let k = 0;
    for (const th of heads(table)) {
      const on = !th.hidden && k < n;
      if (!th.hidden) k++;
      const last = on && k === n;
      for (const c of cellsOf(table, th.dataset.col)) {
        c.classList.toggle('grid-frozen', on);
        c.classList.toggle('grid-frozen-last', last);
        c.style.left = on ? `${left}px` : '';
      }
      if (on) left += th.offsetWidth;
    }
  }

  async function saveLayout(grid) {
    const table = tableOf(grid);
    const hs = heads(table);
    const widths = {};
    for (const th of hs) if (th.dataset.width) widths[th.dataset.colName] = Number(th.dataset.width);
    const layout = {
      order: hs.map((th) => th.dataset.colName),
      hidden: hs.filter((th) => th.hidden).map((th) => th.dataset.colName),
      widths,
      frozen: Number(table.dataset.frozen) || 0,
    };
    const params = new URLSearchParams({ __csrf: csrf, layout: JSON.stringify(layout) });
    try {
      const res = await fetch(`${base}/${pageNo}/grid/${grid.dataset.region}/layout`, { method: 'POST', body: params, headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      // the Columns form shows the new layout after the next page load; keep its positions in step now
      const form = document.getElementById(`rl${grid.dataset.region}`);
      if (form) for (const [i, th] of hs.entries()) {
        const row = [...document.querySelectorAll(`input[form="${form.id}"][name^="col_"]`)].find((x) => x.value === th.dataset.colName);
        const at = row?.name.slice(4);
        const pos = at !== undefined && document.querySelector(`input[form="${form.id}"][name="pos_${at}"]`);
        if (pos) pos.value = String(i + 1);
        const w = at !== undefined && document.querySelector(`input[form="${form.id}"][name="width_${at}"]`);
        if (w && th.dataset.width) w.value = th.dataset.width;
      }
    } catch (err) {
      console.warn('grid layout not saved:', err.message);
    }
  }

  function moveColumn(table, from, to, after) {
    for (const row of table.querySelectorAll('tr')) {
      const a = row.querySelector(`:scope > [data-col="${from}"]`);
      const b = row.querySelector(`:scope > [data-col="${to}"]`);
      if (!a || !b || a === b) continue;
      if (after) b.after(a);
      else b.before(a);
    }
  }

  function arrangeable(root) {
    for (const grid of root.querySelectorAll('[data-grid][data-arrange]')) {
      if (grid.dataset.arranged) continue;
      grid.dataset.arranged = '1';
      const table = tableOf(grid);
      if (!table?.tHead) continue;
      for (const th of heads(table)) th.draggable = true;
      if (Number(table.dataset.frozen)) requestAnimationFrame(() => refreeze(table));
    }
  }
  arrangeable(document);
  document.addEventListener('pgapex:replaced', (e) => {
    const root = e.detail?.parentElement || document;
    disableTemplates(root);
    arrangeable(root);
  });

  let dragCol = null;
  let resizing = false;
  document.addEventListener('dragstart', (e) => {
    const th = e.target.closest?.('[data-grid][data-arrange] thead th[data-col]');
    if (!th) return;
    if (resizing) return e.preventDefault();
    dragCol = th;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', th.dataset.colName);
  });
  const clearDrop = () => document.querySelectorAll('.grid-drop-before, .grid-drop-after').forEach((x) => x.classList.remove('grid-drop-before', 'grid-drop-after'));
  document.addEventListener('dragover', (e) => {
    const th = dragCol && e.target.closest?.('thead th[data-col]');
    if (!th || th.closest('table') !== dragCol.closest('table')) return;
    e.preventDefault();
    clearDrop();
    const r = th.getBoundingClientRect();
    if (th !== dragCol) th.classList.add(e.clientX > r.left + r.width / 2 ? 'grid-drop-after' : 'grid-drop-before');
  });
  document.addEventListener('drop', (e) => {
    const th = dragCol && e.target.closest?.('thead th[data-col]');
    if (!th || th.closest('table') !== dragCol.closest('table')) return;
    e.preventDefault();
    const r = th.getBoundingClientRect();
    const table = th.closest('table');
    moveColumn(table, dragCol.dataset.col, th.dataset.col, e.clientX > r.left + r.width / 2);
    clearDrop();
    refreeze(table);
    saveLayout(table.closest('[data-grid]'));
    dragCol = null;
  });
  document.addEventListener('dragend', () => {
    dragCol = null;
    clearDrop();
  });

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest?.('[data-grid][data-arrange] .grid-resize');
    if (!handle) return;
    e.preventDefault();
    const th = handle.closest('th');
    const table = th.closest('table');
    const grid = table.closest('[data-grid]');
    const startX = e.clientX;
    const startW = th.offsetWidth;
    const cells = cellsOf(table, th.dataset.col);
    resizing = true;
    grid.classList.add('grid-resizing');
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.max(40, Math.min(1000, Math.round(startW + ev.clientX - startX)));
      th.dataset.width = String(w);
      for (const c of cells) {
        c.classList.add('grid-sized');
        c.style.width = c.style.minWidth = c.style.maxWidth = `${w}px`;
      }
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      resizing = false;
      grid.classList.remove('grid-resizing');
      if (th.dataset.width && Number(th.dataset.width) !== startW) {
        refreeze(table);
        saveLayout(grid);
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  // ------------------------------------------------------------ copy and paste
  // Click a cell, then Shift+click another: the range between them is
  // selected. Ctrl+C copies it as tab-separated text (as spreadsheets do);
  // Ctrl+V pastes such text from the focused cell (or the range) on, adding
  // rows when the grid allows it; one value pasted into a range fills it.
  // Delete empties a selected range. Read-only cells are left alone.
  let anchor = null;
  const rowsOf = (grid) => [...grid.querySelectorAll('table.grid-table > tbody:not(.grid-template) > tr')];
  const shownCells = (tr) => [...tr.querySelectorAll(':scope > td[data-col]:not([hidden])')];
  const selectedCells = (grid) => [...grid.querySelectorAll('td.grid-cell-selected')];
  const clearSelection = () => document.querySelectorAll('td.grid-cell-selected').forEach((td) => td.classList.remove('grid-cell-selected'));
  const at = (td) => {
    const rows = rowsOf(td.closest('[data-grid]'));
    const tr = td.closest('tr');
    return { r: rows.indexOf(tr), c: shownCells(tr).indexOf(td) };
  };

  function selectRange(from, to) {
    clearSelection();
    const grid = from.closest('[data-grid]');
    const a = at(from), b = at(to);
    const rows = rowsOf(grid);
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
      const cells = shownCells(rows[r]);
      for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) cells[c]?.classList.add('grid-cell-selected');
    }
  }

  document.addEventListener('focusin', (e) => {
    const td = e.target.closest?.('[data-grid] tbody:not(.grid-template) td[data-col]');
    if (td && !td.classList.contains('grid-cell-selected')) {
      clearSelection();
      anchor = td;
    }
  });
  document.addEventListener('mousedown', (e) => {
    const td = e.target.closest?.('[data-grid] tbody:not(.grid-template) td[data-col]');
    if (!td) return;
    if (e.shiftKey && anchor && anchor.isConnected && anchor.closest('[data-grid]') === td.closest('[data-grid]')) {
      e.preventDefault();
      selectRange(anchor, td);
      return;
    }
    clearSelection();
    anchor = td;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return clearSelection();
    const grid = e.target.closest?.('[data-grid]');
    if (!grid || !['Delete', 'Backspace'].includes(e.key)) return;
    const cells = selectedCells(grid);
    if (cells.length < 2) return;
    e.preventDefault();
    for (const td of cells) setCell(td, '');
  });

  document.addEventListener('copy', (e) => {
    const grid = e.target.closest?.('[data-grid]');
    const cells = grid ? selectedCells(grid) : [];
    if (!cells.length) return;
    const lines = new Map();
    for (const td of cells) {
      const tr = td.closest('tr');
      if (!lines.has(tr)) lines.set(tr, []);
      lines.get(tr).push(cellText(td).replace(/[\t\r\n]+/g, ' '));
    }
    e.clipboardData.setData('text/plain', [...lines.values()].map((l) => l.join('\t')).join('\r\n'));
    e.preventDefault();
  });

  /** Tab-separated text (quoted fields as spreadsheets write them) → rows of values. */
  function parseTsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const s = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') (field += '"'), i++;
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"' && field === '') quoted = true;
      else if (ch === '\t') row.push(field), (field = '');
      else if (ch === '\n') row.push(field), rows.push(row), (row = []), (field = '');
      else field += ch;
    }
    row.push(field);
    rows.push(row);
    return rows.slice(0, 1000).map((r) => r.slice(0, 200));
  }

  document.addEventListener('paste', (e) => {
    const td = e.target.closest?.('[data-grid] tbody:not(.grid-template) td[data-col]');
    if (!td) return;
    const grid = td.closest('[data-grid]');
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const range = selectedCells(grid);
    const data = parseTsv(text);
    const single = data.length === 1 && data[0].length === 1;
    if (single && range.length < 2) return; // one value into one cell: the browser's own paste
    e.preventDefault();
    if (single) {
      for (const c of range) setCell(c, data[0][0]);
      return;
    }
    const start = range.length ? range[0] : td;
    const { r: r0, c: c0 } = at(start);
    for (let i = 0; i < data.length; i++) {
      let rows = rowsOf(grid);
      let tr = rows[r0 + i];
      if (!tr) {
        if (!addRow(grid)) break;
        rows = rowsOf(grid);
        tr = rows[rows.length - 1];
      }
      const cells = shownCells(tr);
      data[i].forEach((v, j) => cells[c0 + j] && setCell(cells[c0 + j], v));
    }
  });
})();

// Faceted search: apply on change. A range facet's own from/to: typing picks
// "Custom"; choosing another range clears them (Apply sends them).
document.addEventListener('change', (e) => {
  if (!e.target.matches?.('[data-facet]')) return;
  if (e.target.type === 'radio') {
    const custom = e.target.closest('fieldset')?.querySelector('[data-facet-range]');
    custom?.querySelectorAll('input').forEach((i) => (i.value = ''));
  }
  e.target.form?.requestSubmit();
});
document.addEventListener('input', (e) => {
  const box = e.target.closest?.('[data-facet-range]');
  const custom = box?.closest('fieldset')?.querySelector('[data-facet-custom]');
  if (custom) custom.checked = true;
});

// Region display selector: the links to the regions become ARIA tabs (or a
// select list) that show one tab's regions at a time; "Show all" shows them
// all. The choice follows #R<id> in the URL and is remembered for the session.
document.querySelectorAll('[data-rds]').forEach((nav) => {
  const tabs = [...nav.querySelectorAll('.rds-tab')];
  const panelsOf = (tab) => (tab.dataset.rdsTarget || '').split(' ').filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  const panels = tabs.flatMap(panelsOf);
  if (!panels.length) return;
  const key = `pgapex.rds.${location.pathname}.${nav.dataset.rds}`;
  const remember = nav.hasAttribute('data-rds-remember');
  const select = nav.querySelector('.rds-select');
  const list = nav.querySelector('.rds-list');
  if (!select) {
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', nav.getAttribute('aria-label') || '');
    tabs.forEach((tab) => {
      tab.parentElement.setAttribute('role', 'presentation');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', (tab.hasAttribute('data-rds-all') ? panels : panelsOf(tab)).map((p) => p.id).join(' '));
      panelsOf(tab).forEach((p) => {
        p.setAttribute('role', 'tabpanel');
        p.setAttribute('aria-labelledby', tab.id);
        if (!p.hasAttribute('tabindex')) p.tabIndex = 0;
      });
    });
  }
  panels.forEach((p) => p.classList.add('rds-panel'));
  const show = (tab, focus) => {
    const shown = tab.hasAttribute('data-rds-all') ? panels : panelsOf(tab);
    tabs.forEach((t) => {
      const on = t === tab;
      if (!select) {
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      }
      t.classList.toggle('is-current', on);
    });
    panels.forEach((p) => p.classList.toggle('rds-hidden', !shown.includes(p)));
    if (select) select.value = tab.hasAttribute('data-rds-all') ? '*' : String(tabs.filter((t) => !t.hasAttribute('data-rds-all')).indexOf(tab));
    if (remember) try { sessionStorage.setItem(key, tab.id); } catch {}
    if (focus) tab.focus();
  };
  // #R<id> of any region in a tab, or the id of a tab
  const byHash = (h) => (h ? tabs.find((t) => (t.dataset.rdsTarget || '').split(' ').includes(h)) : null);
  let stored = null;
  if (remember) try { stored = sessionStorage.getItem(key); } catch {}
  show(byHash(location.hash.slice(1)) || tabs.find((t) => t.id === stored) || tabs[0], false);
  nav.addEventListener('click', (e) => {
    const tab = e.target.closest('.rds-tab');
    if (!tab) return;
    e.preventDefault();
    show(tab, true);
  });
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    show(tabs[(next + tabs.length) % tabs.length], true);
  });
  if (select) {
    list.hidden = true;
    select.closest('label').hidden = false;
    select.addEventListener('change', () => {
      const own = tabs.filter((t) => !t.hasAttribute('data-rds-all'));
      show(select.value === '*' ? tabs[0] : own[Number(select.value)] || tabs[0], false);
    });
  }
  window.addEventListener('hashchange', () => {
    const tab = byHash(location.hash.slice(1));
    if (tab) show(tab, false);
  });
});

// Popup list of values: the select (which works without JavaScript) is hidden
// behind a read-only field and a button that opens a dialog searching the
// item's list of values on the server, page by page.
function enhancePopupLovs(root) {
  const selects = root.matches?.('select[data-popup-lov]') ? [root] : [...(root.querySelectorAll?.('select[data-popup-lov]') ?? [])];
  selects.forEach(popupLov);
}
document.addEventListener('pgapex:replaced', (e) => e.detail && enhancePopupLovs(e.detail));
enhancePopupLovs(document);
function popupLov(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';
  const d = sel.dataset;
  const metaEl = document.getElementById('pgapex-meta');
  const csrf = metaEl ? JSON.parse(metaEl.textContent).csrf : '';
  const label = sel.labels?.[0]?.textContent?.trim() || sel.name;
  const wrap = document.createElement('div');
  wrap.className = 'popup-lov';
  const shown = document.createElement('input');
  shown.type = 'text';
  shown.readOnly = true;
  shown.className = 'popup-lov-display';
  shown.setAttribute('aria-label', label);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn popup-lov-open';
  open.textContent = d.searchLabel || 'Search…';
  open.setAttribute('aria-haspopup', 'dialog');
  open.setAttribute('aria-label', `${d.searchLabel || 'Search'} ${label}`);
  sel.hidden = true;
  sel.after(wrap);
  wrap.append(shown, open);
  const sync = () => (shown.value = sel.value ? (sel.selectedOptions[0]?.text ?? '') : '');
  sync();
  sel.addEventListener('change', sync);
  shown.addEventListener('click', () => open.click());

  let dlg = null;
  let page = 0;
  let timer = 0;
  const build = () => {
    dlg = document.createElement('dialog');
    dlg.className = 't-dialog popup-lov-dialog';
    dlg.setAttribute('aria-label', label);
    const head = document.createElement('div');
    head.className = 't-dialog-head';
    const h = document.createElement('h2');
    h.textContent = label;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'icon-button t-dialog-x';
    x.setAttribute('aria-label', d.closeLabel || 'Close');
    x.textContent = '×';
    x.addEventListener('click', () => dlg.close());
    head.append(h, x);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'popup-lov-body';
    const q = document.createElement('input');
    q.type = 'search';
    q.className = 'popup-lov-search';
    q.placeholder = d.searchLabel || 'Search…';
    q.setAttribute('aria-label', d.searchLabel || 'Search');
    const results = document.createElement('div');
    results.className = 'popup-lov-results';
    results.setAttribute('aria-live', 'polite');
    bodyEl.append(q, results);
    dlg.append(head, bodyEl);
    document.body.appendChild(dlg);
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(0), 250);
    });
    dlg.addEventListener('close', () => open.focus());
  };
  const choose = (value, display) => {
    let opt = [...sel.options].find((o) => o.value === value);
    if (!opt) {
      opt = new Option(display, value);
      sel.add(opt);
    }
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    dlg.close();
  };
  async function load(p) {
    page = p;
    const results = dlg.querySelector('.popup-lov-results');
    const params = new URLSearchParams({ q: dlg.querySelector('.popup-lov-search').value, p: String(p), __csrf: csrf });
    // a cascading LOV sends its parents' current values
    const wrapper = sel.closest('[data-cascade]');
    for (const parent of (wrapper?.dataset.cascade || '').split(',').filter(Boolean)) {
      const el = document.getElementsByName(parent)[0];
      if (el) params.set(parent, el.value);
    }
    let json;
    try {
      const res = await fetch(d.popupLov, { method: 'POST', body: params, headers: { accept: 'application/json' }, credentials: 'same-origin' });
      json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
    } catch (e) {
      results.textContent = e.message;
      return;
    }
    results.replaceChildren();
    if (!json.rows.length) {
      const none = document.createElement('p');
      none.textContent = d.noneLabel || 'Nothing found.';
      results.append(none);
      return;
    }
    const table = document.createElement('table');
    table.className = 'popup-lov-table';
    const tr = table.createTHead().insertRow();
    for (const hd of json.headings) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = hd;
      tr.append(th);
    }
    const tb = table.createTBody();
    for (const r of json.rows) {
      const row = tb.insertRow();
      r.columns.forEach((v, i) => {
        const cell = row.insertCell();
        if (i === 0) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'popup-lov-pick';
          b.textContent = v;
          b.addEventListener('click', () => choose(r.value, r.display));
          cell.append(b);
        } else cell.textContent = v;
      });
      if (r.value === sel.value) row.className = 'is-current';
    }
    results.append(table);
    if (json.more || page > 0) {
      const nav = document.createElement('div');
      nav.className = 'popup-lov-pages';
      if (page > 0) {
        const prev = document.createElement('button');
        prev.type = 'button';
        prev.className = 'btn';
        prev.textContent = '‹';
        prev.setAttribute('aria-label', 'Previous');
        prev.addEventListener('click', () => load(page - 1));
        nav.append(prev);
      }
      if (json.more) {
        const next = document.createElement('button');
        next.type = 'button';
        next.className = 'btn';
        next.textContent = d.moreLabel || 'More';
        next.addEventListener('click', () => load(page + 1));
        nav.append(next);
      }
      results.append(nav);
    }
  }
  open.addEventListener('click', () => {
    if (!dlg) build();
    dlg.querySelector('.popup-lov-search').value = '';
    dlg.showModal();
    dlg.querySelector('.popup-lov-search').focus();
    load(0);
  });
}

// Builder: role suggestions. Clicking a role adds it to the roles field of
// the same form; in a form with an application select, only that app's
// suggestions are shown.
document.addEventListener('click', (e) => {
  const chip = e.target.closest?.('[data-add-role]');
  if (!chip) return;
  const field = chip.closest('form')?.querySelector('input[name="roles"]');
  if (!field) return;
  const roles = field.value.split(',').map((r) => r.trim()).filter(Boolean);
  if (!roles.some((r) => r.toLowerCase() === chip.dataset.addRole)) roles.push(chip.dataset.addRole);
  field.value = roles.join(', ');
  field.focus();
});
function syncRoleHints(select) {
  select.form?.querySelectorAll('[data-hints-for]').forEach((el) => (el.hidden = el.dataset.hintsFor !== select.value));
}
document.querySelectorAll('select[name="app_id"]').forEach((sel) => {
  if (!sel.form?.querySelector('[data-hints-for]')) return;
  syncRoleHints(sel);
  sel.addEventListener('change', () => syncRoleHints(sel));
});

// Actions → Print (the print stylesheet hides navigation and toolbars).
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('[data-print]')) return;
  e.target.closest('details')?.removeAttribute('open');
  window.print();
});

// Report row selection: the header checkbox checks or clears every row on the page.
document.addEventListener('change', (e) => {
  const all = e.target.closest?.('[data-select-all]');
  if (all) {
    const table = all.closest('table');
    for (const box of table.querySelectorAll(`input[type=checkbox][name="${CSS.escape(all.dataset.selectAll)}"]`)) box.checked = all.checked;
    return;
  }
  const box = e.target;
  if (box.type !== 'checkbox' || !box.name) return;
  const head = box.closest('table')?.querySelector(`[data-select-all="${CSS.escape(box.name)}"]`);
  if (!head) return;
  const boxes = [...box.closest('table').querySelectorAll(`input[type=checkbox][name="${CSS.escape(box.name)}"]`)];
  head.checked = boxes.every((b) => b.checked);
  head.indeterminate = !head.checked && boxes.some((b) => b.checked);
});

// SAML: post the identity provider's response on to pgapex itself (same-site, so the
// sign-in's browser cookie comes along). The button is there for browsers without script.
document.addEventListener('DOMContentLoaded', () => {
  for (const form of document.querySelectorAll('form[data-autosubmit]')) form.submit();
});

// ------------------------------------------------------------------ Progressive Web App and field work
(() => {
  const metaEl = document.getElementById('pgapex-meta');
  const texts = (metaEl ? JSON.parse(metaEl.textContent).texts : null) || {};
  const t = (k, n) => (texts[k] || k).replace('{n}', n === undefined ? '' : String(n));
  const body = document.body;

  function note(message, kind = 'success') {
    const box = document.querySelector('.messages') || document.querySelector('main');
    if (!box) return;
    const div = document.createElement('div');
    div.className = `alert alert-${kind}`;
    div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    div.textContent = message;
    box.prepend(div);
  }

  // the service worker of an installable app, and its messages
  if (body.dataset.sw && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(body.dataset.sw, { scope: `${body.dataset.base}/` }).catch(() => {});
    const post = (msg) => navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage(msg));
    if (body.dataset.offlineQueue === '1') {
      post({ type: 'pgapex:user', user: body.dataset.user || 'nobody' });
      post({ type: 'pgapex:replay' });
      window.addEventListener('online', () => post({ type: 'pgapex:replay' }));
    }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'pgapex:queue') showQueue(e.data.items, post);
    });
    if (new URLSearchParams(location.search).get('queued') === '1') note(t('pwa.queued'));
  }

  // offline: say so (the page may come from the device)
  const banner = () => {
    let b = document.querySelector('.offline-banner');
    if (navigator.onLine) return b && b.remove();
    if (b || !document.querySelector('.t-header, .login-card')) return;
    b = document.createElement('div');
    b.className = 'offline-banner';
    b.setAttribute('role', 'status');
    b.textContent = t('pwa.offline_banner');
    document.body.prepend(b);
  };
  window.addEventListener('online', banner);
  window.addEventListener('offline', banner);
  banner();

  // the queue of forms waiting to be sent (data-offline-queue apps)
  function showQueue(items, post) {
    const mine = items.filter((i) => i.user === (body.dataset.user || 'nobody'));
    let box = document.querySelector('.offline-queue');
    if (!mine.length) return box && box.remove();
    if (!box) {
      box = document.createElement('details');
      box.className = 'offline-queue';
      document.body.append(box);
    }
    box.replaceChildren();
    const summary = document.createElement('summary');
    summary.textContent = t('pwa.queue_waiting', mine.length);
    const list = document.createElement('ul');
    for (const i of mine) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.textContent = `${new Date(i.at).toLocaleString()} · ${new URL(i.title, location.href).pathname} · ${t(`pwa.status.${i.status}`)}`;
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'link-button';
      discard.textContent = t('pwa.discard');
      discard.addEventListener('click', () => post({ type: 'pgapex:discard', id: i.id }));
      li.append(what, ' ', discard);
      list.append(li);
    }
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-hot';
    send.textContent = t('pwa.send_now');
    send.addEventListener('click', () => post({ type: 'pgapex:replay' }));
    box.append(summary, list, send);
  }

  // the offline page: the pages kept on this device
  const pages = document.querySelector('[data-offline-pages]');
  if (pages && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'pgapex:pages') return;
      for (const u of e.data.pages) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = u;
        a.textContent = new URL(u).pathname + new URL(u).search;
        li.append(a);
        pages.append(li);
      }
    });
    navigator.serviceWorker.controller.postMessage('pgapex:pages');
  }

  // location items: the device's position as "lat,lng"
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-locate]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.locate);
    if (!input || !navigator.geolocation) return note(t('item.locate_error'), 'error');
    btn.setAttribute('aria-busy', 'true');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        btn.removeAttribute('aria-busy');
        input.value = `${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      () => {
        btn.removeAttribute('aria-busy');
        note(t('item.locate_error'), 'error');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });

  // scan buttons: only where the browser reads barcodes (BarcodeDetector, e.g. Chrome on Android)
  if ('BarcodeDetector' in window && navigator.mediaDevices) {
    for (const b of document.querySelectorAll('[data-scan]')) b.hidden = false;
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('[data-scan]');
      if (!btn) return;
      const input = document.getElementById(btn.dataset.scan);
      const dlg = document.createElement('dialog');
      dlg.className = 'scan-dialog';
      const video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.muted = true;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn';
      close.textContent = t('item.scan_close');
      dlg.append(video, close);
      document.body.append(dlg);
      let stream;
      let done = false;
      const stop = () => {
        done = true;
        if (stream) stream.getTracks().forEach((tr) => tr.stop());
        dlg.close();
        dlg.remove();
      };
      close.addEventListener('click', stop);
      dlg.showModal();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        await video.play();
        const detector = new window.BarcodeDetector();
        while (!done) {
          const codes = await detector.detect(video).catch(() => []);
          if (codes.length) {
            input.value = codes[0].rawValue;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            stop();
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        stop();
        note(t('item.locate_error'), 'error');
      }
    });
  }

  // file items with data-max-px: photos are made smaller (JPEG) before they are uploaded (every file of a multiple item)
  async function smaller(file, max) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
      const img = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      if (scale >= 1) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch {
      return file; // keep the original
    }
  }
  document.addEventListener('change', async (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.dataset.maxPx || !input.files || !input.files[0]) return;
    if (!window.createImageBitmap || !window.DataTransfer) return;
    const max = Number(input.dataset.maxPx);
    const files = [...input.files];
    const out = await Promise.all(files.map((f) => smaller(f, max)));
    if (out.every((f, i) => f === files[i])) return;
    const dt = new DataTransfer();
    for (const f of out) dt.items.add(f);
    input.files = dt.files;
  });

  // file items (data-drop): drop files on the field, or paste them (a screenshot, a copied file).
  // The files go into the <input type="file">, so the form posts them as usual.
  function addFiles(input, files) {
    const dt = new DataTransfer();
    if (input.multiple) for (const f of input.files) dt.items.add(f);
    for (const f of input.multiple ? files : files.slice(0, 1)) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // wrap each file input in a drop zone with its hint (again after a dynamic action replaced an item)
  function dropZones(root) {
    for (const input of root.querySelectorAll('input[type=file][data-drop]')) {
      if (input.parentElement.classList.contains('file-drop')) continue;
      const zone = document.createElement('div');
      zone.className = 'file-drop';
      input.before(zone);
      const hint = document.createElement('span');
      hint.className = 'file-drop-hint';
      hint.textContent = input.dataset.drop;
      zone.append(input, hint);
    }
  }
  if (window.DataTransfer) {
    dropZones(document);
    document.addEventListener('pgapex:replaced', (e) => e.detail && dropZones(e.detail.parentElement || document));
    const zoneOf = (e) => (e.target instanceof Element ? e.target.closest('.file-drop') : null);
    const carriesFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let over = null;
    let depth = 0;
    const leave = () => {
      over?.classList.remove('dragover');
      over = null;
      depth = 0;
    };
    document.addEventListener('dragenter', (e) => {
      const zone = zoneOf(e);
      if (!zone || !carriesFiles(e)) return;
      e.preventDefault();
      if (zone !== over) {
        leave();
        over = zone;
        zone.classList.add('dragover');
      }
      depth++;
    });
    // a file dropped next to a zone must not open in the browser (the form would be lost)
    document.addEventListener('dragover', (e) => {
      if (over && zoneOf(e) === over) e.preventDefault();
      else if (carriesFiles(e) && document.querySelector('.file-drop')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
      }
    });
    document.addEventListener('dragleave', (e) => {
      if (over && zoneOf(e) === over && --depth <= 0) leave();
    });
    document.addEventListener('drop', (e) => {
      const zone = zoneOf(e);
      leave();
      if (carriesFiles(e) && document.querySelector('.file-drop')) e.preventDefault();
      const input = zone?.querySelector('input[type=file]');
      if (!input || !e.dataTransfer.files.length) return;
      addFiles(input, [...e.dataTransfer.files]);
    });
    // Paste: into the file item that has focus (or whose field has it), or the page's only file item
    // when no text field has focus (text fields keep their normal paste).
    document.addEventListener('paste', (e) => {
      const files = e.clipboardData ? [...e.clipboardData.files] : [];
      if (!files.length) return;
      const active = document.activeElement;
      let input = active && active.closest ? active.closest('.field')?.querySelector('input[type=file][data-drop]') : null;
      if (!input) {
        const typing = active && (active.isContentEditable || /^(TEXTAREA|SELECT)$/.test(active.tagName) || (active.tagName === 'INPUT' && active.type !== 'file'));
        const all = document.querySelectorAll('input[type=file][data-drop]');
        if (typing || all.length !== 1) return;
        input = all[0];
      }
      e.preventDefault();
      addFiles(input, files);
    });
  }
})();

// ------------------------------------------------------------------ map regions (Leaflet, loaded on pages with a map)
// After DOMContentLoaded: every deferred script (Leaflet comes after app.js) has run by then.
document.addEventListener('DOMContentLoaded', () => {
  if (!window.L) return;
  for (const el of document.querySelectorAll('[data-map]')) {
    const data = JSON.parse(el.nextElementSibling.textContent);
    const map = window.L.map(el, { scrollWheelZoom: false, tap: true });
    // pgapex sends Referrer-Policy: same-origin, but OpenStreetMap blocks browser tile requests
    // without a Referer: the tiles get the site's origin only (no paths or item values)
    window.L.tileLayer(data.tiles, { attribution: data.attribution, maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
    const popup = (p) => {
      // built with the DOM, not HTML strings: titles and texts are data
      const box = document.createElement('div');
      const b = document.createElement('strong');
      b.textContent = p.title || '';
      box.append(b);
      if (p.body) {
        const d = document.createElement('div');
        d.textContent = p.body;
        box.append(d);
      }
      if (p.href) {
        const a = document.createElement('a');
        a.href = p.href;
        a.textContent = data.open;
        box.append(a);
      }
      return box;
    };
    const layers = [];
    if (data.layer === 'heat') layers.push(heatLayer(data.points));
    else for (const p of data.points) layers.push(window.L.marker([p.lat, p.lng], { title: p.title || '' }).bindPopup(() => popup(p)));
    if (data.shapes.length)
      layers.push(window.L.geoJSON({ type: 'FeatureCollection', features: data.shapes }, { onEachFeature: (f, layer) => layer.bindPopup(() => popup(f.properties)) }));
    const group = window.L.featureGroup(layers).addTo(map);
    const bounds = group.getBounds();
    const area = data.filter && data.filter.area;
    if (area) map.fitBounds([[area.s, area.w], [area.n, area.e]]);
    else if (data.points.length === 1 && !data.shapes.length) map.setView([data.points[0].lat, data.points[0].lng], data.zoom || 14);
    else if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: data.zoom || 16 });
    else map.setView([20, 0], 2);
    if (data.layer === 'heat') heatLegend(map, data.legend);
    if (data.filter) areaFilter(map, data.filter);
  }
});

// A heat map layer: every point is a soft spot on a canvas, weighted; the summed
// intensity is coloured with one-hue blue steps (light and translucent → dark).
const HEAT_STOPS = [
  [0, [109, 167, 236, 0]],
  [0.25, [109, 167, 236, 0.45]],
  [0.5, [57, 135, 229, 0.65]],
  [0.75, [28, 92, 171, 0.8]],
  [1, [13, 54, 107, 0.9]],
];
function heatRamp() {
  const out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < HEAT_STOPS.length - 1 && HEAT_STOPS[k][0] < t) k++;
    const [t0, c0] = HEAT_STOPS[k - 1];
    const [t1, c1] = HEAT_STOPS[k];
    const f = (t - t0) / (t1 - t0 || 1);
    for (let j = 0; j < 4; j++) out[i * 4 + j] = (c0[j] + (c1[j] - c0[j]) * f) * (j === 3 ? 255 : 1);
  }
  return out;
}
function heatLayer(points) {
  const ramp = heatRamp();
  const max = Math.max(...points.map((p) => p.weight), 0) || 1;
  const Heat = window.L.Layer.extend({
    onAdd(map) {
      this._map = map;
      this._canvas = window.L.DomUtil.create('canvas', 'map-heat leaflet-zoom-hide');
      map.getPanes().overlayPane.append(this._canvas);
      map.on('moveend zoomend resize', this._draw, this);
      this._draw();
    },
    onRemove(map) {
      this._canvas.remove();
      map.off('moveend zoomend resize', this._draw, this);
    },
    getBounds() {
      return window.L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    },
    _draw() {
      const map = this._map;
      const size = map.getSize();
      const c = this._canvas;
      c.width = size.x;
      c.height = size.y;
      window.L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      const g = c.getContext('2d');
      // the radius grows a little with the zoom level, so cities stay spots and streets stay readable
      const radius = Math.max(22, Math.min(44, 10 + map.getZoom() * 2.5));
      for (const p of points) {
        if (!p.weight) continue;
        const at = map.latLngToContainerPoint([p.lat, p.lng]);
        if (at.x < -radius || at.y < -radius || at.x > size.x + radius || at.y > size.y + radius) continue;
        const spot = g.createRadialGradient(at.x, at.y, 0, at.x, at.y, radius);
        spot.addColorStop(0, `rgba(0,0,0,${Math.max(0.08, p.weight / max) * 0.6})`);
        spot.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = spot;
        g.fillRect(at.x - radius, at.y - radius, radius * 2, radius * 2);
      }
      const img = g.getImageData(0, 0, size.x, size.y);
      const px = img.data;
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (!a) continue;
        px[i] = ramp[a * 4];
        px[i + 1] = ramp[a * 4 + 1];
        px[i + 2] = ramp[a * 4 + 2];
        px[i + 3] = ramp[a * 4 + 3];
      }
      g.putImageData(img, 0, 0);
    },
  });
  return new Heat();
}
function heatLegend(map, [fewer, more]) {
  const Legend = window.L.Control.extend({
    onAdd() {
      const box = window.L.DomUtil.create('div', 'map-legend');
      const lo = document.createElement('span');
      lo.textContent = fewer;
      const bar = document.createElement('span');
      bar.className = 'map-legend-ramp';
      bar.setAttribute('aria-hidden', 'true');
      const hi = document.createElement('span');
      hi.textContent = more;
      box.append(lo, bar, hi);
      return box;
    },
  });
  new Legend({ position: 'bottomleft' }).addTo(map);
}
// "Show this area in the list": after the user moves the map, a button filters the report to the visible area.
function areaFilter(map, f) {
  const Control = window.L.Control.extend({
    onAdd() {
      const box = window.L.DomUtil.create('div', 'map-filter');
      window.L.DomEvent.disableClickPropagation(box);
      const go = document.createElement('a');
      go.className = 'btn btn-hot map-filter-go';
      go.textContent = f.label;
      go.href = '#';
      go.hidden = true;
      go.addEventListener('click', (e) => {
        e.preventDefault();
        const b = map.getBounds();
        const r = (v) => Math.round(v * 1e5) / 1e5;
        // west/east wrapped to -180..180 (west > east across the antimeridian); the whole world when zoomed far out
        const wrap = (v) => r(((((v + 180) % 360) + 360) % 360) - 180);
        const wide = b.getEast() - b.getWest() >= 360;
        const bb = [r(Math.max(-90, b.getSouth())), wide ? -180 : wrap(b.getWest()), r(Math.min(90, b.getNorth())), wide ? 180 : wrap(b.getEast())].join(',');
        location.href = f.url.replace('__BB__', encodeURIComponent(bb));
      });
      box.append(go);
      if (f.area) {
        const all = document.createElement('a');
        all.className = 'btn map-filter-clear';
        all.textContent = f.clearLabel;
        all.href = f.clear;
        box.append(all);
      }
      // shown once the user moved the map (not after the first fit)
      map.whenReady(() => setTimeout(() => map.on('moveend', () => (go.hidden = false)), 0));
      return box;
    },
  });
  new Control({ position: 'topright' }).addTo(map);
}

// ------------------------------------------------------------------ rich text, Markdown, tags, date range, password items
// Each works without JavaScript (a textarea, a text field, two dates, a password field); these only add comfort.
(() => {
  // Rich text: an editable area in place of the textarea, kept in sync with it. Content always goes in
  // through a small allow-list (the server rebuilds it again on submit), never as raw HTML.
  const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'STRIKE', 'SUB', 'SUP', 'UL', 'OL', 'LI',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'HR', 'DIV']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH', 'TITLE', 'TEXTAREA', 'SELECT']);
  const safeHref = (h) => {
    const u = String(h || '').replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');
    return /^(https?|mailto|tel):/i.test(u) || (u && !/^[^/?#]*:/.test(u)) ? u : null;
  };
  function cleanInto(target, source) {
    for (const node of source.childNodes) {
      if (node.nodeType === 3) target.append(node.textContent);
      if (node.nodeType !== 1 || DROP.has(node.tagName)) continue;
      if (!ALLOWED.has(node.tagName)) {
        cleanInto(target, node); // unknown tag: keep its text
        continue;
      }
      const el = document.createElement(node.tagName);
      if (node.tagName === 'A') {
        const href = safeHref(node.getAttribute('href'));
        if (!href) {
          cleanInto(target, node);
          continue;
        }
        el.setAttribute('href', href);
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }
      cleanInto(el, node);
      target.append(el);
    }
  }
  function setRich(editor, html) {
    const doc = new DOMParser().parseFromString(`<body>${html}`, 'text/html'); // inert: nothing runs or loads
    editor.replaceChildren();
    cleanInto(editor, doc.body);
  }
  const COMMANDS = {
    bold: ['bold'], italic: ['italic'], underline: ['underline'], strike: ['strikeThrough'], heading: ['formatBlock', 'h3'],
    paragraph: ['formatBlock', 'p'], bullets: ['insertUnorderedList'], numbers: ['insertOrderedList'], quote: ['formatBlock', 'blockquote'],
    code: ['formatBlock', 'pre'], unlink: ['unlink'], clear: ['removeFormat'],
  };
  function richText(box) {
    const area = box.querySelector('textarea');
    if (!area || box.querySelector('.rte-area')) return;
    const editor = document.createElement('div');
    editor.className = 'rte-area';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    const label = area.labels && area.labels[0];
    if (label) {
      label.id = label.id || `${area.id}_label`;
      editor.setAttribute('aria-labelledby', label.id);
      label.addEventListener('click', (e) => {
        e.preventDefault();
        editor.focus();
      });
    }
    for (const a of ['aria-describedby', 'aria-invalid', 'aria-required']) if (area.hasAttribute(a)) editor.setAttribute(a, area.getAttribute(a));
    setRich(editor, area.value);
    area.hidden = true;
    area.after(editor);
    const sync = () => {
      area.value = editor.innerHTML;
    };
    editor.addEventListener('input', sync);
    // pasted or dropped content goes through the allow-list too: no styles, images or scripts from
    // other pages reach the live document (they would load, or break the Content-Security-Policy)
    const insert = (e, data) => {
      if (!data) return;
      const html = data.getData('text/html');
      const text = data.getData('text/plain');
      e.preventDefault(); // a pasted image alone would otherwise become an <img>
      if (!html && !text) return;
      const sel = getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!range || !editor.contains(range.commonAncestorContainer)) return;
      if (html) {
        // inserted as nodes: execCommand('insertHTML') adds style attributes of its own
        const clean = document.createElement('div');
        // style attributes are taken out first only so that parsing doesn't report them to the
        // Content-Security-Policy (which blocks them anyway); cleanInto() is what keeps the content safe
        const t = document.createElement('template');
        t.innerHTML = html.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
        cleanInto(clean, t.content);
        const fragment = document.createDocumentFragment();
        fragment.append(...clean.childNodes);
        const last = fragment.lastChild;
        range.deleteContents();
        range.insertNode(fragment);
        if (last) {
          range.setStartAfter(last);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else document.execCommand('insertText', false, text);
      sync();
    };
    editor.addEventListener('paste', (e) => insert(e, e.clipboardData));
    editor.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) return e.preventDefault(); // files are not content
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (r) {
          getSelection().removeAllRanges();
          getSelection().addRange(r);
        }
      }
      insert(e, e.dataTransfer);
    });
    editor.addEventListener('blur', () => area.dispatchEvent(new Event('change', { bubbles: true })));
    // a dynamic action that sets the item's value
    area.addEventListener('change', () => {
      if (document.activeElement !== editor) setRich(editor, area.value);
    });
    toolbar(box, (cmd, btn) => {
      editor.focus();
      document.execCommand('styleWithCSS', false, false);
      if (cmd === 'link') {
        const url = safeHref(window.prompt(btn.dataset.prompt || 'URL', 'https://'));
        if (url) document.execCommand('createLink', false, url);
      } else if (COMMANDS[cmd]) document.execCommand(COMMANDS[cmd][0], false, COMMANDS[cmd][1]);
      sync();
    });
  }
  // Markdown: the toolbar puts the syntax around the selection in the textarea
  const MD = {
    bold: ['**', '**'], italic: ['_', '_'], strike: ['~~', '~~'], code: ['`', '`'],
    heading: ['## ', '', true], bullets: ['- ', '', true], numbers: ['1. ', '', true], quote: ['> ', '', true],
  };
  function markdown(box) {
    const area = box.querySelector('textarea');
    if (!area) return;
    toolbar(box, (cmd, btn) => {
      const { selectionStart: a, selectionEnd: b, value } = area;
      let before = '';
      let after = '';
      let start = a;
      if (cmd === 'link') {
        const url = window.prompt(btn.dataset.prompt || 'URL', 'https://');
        if (!url) return;
        before = '[';
        after = `](${url.replace(/[()\s]/g, encodeURIComponent)})`;
      } else if (MD[cmd]) {
        [before, after] = MD[cmd];
        if (MD[cmd][2]) start = value.lastIndexOf('\n', a - 1) + 1; // at the start of the line
      } else return;
      const sel = value.slice(a, b);
      area.setRangeText(before + (start === a ? sel : value.slice(start, a) + sel) + after, start, b, 'end');
      if (!sel && after) area.selectionStart = area.selectionEnd = area.selectionEnd - after.length;
      area.focus();
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function toolbar(box, run) {
    const bar = box.querySelector('.rte-toolbar');
    if (!bar) return;
    bar.hidden = false;
    // keep the selection in the editor when a button is pressed
    bar.addEventListener('mousedown', (e) => e.target.closest('button') && e.preventDefault());
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cmd]');
      if (btn) run(btn.dataset.cmd, btn);
    });
    // one tab stop: the arrow keys move between the buttons
    const buttons = [...bar.querySelectorAll('button')];
    buttons.forEach((b, i) => (b.tabIndex = i ? -1 : 0));
    bar.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[i].tabIndex = -1;
      buttons[next].tabIndex = 0;
      buttons[next].focus();
    });
  }

  // Combobox with several values: tags. A hidden input keeps the colon-separated value under the item's name.
  function tags(box) {
    const input = box.querySelector('input[list]');
    if (!input || box.querySelector('.tag-list')) return;
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = input.name;
    hidden.value = input.value;
    input.removeAttribute('name');
    input.value = '';
    const list = document.createElement('ul');
    list.className = 'tag-list';
    box.prepend(list);
    box.append(hidden);
    box.querySelector('.tags-hint')?.setAttribute('hidden', '');
    const labels = new Map([...(input.list?.options || [])].map((o) => [o.value, o.label || o.value]));
    const values = () => hidden.value.split(':').filter(Boolean);
    const draw = () => {
      list.replaceChildren(
        ...values().map((v) => {
          const li = document.createElement('li');
          li.className = 'tag';
          li.append(labels.get(v) || v);
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'tag-remove';
          x.textContent = '×';
          x.setAttribute('aria-label', (box.dataset.removeLabel || 'Remove {value}').replace('{value}', labels.get(v) || v));
          x.addEventListener('click', () => {
            set(values().filter((w) => w !== v));
            input.focus();
          });
          li.append(x);
          return li;
        }),
      );
    };
    const set = (vs) => {
      hidden.value = [...new Set(vs)].join(':');
      draw();
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const add = () => {
      const typed = input.value.split(':').map((v) => v.trim()).filter(Boolean);
      input.value = '';
      if (!typed.length) return;
      // a label typed as shown becomes its value
      const byLabel = new Map([...labels].map(([v, l]) => [l.toLowerCase(), v]));
      set([...values(), ...typed.map((t) => (labels.has(t) ? t : byLabel.get(t.toLowerCase()) || t))]);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        if (!input.value.trim()) return;
        e.preventDefault();
        add();
      } else if (e.key === 'Backspace' && !input.value && values().length) set(values().slice(0, -1));
    });
    // picking a suggestion from the list
    input.addEventListener('input', (e) => {
      if (!e.inputType || e.inputType === 'insertReplacementText') if (labels.has(input.value)) add();
    });
    input.addEventListener('change', (e) => {
      e.stopPropagation(); // the item's value is the hidden input's
      add();
    });
    input.form?.addEventListener('submit', add);
    hidden.addEventListener('change', (e) => e.isTrusted || draw());
    draw();
  }

  // Date range: the end date can't be before the start date
  function range(box) {
    const [from, to] = box.querySelectorAll('input[type=date]');
    if (!from || !to) return;
    const limit = () => {
      to.min = from.value;
      from.max = to.value;
    };
    from.addEventListener('change', limit);
    to.addEventListener('change', limit);
  }

  function enhance(root) {
    root.querySelectorAll('[data-richtext]').forEach(richText);
    root.querySelectorAll('[data-markdown]').forEach(markdown);
    root.querySelectorAll('[data-tags]').forEach(tags);
    root.querySelectorAll('[data-range]').forEach(range);
    root.querySelectorAll('[data-reveal]').forEach((b) => (b.hidden = false));
  }
  enhance(document);
  document.addEventListener('pgapex:replaced', (e) => e.detail && enhance(e.detail.parentElement || document));

  // Password reveal: show or hide what was typed; hidden again before the form is sent
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-reveal]');
    const input = btn && document.getElementById(btn.dataset.reveal);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    if (!btn.dataset.show) btn.dataset.show = btn.textContent;
    btn.textContent = show ? btn.dataset.hide : btn.dataset.show;
  });
  document.addEventListener('submit', (e) => {
    for (const btn of e.target.querySelectorAll('[data-reveal][aria-pressed="true"]')) btn.click();
  }, true);
})();
