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
    if (el.type === 'radio') els.forEach((e) => (e.checked = e.value === value));
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

// Interactive grid: add rows, track unsaved changes.
(() => {
  let dirty = false;
  // With JS the blank template row is hidden and must not be submitted (its
  // clones are); without JS it stays visible as the "new row".
  document.querySelectorAll('.grid-template [name]').forEach((el) => (el.disabled = true));
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-grid-add]');
    if (add) {
      const grid = add.closest('[data-grid]');
      const g = grid.dataset.grid;
      const tpl = grid.querySelector('.grid-template tr');
      const rows = grid.querySelector('tbody:not(.grid-template)');
      const used = [...grid.querySelectorAll('tbody:not(.grid-template) [data-new-row]')].map((r) => Number(r.dataset.newRow));
      const next = Math.max(Number(tpl.dataset.newRow), ...used.map((n) => n + 1));
      const row = tpl.cloneNode(true);
      row.dataset.newRow = String(next);
      row.querySelectorAll('[name]').forEach((el) => (el.disabled = false, el.name = el.name.replace(new RegExp(`^${g}_n\\d+_`), `${g}_n${next}_`)));
      rows.appendChild(row);
      row.querySelector('input, select')?.focus();
      dirty = true;
      return;
    }
    const leave = e.target.closest('[data-grid-leave]');
    if (leave && dirty && !window.confirm('You have unsaved changes in the grid. Leave anyway?')) e.preventDefault();
  });
  document.addEventListener('input', (e) => {
    const row = e.target.closest?.('[data-grid] tr');
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
})();

// Faceted search: apply on change.
document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-facet]')) e.target.form?.requestSubmit();
});

// Popup list of values: a search box that filters the options of a select.
function enhanceSearchable(root) {
  const selects = root.matches?.('select[data-searchable]') ? [root] : [...root.querySelectorAll('select[data-searchable]')];
  selects.forEach(addLovSearch);
}
document.addEventListener('pgapex:replaced', (e) => enhanceSearchable(e.detail));
enhanceSearchable(document);
function addLovSearch(sel) {
  const box = document.createElement('input');
  box.type = 'search';
  box.className = 'lov-search';
  box.placeholder = 'Search…';
  box.setAttribute('aria-label', `Search ${sel.labels?.[0]?.textContent?.trim() ?? 'list'}`);
  sel.before(box);
  box.addEventListener('input', () => {
    const q = box.value.toLowerCase();
    let firstMatch = null;
    for (const o of sel.options) {
      const match = !o.value || o.text.toLowerCase().includes(q);
      o.hidden = !match;
      if (match && o.value && !firstMatch) firstMatch = o;
    }
    if (q && firstMatch && sel.selectedOptions[0]?.hidden) sel.value = firstMatch.value;
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
