import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { APPEARANCE_DEFAULT, appStyles, BASE_STYLES, baseStyleOf, FONT_SIZES, FONTS, HEX, ITEM_REF, MAX_STYLES, NAV_APPEARANCES, navAppearance, parseStyle, RADII, STYLE_NAME, type StyleVariant } from '../runtime/styles.ts';
import { REGION_OPTIONS, BUTTON_OPTIONS } from '../runtime/template-options.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// App → Settings → Theme Roller: style variants (APEX: theme styles). The
// styles live in meta.app.theme ("styles", "style", "style_choice"), so they
// travel with the application's export. Values come from fixed lists only
// (src/runtime/styles.ts checks them on save and again when making the CSS).

type Theme = Record<string, unknown>;

const appRow = async (id: string) => (/^\d{1,9}$/.test(id) ? owner.one('select id, name, alias, theme from meta.app where id = $1', [id]) : undefined);

/** Change the app's theme in one transaction (the row is locked while `change` runs). */
async function updateTheme(id: string, change: (theme: Theme) => Theme | string) {
  return owner.tx(async (c) => {
    const row = (await c.query('select theme from meta.app where id = $1 for update', [id])).rows[0];
    if (!row) return 'Application not found.';
    const next = change({ ...(row.theme ?? {}) });
    if (typeof next === 'string') return next;
    await c.query('update meta.app set theme = $2, updated_at = now() where id = $1', [id, JSON.stringify(next)]);
    return null;
  });
}

const label = (list: Record<string, { label: string }>, k: string | undefined) => (k && list[k] ? list[k].label : tx('thr.as_base'));
/** (sprint 117) a style's navigation appearance as shown in the list */
const appearanceLabel = (k: string | undefined) => (k === APPEARANCE_DEFAULT ? tx('thr.default') : k && NAV_APPEARANCES[k] ? NAV_APPEARANCES[k].label : tx('thr.as_app'));
const appearanceChoices = (forStyle: boolean): [string, string][] => [
  forStyle ? ['', tx('thr.as_the_application')] : ['', tx('thr.default_the_base_style_s')],
  ...(forStyle ? [[APPEARANCE_DEFAULT, tx('thr.default_base_style')] as [string, string]] : []),
  ...Object.entries(NAV_APPEARANCES).map(([k, v]): [string, string] => [k, v.label]),
];
const APPEARANCE_HELP = 'APEX 26.2: Pillar Light puts the header and menu on the page\'s own light surfaces, Pillar Dark makes them one dark column in the header colour; both have a header pillar strip and show the current page as a filled pill.';

