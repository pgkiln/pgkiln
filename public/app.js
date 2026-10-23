// pgkiln client runtime. Progressive enhancement only: every page works
// without JavaScript (dialogs become normal pages, dynamic actions do nothing).
// No inline handlers anywhere, so the Content-Security-Policy can forbid
// inline scripts.
document.documentElement.classList.add('js');

// (sprint 86) Values a browser kept under pgkiln's old name (pgapex.*, pgapex-push:*) move to
// pgkiln.* / pgkiln-push:* once: the navigation drawer, the builder's tabs and panes, the region
// display selector's tab, a device's push notifications. A value already kept under the new name wins.
for (const store of ['localStorage', 'sessionStorage']) {
  try {
    const s = window[store];
    for (const k of Object.keys(s)) {
      if (!/^pgapex[.-]/.test(k)) continue;
      const neu = `pgkiln${k.slice(6)}`;
      if (s.getItem(neu) === null) s.setItem(neu, s.getItem(k));
      s.removeItem(k);
    }
  } catch {
    /* storage off (private mode, a blocked cookie setting): nothing kept, nothing to move */
  }
}

// Push notifications (migration 074): the page of an app with notifications on carries
// the app's public key (data-push) and the user (data-push-user). Subscribing needs a
// click (My account → Notifications, or the dynamic action push_subscribe); the
// subscription is sent to /a/<alias>/push/subscribe. A device keeps one user's
// notifications: signing out ends them (sw.js), and a device another user turned them
// on for is turned off here, so nobody sees someone else's notifications.
const pgkilnPush = (() => {
  const body = document.body;
  const key = body.dataset.push;
  const user = body.dataset.pushUser || '';
  const base = body.dataset.base;
  const metaEl = document.getElementById('pgkiln-meta');
  const meta = (metaEl ? JSON.parse(metaEl.textContent) : null) || {};
  const t = (k) => (meta.texts && meta.texts[k]) || k;
  const OWNER = `pgkiln-push:${base}`;
  const store = {
    get: () => {
      try {
        return JSON.parse(localStorage.getItem(OWNER) || 'null');
      } catch {
        return null;
      }
    },
    set: (v) => {
      try {
        if (v) localStorage.setItem(OWNER, JSON.stringify(v));
        else localStorage.removeItem(OWNER);
      } catch {
        /* private mode: the server still knows the device */
      }
    },
  };
  const supported = () => !!(key && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  const bytes = (k) => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sameKey = (sub) => !sub.options || !sub.options.applicationServerKey || b64u(sub.options.applicationServerKey) === key;

  async function send(path, data) {
    const params = new URLSearchParams(data);
    params.set('__csrf', meta.csrf || '');
    const res = await fetch(`${base}/push/${path}`, { method: 'POST', body: params, headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const json = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(json.error || res.statusText);
  }
  async function current() {
    const reg = await navigator.serviceWorker.ready;
    return { reg, sub: await reg.pushManager.getSubscription() };
  }
  const register = (sub) => {
    const j = sub.toJSON();
    return send('subscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, key });
  };

  async function subscribe() {
    if (!supported()) throw new Error(t('push.unsupported'));
    if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('push.blocked'));
    let { reg, sub } = await current();
    if (sub && !sameKey(sub)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
    await register(sub);
    store.set({ user, endpoint: sub.endpoint, at: Date.now() });
  }
  async function unsubscribe() {
    const { sub } = await current();
    store.set(null);
    if (!sub) return;
    await send('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  /** On: a subscription with the app's current key, notifications allowed. */
  async function isOn() {
    if (!supported() || Notification.permission !== 'granted') return false;
    const { sub } = await current();
    return !!sub && sameKey(sub);
  }

  // every page: keep the server's copy current (browsers renew subscriptions), once a day
  if (supported() && Notification.permission === 'granted') {
    current()
      .then(async ({ sub }) => {
        const owner = store.get();
        if (!sub) return owner && store.set(null);
        if (owner && owner.user !== user) {
          // turned on by someone else on this device: off, so this user doesn't see theirs
          store.set(null);
          return sub.unsubscribe();
        }
        if (!owner || !sameKey(sub)) return;
        if (owner.endpoint !== sub.endpoint || Date.now() - (owner.at || 0) > 86400000) {
          await register(sub);
          store.set({ user, endpoint: sub.endpoint, at: Date.now() });
        }
      })
      .catch(() => {});
  }

  // My account → Notifications
  const box = document.querySelector('[data-push-section]');
  if (box && supported()) {
    const status = box.querySelector('[data-push-status]');
    const button = box.querySelector('[data-push-toggle]');
    const show = async () => {
      if (Notification.permission === 'denied') {
        status.textContent = t('push.blocked');
        button.hidden = true;
        return;
      }
      const on = await isOn();
      status.textContent = t(on ? 'push.on' : 'push.off');
      button.textContent = t(on ? 'push.turn_off' : 'push.turn_on');
      button.dataset.on = on ? '1' : '';
      button.hidden = false;
    };
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        if (button.dataset.on) await unsubscribe();
        else await subscribe();
        await show();
      } catch (e) {
        status.textContent = (e && e.message) || t('push.failed');
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
    show().catch(() => {});
  }

  return { supported, subscribe, unsubscribe, isOn, t };
})();

// Warn on unsaved changes (migration 077): a page form with data-warn-unsaved asks
// before the user leaves the page (a link, a redirect button, another form, closing
// or reloading the tab, closing a dialog) while one of its items differs from the
// value the server rendered. Submitting the page doesn't ask. Items inside an
// element with data-no-warn, and the interactive grid (it has its own check), are
// left out. data-warn-unsaved="changed": the page came back from a failed submit,
// so its values are not saved yet.
const pgkilnUnsaved = (() => {
  const form = document.querySelector('form.page-form[data-warn-unsaved]');
  const metaEl = document.getElementById('pgkiln-meta');
  const meta = (metaEl ? JSON.parse(metaEl.textContent) : null) || {};
  const text = (meta.texts && meta.texts['page.unsaved_changes']) || 'You have unsaved changes. Leave this page anyway?';
  let leaving = false;
  const tracked = (el) =>
    el.name && !el.name.startsWith('__') && (el.type !== 'hidden' || 'initial' in el.dataset) && el.type !== 'submit' && el.type !== 'button' && !el.disabled &&
    !el.closest('[data-no-warn], [data-grid], .grid-template');
  function differs(el) {
    if (el.type === 'hidden') return el.value !== el.dataset.initial;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.type === 'file') return !!(el.files && el.files.length);
    if (el.tagName === 'SELECT') {
      const opts = [...el.options];
      if (el.multiple) return opts.some((o) => o.selected !== o.defaultSelected);
      const def = opts.findIndex((o) => o.defaultSelected);
      return el.selectedIndex !== (def >= 0 ? def : el.size > 1 ? -1 : 0);
    }
    return 'defaultValue' in el && el.value !== el.defaultValue;
  }
  const changed = () => !!form && (form.dataset.warnUnsaved === 'changed' || [...form.elements].some((el) => tracked(el) && differs(el)));
  /** True when the user may leave: nothing changed, or they said so. */
  function mayLeave() {
    if (leaving || !changed()) return true;
    if (!window.confirm(text)) return false;
    leaving = true;
    return true;
  }
  if (form) {
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      const href = a.getAttribute('href') || '';
      // a dialog, a new tab, a download or a place on this page doesn't leave it
      if (href.startsWith('#') || /^javascript:/i.test(href) || a.hasAttribute('download') || a.target === '_blank' || a.hasAttribute('data-dialog') || a.hasAttribute('data-dialog-cancel')) return;
      if (!mayLeave()) e.preventDefault();
    });
    // submitting the page saves; another form (a menu, a switch) leaves it
    document.addEventListener('submit', (e) => {
      if (e.target === form) leaving = true;
      else if (!e.defaultPrevented && (e.target.method || '').toLowerCase() === 'post' && !mayLeave()) e.preventDefault();
    }, true);
    window.addEventListener('beforeunload', (e) => {
      if (leaving || !changed()) return;
      e.preventDefault();
      e.returnValue = '';
    });
    // a navigation that was answered "leave" and then cancelled (download, same page) arms the check again
    window.addEventListener('pageshow', () => (leaving = false));
  }
  return { changed, mayLeave, text };
})();


(() => {
  const body = document.body;
  const base = body.dataset.base;
  const pageNo = body.dataset.page;
  const metaEl = document.getElementById('pgkiln-meta');
  const meta = metaEl ? JSON.parse(metaEl.textContent) : { das: [], csrf: '' };
  const form = document.querySelector('form.page-form');

  // ------------------------------------------------------------ automatic time zone
  // The app shows times in the browser's time zone: send it once per session; when it
  // changes what the page shows, load the page again (as a GET, unless the user typed).
  let browserTz = '';
  try {
    browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    browserTz = '';
  }
  // the sign-in form sends it along, so the first page already shows the right times
  document.querySelectorAll('input[type="hidden"][name="__tz"]').forEach((el) => (el.value = browserTz));
  if (meta.tz) {
    const tz = browserTz;
    if (tz) {
      let typed = false;
      document.addEventListener('input', () => (typed = true), { capture: true, once: true });
      fetch(meta.tz, { method: 'POST', body: new URLSearchParams({ tz, __csrf: meta.csrf }), headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => {
          if (r && r.reload && !typed && !document.querySelector('.alert-error, .has-error, dialog[open]')) location.replace(location.href);
        })
        .catch(() => {});
    }
  }

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
      document.dispatchEvent(new CustomEvent('pgkiln:replaced', { detail: node }));
    }
    return node;
  }

  // ------------------------------------------------------------ dynamic actions
  // `value`: what the condition compares (dialog_closed: the dialog's page number); else the first trigger item
  function conditionHolds(da, value) {
    if (!da.cond) return true;
    const v = value !== undefined ? value : da.trigger.length ? itemValue(da.trigger[0]) : '';
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

  // ------------------------------------------------------------ the application's own JavaScript
  // Static application files (loaded with <script src>, after this file) register
  // functions here; the dynamic action "Execute JavaScript" calls them by name.
  const actions = new Map();
  const ACTION_NAME = /^[A-Za-z_$][\w$.-]{0,99}$/;
  // every deferred script has run by DOMContentLoaded
  const scriptsLoaded = new Promise((resolve) =>
    document.readyState === 'complete' ? resolve() : document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  // Plug-ins (069) register one function each: called for every element with
  // data-plugin="<name>" (region and item plug-ins, also after a refresh) and
  // for the plug-in's dynamic actions.
  const plugins = new Map();
  const PLUGIN_NAME = /^[a-z][a-z0-9_]{0,59}$/;
  const pluginAttrs = (el) => {
    try {
      return JSON.parse(el.dataset.pluginAttrs || '{}');
    } catch {
      return {};
    }
  };
  function startPlugins(root) {
    const els = [...(root.matches && root.matches('[data-plugin]') ? [root] : []), ...root.querySelectorAll('[data-plugin]')];
    for (const el of els) {
      const fn = plugins.get(el.dataset.plugin);
      if (!fn || el.pgkilnPlugin) continue;
      el.pgkilnPlugin = true;
      const item = el.dataset.item || null;
      try {
        fn({ type: item ? 'item' : 'region', element: el, item, attributes: pluginAttrs(el) });
      } catch (e) {
        console.error(e);
      }
    }
  }
  scriptsLoaded.then(() => startPlugins(document));
  document.addEventListener('pgkiln:replaced', (e) => scriptsLoaded.then(() => startPlugins(e.detail)));

  window.pgkiln = Object.freeze({
    actions: Object.freeze({
      register(name, fn) {
        if (!ACTION_NAME.test(String(name)) || typeof fn !== 'function') throw new TypeError(`pgkiln.actions.register: a name and a function, not ${name}`);
        actions.set(String(name), fn);
      },
    }),
    plugins: Object.freeze({
      register(name, fn) {
        if (!PLUGIN_NAME.test(String(name)) || typeof fn !== 'function') throw new TypeError(`pgkiln.plugins.register: a plug-in name and a function, not ${name}`);
        plugins.set(String(name), fn);
        if (document.readyState !== 'loading') startPlugins(document);
      },
    }),
    getValue: (name) => itemValue(name),
    // (085) raise a custom event: dynamic actions with event "custom" and this name run
    trigger: (name, value) => runChain(das.filter((da) => da.event === 'custom' && da.trigger.some((t) => String(t).toLowerCase() === String(name).toLowerCase())), value),
    // (085) APEX: apex.server.process. An Ajax callback (a process with point "ajax") by name: posts the items given
    // (a list of names, or {name: value}) and x01 … x10; answers { data, rows, items } and sets the items it changed.
    server: Object.freeze({
      async process(name, opts = {}) {
        const data = {};
        if (Array.isArray(opts.items)) for (const n of opts.items) data[n] = itemValue(n);
        else if (opts.items && typeof opts.items === 'object') Object.assign(data, opts.items);
        for (let i = 1; i <= 10; i++) {
          const k = `x${String(i).padStart(2, '0')}`;
          if (opts[k] !== undefined && opts[k] !== null) data[k] = String(opts[k]);
        }
        const res = await post(`/ajax/${encodeURIComponent(name)}`, data);
        for (const [n, v] of Object.entries(res.items || {})) setItemValue(n, v);
        return res;
      },
    }),
    // (077) APEX: apex.page.isChanged()
    isChanged: () => pgkilnUnsaved.changed(),
    setValue: (name, value) => setItemValue(name, value),
    // (124) APEX: apex.widget.waitPopup; the returned function removes it
    waitPopup: (message) => (showWait(message == null ? '' : String(message)), removeWait),
    removeWaitPopup: () => removeWait(),
    showSuccess: (message) => showMessage(String(message), 'success'),
    showError: (message, item) => (item ? itemError(item, String(message)) : showMessage(String(message), 'error')),
    clearErrors: (...items) => clearErrors(items),
    page: pageNo,
  });

  /** (085) what runDa returns to stop the actions after it (a declined confirm) */
  const STOP = Symbol('stop');
  const text = (k) => (meta.texts && meta.texts[k]) || k;

  /** The actions of one event and trigger, one after the other in sequence order; false when one stopped them. */
  async function runChain(list, value, extra) {
    for (const da of list) if ((await runDa(da, false, value, extra)) === STOP) return false;
    return true;
  }

  /** (085) The download dynamic action: the file of the download process it names, saved by the browser. */
  async function download(da) {
    const params = new URLSearchParams();
    for (const n of da.submit) params.set(n, itemValue(n));
    params.set('__csrf', meta.csrf);
    try {
      const res = await fetch(`${base}/${pageNo}/da/${da.id}/download`, { method: 'POST', body: params, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '')?.[1];
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name ? decodeURIComponent(name) : 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      showError(e.message);
    }
  }

  // (124) APEX: Show / Remove Wait Popup. A modal dialog (the page below is inert, Escape doesn't
  // close it) with a spinner and a status text read out by screen readers; <main> is aria-busy.
  // It goes with the page on a submit; a submit the browser refused (an invalid field) or a page
  // restored from the back/forward cache removes it.
  let waitDlg = null;
  function showWait(message) {
    if (!waitDlg) {
      waitDlg = document.createElement('dialog');
      waitDlg.className = 'wait-popup';
      waitDlg.tabIndex = -1;
      const spin = document.createElement('span');
      spin.className = 'wait-popup-spinner';
      spin.setAttribute('aria-hidden', 'true');
      const p = document.createElement('p');
      p.className = 'wait-popup-text';
      p.id = 'pgkiln-wait-text';
      p.setAttribute('role', 'status');
      waitDlg.setAttribute('aria-labelledby', p.id);
      waitDlg.append(spin, p);
      waitDlg.addEventListener('cancel', (e) => e.preventDefault());
      body.appendChild(waitDlg);
    }
    waitDlg.querySelector('.wait-popup-text').textContent = message || text('da.wait');
    if (!waitDlg.open) waitDlg.showModal();
    (document.getElementById('main') || body).setAttribute('aria-busy', 'true');
  }
  function removeWait() {
    if (waitDlg && waitDlg.open) waitDlg.close();
    (document.getElementById('main') || body).removeAttribute('aria-busy');
  }
  document.addEventListener('invalid', () => waitDlg && waitDlg.open && removeWait(), true);
  window.addEventListener('pageshow', (e) => e.persisted && removeWait());

  async function runDa(da, initial, value, extra) {
    const holds = conditionHolds(da, value);
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
      // (085) a question: No stops the actions after it (and a page submit for before_submit)
      case 'confirm':
        return window.confirm(da.message || '') ? undefined : STOP;
      case 'close_dialog':
      case 'cancel_dialog':
        if (window.parent !== window) window.parent.postMessage({ type: 'pgkiln:close', reload: da.action === 'close_dialog', page: body.dataset.dialogPage || String(pageNo) }, location.origin);
        return;
      case 'clear':
        for (const n of da.items) setItemValue(n, '');
        return;
      case 'open_region':
      case 'close_region':
        for (const el of targets(da)) {
          const details = el.querySelector(':scope > details');
          // (088) an inline dialog or drawer region
          if (el.matches('dialog[data-inline-region]')) {
            if (da.action === 'open_region' && !el.open) el.showModal();
            else if (da.action === 'close_region' && el.open) el.close();
          } else if (details) details.open = da.action === 'open_region';
          else el.hidden = da.action === 'close_region';
        }
        return;
      case 'print':
        window.print();
        return;
      // (124) the wait popup: until remove_wait_popup, the next page or a refused submit
      case 'wait_popup':
        showWait(da.message);
        return;
      case 'remove_wait_popup':
        removeWait();
        return;
      case 'current_position':
        return new Promise((resolve) => {
          if (!navigator.geolocation) return showError(text('item.locate_error')), resolve();
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (da.items[0]) setItemValue(da.items[0], `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`);
              resolve();
            },
            () => (showError(text('item.locate_error')), resolve()),
            { enableHighAccuracy: true, timeout: 15000 },
          );
        });
      case 'share': {
        const data = { title: document.title, text: da.message || undefined, url: location.href };
        try {
          if (navigator.share) await navigator.share(data);
          else {
            await navigator.clipboard.writeText(location.href);
            showMessage(text('page.link_copied'), 'success');
          }
        } catch {
          // the user closed the share sheet
        }
        return;
      }
      case 'download':
        return download(da);
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
      case 'plugin': {
        await scriptsLoaded;
        const fn = da.plugin && plugins.get(da.plugin);
        if (!fn) return console.warn(`pgkiln: the plug-in "${da.plugin}" did not register (pgkiln.plugins.register) for dynamic action ${da.id}`);
        try {
          await fn({ type: 'dynamic_action', value, items: da.items, region: da.region ? document.getElementById(`R${da.region}`) : null, elements: targets(da), message: da.message, attributes: da.attributes || {} });
        } catch (e) {
          console.error(e);
          showError(e.message);
        }
        return;
      }
      case 'push_subscribe':
        // turn on notifications on this device (a click: browsers ask only after one)
        try {
          await pgkilnPush.subscribe();
          showMessage(da.message || pgkilnPush.t('push.on'), 'success');
        } catch (e) {
          showMessage((e && e.message) || pgkilnPush.t('push.failed'), 'error');
        }
        return;
      case 'execute_javascript': {
        await scriptsLoaded;
        const fn = da.fn && actions.get(da.fn);
        if (!fn) return console.warn(`pgkiln: no function "${da.fn}" registered (pgkiln.actions.register) for dynamic action ${da.id}`);
        try {
          await fn({ value, items: da.items, region: da.region ? document.getElementById(`R${da.region}`) : null, elements: targets(da), message: da.message });
        } catch (e) {
          console.error(e);
          showError(e.message);
        }
        return;
      }
    }
    const data = { ...(extra || {}) };
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
      const sheet = document.getElementById('pgkiln-css')?.sheet;
      if (sheet && res.css) for (const rule of res.css.split('\n')) if (rule) sheet.insertRule(rule, sheet.cssRules.length);
      for (const [id, markup] of Object.entries(res.regions || {})) {
        const r = document.getElementById(`R${id}`);
        if (r) replaceHtml(r, markup);
      }
      if (da.action === 'set_value' || da.action === 'execute_sql' || da.action === 'ai_generate')
        for (const [name, value] of Object.entries(res.items || {})) setItemValue(name, value);
      if (res.flash) showMessage(res.flash, 'success');
    } catch (e) {
      showError(e.message);
    } finally {
      busy.forEach((el) => el.removeAttribute('aria-busy'));
    }
  }

  const das = meta.das || [];
  // (121) an AI agent's javascript tools: after the answer, the registered function of the action
  // (pgkiln.actions.register) and the dynamic actions of the custom event of that name, with the arguments
  scriptsLoaded.then(async () => {
    for (const el of document.querySelectorAll('.assistant-action[data-ai-action]')) {
      const name = el.dataset.aiAction;
      let args = {};
      try {
        args = JSON.parse(el.dataset.aiArgs || '{}');
      } catch {
        // ignored
      }
      const region = el.closest('[id^="R"]');
      el.remove();
      const fn = actions.get(name);
      try {
        if (fn) await fn({ value: args, items: [], region, elements: [], message: null });
        await runChain(das.filter((da) => da.event === 'custom' && da.trigger.some((t) => String(t).toLowerCase() === name.toLowerCase())), JSON.stringify(args));
      } catch (e) {
        console.error(e);
      }
    }
  });
  document.addEventListener('change', (e) => {
    const name = e.target.name;
    if (!name) return;
    runChain(das.filter((da) => da.event === 'change' && da.trigger.includes(name)));
    cascade(name);
    if (e.target.closest('[data-submit-on-change]') && e.target.form === form && depth === 0) form.requestSubmit();
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-button]');
    if (!btn || e.target.closest('[data-menu-entry]')) return;
    const run = das.filter((da) => da.event === 'click' && da.trigger.includes(btn.dataset.button));
    // "Generate text with AI" on a submit button: the AJAX call replaces the submit
    // (without JavaScript the button submits and the page process runs instead)
    const ai = run.some((da) => da.action === 'ai_generate');
    if (ai && btn.type === 'submit') e.preventDefault();
    const pending = runChain(run);
    if (ai && btn.tagName === 'BUTTON') {
      // one request at a time: the button waits for the answer
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      Promise.allSettled([pending]).then(() => {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      });
    }
  });
  // (124) menu_entry: an entry {"action": NAME} of a menu button was chosen (a declined confirm
  // stops it in the capture handler below). Trigger: the entry's name or the menu button's name;
  // the value a client-side condition tests is the entry's name.
  document.addEventListener('click', (e) => {
    const entry = e.target.closest?.('[data-menu-entry]');
    if (!entry) return;
    const name = entry.dataset.menuEntry;
    const menu = entry.closest('details.menu');
    const owner = (menu && menu.dataset.button) || '';
    if (menu) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
    runChain(das.filter((da) => da.event === 'menu_entry' && (da.trigger.includes(name) || (owner && da.trigger.includes(owner)))), name);
  });
  for (const da of das) if (da.event !== 'dialog_closed' && ['show', 'hide', 'enable', 'disable'].includes(da.action)) runDa(da, true);
  runChain(das.filter((da) => da.event === 'load'));

  // (085) more events. Item events: focus, blur, key_release (trigger: item names).
  const itemEvent = (event) => (e) => {
    const name = e.target && e.target.name;
    if (!name) return;
    const run = das.filter((da) => da.event === event && da.trigger.includes(name));
    if (run.length) runChain(run);
  };
  document.addEventListener('focusin', itemEvent('focus'));
  document.addEventListener('focusout', itemEvent('blur'));
  document.addEventListener('keyup', itemEvent('key_release'));
  // region events (trigger: region ids or static ids, case-insensitive)
  const regionRun = (event, region) => {
    if (!region || !/^R\d+$/.test(region.id || '')) return [];
    const keys = [region.id.slice(1), (region.dataset.staticId || '').toLowerCase()].filter(Boolean);
    return das.filter((da) => da.event === event && da.trigger.some((t) => keys.includes(String(t).toLowerCase())));
  };
  // after_refresh: a region replaced by a refresh, a lazy load or a master row
  document.addEventListener('pgkiln:replaced', (e) => {
    const run = regionRun('after_refresh', e.detail);
    if (run.length) runChain(run);
  });
  // selection_change: the row checkboxes of a report (and a grid's selected master row, see selectMaster)
  const selectionChanged = (region) => {
    const run = regionRun('selection_change', region);
    if (!run.length) return;
    const boxes = region.querySelectorAll('td.row-select input[type=checkbox]:checked');
    runChain(run, [...boxes].map((b) => b.value).join(':'));
  };
  document.addEventListener('change', (e) => {
    if (e.target.closest?.('.row-select')) selectionChanged(e.target.closest('section[id^="R"]'));
  });
  document.addEventListener('pgkiln:selection', (e) => selectionChanged(e.detail));
  // before_submit: the page's form; a declined confirm keeps the page
  let submitting = false;
  document.addEventListener('submit', async (e) => {
    if (e.target !== form || submitting) return;
    const run = das.filter((da) => da.event === 'before_submit');
    if (!run.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const submitter = e.submitter;
    if (!(await runChain(run))) return;
    submitting = true;
    try {
      form.requestSubmit(submitter && submitter.form === form ? submitter : undefined);
    } finally {
      submitting = false;
    }
  }, true);

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
    try { stored = localStorage.getItem('pgkiln.nav'); } catch {}
    if (stored === 'closed') body.classList.add('nav-collapsed');
    toggle.setAttribute('aria-expanded', String(navOpen()));
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const open = !navOpen();
      setNav(open);
      if (!drawer.matches) try { localStorage.setItem('pgkiln.nav', open ? 'open' : 'closed'); } catch {}
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
  // (097) a long menu shows the current page's entry: the menu scrolls, not the page
  {
    const nav = document.getElementById('t-nav');
    const current = nav?.querySelector('a[aria-current="page"]');
    if (nav && current && nav.scrollHeight > nav.clientHeight) {
      const top = current.getBoundingClientRect().top - nav.getBoundingClientRect().top;
      if (top < 0 || top + current.offsetHeight > nav.clientHeight) nav.scrollTop += top - nav.clientHeight / 3;
    }
  }

  // ------------------------------------------------------------ modal dialogs
  const POSITIONS = ['center', 'left', 'right', 'top', 'bottom'];
  const SIZES = ['small', 'medium', 'large'];
  function dialogShape(url) {
    let shapes = {};
    try {
      shapes = JSON.parse(document.getElementById('pgkiln-meta')?.textContent || '{}').dialogs || {};
    } catch {}
    let page = '';
    try {
      const u = new URL(url, location.href);
      const base = body.dataset.base || '';
      if (u.origin === location.origin && u.pathname.startsWith(base + '/')) page = u.pathname.slice(base.length + 1);
    } catch {}
    const s = Object.prototype.hasOwnProperty.call(shapes, page) ? shapes[page] : null;
    return [POSITIONS.includes(s?.[0]) ? s[0] : 'center', SIZES.includes(s?.[1]) ? s[1] : 'medium'];
  }
  function openDialog(url) {
    let dlg = document.getElementById('t-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 't-dialog';
      dlg.className = 't-dialog';
      dlg.setAttribute('aria-labelledby', 't-dialog-title');
      dlg.innerHTML = '<div class="t-dialog-head"><h2 id="t-dialog-title"></h2><button type="button" class="icon-button t-dialog-x" aria-label="Close">×</button></div><iframe title="Dialog"></iframe>';
      document.body.appendChild(dlg);
      // (077) the page in the dialog decides whether its unsaved changes may go
      const mayClose = () => {
        try {
          const w = dlg.querySelector('iframe').contentWindow;
          return !w.pgkiln?.isChanged?.() || window.confirm(pgkilnUnsaved.text);
        } catch {
          return true;
        }
      };
      dlg.querySelector('.t-dialog-x').addEventListener('click', () => mayClose() && dlg.close());
      dlg.addEventListener('cancel', (e) => {
        if (!mayClose()) e.preventDefault();
      });
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
    // (065) drawers from an edge and dialog sizes, per target page (pgkiln-meta "dialogs")
    const [pos, size] = dialogShape(url);
    dlg.className = `t-dialog t-dialog-${pos} t-dialog-${size}${pos === 'center' ? '' : ' t-drawer'}`;
    frame.src = url + (url.includes('?') ? '&' : '?') + 'dialog=1';
    dlg.showModal();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-dialog]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || body.dataset.dialog === '1') return;
    e.preventDefault();
    openDialog(a.href);
  });

  // A dialog closed after a submit: the page's "dialog_closed" dynamic actions for
  // that dialog page (trigger: its page numbers, or any) run instead of a reload.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'pgkiln:close') return;
    const dlg = document.getElementById('t-dialog');
    if (dlg) dlg.close();
    if (!e.data.reload) return;
    const page = /^\d{1,9}$/.test(String(e.data.page || '')) ? String(e.data.page) : '';
    const handlers = das.filter((da) => da.event === 'dialog_closed' && (!da.trigger.length || da.trigger.includes(page)));
    if (!handlers.length) return location.reload();
    // the first action that goes to the server brings the dialog's success message along
    let first = true;
    const serverSide = ['set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'ai_generate'];
    (async () => {
      for (const da of handlers) {
        const extra = first && serverSide.includes(da.action) ? { __dialog_closed: '1' } : undefined;
        if (extra) first = false;
        await runDa(da, false, page, extra);
      }
    })();
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
      const sheet = document.getElementById('pgkiln-css')?.sheet;
      if (sheet && res.css) for (const rule of res.css.split('\n')) if (rule) sheet.insertRule(rule, sheet.cssRules.length);
      const node = region ? replaceHtml(region, res.region) : null;
      const status = node?.querySelector('.cal-status');
      if (status) status.textContent = res.message;
    } catch (err) {
      cal.removeAttribute('aria-busy');
      showError(err.message);
    }
  });

  // ------------------------------------------------------------ Gantt chart drag and drop (sprint 69)
  // An editable Gantt chart (.gantt-editable, data-gantt = its region) has tasks with
  // data-task, data-start and data-end (wall clock ms, read as UTC). Dragging a task moves
  // it, dragging a bar's end handle changes its end, in whole days or hours (data-snap);
  // from the keyboard the arrow keys do the same (Shift: the end), Enter saves, Escape
  // cancels. The server checks and saves the new dates and sends the chart back.
  const GANTT_STEP = { day: 86400000, hour: 3600000 };
  const ganttWhen = (ms, snap) => new Date(ms).toISOString().slice(0, snap === 'hour' ? 16 : 10);
  const ganttState = new WeakMap();
  function ganttPreview(task, steps, mode) {
    const chart = task.closest('.gantt-editable');
    const plot = chart.querySelector('.gantt-plot');
    const step = GANTT_STEP[chart.dataset.snap] || GANTT_STEP.day;
    const span = Number(chart.dataset.hi) - Number(chart.dataset.lo);
    const start = Number(task.dataset.start);
    const end = Number(task.dataset.end);
    const prev = ganttState.get(task);
    // the bar's width before this edit (the preview changes it)
    const orig = prev ? prev.orig : task.getBoundingClientRect().width;
    // a bar's end never goes before its start; a milestone only moves
    const resize = mode === 'end' && task.classList.contains('gantt-bar');
    if (resize) steps = Math.max(steps, Math.round((start - end) / step));
    const next = resize ? { start, end: end + steps * step } : { start: start + steps * step, end: end + steps * step };
    const px = (ms) => (ms / span) * plot.getBoundingClientRect().width;
    // (translate, not transform: a milestone is a rotated square)
    task.style.translate = !resize && steps ? `${px(steps * step)}px 0` : '';
    task.style.width = resize && steps ? `${Math.max(orig + px(steps * step), 2)}px` : '';
    ganttState.set(task, { steps, mode: resize ? 'end' : 'move', next, orig, keyboard: prev?.keyboard });
    task.classList.toggle('gantt-moving', !!steps);
    const status = chart.closest('.region')?.querySelector('.gantt-status');
    if (status) status.textContent = steps ? `${task.dataset.label}: ${ganttWhen(next.start, chart.dataset.snap).replace('T', ' ')} – ${ganttWhen(next.end, chart.dataset.snap).replace('T', ' ')}` : '';
    return next;
  }
  function ganttReset(task) {
    task.style.translate = '';
    task.style.width = '';
    const status = task.closest('.region')?.querySelector('.gantt-status');
    if (status) status.textContent = '';
    task.classList.remove('gantt-moving', 'gantt-dragging');
    ganttState.delete(task);
  }
  async function ganttSave(task) {
    const st = ganttState.get(task);
    if (!st || !st.steps) return ganttReset(task);
    const chart = task.closest('.gantt-editable');
    const region = chart.closest('.region');
    const id = task.dataset.task;
    const snap = chart.dataset.snap;
    chart.setAttribute('aria-busy', 'true');
    try {
      const res = await post(`/chart/${chart.dataset.gantt}/move`, { task: id, start: ganttWhen(st.next.start, snap), end: ganttWhen(st.next.end, snap) });
      const sheet = document.getElementById('pgkiln-css')?.sheet;
      if (sheet && res.css) for (const rule of res.css.split('\n')) if (rule) sheet.insertRule(rule, sheet.cssRules.length);
      const node = region ? replaceHtml(region, res.region) : null;
      const status = node?.querySelector('.gantt-status');
      if (status) status.textContent = res.message;
      // keyboard users keep their place
      if (st.keyboard) node?.querySelector(`.gantt-editable [data-task="${CSS.escape(id)}"]`)?.focus();
    } catch (err) {
      chart.removeAttribute('aria-busy');
      ganttReset(task);
      showError(err.message);
    }
  }
  let ganttDrag = null;
  let ganttSwallowClick = false;
  document.addEventListener('pointerdown', (e) => {
    const task = e.button === 0 && e.target.closest?.('.gantt-editable [data-task]');
    if (!task || task.closest('[aria-busy="true"]')) return;
    ganttDrag = { task, x: e.clientX, mode: e.target.closest('.gantt-handle') ? 'end' : 'move', id: e.pointerId, moved: false };
    task.setPointerCapture?.(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => {
    if (!ganttDrag || e.pointerId !== ganttDrag.id) return;
    const { task } = ganttDrag;
    const chart = task.closest('.gantt-editable');
    const width = chart.querySelector('.gantt-plot').getBoundingClientRect().width || 1;
    const step = GANTT_STEP[chart.dataset.snap] || GANTT_STEP.day;
    const dx = e.clientX - ganttDrag.x;
    if (!ganttDrag.moved && Math.abs(dx) < 4) return;
    ganttDrag.moved = true;
    task.classList.add('gantt-dragging');
    const steps = Math.round(((dx / width) * (Number(chart.dataset.hi) - Number(chart.dataset.lo))) / step);
    if (steps !== ganttState.get(task)?.steps) ganttPreview(task, steps, ganttDrag.mode);
  });
  const ganttEnd = (e, cancel) => {
    if (!ganttDrag || e.pointerId !== ganttDrag.id) return;
    const { task, moved } = ganttDrag;
    ganttDrag = null;
    task.classList.remove('gantt-dragging');
    if (!moved) return;
    // a drag is not a click on the task's link
    ganttSwallowClick = true;
    setTimeout(() => (ganttSwallowClick = false), 0);
    if (cancel) ganttReset(task);
    else ganttSave(task);
  };
  document.addEventListener('pointerup', (e) => ganttEnd(e, false));
  document.addEventListener('pointercancel', (e) => ganttEnd(e, true));
  document.addEventListener('click', (e) => {
    if (ganttSwallowClick && e.target.closest?.('.gantt-editable [data-task]')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    const task = e.target.closest?.('.gantt-editable [data-task]');
    if (!task || e.altKey || e.ctrlKey || e.metaKey) return;
    const st = ganttState.get(task);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const mode = e.shiftKey && task.classList.contains('gantt-bar') ? 'end' : 'move';
      // switching between moving and changing the end starts over
      if (st && st.mode !== mode) ganttReset(task);
      const same = ganttState.get(task);
      ganttPreview(task, (same ? same.steps : 0) + (e.key === 'ArrowRight' ? 1 : -1), mode);
      ganttState.get(task).keyboard = true;
    } else if (e.key === 'Enter' && st?.steps) {
      e.preventDefault();
      ganttSave(task);
    } else if (e.key === 'Escape' && st) {
      e.preventDefault();
      ganttReset(task);
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
      const sheet = document.getElementById('pgkiln-css')?.sheet;
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
    const tell = (reload) => window.parent.postMessage({ type: 'pgkiln:close', reload, page: body.dataset.dialogPage || '' }, location.origin);
    if (body.dataset.dialogClose) tell(true);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-dialog-cancel]')) return;
      e.preventDefault();
      if (pgkilnUnsaved.mayLeave()) tell(false);
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
  const metaEl = document.getElementById('pgkiln-meta');
  const csrf = metaEl ? JSON.parse(metaEl.textContent).csrf : '';
  let dirty = false;

  // With JS the blank template row is hidden and must not be submitted (its
  // clones are); without JS it stays visible as the "new row".
  const disableTemplates = (root) => root.querySelectorAll('.grid-template [name]').forEach((el) => (el.disabled = true));
  disableTemplates(document);

  // ------------------------------------------------------------ rows
  function addRow(grid) {
    const g = grid.dataset.grid;
    const tpl = grid.querySelector('table.grid-table > .grid-template > tr');
    if (!tpl) return null;
    // the grid's own rows (the Actions menu's Columns form has a table too)
    const rows = grid.querySelector('table.grid-table > tbody:not(.grid-template)');
    const used = [...rows.querySelectorAll(':scope > [data-new-row]')].map((r) => Number(r.dataset.newRow));
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
    if (leave && dirty && !window.confirm(pgkilnUnsaved.text)) e.preventDefault();
  });
  document.addEventListener('input', (e) => {
    // a grid row, or the single row view's form
    const row = e.target.closest?.('[data-grid] table.grid-table > tbody > tr, [data-grid] .grid-record');
    if (!row) return;
    row.classList.add('dirty');
    dirty = true;
  });
  document.addEventListener('change', (e) => {
    const del = e.target.closest?.('[data-grid] .grid-sel input');
    if (del) del.closest('tr, .grid-record').classList.toggle('deleted', del.checked);
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
    if (dirtyDetail && !window.confirm(pgkilnUnsaved.text)) return;
    const query = new URL(link.href, location.href).search.slice(1);
    for (const id of ids) {
      const region = document.getElementById(`R${id}`);
      region?.setAttribute('aria-busy', 'true');
      try {
        const res = await fetch(`${base}/${pageNo}/region/${id}?${query}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
        const json = await res.json().catch(() => ({ error: res.statusText }));
        if (!res.ok) throw new Error(json.error || res.statusText);
        const sheet = document.getElementById('pgkiln-css')?.sheet;
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
          document.dispatchEvent(new CustomEvent('pgkiln:replaced', { detail: node }));
        }
      } catch (err) {
        region?.removeAttribute('aria-busy');
        window.alert(err.message);
        return;
      }
    }
    // (085) the dynamic actions on the master's "selection change"
    document.dispatchEvent(new CustomEvent('pgkiln:selection', { detail: master.closest('section[id^="R"]') }));
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
  document.addEventListener('pgkiln:replaced', (e) => {
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

  // ------------------------------------------------------------ cell navigation and edit mode (APEX)
  // An editable cell reads as text (app.css) until it is edited: a click in it, Enter or F2 or typing
  // edits it. On a cell the arrow keys move to the next one; while editing, Escape goes back to the
  // cell and Enter to the cell below. Tab moves through the cells' controls as usual.
  const cellSel = '[data-grid] table.grid-table > tbody:not(.grid-template) > tr > td[data-col]';
  function focusCell(td, edit) {
    if (!td) return;
    const el = control(td);
    if (edit && el && !el.disabled) {
      el.focus();
      if (el.type !== 'checkbox' && el.tagName !== 'SELECT') el.select?.();
      return;
    }
    if (!td.hasAttribute('tabindex')) td.tabIndex = -1;
    td.focus();
  }
  function neighbour(td, dr, dc) {
    const rows = rowsOf(td.closest('[data-grid]'));
    const { r, c } = at(td);
    return rows[r + dr] ? shownCells(rows[r + dr])[c + dc] : undefined;
  }
  const MOVES = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t.matches?.(cellSel)) {
      const el = control(t);
      if (MOVES[e.key]) {
        e.preventDefault();
        focusCell(neighbour(t, ...MOVES[e.key]), false);
      } else if (el && (e.key === 'Enter' || e.key === 'F2')) {
        e.preventDefault();
        focusCell(t, true);
      } else if (el?.type === 'checkbox' && e.key === ' ') {
        e.preventDefault();
        el.click();
      } else if (el && e.key.length === 1) focusCell(t, true); // the key types into the control
      return;
    }
    const td = t.closest?.(cellSel);
    if (!td || !t.matches('input, select')) return;
    if (e.key === 'Escape') focusCell(td, false);
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const below = neighbour(td, 1, 0);
      focusCell(below ?? td, !!below);
    } else if (e.key === 'F2') focusCell(td, false);
  });
  // a click in a cell beside its control edits it
  document.addEventListener('click', (e) => {
    if (!e.shiftKey && e.target.matches?.(cellSel)) focusCell(e.target, true);
  });
  // an edited value shows as itself (a list's display value)
  const syncText = (e) => {
    const span = e.target.closest?.('td[data-col]')?.querySelector(':scope > .grid-text');
    if (!span) return;
    const el = e.target;
    if (el.tagName === 'SELECT') span.textContent = el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '';
    else span.remove();
  };
  document.addEventListener('input', syncText);
  document.addEventListener('change', syncText);
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

// (088) Inline dialog and drawer regions: a link to #R<id> opens one as a modal dialog (without
// JavaScript CSS shows it as the :target), its close button and Esc close it, a click on the
// backdrop too.
document.addEventListener('click', (e) => {
  const close = e.target.closest?.('[data-region-close]');
  if (close) {
    e.preventDefault();
    close.closest('dialog')?.close();
    return;
  }
  const a = e.target.closest?.('a[href^="#R"]');
  const d = a && document.getElementById(a.getAttribute('href').slice(1));
  if (d?.matches('dialog[data-inline-region]')) {
    e.preventDefault();
    if (!d.open) d.showModal();
    return;
  }
  if (e.target.matches?.('dialog[data-inline-region]')) e.target.close();
});
if (location.hash) {
  const d = document.getElementById(location.hash.slice(1));
  if (d?.matches('dialog[data-inline-region]')) d.showModal();
}

// Region display selector: the links to the regions become ARIA tabs (or a
// select list) that show one tab's regions at a time; "Show all" shows them
// all. The choice follows #R<id> in the URL and is remembered for the session.
document.querySelectorAll('[data-rds]').forEach((nav) => {
  const tabs = [...nav.querySelectorAll('.rds-tab')];
  const panelsOf = (tab) => (tab.dataset.rdsTarget || '').split(' ').filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  const panels = tabs.flatMap(panelsOf);
  if (!panels.length) return;
  const key = `pgkiln.rds.${location.pathname}.${nav.dataset.rds}`;
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
  // (088) carousel: Previous and Next, and turning by itself every data-rds-interval seconds
  if (nav.classList.contains('rds-carousel')) {
    const step = (n) => {
      const i = tabs.findIndex((t) => t.classList.contains('is-current'));
      show(tabs[(i + n + tabs.length) % tabs.length], false);
    };
    nav.querySelectorAll('[data-rds-step]').forEach((b) => {
      b.hidden = false;
      b.addEventListener('click', () => step(Number(b.dataset.rdsStep)));
    });
    const seconds = Number(nav.dataset.rdsInterval) || 0;
    if (seconds && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const area = [nav, ...panels];
      const busy = () => area.some((el) => el.matches(':hover') || el.contains(document.activeElement));
      setInterval(() => { if (!busy() && !document.hidden) step(1); }, seconds * 1000);
    }
  }
});

// Popup list of values: the select (which works without JavaScript) is hidden
// behind a read-only field and a button that opens a dialog searching the
// item's list of values on the server, page by page (loaded as the list scrolls).
function enhancePopupLovs(root) {
  const selects = root.matches?.('select[data-popup-lov]') ? [root] : [...(root.querySelectorAll?.('select[data-popup-lov]') ?? [])];
  selects.forEach(popupLov);
}
document.addEventListener('pgkiln:replaced', (e) => e.detail && enhancePopupLovs(e.detail));
enhancePopupLovs(document);
function popupLov(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';
  const d = sel.dataset;
  const metaEl = document.getElementById('pgkiln-meta');
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
  // (124) infinite scrolling: the next page loads when the end of the list scrolls into view
  // (APEX: lazy loading); without IntersectionObserver the dialog pages with ‹ and More
  const infinite = 'IntersectionObserver' in window;
  let observer = null;
  let seq = 0;
  let loading = false;
  async function load(p) {
    page = p;
    const my = ++seq;
    const append = infinite && p > 0;
    const results = dlg.querySelector('.popup-lov-results');
    const params = new URLSearchParams({ q: dlg.querySelector('.popup-lov-search').value, p: String(p), __csrf: csrf });
    // a cascading LOV sends its parents' current values
    const wrapper = sel.closest('[data-cascade]');
    for (const parent of (wrapper?.dataset.cascade || '').split(',').filter(Boolean)) {
      const el = document.getElementsByName(parent)[0];
      if (el) params.set(parent, el.value);
    }
    let json;
    loading = true;
    try {
      const res = await fetch(d.popupLov, { method: 'POST', body: params, headers: { accept: 'application/json' }, credentials: 'same-origin' });
      json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
    } catch (e) {
      if (my !== seq) return;
      loading = false;
      const end = results.querySelector('.popup-lov-sentinel');
      if (append && end) end.textContent = e.message;
      else results.textContent = e.message;
      return;
    }
    // a newer search (or page) replaced this one
    if (my !== seq) return;
    loading = false;
    observer?.disconnect();
    results.querySelector('.popup-lov-pages, .popup-lov-sentinel')?.remove();
    let tb = append ? results.querySelector('.popup-lov-table tbody') : null;
    if (!tb) {
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
      tb = table.createTBody();
      results.append(table);
    }
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
    if (infinite) {
      if (!json.more) return;
      const end = document.createElement('p');
      end.className = 'popup-lov-sentinel muted';
      end.textContent = d.loadingLabel || 'Loading more…';
      results.append(end);
      // the implicit root: whichever box scrolls the list (the dialog's body or the results), it clips
      observer = observer || new IntersectionObserver((entries) => {
        if (entries.some((x) => x.isIntersecting) && !loading) load(page + 1);
      });
      observer.observe(end);
      return;
    }
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

// A table that scrolls sideways can be scrolled from the keyboard: the scrolling box
// gets the focus (tabindex 0) and a name (its region's heading). Only boxes that
// actually overflow, checked on load and when the window size changes.
function markScrollingTables() {
  for (const box of document.querySelectorAll('.table-wrap')) {
    const scrolls = box.scrollWidth > box.clientWidth + 1;
    if (scrolls && !box.hasAttribute('tabindex')) {
      box.setAttribute('tabindex', '0');
      box.setAttribute('role', 'region');
      const heading = box.closest('section, .region, .ide-region')?.querySelector('h2, h3');
      box.setAttribute('aria-label', heading?.textContent.trim() || 'Table');
      box.dataset.scrollMarked = '1';
    } else if (!scrolls && box.dataset.scrollMarked) {
      box.removeAttribute('tabindex');
      box.removeAttribute('role');
      box.removeAttribute('aria-label');
      delete box.dataset.scrollMarked;
    }
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markScrollingTables);
else markScrollingTables();
let scrollTablesTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(scrollTablesTimer);
  scrollTablesTimer = setTimeout(markScrollingTables, 200);
});

// Actions → Print (the print stylesheet hides navigation and toolbars).
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('[data-print]')) return;
  e.target.closest('details')?.removeAttribute('open');
  window.print();
});

// Report row selection: the header checkbox checks or clears every row on the page.
// Each change is recorded on the server (the selection item's session state), so
// rows chosen on other pages stay chosen while paging; without script only the
// current page's rows can be chosen.
function recordSelection(table, boxes, checked) {
  const region = table.dataset.selRegion;
  const base = document.body.dataset.base;
  const page = document.body.dataset.page;
  if (!region || !base || !page) return;
  let csrf = '';
  try {
    csrf = JSON.parse(document.getElementById('pgkiln-meta')?.textContent || '{}').csrf || '';
  } catch {}
  const form = new URLSearchParams({ __csrf: csrf, checked: String(checked) });
  for (const b of boxes) form.append('value', b.value);
  fetch(`${base}/${page}/report/${region}/select`, { method: 'POST', body: form, credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((out) => {
      const note = out && document.querySelector(`[data-sel-count="${CSS.escape(region)}"]`);
      if (note) note.textContent = out.text;
    })
    .catch(() => {});
}
document.addEventListener('change', (e) => {
  const all = e.target.closest?.('[data-select-all]');
  if (all) {
    const table = all.closest('table');
    const boxes = [...table.querySelectorAll(`input[type=checkbox][name="${CSS.escape(all.dataset.selectAll)}"]`)];
    for (const box of boxes) box.checked = all.checked;
    recordSelection(table, boxes, all.checked);
    return;
  }
  const box = e.target;
  if (box.type !== 'checkbox' || !box.name) return;
  const head = box.closest('table')?.querySelector(`[data-select-all="${CSS.escape(box.name)}"]`);
  if (!head) return;
  const boxes = [...box.closest('table').querySelectorAll(`input[type=checkbox][name="${CSS.escape(box.name)}"]`)];
  head.checked = boxes.every((b) => b.checked);
  head.indeterminate = !head.checked && boxes.some((b) => b.checked);
  recordSelection(box.closest('table'), [box], box.checked);
});

// SAML: post the identity provider's response on to pgkiln itself (same-site, so the
// sign-in's browser cookie comes along). The button is there for browsers without script.
document.addEventListener('DOMContentLoaded', () => {
  for (const form of document.querySelectorAll('form[data-autosubmit]')) form.submit();
});

// ------------------------------------------------------------------ Progressive Web App and field work
(() => {
  const metaEl = document.getElementById('pgkiln-meta');
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
      post({ type: 'pgkiln:user', user: body.dataset.user || 'nobody' });
      post({ type: 'pgkiln:replay' });
      window.addEventListener('online', () => post({ type: 'pgkiln:replay' }));
    }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'pgkiln:queue') showQueue(e.data.items, post);
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
      discard.addEventListener('click', () => post({ type: 'pgkiln:discard', id: i.id }));
      li.append(what, ' ', discard);
      list.append(li);
    }
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-hot';
    send.textContent = t('pwa.send_now');
    send.addEventListener('click', () => post({ type: 'pgkiln:replay' }));
    box.append(summary, list, send);
  }

  // the offline page: the pages kept on this device
  const pages = document.querySelector('[data-offline-pages]');
  if (pages && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'pgkiln:pages') return;
      for (const u of e.data.pages) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = u;
        a.textContent = new URL(u).pathname + new URL(u).search;
        li.append(a);
        pages.append(li);
      }
    });
    navigator.serviceWorker.controller.postMessage('pgkiln:pages');
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

  // (086) address items: the geocoder's addresses for the text; the one chosen replaces it, its position goes into the coordinates item
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-geocode]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.geocode);
    const list = document.getElementById(`${btn.dataset.geocode}_places`);
    if (!input || !list) return;
    const csrf = (metaEl ? JSON.parse(metaEl.textContent).csrf : '') || '';
    btn.setAttribute('aria-busy', 'true');
    let places = null;
    try {
      const res = await fetch(btn.dataset.url, { method: 'POST', body: new URLSearchParams({ q: input.value, __csrf: csrf }), headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) note(data.error || t('item.address_error'), 'error');
      else places = data.places || [];
    } catch {
      note(t('item.address_error'), 'error');
    }
    btn.removeAttribute('aria-busy');
    list.replaceChildren();
    if (!places) return;
    if (!places.length) {
      list.hidden = true;
      note(t('item.address_none'), 'error');
      return;
    }
    for (const p of places) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-button';
      b.textContent = p.label;
      b.addEventListener('click', () => {
        input.value = p.label;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const target = btn.dataset.coords && document.getElementById(btn.dataset.coords);
        if (target) {
          target.value = `${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`;
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
        list.hidden = true;
        list.replaceChildren();
        input.focus();
      });
      li.append(b);
      list.append(li);
    }
    list.hidden = false;
    list.querySelector('button').focus();
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
  // file items with data-crop: the user chooses the part of a picture to upload (to the item's aspect ratio,
  // or free), then max_px applies. Keyboard: arrow keys move the frame, Shift + arrow keys resize it.
  const CROP_RATIOS = { free: 0, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '3:2': 3 / 2, '2:3': 2 / 3 };
  async function cropPicture(file, ratio) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !window.createImageBitmap || !HTMLDialogElement.prototype.showModal) return file;
    let img;
    try {
      img = await createImageBitmap(file);
    } catch {
      return file;
    }
    const dlg = document.createElement('dialog');
    dlg.className = 'crop-dialog';
    dlg.setAttribute('aria-labelledby', 'crop-title');
    dlg.innerHTML = '<form method="dialog"><h2 id="crop-title"></h2><p class="crop-help"></p><div class="crop-stage"><canvas></canvas><div class="crop-frame" tabindex="0" role="group"><span class="crop-handle" aria-hidden="true"></span></div></div><div class="buttons"><button value="skip" class="btn"></button><button value="apply" class="btn btn-hot"></button></div></form>';
    dlg.querySelector('h2').textContent = t('crop.title');
    dlg.querySelector('.crop-help').textContent = t('crop.help');
    dlg.querySelector('[value=skip]').textContent = t('crop.skip');
    dlg.querySelector('[value=apply]').textContent = t('crop.apply');
    document.body.append(dlg);
    const stageW = Math.min(560, window.innerWidth - 64);
    const stageH = Math.min(420, window.innerHeight - 280);
    const scale = Math.min(stageW / img.width, stageH / img.height, 1);
    const W = Math.max(1, Math.round(img.width * scale));
    const H = Math.max(1, Math.round(img.height * scale));
    const canvas = dlg.querySelector('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(img, 0, 0, W, H);
    const stage = dlg.querySelector('.crop-stage');
    stage.style.width = `${W}px`;
    stage.style.height = `${H}px`;
    const frame = dlg.querySelector('.crop-frame');
    frame.setAttribute('aria-label', t('crop.title'));
    // the frame in display pixels: the largest centred box of the ratio, at 80%
    let w = W * 0.8;
    let h = H * 0.8;
    if (ratio) {
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
    }
    let x = (W - w) / 2;
    let y = (H - h) / 2;
    const clamp = () => {
      const min = 16;
      w = Math.max(min, Math.min(w, W));
      h = ratio ? w / ratio : Math.max(min, Math.min(h, H));
      if (h > H) {
        h = H;
        if (ratio) w = h * ratio;
      }
      x = Math.max(0, Math.min(x, W - w));
      y = Math.max(0, Math.min(y, H - h));
    };
    const draw = () => {
      clamp();
      frame.style.left = `${x}px`;
      frame.style.top = `${y}px`;
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
    };
    draw();
    let drag = null;
    frame.addEventListener('pointerdown', (e) => {
      drag = { mode: e.target.classList.contains('crop-handle') ? 'size' : 'move', px: e.clientX, py: e.clientY, x, y, w, h };
      frame.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.px;
      const dy = e.clientY - drag.py;
      if (drag.mode === 'move') {
        x = drag.x + dx;
        y = drag.y + dy;
      } else {
        w = drag.w + dx;
        h = ratio ? w / ratio : drag.h + dy;
      }
      draw();
    });
    frame.addEventListener('pointerup', () => (drag = null));
    frame.addEventListener('keydown', (e) => {
      const step = e.altKey ? 1 : 8;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      if (e.shiftKey) {
        w += d[0] || -d[1];
        if (!ratio) h += d[1] || 0;
      } else {
        x += d[0];
        y += d[1];
      }
      draw();
    });
    dlg.showModal();
    frame.focus();
    const choice = await new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
    dlg.remove();
    if (choice !== 'apply') return file;
    const sx = x / scale;
    const sy = y / scale;
    const sw = Math.max(1, Math.round(w / scale));
    const sh = Math.max(1, Math.round(h / scale));
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    out.getContext('2d').drawImage(img, sx, sy, w / scale, h / scale, 0, 0, sw, sh);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((r) => out.toBlob(r, type, 0.9));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + (type === 'image/png' ? '.png' : '.jpg'), { type });
  }
  document.addEventListener('change', async (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.dataset.crop || !input.files || !input.files[0]) return;
    if (!window.DataTransfer || !Object.prototype.hasOwnProperty.call(CROP_RATIOS, input.dataset.crop)) return;
    const original = input.files[0];
    let file = await cropPicture(original, CROP_RATIOS[input.dataset.crop]);
    if (input.dataset.maxPx) file = await smaller(file, Number(input.dataset.maxPx));
    if (file === original) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new CustomEvent('pgkiln:cropped', { bubbles: true }));
  });
  document.addEventListener('change', async (e) => {
    const input = e.target;
    // (inputs with data-crop make their pictures smaller after the crop, above)
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.dataset.maxPx || input.dataset.crop || !input.files || !input.files[0]) return;
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
    document.addEventListener('pgkiln:replaced', (e) => e.detail && dropZones(e.detail.parentElement || document));
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
    // pgkiln sends Referrer-Policy: same-origin, but OpenStreetMap blocks browser tile requests
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
    // one Leaflet layer per query: markers (clustered or not) with their lines and areas, or a heat map
    const several = data.layers.length > 1;
    // (0.31) a layer with an area URL loads the places in the visible area; one with a tiles URL is vector tiles
    const note = zoomNote(map, data.zoomIn);
    const built = data.layers.map((l, i) => {
      const parts = l.tiles ? [vectorTiles(l, popup, several, note.set(i))] : l.area ? [areaLayer(l, popup, data, several, note.set(i))] : layerParts(l, popup, data, several);
      return { def: l, layer: window.L.featureGroup(parts) };
    });
    const group = window.L.featureGroup(built.map((b) => b.layer)).addTo(map);
    const bounds = group.getBounds();
    for (const b of built) if (b.def.hidden) group.removeLayer(b.layer);
    const f = data.filter;
    const allPoints = data.layers.flatMap((l) => l.points);
    const allShapes = data.layers.flatMap((l) => l.shapes);
    if (f && f.area) map.fitBounds([[f.area.s, f.area.w], [f.area.n, f.area.e]]);
    else if (f && f.near) {
      // the bounds from the centre (the circle can only measure itself once the map has a view)
      map.fitBounds(window.L.latLng(f.near.lat, f.near.lng).toBounds(f.near.km * 2000));
      window.L.circle([f.near.lat, f.near.lng], { radius: f.near.km * 1000, className: 'map-near', interactive: false }).addTo(map);
    } else if (allPoints.length === 1 && !allShapes.length) map.setView([allPoints[0].lat, allPoints[0].lng], data.zoom || 14);
    else if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: data.zoom || 16 });
    else map.setView([20, 0], 2);
    if (data.layers.some((l) => l.kind === 'heat')) heatLegend(map, data.legend);
    if (several) layerSwitch(map, group, built, data.layersLabel);
    if (f) areaFilter(map, f);
  }
});

// One layer's Leaflet parts: markers (clustered or not) or a heat map, with its lines and areas.
function layerParts(l, popup, data, several) {
  const parts = [];
  if (l.kind === 'heat') parts.push(heatLayer(l.points));
  else if (l.cluster) parts.push(clusterLayer(l, popup, data.clusterLabel, several));
  else for (const p of l.points) parts.push(placeMarker(p, l, popup, several));
  if (l.shapes.length)
    parts.push(window.L.geoJSON({ type: 'FeatureCollection', features: l.shapes }, {
      style: () => (several ? { className: `map-c${l.color}` } : {}),
      onEachFeature: (f, layer) => layer.bindPopup(() => popup(f.properties)),
    }));
  return parts;
}

// The visible area as "south,west,north,east" (west/east wrapped to -180..180, so west > east across the
// antimeridian; the whole world when zoomed far out), as the server's area filters read it.
function visibleBox(map) {
  const r = (v) => Math.round(v * 1e5) / 1e5;
  const b = map.getBounds();
  const wrap = (v) => r(((((v + 180) % 360) + 360) % 360) - 180);
  const wide = b.getEast() - b.getWest() >= 360;
  return [r(Math.max(-90, b.getSouth())), wide ? -180 : wrap(b.getWest()), r(Math.min(90, b.getNorth())), wide ? 180 : wrap(b.getEast())].join(',');
}

// "Not every place is shown: zoom in": shown while a visible-area layer or a vector tile hit its row limit.
function zoomNote(map, text) {
  const box = window.L.DomUtil.create('div', 'map-note');
  box.setAttribute('role', 'status');
  box.hidden = true;
  const Note = window.L.Control.extend({ onAdd: () => box });
  new Note({ position: 'topright' }).addTo(map);
  const cut = new Map();
  return {
    // set(layer)(truncated)
    set: (i) => (truncated) => {
      cut.set(i, truncated);
      const any = [...cut.values()].some(Boolean);
      box.textContent = any ? text : '';
      box.hidden = !any;
    },
  };
}

// (0.31) A layer loaded for the visible area: again after every move (a quarter second after it stops),
// with the same markers, clusters, heat map and shapes as a layer that comes with the page.
function areaLayer(l, popup, data, several, truncated) {
  const Area = window.L.FeatureGroup.extend({
    onAdd(map) {
      window.L.FeatureGroup.prototype.onAdd.call(this, map);
      this._map = map;
      map.on('moveend', this._later, this);
      map.whenReady(this._later, this);
    },
    onRemove(map) {
      map.off('moveend', this._later, this);
      clearTimeout(this._timer);
      this._abort?.abort();
      truncated(false);
      window.L.FeatureGroup.prototype.onRemove.call(this, map);
    },
    // the map's first view doesn't wait for these places
    getBounds: () => window.L.latLngBounds([]),
    _later() {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._load(), 250);
    },
    async _load() {
      const map = this._map;
      if (!map) return;
      this._abort?.abort();
      const abort = (this._abort = new AbortController());
      try {
        const res = await fetch(`${l.area}?bb=${encodeURIComponent(visibleBox(map))}`, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: abort.signal });
        const got = await res.json();
        if (!res.ok || abort.signal.aborted || this._map !== map) return;
        this.clearLayers();
        for (const part of layerParts({ ...l, points: got.points || [], shapes: got.shapes || [] }, popup, data, several)) this.addLayer(part);
        truncated(!!got.truncated);
      } catch {
        // aborted by a newer move, or offline: the last places stay
      }
    },
  });
  return new Area();
}

// (0.31) A layer served as Mapbox Vector Tiles: each tile is fetched, decoded and drawn on a canvas;
// a click finds the place, line or area under the pointer in the tile's features and opens its popup.
function vectorTiles(l, popup, several, truncated) {
  const cut = new Set();
  const colour = (() => {
    const probe = document.createElement('span');
    probe.className = `map-c${several ? l.color : 1}`;
    probe.hidden = true;
    document.body.append(probe);
    const c = getComputedStyle(probe).getPropertyValue('--mc').trim() || '#2a78d6';
    probe.remove();
    return c;
  })();
  const Tiles = window.L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      const size = this.getTileSize();
      tile.width = size.x * ratio;
      tile.height = size.y * ratio;
      const key = `${coords.x}:${coords.y}:${coords.z}`;
      fetch(l.tiles.replace('{z}', coords.z).replace('{x}', coords.x).replace('{y}', coords.y), { credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          if (res.headers.get('x-pgkiln-truncated')) cut.add(key);
          else cut.delete(key);
          truncated(cut.size > 0);
          const layer = readVectorTile(await res.arrayBuffer())[0];
          tile.pgkilnLayer = layer;
          if (layer) drawVectorTile(tile, layer, colour, l.kind === 'heat');
          done(null, tile);
        })
        .catch((e) => done(e, tile));
      return tile;
    },
    onAdd(map) {
      // above the base map, below markers and popups; clicks go through to the map (see _click)
      if (!map.getPane('pgkilnTiles')) {
        const pane = map.createPane('pgkilnTiles');
        pane.style.zIndex = '350';
        pane.style.pointerEvents = 'none';
      }
      window.L.GridLayer.prototype.onAdd.call(this, map);
      map.on('click', this._click, this);
    },
    onRemove(map) {
      map.off('click', this._click, this);
      cut.clear();
      truncated(false);
      window.L.GridLayer.prototype.onRemove.call(this, map);
    },
    getBounds: () => window.L.latLngBounds([]),
    _click(e) {
      const map = this._map;
      const z = this._tileZoom;
      const size = this.getTileSize();
      const at = map.project(e.latlng, z);
      const tx = Math.floor(at.x / size.x);
      const ty = Math.floor(at.y / size.y);
      const layer = this._tiles[`${tx}:${ty}:${z}`]?.el.pgkilnLayer;
      if (!layer) return;
      const scale = layer.extent / size.x;
      const hit = hitVectorTile(layer, (at.x - tx * size.x) * scale, (at.y - ty * size.y) * scale, 8 * scale);
      if (hit) window.L.popup().setLatLng(e.latlng).setContent(popup(hit)).openOn(map);
    },
  });
  return new Tiles({ maxZoom: 22, pane: 'pgkilnTiles' });
}

// A Mapbox Vector Tile (protocol buffers) → its layers: { name, extent, features: [{ type, paths, props }] }.
function readVectorTile(buffer) {
  const b = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let pos = 0;
  const varint = () => {
    let r = 0;
    let m = 1;
    let c;
    do {
      c = b[pos++];
      r += (c & 127) * m;
      m *= 128;
    } while (c & 128);
    return r;
  };
  const skip = (wire) => {
    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 2) pos += varint();
    else if (wire === 5) pos += 4;
    else throw new Error('wire type');
  };
  // read the fields of a message up to end: read(field, wire) returns false for a field it skips
  const message = (end, read) => {
    while (pos < end) {
      const k = varint();
      if (!read(k >> 3, k & 7)) skip(k & 7);
    }
  };
  const text = () => {
    const n = varint();
    return new TextDecoder().decode(b.subarray(pos, (pos += n)));
  };
  const packed = () => {
    const end = varint() + pos;
    const out = [];
    while (pos < end) out.push(varint());
    return out;
  };
  const value = () => {
    const end = varint() + pos;
    let v = null;
    message(end, (f, w) => {
      if (f === 1 && w === 2) v = text();
      else if (f === 2 && w === 5) (v = view.getFloat32(pos, true)), (pos += 4);
      else if (f === 3 && w === 1) (v = view.getFloat64(pos, true)), (pos += 8);
      else if ((f === 4 || f === 5) && w === 0) v = varint();
      else if (f === 6 && w === 0) {
        const n = varint();
        v = n % 2 ? -(n + 1) / 2 : n / 2;
      } else if (f === 7 && w === 0) v = varint() === 1;
      else return false;
      return true;
    });
    return v;
  };
  const layers = [];
  message(b.length, (f, w) => {
    if (f !== 3 || w !== 2) return false;
    const end = varint() + pos;
    const layer = { name: '', extent: 4096, keys: [], values: [], raw: [] };
    message(end, (f, w) => {
      if (f === 1 && w === 2) layer.name = text();
      else if (f === 3 && w === 2) layer.keys.push(text());
      else if (f === 4 && w === 2) layer.values.push(value());
      else if (f === 5 && w === 0) layer.extent = varint();
      else if (f === 2 && w === 2) {
        const fend = varint() + pos;
        const feature = { type: 0, tags: [], geometry: [] };
        message(fend, (f, w) => {
          if (f === 2 && w === 2) feature.tags = packed();
          else if (f === 3 && w === 0) feature.type = varint();
          else if (f === 4 && w === 2) feature.geometry = packed();
          else return false;
          return true;
        });
        layer.raw.push(feature);
      } else return false;
      return true;
    });
    layer.features = layer.raw.map((ft) => {
      const props = {};
      for (let i = 0; i + 1 < ft.tags.length; i += 2) props[layer.keys[ft.tags[i]]] = layer.values[ft.tags[i + 1]];
      return { type: ft.type, paths: tilePaths(ft.geometry), props };
    });
    layers.push(layer);
    return true;
  });
  return layers;
}

// Geometry commands → paths of [x, y] in tile coordinates (MoveTo starts a path; ClosePath ends a ring).
function tilePaths(cmds) {
  const paths = [];
  let x = 0;
  let y = 0;
  let path = null;
  for (let i = 0; i < cmds.length; ) {
    const id = cmds[i] & 7;
    const n = cmds[i++] >> 3;
    if (id === 7) continue;
    for (let k = 0; k < n; k++) {
      const dx = cmds[i++];
      const dy = cmds[i++];
      x += (dx >>> 1) ^ -(dx & 1);
      y += (dy >>> 1) ^ -(dy & 1);
      if (id === 1) paths.push((path = [[x, y]]));
      else path.push([x, y]);
    }
  }
  return paths;
}

function drawVectorTile(canvas, layer, colour, heat) {
  const c = canvas.getContext('2d');
  const s = canvas.width / layer.extent;
  const ratio = canvas.width / 256;
  c.lineJoin = 'round';
  for (const f of layer.features) {
    if (f.type === 1) continue;
    c.beginPath();
    for (const path of f.paths) path.forEach(([x, y], i) => (i ? c.lineTo(x * s, y * s) : c.moveTo(x * s, y * s)));
    c.strokeStyle = colour;
    c.lineWidth = 2.5 * ratio;
    if (f.type === 3) {
      c.closePath();
      c.globalAlpha = 0.2;
      c.fillStyle = colour;
      c.fill('evenodd');
      c.globalAlpha = 1;
    }
    c.stroke();
  }
  // places on top: dots in the layer's colour (a heat layer: soft, translucent spots)
  for (const f of layer.features) {
    if (f.type !== 1) continue;
    for (const [[x, y]] of f.paths.map((p) => [p[0]])) {
      c.beginPath();
      c.arc(x * s, y * s, (heat ? 9 : 5.5) * ratio, 0, Math.PI * 2);
      c.fillStyle = colour;
      c.globalAlpha = heat ? 0.25 : 0.9;
      c.fill();
      c.globalAlpha = 1;
      if (!heat) {
        c.strokeStyle = '#fff';
        c.lineWidth = 1.5 * ratio;
        c.stroke();
      }
    }
  }
}

// The feature under a tile position: a place within tolerance first, then a line within it, then an area around it.
function hitVectorTile(layer, x, y, tol) {
  const near = (a, b) => {
    // distance from the point to segment a-b
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = dx || dy ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  const inside = (paths) => {
    let odd = false;
    for (const p of paths)
      for (let i = 0, j = p.length - 1; i < p.length; j = i++)
        if (p[i][1] > y !== p[j][1] > y && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) odd = !odd;
    return odd;
  };
  const fs = layer.features;
  return (
    fs.find((f) => f.type === 1 && f.paths.some((p) => Math.hypot(p[0][0] - x, p[0][1] - y) <= tol))?.props ||
    fs.find((f) => f.type === 2 && f.paths.some((p) => p.some((pt, i) => i && near(p[i - 1], pt) <= tol)))?.props ||
    fs.find((f) => f.type === 3 && inside(f.paths))?.props ||
    null
  );
}

// A place on a map with several layers is a dot in its layer's colour (map-c1…); a lone layer keeps Leaflet's pins.
function placeMarker(p, l, popup, several) {
  const m = several
    ? window.L.circleMarker([p.lat, p.lng], { radius: 7, weight: 2, fillOpacity: 0.85, className: `map-dot map-c${l.color}` })
    : window.L.marker([p.lat, p.lng], { title: p.title || '' });
  if (several && p.title) m.bindTooltip(p.title);
  return m.bindPopup(() => popup(p));
}

// Marker clustering: places closer than CELL pixels at the current zoom level are one round marker with
// their count; clicking it zooms to them. Recomputed after zooming; at the highest zoom levels every
// place is shown by itself.
const CELL = 56;
function clusterLayer(l, popup, label, several) {
  const markers = l.points.map((p) => placeMarker(p, l, popup, several));
  const Cluster = window.L.FeatureGroup.extend({
    onAdd(map) {
      this._map = map;
      map.on('zoomend', this._redraw, this);
      this._redraw();
    },
    onRemove(map) {
      map.off('zoomend', this._redraw, this);
      this.clearLayers();
    },
    getBounds() {
      return window.L.latLngBounds(l.points.map((p) => [p.lat, p.lng]));
    },
    _redraw() {
      const map = this._map;
      this.clearLayers();
      const zoom = map.getZoom();
      if (zoom >= map.getMaxZoom() - 1) {
        for (const m of markers) this.addLayer(m);
        return;
      }
      const cells = new Map();
      l.points.forEach((p, i) => {
        const at = map.project([p.lat, p.lng], zoom);
        const k = `${Math.floor(at.x / CELL)}:${Math.floor(at.y / CELL)}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      });
      for (const members of cells.values()) {
        if (members.length === 1) {
          this.addLayer(markers[members[0]]);
          continue;
        }
        const pts = members.map((i) => l.points[i]);
        const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
        const lng = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
        const count = document.createElement('span');
        count.textContent = String(pts.length);
        const size = pts.length < 10 ? 32 : pts.length < 100 ? 38 : 44;
        const title = label.replace('{n}', String(pts.length));
        const m = window.L.marker([lat, lng], {
          title,
          alt: title,
          icon: window.L.divIcon({ html: count, className: `map-cluster map-c${l.color}`, iconSize: [size, size] }),
        });
        m.on('click', () => {
          const b = window.L.latLngBounds(pts.map((p) => [p.lat, p.lng]));
          // all in one spot: zoom in as far as the cluster goes apart (the highest levels show every place)
          if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), map.getMaxZoom());
          else map.fitBounds(b, { padding: [32, 32] });
        });
        this.addLayer(m);
      }
    },
  });
  return new Cluster();
}

// The legend of a map with several layers: a check box per layer (with its colour) switches it on and off.
function layerSwitch(map, group, built, label) {
  const Control = window.L.Control.extend({
    onAdd() {
      const box = window.L.DomUtil.create('fieldset', 'map-layers');
      window.L.DomEvent.disableClickPropagation(box);
      window.L.DomEvent.disableScrollPropagation(box);
      const legend = document.createElement('legend');
      legend.textContent = label;
      box.append(legend);
      for (const b of built) {
        const row = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !b.def.hidden;
        cb.addEventListener('change', () => (cb.checked ? group.addLayer(b.layer) : group.removeLayer(b.layer)));
        const swatch = document.createElement('span');
        swatch.className = `map-swatch ${b.def.kind === 'heat' ? 'map-swatch-heat' : `map-c${b.def.color}`}`;
        swatch.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.textContent = b.def.name;
        row.append(cb, swatch, name);
        box.append(row);
      }
      return box;
    },
  });
  new Control({ position: 'bottomright' }).addTo(map);
}

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
      // distance mode: the places within the distance from the centre to the nearest edge of the map
      const radius = () => {
        const c = map.getCenter();
        const b = map.getBounds();
        const km = Math.min(map.distance(c, [b.getNorth(), c.lng]), map.distance(c, [c.lat, b.getEast()])) / 1000;
        // two significant digits: 1.2, 35, 480 km
        const p = Math.pow(10, Math.floor(Math.log10(Math.max(km, 0.001))) - 1);
        return Math.min(20000, Math.max(0.1, Math.round(km / p) * p));
      };
      const kmText = (km) => new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 1 }).format(km);
      if (f.mode === 'distance') go.textContent = f.label.replace('{km}', kmText(radius()));
      go.addEventListener('click', (e) => {
        e.preventDefault();
        const r = (v) => Math.round(v * 1e5) / 1e5;
        if (f.mode === 'distance') {
          const c = map.getCenter().wrap();
          const near = [r(c.lat), r(c.lng), Math.round(radius() * 1000) / 1000].join(',');
          location.href = f.url.replace('__NEAR__', encodeURIComponent(near));
          return;
        }
        location.href = f.url.replace('__BB__', encodeURIComponent(visibleBox(map)));
      });
      box.append(go);
      if (f.area || f.near) {
        const all = document.createElement('a');
        all.className = 'btn map-filter-clear';
        all.textContent = f.clearLabel;
        all.href = f.clear;
        box.append(all);
      }
      // shown once the user moved the map (not after the first fit)
      map.whenReady(() =>
        setTimeout(() =>
          map.on('moveend', () => {
            if (f.mode === 'distance') go.textContent = f.label.replace('{km}', kmText(radius()));
            go.hidden = false;
          }),
        0));
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
    // (077) a hidden input's value is its default too: the value to compare with for "unsaved changes"
    hidden.dataset.initial = input.value;
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

  function enhance(root) {
    root.querySelectorAll('[data-richtext]').forEach(richText);
    root.querySelectorAll('[data-markdown]').forEach(markdown);
    root.querySelectorAll('[data-tags]').forEach(tags);
    root.querySelectorAll('[data-reveal]').forEach((b) => (b.hidden = false));
  }
  enhance(document);
  document.addEventListener('pgkiln:replaced', (e) => e.detail && enhance(e.detail.parentElement || document));

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

