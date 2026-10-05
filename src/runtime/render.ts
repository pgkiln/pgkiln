import { randomUUID } from 'node:crypto';
import { urlChecksum } from '../security.ts';
import { pwaBody, pwaHead } from './pwa.ts';
import { mapHead } from './maps.ts';
import { appStyles, chosenStyle, chosenStyleName, styleChoice, themeCss } from './styles.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { documentShell } from '../layout.ts';
import { baseLanguage, LANGUAGE_NAMES } from '../i18n.ts';
import type { NavEntry } from '../metadata.ts';
import { isAuthorized, pageAllowed } from './authz.ts';
import { substitute, type PageContext } from './context.ts';
import { renderItems } from './items.ts';
import { buttonsFor, renderRegion } from './regions.ts';
import { listTree, navbarMarkup, navMarkup } from './lists.ts';
import { aiInputs, aiOutputs, aiProcessOf } from './ai.ts';

// ---------------------------------------------------------------- dynamic actions

const list = (s: string | null) => (s ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

/** Client-side definition of the page's dynamic actions (never includes SQL). */
function dynamicActionsJson(ctx: PageContext) {
  return ctx.page.dynamic_actions
    .filter((d) => ctx.vis!.dynamicActions.has(d.id))
    .map((d) => ({
      id: d.id,
      event: d.event,
      trigger: list(d.trigger_element),
      cond: d.condition_type ? { type: d.condition_type, value: d.condition_value ?? '' } : null,
      action: d.action,
      // ai_generate: the items its process fills (busy while it runs), unless named
      items: d.action === 'ai_generate' && !d.affected_items ? aiOutputs(aiProcessOf(ctx.page, d.code)?.config) : list(d.affected_items),
      region: d.affected_region_id,
      submit: d.action === 'ai_generate' && !d.items_to_submit ? aiInputs(aiProcessOf(ctx.page, d.code)?.config, ctx.page) : list(d.items_to_submit),
      message: d.message,
      // add_class / remove_class: names checked by the database (and again in app.js)
      classes: d.css_classes ? d.css_classes.split(' ').filter((c) => /^[a-z][a-z0-9_-]{0,39}$/.test(c)) : [],
    }));
}

function conditionHolds(type: string | null, expected: string | null, value: string) {
  switch (type) {
    case 'equals': return value === (expected ?? '');
    case 'not_equals': return value !== (expected ?? '');
    case 'in_list': return (expected ?? '').split(',').map((x) => x.trim()).includes(value);
    case 'is_null': return value === '';
    case 'is_not_null': return value !== '';
    default: return true;
  }
}

/**
 * Apply show/hide dynamic actions on the server too, so the first paint is
 * already right (the browser re-applies them on every change).
 */
function initiallyHidden(ctx: PageContext) {
  const hidden = new Set<string>();
  for (const d of ctx.page.dynamic_actions) {
    if (!ctx.vis!.dynamicActions.has(d.id) || (d.action !== 'show' && d.action !== 'hide') || d.event === 'dialog_closed') continue;
    const trigger = list(d.trigger_element)[0];
    const value = trigger ? (ctx.session.state[trigger] ?? '') : '';
    const holds = conditionHolds(d.condition_type, d.condition_value, value);
    const show = (d.action === 'show') === holds;
    const targets = [...list(d.affected_items), ...(d.affected_region_id ? [`R${d.affected_region_id}`] : [])];
    for (const t of targets) show ? hidden.delete(t) : hidden.add(t);
  }
  return hidden;
}

// ---------------------------------------------------------------- navigation

async function navTree(ctx: PageContext, topNav = false) {
  // a list as the navigation menu (falls back to the navigation entries when the list is missing)
  if (ctx.app.nav_list) {
    const nodes = await listTree(ctx, ctx.app.nav_list);
    if (nodes) return navMarkup(nodes, topNav);
  }
  const current = new Set<number>();
  for (let p: number | null | undefined = ctx.page.page_no, guard = 0; p && guard < 10; guard++) {
    current.add(p);
    p = ctx.app.pages.find((x) => x.page_no === p)?.parent_page;
  }
  const visible = async (e: NavEntry) => (await isAuthorized(ctx, e.authz)) && (!e.target_page || (await pageAllowed(ctx, e.target_page)));
  const render = async (parent: number | null): Promise<Raw[]> => {
    const out: Raw[] = [];
    for (const e of ctx.app.nav.filter((n) => n.parent_id === parent).sort((a, b) => a.seq - b.seq)) {
      if (!(await visible(e))) continue;
      const children = await render(e.id);
      if (!e.target_page && !children.length) continue;
      const active = e.target_page !== null && e.target_page === ctx.page.page_no;
      const inTrail = (e.target_page !== null && current.has(e.target_page)) || children.some((c) => c.value.includes('aria-current'));
      const label = html`${icon(e.icon ?? 'chevron')}<span>${e.label}</span>`;
      out.push(
        children.length
          ? html`<li><details${inTrail && !topNav ? raw(' open') : ''}><summary class="${inTrail ? 'in-trail' : null}">${label}</summary><ul>${children}</ul></details></li>`
          : html`<li><a href="${ctx.base}/${e.target_page}"${active ? raw(' aria-current="page"') : inTrail ? raw(' class="in-trail"') : ''}>${label}</a></li>`,
      );
    }
    return out;
  };
  return render(null);
}

async function breadcrumb(ctx: PageContext) {
  const trail: { page_no: number; name: string }[] = [];
  let p = ctx.app.pages.find((x) => x.page_no === ctx.page.parent_page);
  for (let guard = 0; p && guard < 6; guard++) {
    trail.unshift(p);
    p = ctx.app.pages.find((x) => x.page_no === p!.parent_page);
  }
  if (!trail.length && ctx.page.page_no !== ctx.app.home_page) {
    const home = ctx.app.pages.find((x) => x.page_no === ctx.app.home_page);
    if (home) trail.push(home);
  }
  const links = [];
  for (const t of trail) if (await pageAllowed(ctx, t.page_no)) links.push(html`<li><a href="${ctx.base}/${t.page_no}">${t.name}</a></li>`);
  return links;
}

// ---------------------------------------------------------------- theme

/** Per-app colours (Theme Roller) and the style variant in use. Only checked values reach the CSS (styles.ts). */
export const themeStyle = (ctx: Pick<PageContext, 'app' | 'session'>) => themeCss(ctx.app.theme, chosenStyle(ctx.app, ctx.session));

/**
 * The page's one inline <style>: theme colours and the data-dependent rules
 * of its regions, with the response's CSP nonce. Always present, so a
 * refreshed region can add its rules to it (app.js).
 */
export const pageStyle = (ctx: PageContext) =>
  html`<style nonce="${ctx.nonce}" id="pgapex-css">${raw([themeStyle(ctx), ctx.css.text].filter(Boolean).join('\n'))}</style>`;

// ---------------------------------------------------------------- language

/** Links to switch the language (when the app has more than one). */
export function languagePicker(app: PageContext['app'], locale: PageContext['locale'], path: string) {
  if (locale.languages.length < 2) return '';
  const sep = path.includes('?') ? '&' : '?';
  return html`<nav class="lang-picker" aria-label="${locale.t('language.label')}">${locale.languages.map((l, i) =>
    html`${i ? ' · ' : ''}${l === locale.lang
      ? html`<span aria-current="true">${LANGUAGE_NAMES[baseLanguage(l)] ?? l}</span>`
      : html`<a href="${path}${sep}lang=${l}" hreflang="${l}" lang="${l}">${LANGUAGE_NAMES[baseLanguage(l)] ?? l}</a>`}`)}</nav>`;
}

// ---------------------------------------------------------------- page

/** Auto / light / dark buttons (posted to the account's preference, or a cookie when signed out). */
export function themeSwitch(ctx: PageContext, back: string) {
  const { t, theme, themeChoice } = ctx.locale;
  if (!themeChoice) return '';
  return html`<form method="post" action="${ctx.base}/account/theme" class="menu-section theme-switch">
    <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="next" value="${back}">
    <span class="muted">${t('theme.label')}</span>
    <div class="segmented" role="group" aria-label="${t('theme.label')}">${(['auto', 'light', 'dark'] as const).map((m) =>
      html`<button name="theme" value="${m}"${theme === m ? raw(' aria-pressed="true"') : raw(' aria-pressed="false"')}>${t(`theme.${m}` as 'theme.auto').split(' (')[0]}</button>`)}</div>
  </form>`;
}

/** The app's style variants (Theme Roller), when users may choose one. */
export function styleSwitch(ctx: PageContext, back: string) {
  if (!styleChoice(ctx.app)) return '';
  const { t } = ctx.locale;
  const current = chosenStyleName(ctx.app, ctx.session);
  const names = ['', ...appStyles(ctx.app.theme).map((x) => x.name)];
  return html`<form method="post" action="${ctx.base}/account/style" class="menu-section style-switch">
    <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}"><input type="hidden" name="next" value="${back}">
    <span class="muted" id="style-switch-label">${t('style.label')}</span>
    <div class="menu-links" role="group" aria-labelledby="style-switch-label">${names.map((n) =>
      html`<button name="style" value="${n}" aria-pressed="${current === n ? 'true' : 'false'}">${current === n ? icon('check') : html`<span class="icon"></span>`}${n || t('style.standard')}</button>`)}</div>
  </form>`;
}

export async function chrome(ctx: PageContext, main: Raw, title: string) {
  const root = { lang: ctx.locale.lang, dir: ctx.locale.dir, theme: ctx.locale.theme };
  const t = ctx.locale.t;
  if (ctx.dialog)
    return documentShell(`${title} · ${ctx.app.name}`, html`<main class="t-dialog-main" id="main">${main}</main>`, 't-dialog-page', {
      'data-base': ctx.base,
      'data-page': String(ctx.page.page_no),
      'data-dialog': '1',
    }, html`${pageStyle(ctx)}${pwaHead(ctx.app)}${mapHead(ctx)}`, root);

  const signedIn = ctx.user !== 'nobody';
  const topNav = ctx.app.theme?.nav === 'top';
  const nav = await navTree(ctx, topNav);
  const navbarNodes = ctx.app.navbar_list ? await listTree(ctx, ctx.app.navbar_list) : null;
  const navbar = navbarNodes ? navbarMarkup(navbarNodes, t('list.navbar')) : '';
  return documentShell(
    `${title} · ${ctx.app.name}`,
    html`<a class="skip-link" href="#main">${t('common.skip')}</a>
    <header class="t-header">
      <a href="#t-nav" class="t-nav-toggle icon-button" role="button" aria-label="${t('common.toggle_nav')}" aria-controls="t-nav">${icon('menu')}</a>
      <a class="t-logo" href="${ctx.base}/${ctx.app.home_page}">${ctx.app.name}</a>
      <span class="t-spacer"></span>
      ${navbar}
      ${ctx.app.authentication !== 'none'
        ? signedIn
          ? html`<details class="menu t-user">
              <summary>${icon('user')}<span>${ctx.user}</span></summary>
              <div class="menu-panel align-right">
                <div class="menu-section"><strong>${ctx.user}</strong>${ctx.roles.length ? html`<div class="muted">${t('account.roles')}: ${ctx.roles.join(', ')}</div>` : ''}</div>
                <div class="menu-section"><a href="${ctx.base}/account">${icon('user')} ${t('account.menu')}</a></div>
                ${themeSwitch(ctx, here(ctx))}
                ${styleSwitch(ctx, here(ctx))}
                <form method="post" action="${ctx.base}/logout" class="menu-section">
                  <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
                  <button class="link-button plain">${icon('logout')} ${t('login.sign_out')}</button>
                </form>
              </div>
            </details>`
          : html`<a href="${ctx.base}/login">${t('login.sign_in_link')}</a>`
        : ctx.locale.themeChoice || styleChoice(ctx.app)
          ? html`<details class="menu t-user"><summary>${icon('settings')}<span class="sr-only">${t('theme.label')}</span></summary>
              <div class="menu-panel align-right">${themeSwitch(ctx, here(ctx))}${styleSwitch(ctx, here(ctx))}</div></details>`
          : ''}
    </header>
    <div class="t-body">
      <nav id="t-nav" class="t-nav" aria-label="Main"><ul>${nav}</ul></nav>
      <a href="#" class="t-nav-backdrop" tabindex="-1" aria-hidden="true"></a>
      <main class="t-main" id="main">${main}</main>
    </div>`,
    `t-app${topNav ? ' nav-top' : ''}`,
    { 'data-base': ctx.base, 'data-page': String(ctx.page.page_no), ...pwaBody(ctx.app, ctx.user) },
    html`${pageStyle(ctx)}${pwaHead(ctx.app)}${mapHead(ctx)}`,
    root,
  );
}

/**
 * The key of each form region, signed (bound to app, page and user), so a form sent later (an offline
 * queue) updates the record it was opened for, whatever the session state says by then.
 */
function formKeys(ctx: PageContext) {
  return ctx.page.regions
    .filter((r) => r.type === 'form' && r.pk_item && ctx.vis!.regions.has(r.id))
    .map((r) => {
      const pk = ctx.session.state[r.pk_item!] ?? '';
      return html`<input type="hidden" name="__pk_${r.id}" value="${pk}"><input type="hidden" name="__pkcs_${r.id}" value="${urlChecksum(ctx.app.id, ctx.page.page_no, ctx.user, { [`F${r.id}`]: pk })}">`;
    });
}

/** Texts app.js shows (offline banner and queue, location and scan buttons), in the page's language. */
const CLIENT_TEXTS = ['pwa.offline_banner', 'pwa.queued', 'pwa.queue_waiting', 'pwa.send_now', 'pwa.discard', 'pwa.status.waiting',
  'pwa.status.signin', 'pwa.status.invalid', 'pwa.status.error', 'item.locate_error', 'item.scan_close', 'common.dismiss'] as const;
const clientTexts = (ctx: PageContext) => Object.fromEntries(CLIENT_TEXTS.map((k) => [k, ctx.locale.t(k)]));

/** The current page's URL (for returning after a preference change). */
const here = (ctx: PageContext) => `${ctx.base}/${ctx.page.page_no}`;

/**
 * Automatic time zone: until the session knows the browser's time zone, app.js
 * sends it (POST …/tz) and shows the page again when the zone changes.
 */
const timeZoneMeta = (ctx: PageContext) =>
  ctx.app.time_zone_auto && typeof ctx.session.state.__TZ !== 'string' ? { tz: `${ctx.base}/tz` } : {};

export async function renderPage(ctx: PageContext) {
  const t = ctx.locale.t;
  const hidden = initiallyHidden(ctx);
  const defaultButton = [...ctx.vis!.buttons.values()].find((b) => b.hot && b.action === 'submit');
  const pageItems = await renderItems(ctx, ctx.page.items.filter((i) => i.region_id === null), hidden);
  const regions = [];
  for (const r of ctx.page.regions) regions.push(await renderRegion(ctx, r, hidden));
  const title = substitute(ctx.page.title ?? ctx.page.name, ctx, (v) => v);
  const crumbs = ctx.dialog ? [] : await breadcrumb(ctx);
  const das = dynamicActionsJson(ctx);

  const main = html`
    ${ctx.dialog
      ? ''
      : html`<div class="t-titlebar">
          ${crumbs.length ? html`<nav aria-label="Breadcrumb"><ol class="crumbs">${crumbs}</ol></nav>` : ''}
          <h1>${title}</h1>
        </div>`}
    <div class="t-content">
      <div class="messages" aria-live="polite">
        ${ctx.messages.map((m) => html`<div class="alert alert-success" role="status">${m}<button type="button" class="alert-close" aria-label="${t('common.dismiss')}">×</button></div>`)}
        ${ctx.errors.page.map((m) => html`<div class="alert alert-error" role="alert">${m}</div>`)}
        ${Object.keys(ctx.errors.items).length && !ctx.errors.page.length
          ? html`<div class="alert alert-error" role="alert">${t('error.correct_below')}</div>`
          : ''}
      </div>
      <form method="post" class="page-form" action="${ctx.base}/${ctx.page.page_no}"${ctx.page.items.some((i) => i.type === 'file') ? raw(' enctype="multipart/form-data"') : ''} novalidate>
        <input type="hidden" name="__csrf" value="${ctx.session.csrf_token}">
        <input type="hidden" name="__submit_id" value="${randomUUID()}">
        ${formKeys(ctx)}
        ${ctx.dialog ? html`<input type="hidden" name="__dialog" value="1">` : ''}
        ${defaultButton ? html`<button type="submit" name="__request" value="${defaultButton.name}" class="default-submit" tabindex="-1" aria-hidden="true"></button>` : ''}
        ${pageItems.length ? html`<div class="page-items form-grid">${pageItems}</div>` : ''}
        <div class="t-regions">${regions}</div>
        ${await buttonsFor(ctx, null)}
      </form>
      ${ctx.detached}
    </div>
    <script type="application/json" id="pgapex-meta">${raw(
      JSON.stringify({ csrf: ctx.session.csrf_token, das, texts: clientTexts(ctx), ...timeZoneMeta(ctx) }).replace(/</g, '\\u003c'),
    )}</script>`;
  return chrome(ctx, main, title);
}

/** Response to a successful submit inside a dialog: tells the opener to close it. */
export function dialogClosePage(ctx: PageContext) {
  return documentShell(
    ctx.app.name,
    html`<main class="t-dialog-main"><p>${ctx.locale.t('dialog.done')} <a href="${ctx.base}/${ctx.app.home_page}">${ctx.locale.t('dialog.continue')}</a></p></main>`,
    't-dialog-page',
    { 'data-dialog-close': '1', 'data-dialog-page': String(ctx.page.page_no) },
    '',
    { lang: ctx.locale.lang, dir: ctx.locale.dir, theme: ctx.locale.theme },
  );
}