function styleForm(appId: number, s: Parameters<typeof csrf>[0], st: StyleVariant | null, base: Theme) {
  const colour = (name: 'accent' | 'header' | 'accent_dark' | 'header_dark' | 'strip' | 'strip_dark', title: string, fallback: string) => {
    const ref = st?.[name] && ITEM_REF.test(st[name]!) ? st[name]! : '';
    const own = !!st?.[name] && !ref;
    const value = (own ? st?.[name] : undefined) ?? (typeof base[name] === 'string' && HEX.test(base[name] as string) ? (base[name] as string) : fallback);
    return html`<div class="field"><label class="label" for="f_${name}">${title}</label>
      <input id="f_${name}" name="${name}" type="color" value="${value}">
      <label class="check"><input type="checkbox" name="${name}_own" value="true"${own ? raw(' checked') : ''}> ${tx('thr.use_this_colour_else_the')}</label>
      <label class="sub" for="f_${name}_item">${tx('thr.or_the_value_of_an')}</label>
      <input id="f_${name}_item" name="${name}_item" value="${ref}" placeholder="&amp;APP_BRAND_COLOUR." autocomplete="off" spellcheck="false">
      <small class="help">${tx('thr.a_dynamic_colour_the_item')}</small></div>`;
  };
  const baseOf = BASE_STYLES[baseStyleOf(base)];
  const choices = (list: Record<string, { label: string }>) => [['', tx('thr.as_the_base')] as [string, string], ...Object.entries(list).map(([k, v]): [string, string] => [k, v.label])];
  // the live preview (builder.js): the style form's values as CSS variables on a sample of the application's look
  const lists = JSON.stringify({
    fonts: Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.css])),
    sizes: Object.fromEntries(Object.entries(FONT_SIZES).map(([k, v]) => [k, v.css])),
    radii: Object.fromEntries(Object.entries(RADII).map(([k, v]) => [k, v.css])),
  });
  // (sprint 117) the preview has a menu: the current page, its parent and the appearance in use
  const appearance = navAppearance(base as never, st) ?? '';
  const preview = html`<div class="tr-preview tr-preview-${baseStyleOf(base)}" data-tr-preview="${lists}" data-tr-app-appearance="${navAppearance(base as never, null) ?? ''}" data-appearance="${appearance}" aria-label="${tx('thr.preview_of_the_style')}">
    <div class="tr-preview-header">${icon('menu')}<span>${tx('thr.preview')}</span></div>
    <div class="tr-preview-main">
    <ul class="tr-preview-nav" aria-label="${tx('thr.sample_menu')}">
      <li><span class="tr-nav-parent">${icon('users')}<span>${tx('thr.employees')}</span></span>
        <ul><li><span class="tr-nav-current">${tx('thr.employee_list')}</span></li><li><span>${tx('thr.directory')}</span></li></ul></li>
      <li><span>${icon('chart')}<span>${tx('thr.reports')}</span></span></li>
    </ul>
    <div class="tr-preview-body">
      <section class="region region-standard"><header class="region-header"><h2>${tx('thr.a_region')}</h2></header>
        <div class="region-body"><p class="u-mt0">${tx.rich('thr.preview_text', { link: html`<a href="#tr-preview-link" id="tr-preview-link">${tx('thr.link')}</a>`, badge: html`<span class="tc-badge tc-badge-info">${tx('thr.badge')}</span>` })}</p>
          <div class="field"><label class="label" for="tr-preview-input">${tx('thr.a_field')}</label><input id="tr-preview-input" value="${tx('thr.value')}" readonly></div>
          <div class="buttons"><button type="button" class="btn">${tx('thr.cancel')}</button><button type="button" class="btn btn-hot">${tx('thr.save')}</button></div></div></section>
    </div></div></div>`;
  return html`${preview}<form method="post" action="${BASE}/apps/${appId}/theme/styles" data-tr-form>${csrf(s)}
    ${st ? html`<input type="hidden" name="original" value="${st.name}">` : ''}
    <div class="form-grid">
      ${input('name', tx('thr.name'), st?.name ?? '', { required: true, placeholder: tx('thr.e_g_ocean'), help: tx('thr.shown_to_users_who_may') })}
      ${colour('accent', tx('thr.c_accent'), baseOf.accent)}
      ${colour('header', tx('thr.c_header'), baseOf.header)}
      ${colour('accent_dark', tx('thr.c_accent_dark'), '#a59cff')}
      ${colour('header_dark', tx('thr.c_header_dark'), '#0d0c1a')}
      ${select('appearance', tx('thr.navigation_appearance'), st?.appearance ?? '', appearanceChoices(true), APPEARANCE_HELP)}
      ${colour('strip', tx('thr.c_strip'), baseOf.accent)}
      ${colour('strip_dark', tx('thr.c_strip_dark'), '#a59cff')}
      ${select('font', tx('thr.font'), st?.font ?? '', choices(FONTS))}
      ${select('font_size', tx('thr.font_size'), st?.font_size ?? '', choices(FONT_SIZES))}
      ${select('radius', tx('thr.corners'), st?.radius ?? '', choices(RADII))}
      <div class="field" data-wide><label class="label" for="f_condition">${tx('thr.condition_sql')}</label>
        <textarea id="f_condition" name="condition" class="code" rows="2" spellcheck="false" data-code="sql" placeholder=":APP_TENANT = 'north'">${st?.condition ?? ''}</textarea>
        <small class="help">${tx('thr.optional_a_boolean_expression_with')}</small></div>
    </div>
    <div class="buttons"><button class="btn btn-hot">${st ? tx('thr.save_style') : tx('thr.add_style')}</button>
      ${st ? html`<a class="btn" href="${BASE}/apps/${appId}/theme">${tx('thr.cancel')}</a>` : ''}</div>
  </form>`;
}