// ------------------------------------------------------------ AI assistant and report questions (assistant.ts, ai-filter.ts)
// The newest message in view; while an AI request runs, its button says so and can't be pressed twice.
(() => {
  document.querySelectorAll('.assistant-log').forEach((log) => {
    if (log.lastElementChild && log.children.length > 1) log.lastElementChild.scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (e.defaultPrevented) return;
    const busy = e.submitter ? [e.submitter].filter((b) => b.dataset.busy) : f.id ? [...document.querySelectorAll(`button[form="${CSS.escape(f.id)}"][data-busy]`)] : [];
    for (const btn of busy) {
      btn.textContent = btn.dataset.busy;
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('is-busy');
      btn.addEventListener('click', (x) => x.preventDefault());
    }
  });
  // Ctrl+Enter (or ⌘+Enter) sends the message
  document.addEventListener('keydown', (e) => {
    const box = e.target;
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !box.matches || !box.matches('.assistant-input textarea')) return;
    const f = box.form;
    if (f) {
      e.preventDefault();
      f.requestSubmit();
    }
  });
})();

// Search region (migration 080): search as the user types. The field is a GET form that works
// without JavaScript; here a pause in typing fetches the region (GET …/region/<id>) and swaps in
// its results only, so the field keeps its focus and cursor. Answers that arrive late are dropped.
(() => {
  const base = document.body.dataset.base;
  const page = document.body.dataset.page;
  if (!base || !page) return;
  const timers = new WeakMap();
  const latest = new WeakMap();
  async function search(field) {
    const id = field.dataset.searchRegion;
    if (!/^\d+$/.test(id || '') || !field.form) return;
    // (the form keeps the page's own parameters, dialog=1 among them)
    const params = new URLSearchParams(new FormData(field.form));
    const n = (latest.get(field) || 0) + 1;
    latest.set(field, n);
    try {
      const res = await fetch(`${base}/${page}/region/${id}?${params}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok || latest.get(field) !== n) return;
      const json = await res.json();
      const fresh = new DOMParser().parseFromString(json.html || '', 'text/html').getElementById(`R${id}_results`);
      const results = document.getElementById(`R${id}_results`);
      if (!fresh || !results) return;
      results.replaceChildren(...[...fresh.childNodes].map((node) => document.importNode(node, true)));
      history.replaceState(history.state, '', `${location.pathname}?${params}${location.hash}`);
    } catch {
      // offline or the session ended: Enter still submits the form
    }
  }
  document.addEventListener('input', (e) => {
    const field = e.target.closest?.('input[data-search-region]');
    if (!field) return;
    clearTimeout(timers.get(field));
    timers.set(field, setTimeout(() => search(field), 250));
  });
})();

// Session timeout warning (migration 085; APEX: Session timeout warning). The page knows when its
// session ends: after the idle time since the page was loaded (or since "Stay signed in"), and at
// the session's maximum length. A dialog warns `warn` seconds before; "Stay signed in" marks the
// session active on the server. At the maximum length the user can only save their work.
(() => {
  const metaEl = document.getElementById('pgkiln-meta');
  if (!metaEl) return;
  const meta = JSON.parse(metaEl.textContent);
  const s = meta.session;
  if (!s || !s.idle || !s.warn) return;
  const t = (k) => (meta.texts && meta.texts[k]) || k;
  let last = Date.now();
  let timer;
  let dlg;
  let shown = '';
  let dismissed = false;
  const end = () => Math.min(last + s.idle * 1000, s.maxEnd || Infinity);
  const atMax = () => s.maxEnd && end() === s.maxEnd;
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(check, Math.max(500, Math.min(ms, 2 ** 31 - 1)));
  }
  function check() {
    const left = end() - Date.now();
    if (left <= 0) return show('ended');
    if (left > s.warn * 1000) return schedule(left - s.warn * 1000);
    // the idle warning counts down until it is dismissed; the maximum length is said once
    if (atMax() ? shown !== 'max' : !dismissed) show(atMax() ? 'max' : 'idle', left);
    schedule(Math.min(left, 30000));
  }
  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function show(kind, left) {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'session-dialog';
      dlg.setAttribute('aria-labelledby', 'session-dialog-text');
      dlg.innerHTML = '<p id="session-dialog-text"></p><div class="buttons"></div>';
      document.body.appendChild(dlg);
      // Escape dismisses the warning like the button
      dlg.addEventListener('cancel', () => (dismissed = true));
    }
    if (kind === 'max' && shown === 'max' && dlg.open) return;
    shown = kind;
    const p = dlg.querySelector('p');
    const buttons = dlg.querySelector('.buttons');
    buttons.replaceChildren();
    if (kind === 'ended') {
      clearTimeout(timer);
      p.textContent = t('session.ended');
      buttons.append(button(t('login.sign_in_link'), 'btn-hot', () => (location.href = `${document.body.dataset.base}/login?next=${encodeURIComponent(location.pathname + location.search)}`)));
    } else if (kind === 'max') {
      p.textContent = t('session.max').replace('{time}', new Date(s.maxEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      buttons.append(button('OK', 'btn-hot', () => dlg.close()));
    } else {
      p.textContent = t('session.warning').replace('{minutes}', String(Math.max(1, Math.ceil(left / 60000))));
      buttons.append(button(t('session.stay'), 'btn-hot', stay), button(t('common.dismiss'), '', () => ((dismissed = true), dlg.close())));
    }
    if (!dlg.open) dlg.showModal();
  }
  async function stay() {
    try {
      const res = await fetch(s.extend, { method: 'POST', body: new URLSearchParams({ __csrf: meta.csrf }), headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) return show('ended');
      last = Date.now();
      shown = '';
      dismissed = false;
      dlg.close();
      check();
    } catch {
      // offline: try again with the next click
    }
  }
  check();
})();

// (sprint 72) Install app (PWA): the header's button appears when the browser offers the installation.
(() => {
  const button = document.querySelector('[data-pwa-install]');
  if (!button) return;
  let offer = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    offer = e;
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!offer) return;
    offer.prompt();
    await offer.userChoice.catch(() => null);
    offer = null;
    button.hidden = true;
  });
  window.addEventListener('appinstalled', () => { button.hidden = true; });
})();

// (sprint 72) The developer toolbar: docked where the developer chose (bottom, top, left, right;
// kept in this browser), shrunk to a slim tab after a few seconds without use (unless turned off),
// back when pointed at or focused. Its panels close when another opens or on Escape.
(() => {
  const bar = document.querySelector('.devbar');
  if (!bar) return;
  const KEY = 'pgkiln.devbar';
  let prefs = { dock: 'bottom', autohide: true, compact: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
  if (!['bottom', 'top', 'left', 'right'].includes(prefs.dock)) prefs.dock = 'bottom';
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };
  const settings = bar.querySelector('.devbar-settings');
  settings?.closest('li')?.removeAttribute('hidden');
  const apply = () => {
    bar.dataset.dock = prefs.dock;
    // (sprint 79) "Icons only": the tools without their texts
    bar.toggleAttribute('data-compact', !!prefs.compact);
    const compact = bar.querySelector('input[name="devbar-compact"]');
    if (compact) compact.checked = !!prefs.compact;
    bar.querySelectorAll('input[name="devbar-dock"]').forEach((r) => { r.checked = r.value === prefs.dock; });
    const auto = bar.querySelector('input[name="devbar-autohide"]');
    if (auto) auto.checked = !!prefs.autohide;
  };
  apply();
  bar.addEventListener('change', (e) => {
    if (e.target.name === 'devbar-dock') prefs.dock = e.target.value;
    else if (e.target.name === 'devbar-autohide') prefs.autohide = e.target.checked;
    else if (e.target.name === 'devbar-compact') prefs.compact = e.target.checked;
    else return;
    save();
    apply();
  });
  const menus = [...bar.querySelectorAll('details.devbar-menu')];
  menus.forEach((m) => m.addEventListener('toggle', () => { if (m.open) menus.forEach((o) => { if (o !== m) o.open = false; }); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menus.some((m) => m.open)) {
      const open = menus.find((m) => m.open);
      open.open = false;
      open.querySelector('summary')?.focus();
    }
  });
  document.addEventListener('click', (e) => { if (!bar.contains(e.target)) menus.forEach((m) => { m.open = false; }); });
  let timer = 0;
  const busy = () => bar.matches(':hover') || bar.contains(document.activeElement) || menus.some((m) => m.open) || !!bar.querySelector('[aria-pressed="true"]');
  const later = () => {
    clearTimeout(timer);
    if (prefs.autohide) timer = setTimeout(() => { if (!busy()) bar.classList.add('is-idle'); else later(); }, 3000);
  };
  const wake = () => { bar.classList.remove('is-idle'); later(); };
  bar.addEventListener('pointerenter', wake);
  bar.addEventListener('focusin', wake);
  bar.addEventListener('pointerleave', later);
  bar.addEventListener('change', wake);
  later();
})();

// (sprint 59) Quick edit from the developer toolbar (APEX: Quick Edit): while it is on, pointing at a
// region, item or button outlines it and a click opens it in the Page Designer (in the builder's tab);
// Esc or the button again turns it off. The toolbar is only there for developers of the application.
(() => {
  const toggle = document.querySelector('[data-quick-edit]');
  if (!toggle) return;
  toggle.hidden = false;
  const base = toggle.dataset.quickEdit;
  const pick = (el) => el?.closest?.('[data-item], [data-button], .region[id^="R"]');
  let on = false;
  let marked = null;
  const mark = (el) => {
    marked?.classList.remove('qe-target');
    marked = el;
    el?.classList.add('qe-target');
  };
  const set = (v) => {
    on = v;
    toggle.setAttribute('aria-pressed', String(v));
    document.body.classList.toggle('quick-edit', v);
    if (!v) mark(null);
  };
  const urlOf = (el) => {
    if (el.dataset.item) return `${base}/quick?item=${encodeURIComponent(el.dataset.item)}`;
    if (el.dataset.button) return `${base}/quick?button=${encodeURIComponent(el.dataset.button)}`;
    return `${base}?c=region-${el.id.slice(1)}`;
  };
  toggle.addEventListener('click', () => set(!on));
  document.addEventListener('pointerover', (e) => { if (on && !e.target.closest('.devbar')) mark(pick(e.target)); });
  document.addEventListener('click', (e) => {
    if (!on || e.target.closest('.devbar')) return;
    const el = pick(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(urlOf(el), 'pgkiln-builder');
  }, true);
  document.addEventListener('keydown', (e) => { if (on && e.key === 'Escape') set(false); });
})();

// (sprint 76) the page's texts for the report menus below (render.ts CLIENT_TEXTS)
const reportTexts = (() => {
  try {
    return JSON.parse(document.getElementById('pgkiln-meta')?.textContent || '{}').texts || {};
  } catch {
    return {};
  }
})();

// (sprint 76) The interactive report's Actions menu: an entry opens its form in a dialog (APEX: the
// Actions dialogs); the form fields stay the same elements, moved into the dialog and back on close.
(() => {
  const close = (details) => { if (details) details.open = false; };
  document.addEventListener('toggle', (e) => {
    const item = e.target;
    if (!(item instanceof HTMLDetailsElement) || !item.matches('.ir-item[data-ir-dialog]') || !item.open) return;
    const body = item.querySelector(':scope > .ir-body');
    const menu = item.closest('details.actions-menu');
    if (!body || typeof HTMLDialogElement !== 'function') return;
    item.open = false;
    menu?.querySelectorAll('details.ir-sub[open]').forEach(close);
    close(menu);
    const dialog = document.createElement('dialog');
    dialog.className = 'ir-dialog';
    const title = document.createElement('h2');
    title.textContent = item.querySelector('summary span')?.textContent ?? '';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'icon-button ir-dialog-close';
    x.setAttribute('aria-label', reportTexts['common.dismiss'] || 'Close');
    x.textContent = '×';
    x.addEventListener('click', () => dialog.close());
    const head = document.createElement('div');
    head.className = 'ir-dialog-head';
    head.append(title, x);
    dialog.append(head, body);
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      item.append(body);
      dialog.remove();
      menu?.querySelector('summary')?.focus();
    });
    dialog.showModal();
    body.querySelector('select, input, a, button')?.focus();
  }, true);
  // one submenu open at a time
  document.addEventListener('toggle', (e) => {
    const sub = e.target;
    if (!(sub instanceof HTMLDetailsElement) || !sub.matches('.ir-sub') || !sub.open) return;
    sub.parentElement?.parentElement?.querySelectorAll(':scope > li > details.ir-sub[open]').forEach((d) => { if (d !== sub) d.open = false; });
  }, true);
})();

// (sprint 76) A report column heading opens a menu: sort ascending or descending, hide, control break, and
// the column's values (with counts, a search box) to filter by; the sort arrow still sorts at once.
(() => {
  let open = null;
  const shut = () => { open?.remove(); open = null; };
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('th[data-col] > a');
    if (!a) {
      if (open && !open.contains(e.target)) shut();
      return;
    }
    const th = a.parentElement;
    // the sort indicator keeps sorting
    if (e.target.closest('.sort-ind') && th.getAttribute('aria-sort') !== 'none') return;
    e.preventDefault();
    shut();
    const menu = document.createElement('div');
    menu.className = 'th-menu menu-panel';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', th.dataset.label);
    const t = (k, d) => reportTexts[k] || d;
    const link = (href, text) => { const l = document.createElement('a'); l.href = href; l.textContent = text; return l; };
    const actions = document.createElement('div');
    actions.className = 'th-menu-actions';
    actions.append(link(th.dataset.asc, `▲ ${t('report.sort_asc', 'Sort ascending')}`), link(th.dataset.desc, `▼ ${t('report.sort_desc', 'Sort descending')}`),
      link(th.dataset.hide, t('report.hide', 'Hide column')), link(th.dataset.break, t('report.break', 'Control break')));
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = t('report.filter_values', 'Filter the values');
    search.setAttribute('aria-label', search.placeholder);
    const list = document.createElement('ul');
    list.className = 'th-menu-values';
    menu.append(actions, search, list);
    document.body.append(menu);
    const box = th.getBoundingClientRect();
    menu.style.setProperty('position', 'absolute');
    menu.style.setProperty('top', `${window.scrollY + box.bottom + 4}px`);
    menu.style.setProperty('left', `${Math.max(8, Math.min(window.scrollX + box.left, window.scrollX + document.documentElement.clientWidth - 288))}px`);
    open = menu;
    const here = new URL(location.href);
    const url = new URL(th.dataset.values, location.href);
    here.searchParams.forEach((v, k) => url.searchParams.append(k, v));
    url.searchParams.set('col', th.dataset.col);
    fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { values: [] }))
      .then(({ values }) => {
        if (!values?.length) {
          const li = document.createElement('li');
          li.className = 'muted';
          li.textContent = t('report.no_values', 'No values');
          list.append(li);
          return;
        }
        for (const { value, count } of values) {
          if (value === null) continue;
          const target = new URL(location.href);
          for (const k of [...target.searchParams.keys()]) if (/^r\d+_(p|k)$/.test(k)) target.searchParams.delete(k);
          target.searchParams.append(th.dataset.filter, `${th.dataset.col}|eq|${value}`);
          const li = document.createElement('li');
          const l = link(target.toString(), value);
          const n = document.createElement('span');
          n.className = 'muted';
          n.textContent = String(count);
          l.append(n);
          li.append(l);
          list.append(li);
        }
      })
      .catch(() => {});
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('li').forEach((li) => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); });
    });
    actions.querySelector('a')?.focus();
    menu.addEventListener('keydown', (k) => { if (k.key === 'Escape') { shut(); a.focus(); } });
  });
  window.addEventListener('resize', shut);
})();

// (sprint 76) the report pager's rows per page: sent on change
document.addEventListener('change', (e) => {
  if (e.target.matches?.('select[data-go]')) e.target.form?.submit();
});

// (sprint 76, 84; APEX: the date picker) A date field in a date mask (items.ts dateField): its calendar button
// opens pgkiln's date picker, a month of days under the field; the chosen date is written into the text field
// in the mask. Keys: arrows (a day, a week), Page Up/Down (a month; with Shift a year), Home/End (the week),
// Enter or Space (choose), Escape (close).
(() => {
  const meta = (() => { try { return JSON.parse(document.getElementById('pgkiln-meta')?.textContent || '{}'); } catch { return {}; } })();
  const t = (k, d) => (meta.texts && meta.texts[k]) || d;
  const lang = document.documentElement.lang || 'en';
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const dateOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (iso, n) => { const d = dateOf(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
  const addMonths = (iso, n) => {
    const d = dateOf(iso);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return isoOf(d);
  };
  const today = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; };
  // the week starts on the language's first day (Monday where the browser doesn't say)
  const weekStart = (() => {
    try {
      const l = new Intl.Locale(lang);
      const w = (l.getWeekInfo && l.getWeekInfo()) || l.weekInfo;
      if (w && w.firstDay) return w.firstDay % 7;
    } catch {}
    return /^en-US$|^(ja|ko|zh|he|ar|pt-BR)/i.test(lang) ? 0 : 1;
  })();
  const fmt = (o) => { try { return new Intl.DateTimeFormat(lang, { ...o, timeZone: 'UTC' }); } catch { return new Intl.DateTimeFormat('en', { ...o, timeZone: 'UTC' }); } };
  const dayShort = fmt({ weekday: 'short' }), dayLong = fmt({ weekday: 'long' }), full = fmt({ dateStyle: 'full' }), title = fmt({ month: 'long', year: 'numeric' });

  const TOKEN = /"[^"]*"|YYYY|YY|MONTH|MON|MM|DD|DAY|DY/gi;
  const monthsOf = (field) => { try { return JSON.parse(field.dataset.months || '{}'); } catch { return {}; } };
  const format = (iso, mask, months) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return '';
    const [y, mo, d] = m.slice(1).map(Number);
    return mask.replace(TOKEN, (tok) => {
      if (tok.startsWith('"')) return tok.slice(1, -1);
      const up = tok.toUpperCase();
      const cased = (s) => (tok === up ? s.toUpperCase() : tok[1] && tok[1] !== up[1] ? s[0].toUpperCase() + s.slice(1) : s);
      if (up === 'YYYY') return String(y);
      if (up === 'YY') return pad(y % 100);
      if (up === 'MM') return pad(mo);
      if (up === 'DD') return pad(d);
      if (up === 'MONTH') return cased((months.long || [])[mo - 1] || '');
      if (up === 'MON') return cased((months.short || [])[mo - 1] || '');
      if (up === 'DAY') return cased(dayLong.format(dateOf(iso)));
      if (up === 'DY') return cased(dayShort.format(dateOf(iso)));
      return tok;
    });
  };
  // the text read back in the mask (as format.ts parseDateMask does), or as YYYY-MM-DD; null when it isn't a date
  const parse = (text, mask, months) => {
    const v = (text || '').trim();
    let y, mo, d;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (iso) [y, mo, d] = iso.slice(1).map(Number);
    else {
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const names = (list) => `(${(list || []).map(esc).join('|') || '\\p{L}+'})`;
      const groups = [];
      let last = 0, re = '';
      for (const m of mask.matchAll(TOKEN)) {
        re += esc(mask.slice(last, m.index));
        last = m.index + m[0].length;
        if (m[0].startsWith('"')) { re += esc(m[0].slice(1, -1)); continue; }
        const up = m[0].toUpperCase();
        re += { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{1,2})', DD: '(\\d{1,2})', MONTH: names(months.long), MON: names(months.short), DAY: '(\\p{L}+)', DY: '(\\p{L}+)' }[up];
        groups.push(up);
      }
      re += esc(mask.slice(last));
      const m = new RegExp(`^${re}$`, 'iu').exec(v);
      if (!m) return null;
      groups.forEach((g, i) => {
        const x = m[i + 1];
        if (g === 'YYYY') y = Number(x);
        else if (g === 'YY') y = 2000 + Number(x);
        else if (g === 'MM') mo = Number(x);
        else if (g === 'DD') d = Number(x);
        else if (g === 'MONTH' || g === 'MON') mo = ((g === 'MONTH' ? months.long : months.short) || []).findIndex((n) => n.toLowerCase() === x.toLowerCase()) + 1;
      });
    }
    if (!y || !mo || !d) return null;
    const out = `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}`;
    return isoOf(dateOf(out)) === out ? out : null;
  };

  let open = null; // { box, field, btn, focus, view }
  function close(back) {
    if (!open) return;
    const { box, btn } = open;
    open = null;
    box.remove();
    btn.setAttribute('aria-expanded', 'false');
    if (back) btn.focus();
  }
  function choose(iso) {
    const { field } = open;
    field.value = iso ? format(iso, field.dataset.dateMask || 'YYYY-MM-DD', monthsOf(field)) : '';
    close(false);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.focus();
  }
  // a date range's to is on or after its from (and the from on or before the to)
  const allowed = (iso) => {
    const { field } = open;
    if (!field.closest('.date-range')) return true;
    const isTo = field.id.endsWith('_TO');
    const other = document.getElementById(isTo ? field.id.slice(0, -3) : `${field.id}_TO`);
    const bound = other ? parse(other.value, other.dataset.dateMask || 'YYYY-MM-DD', monthsOf(other)) : null;
    return !bound || (isTo ? iso >= bound : iso <= bound);
  };
  function render() {
    const { box, field } = open;
    const sel = parse(field.value, field.dataset.dateMask || 'YYYY-MM-DD', monthsOf(field));
    const now = today();
    const view = open.view;
    const first = dateOf(`${view.slice(0, 7)}-01`);
    const start = addDays(isoOf(first), -((first.getUTCDay() - weekStart + 7) % 7));
    box.textContent = '';
    const head = document.createElement('div');
    head.className = 'date-picker-head';
    const nav = (label, n, glyph) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm';
      b.setAttribute('aria-label', label);
      b.textContent = glyph;
      b.addEventListener('click', () => { open.focus = addMonths(open.focus, n); open.view = open.focus; render(); });
      return b;
    };
    const caption = document.createElement('div');
    caption.className = 'date-picker-title';
    caption.setAttribute('aria-live', 'polite');
    caption.id = `${field.id}_dp_title`;
    caption.textContent = title.format(first);
    head.append(nav(t('calendar.previous', 'Previous month'), -1, '‹'), caption, nav(t('calendar.next', 'Next month'), 1, '›'));
    const table = document.createElement('table');
    table.className = 'date-picker-grid';
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-labelledby', caption.id);
    const hr = table.createTHead().insertRow();
    for (let i = 0; i < 7; i++) {
      const th = document.createElement('th');
      const day = addDays(start, i);
      th.scope = 'col';
      th.abbr = dayLong.format(dateOf(day));
      th.textContent = dayShort.format(dateOf(day));
      hr.append(th);
    }
    const body = table.createTBody();
    for (let w = 0; w < 6; w++) {
      const tr = body.insertRow();
      for (let i = 0; i < 7; i++) {
        const iso = addDays(start, w * 7 + i);
        const td = tr.insertCell();
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.iso = iso;
        b.textContent = String(Number(iso.slice(8)));
        b.setAttribute('aria-label', full.format(dateOf(iso)));
        b.tabIndex = iso === open.focus ? 0 : -1;
        if (iso.slice(0, 7) !== view.slice(0, 7)) b.classList.add('date-other');
        if (iso === now) { b.classList.add('date-today'); b.setAttribute('aria-current', 'date'); }
        if (iso === sel) { b.classList.add('date-selected'); b.setAttribute('aria-pressed', 'true'); }
        if (!allowed(iso)) b.disabled = true;
        td.append(b);
      }
    }
    const foot = document.createElement('div');
    foot.className = 'date-picker-foot';
    const act = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = label; b.addEventListener('click', fn); return b; };
    foot.append(act(t('calendar.today', 'Today'), () => (allowed(now) ? choose(now) : null)), act(t('facets.clear_short', 'Clear'), () => choose('')));
    box.append(head, table, foot);
    box.querySelector('button[tabindex="0"]')?.focus({ preventScroll: true });
  }
  // fixed under the field (above it when there is no room), so a scrolling table or grid cell doesn't clip it
  function place() {
    if (!open) return;
    const { box, field } = open;
    const r = field.getBoundingClientRect();
    const h = box.offsetHeight, w = box.offsetWidth;
    box.style.position = 'fixed';
    box.style.top = `${Math.round(r.bottom + 4 + h > window.innerHeight - 8 && r.top - h - 4 > 8 ? r.top - h - 4 : r.bottom + 4)}px`;
    box.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8)))}px`;
  }
  window.addEventListener('scroll', place, { passive: true, capture: true });
  window.addEventListener('resize', place);
  function show(field, btn) {
    close(false);
    const box = document.createElement('div');
    box.className = 'date-picker';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('item.choose_date', 'Choose a date'));
    const sel = parse(field.value, field.dataset.dateMask || 'YYYY-MM-DD', monthsOf(field));
    open = { box, field, btn, focus: sel || today(), view: sel || today() };
    btn.setAttribute('aria-expanded', 'true');
    (field.closest('.date-field') || field.parentElement).append(box);
    render();
    place();
    box.addEventListener('keydown', (e) => {
      const day = e.target.dataset?.iso;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (!day) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      let next = null;
      if (step) next = addDays(day, step);
      else if (e.key === 'PageUp' || e.key === 'PageDown') next = addMonths(day, (e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1));
      else if (e.key === 'Home') next = addDays(day, -((dateOf(day).getUTCDay() - weekStart + 7) % 7));
      else if (e.key === 'End') next = addDays(day, 6 - ((dateOf(day).getUTCDay() - weekStart + 7) % 7));
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (allowed(day)) choose(day); return; }
      if (!next) return;
      e.preventDefault();
      open.focus = next;
      if (next.slice(0, 7) !== open.view.slice(0, 7)) { open.view = next; render(); }
      else {
        box.querySelectorAll('button[data-iso]').forEach((b) => (b.tabIndex = b.dataset.iso === next ? 0 : -1));
        box.querySelector(`button[data-iso="${next}"]`)?.focus({ preventScroll: true });
      }
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-iso]');
      if (b && !b.disabled) choose(b.dataset.iso);
    });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-date-pick]');
    if (btn) {
      const field = document.getElementById(btn.dataset.datePick);
      if (!field) return;
      e.preventDefault();
      if (open && open.btn === btn) close(true);
      else show(field, btn);
      return;
    }
    if (open && !e.target.closest?.('.date-picker')) close(false);
  });
  // Alt+Down in the field opens the picker (as a native date field does)
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowDown' && e.target.matches?.('input[data-date-mask]')) {
      const btn = e.target.parentElement?.querySelector('[data-date-pick]');
      if (btn) { e.preventDefault(); show(e.target, btn); }
    }
  });
})();

