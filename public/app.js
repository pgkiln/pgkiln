// pgapex client runtime. Progressive enhancement only: every page works
// without JavaScript (dialogs become normal pages, dynamic actions do nothing).
// No inline handlers anywhere, so the Content-Security-Policy can forbid
// inline scripts.
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
    if (node) el.replaceWith(node);
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

  // ------------------------------------------------------------ navigation toggle
  const toggle = document.querySelector('.t-nav-toggle');
  const narrow = () => window.matchMedia('(max-width: 800px)').matches;
  const setNav = (open) => {
    body.classList.toggle('nav-collapsed', !open);
    toggle?.setAttribute('aria-expanded', String(open));
  };
  if (toggle) {
    let stored = null;
    try { stored = localStorage.getItem('pgapex.nav'); } catch {}
    setNav(narrow() ? false : stored !== 'closed');
    toggle.addEventListener('click', () => {
      const open = body.classList.contains('nav-collapsed');
      setNav(open);
      if (!narrow()) try { localStorage.setItem('pgapex.nav', open ? 'open' : 'closed'); } catch {}
    });
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