export async function themeRollerRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/theme`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const theme: Theme = a.theme ?? {};
    const styles = appStyles(a.theme);
    const editing = typeof req.query.edit === 'string' ? styles.find((x) => x.name === req.query.edit) ?? null : null;
    // (sprint 117) the application's header strip colours (else the accent)
    const appColour = (k: 'strip' | 'strip_dark', title: string, fallback: string) => {
      const v = typeof theme[k] === 'string' && HEX.test(theme[k] as string) ? (theme[k] as string) : '';
      return html`<div class="field"><label class="label" for="f_app_${k}">${title}</label>
        <input id="f_app_${k}" name="${k}" type="color" value="${v || fallback}">
        <label class="check"><input type="checkbox" name="${k}_own" value="true"${v ? raw(' checked') : ''}> ${tx('thr.use_this_colour_else_the_2')}</label></div>`;
    };
    const swatch = (hex: string | undefined) =>
      !hex ? html`<span class="muted">base</span>` : ITEM_REF.test(hex) ? html`<code>${hex}</code>` : html`<input type="color" value="${hex}" disabled aria-label="${hex}" class="swatch"> <code>${hex}</code>`;
    const main = html`${appHeader(a, 'settings', s)}
      <div class="ide-body">
        ${region(tx('thr.theme_roller_style_variants'), html`
          <p class="muted u-mt0">${tx.rich('thr.variants_intro', { base: BASE_STYLES[baseStyleOf(a.theme)].label, settings: html`<a href="${BASE}/apps/${a.id}/settings">${tx('thr.settings_theme')}</a>` })}</p>
          ${styles.length
            ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('thr.name')}</th><th>${tx('thr.accent')}</th><th>${tx('thr.header')}</th><th>${tx('thr.dark_accent')}</th><th>${tx('thr.dark_header')}</th><th>${tx('thr.navigation')}</th><th>${tx('thr.strip')}</th><th>${tx('thr.font')}</th><th>${tx('thr.font_size')}</th><th>${tx('thr.corners')}</th><th><span class="sr-only">${tx('thr.actions')}</span></th></tr></thead><tbody>
                ${styles.map((x) => html`<tr><td>${x.name}${theme.style === x.name ? html` <span class="badge">default</span>` : ''}${x.condition ? html`<br><small class="muted">when <code>${x.condition.length > 60 ? `${x.condition.slice(0, 60)}…` : x.condition}</code></small>` : ''}</td>
                  <td>${swatch(x.accent)}</td><td>${swatch(x.header)}</td><td>${swatch(x.accent_dark)}</td><td>${swatch(x.header_dark)}</td><td>${appearanceLabel(x.appearance)}</td><td>${swatch(x.strip)}</td><td>${label(FONTS, x.font)}</td><td>${label(FONT_SIZES, x.font_size)}</td><td>${label(RADII, x.radius)}</td>
                  <td><a class="btn btn-sm" href="${BASE}/apps/${a.id}/theme?edit=${encodeURIComponent(x.name)}">${icon('edit')} ${tx('thr.edit')}</a>
                    <form method="post" action="${BASE}/apps/${a.id}/theme/styles/delete" class="u-inline">${csrf(s)}<input type="hidden" name="name" value="${x.name}">
                      <button class="btn btn-sm btn-danger" data-confirm="${tx('thr.delete_confirm', { name: x.name })}">${tx('thr.delete')}</button></form></td></tr>`)}
              </tbody></table></div>`
            : html`<p class="muted">${tx('thr.no_styles_yet_the_application')}</p>`}
          <form method="post" action="${BASE}/apps/${a.id}/theme/settings" class="u-mt1">${csrf(s)}
            <div class="form-grid">
              ${select('style', tx('thr.default_style'), typeof theme.style === 'string' ? theme.style : '', [['', tx('thr.none_the_base_style_and')], ...styles.map((x): [string, string] => [x.name, x.name])], tx('thr.what_everyone_sees_unless_they'))}
              ${select('appearance', tx('thr.navigation_appearance'), navAppearance(theme as never, null) ?? '', appearanceChoices(false), `${APPEARANCE_HELP} A style may choose its own.`)}
              ${appColour('strip', tx('thr.c_strip'), BASE_STYLES[baseStyleOf(a.theme)].accent)}
              ${appColour('strip_dark', tx('thr.c_strip_dark'), '#a59cff')}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="style_choice" value="true"${theme.style_choice === true ? raw(' checked') : ''}> ${tx('thr.users_may_choose_a_style')}</label>
              <small class="help">${tx('thr.adds_the_styles_to_the')}</small></div>
            <div class="buttons"><button class="btn btn-hot">${tx('thr.save')}</button></div>
          </form>`)}
        ${region(editing ? tx('thr.edit_style', { name: editing.name }) : tx('thr.add_a_style'), styles.length >= MAX_STYLES && !editing
          ? html`<p class="muted">${tx('thr.max_styles', { n: MAX_STYLES })}</p>`
          : styleForm(a.id, s, editing, theme))}
        ${region(tx('thr.template_options'), html`<p class="muted u-mt0">${tx.rich('thr.options_intro', { options: html`<em>${tx('thr.template_options')}</em>` })}</p>
          <ul class="u-mt0"><li>${tx.rich('thr.regions_list', { list: html`${REGION_OPTIONS.map((o, i) => html`${i ? ', ' : ''}<code>${o.cls}</code>`)}` })}</li>
            <li>${tx.rich('thr.buttons_list', { list: html`${BUTTON_OPTIONS.map((o, i) => html`${i ? ', ' : ''}<code>${o.cls}</code>`)}` })}</li></ul>`)}
      </div>`;
    return send(reply, s, shell(s, tx('thr.title', { app: a.name }), [[tx('thr.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('thr.settings'), `${BASE}/apps/${a.id}/settings`], [tx('thr.theme_roller')]], main));
  });

  // add or change a style
  app.post(`${BASE}/apps/:id/theme/styles`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    if (!(await appRow(id))) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    const target = `${BASE}/apps/${id}/theme`;
    const parsed = parseStyle({
      name: b.name, font: b.font, font_size: b.font_size, radius: b.radius,
      // an item reference wins over a picked colour
      accent: b.accent_item?.trim() || (b.accent_own === 'true' ? b.accent : undefined),
      header: b.header_item?.trim() || (b.header_own === 'true' ? b.header : undefined),
      accent_dark: b.accent_dark_item?.trim() || (b.accent_dark_own === 'true' ? b.accent_dark : undefined),
      header_dark: b.header_dark_item?.trim() || (b.header_dark_own === 'true' ? b.header_dark : undefined),
      strip: b.strip_item?.trim() || (b.strip_own === 'true' ? b.strip : undefined),
      strip_dark: b.strip_dark_item?.trim() || (b.strip_dark_own === 'true' ? b.strip_dark : undefined),
      appearance: b.appearance,
      condition: b.condition,
    });
    if (typeof parsed === 'string') {
      flash(s, parsed, 'error');
      return back(reply, s, b.original ? `${target}?edit=${encodeURIComponent(b.original)}` : target);
    }
    const original = typeof b.original === 'string' && STYLE_NAME.test(b.original) ? b.original : null;
    const problem = await updateTheme(id, (t) => {
      const styles = appStyles(t as never);
      const at = original ? styles.findIndex((x) => x.name === original) : -1;
      if (original && at < 0) return tx('thr.gone', { name: original });
      if (styles.some((x, i) => i !== at && x.name.toLowerCase() === parsed.name.toLowerCase())) return tx('thr.exists', { name: parsed.name });
      if (at < 0 && styles.length >= MAX_STYLES) return tx('thr.max_styles', { n: MAX_STYLES });
      if (at >= 0) styles[at] = parsed;
      else styles.push(parsed);
      const next: Theme = { ...t, styles };
      if (original && original !== parsed.name && t.style === original) next.style = parsed.name;
      return next;
    });
    if (problem) {
      flash(s, problem, 'error');
      return back(reply, s, target);
    }
    // users who chose the renamed style keep it
    if (original && original !== parsed.name)
      await owner.query('update meta.account_style set style = $3 where app_id = $1 and style = $2', [id, original, parsed.name]);
    flash(s, tx('thr.saved', { name: parsed.name }));
    return back(reply, s, target);
  });

  app.post(`${BASE}/apps/:id/theme/styles/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    if (!(await appRow(id))) return reply.code(404).send('Not found');
    const name = req.body?.name ?? '';
    const problem = await updateTheme(id, (t) => {
      const styles = appStyles(t as never);
      if (!styles.some((x) => x.name === name)) return 'That style does not exist.';
      const next: Theme = { ...t, styles: styles.filter((x) => x.name !== name) };
      if (t.style === name) delete next.style;
      return next;
    });
    if (!problem) await owner.query('delete from meta.account_style where app_id = $1 and style = $2', [id, name]);
    flash(s, problem ?? tx('thr.deleted', { name }), problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/apps/${id}/theme`);
  });

  // the default style and whether users may choose
  app.post(`${BASE}/apps/:id/theme/settings`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = req.params.id;
    if (!(await appRow(id))) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    const problem = await updateTheme(id, (t) => {
      const styles = appStyles(t as never);
      const next: Theme = { ...t, style_choice: b.style_choice === 'true' };
      // (sprint 117) the navigation appearance and the header strip colours: fixed keys and #rrggbb only
      if (!b.appearance) delete next.appearance;
      else if (Object.hasOwn(NAV_APPEARANCES, b.appearance)) next.appearance = b.appearance;
      else return 'Navigation appearance: choose Default, Pillar Light or Pillar Dark.';
      for (const k of ['strip', 'strip_dark'] as const) {
        if (b[`${k}_own`] !== 'true') delete next[k];
        else if (HEX.test(b[k] ?? '')) next[k] = b[k]!.toLowerCase();
        else return 'Header strip colour: #rrggbb.';
      }
      if (!b.style) delete next.style;
      else if (styles.some((x) => x.name === b.style)) next.style = b.style;
      else return 'Choose one of the styles.';
      return next;
    });
    flash(s, problem ?? tx('thr.theme_roller_settings_saved'), problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/apps/${id}/theme`);
  });
}