// (sprint 131) Passkeys for application users, as in the builder (public/builder.js): a [data-passkey] button asks
// the server (its URL) for WebAuthn options, calls navigator.credentials.create() (My account, adding one while
// signing in) or .get() (the second step) and posts the answer in its own form. Without WebAuthn or JavaScript
// the buttons stay hidden; codes keep working.
(() => {
  'use strict';
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  for (const btn of document.querySelectorAll('[data-passkey]')) {
    const form = btn.closest('form');
    if (!form) continue;
    btn.hidden = false;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const status = form.querySelector('[data-passkey-status]');
      const set = (name, value) => {
        const field = form.querySelector(`[name="${name}"]`);
        if (field) field.value = value;
      };
      btn.disabled = true;
      if (status) status.textContent = '';
      try {
        const res = await fetch(btn.dataset.passkey, {
          method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' },
          body: new URLSearchParams({ __csrf: form.querySelector('[name="__csrf"]').value }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const o = await res.json();
        if (o.mode === 'create') {
          const c = await navigator.credentials.create({ publicKey: {
            challenge: bytes(o.challenge), rp: o.rp,
            user: { id: bytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
            pubKeyCredParams: o.algs.map((alg) => ({ type: 'public-key', alg })),
            excludeCredentials: o.exclude.map((id) => ({ type: 'public-key', id: bytes(id) })),
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
            attestation: 'none', timeout: 120000,
          } });
          set('clientDataJSON', b64(c.response.clientDataJSON));
          set('attestationObject', b64(c.response.attestationObject));
          set('transports', (c.response.getTransports ? c.response.getTransports() : []).join(','));
        } else {
          const c = await navigator.credentials.get({ publicKey: {
            challenge: bytes(o.challenge), rpId: o.rpId, userVerification: o.uv || 'preferred', timeout: 120000,
            allowCredentials: o.allow.map((a) => ({ type: 'public-key', id: bytes(a.id), transports: a.transports })),
          } });
          set('credentialId', b64(c.rawId));
          set('clientDataJSON', b64(c.response.clientDataJSON));
          set('authenticatorData', b64(c.response.authenticatorData));
          set('signature', b64(c.response.signature));
          if (c.response.userHandle) set('userHandle', b64(c.response.userHandle));
        }
        if (btn.dataset.passkeySubmit) form.action = btn.dataset.passkeySubmit;
        form.submit();
      } catch (err) {
        btn.disabled = false;
        if (status) status.textContent = btn.dataset.passkeyError || String(err);
      }
    });
  }
})();
