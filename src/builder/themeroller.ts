import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { appStyles, FONT_SIZES, FONTS, HEX, MAX_STYLES, parseStyle, RADII, STYLE_NAME, type StyleVariant } from '../runtime/styles.ts';
import { REGION_OPTIONS, BUTTON_OPTIONS } from '../runtime/template-options.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

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

const label = (list: Record<string, { label: string }>, k: string | undefined) => (k && list[k] ? list[k].label : '- as the base -');

function styleForm(appId: number, s: Parameters<typeof csrf>[0], st: StyleVariant | null, base: Theme) {
  const colour = (name: 'accent' | 'header', title: string, fallback: string) => {
    const own = !!st?.[name];
    const value = st?.[name] ?? (typeof base[name] === 'string' && HEX.test(base[name] as string) ? (base[name] as string) : fallback);
    return html`<div class="field"><label class="label" for="f_${name}">${title}</label>
      <input id="f_${name}" name="${name}" type="color" value="${value}">
      <label class="check"><input type="checkbox" name="${name}_own" value="true"${own ? raw(' checked') : ''}> Use this colour (else the base colour)</label></div>`;
  };
  const choices = (list: Record<string, { label: string }>) => [['', '- as the base -'] as [string, string], ...Object.entries(list).map(([k, v]): [string, string] => [k, v.label])];
  return html`<form method="post" action="${BASE}/apps/${appId}/theme/styles">${csrf(s)}
    ${st ? html`<input type="hidden" name="original" value="${st.name}">` : ''}
    <div class="form-grid">
      ${input('name', 'Name', st?.name ?? '', { required: true, placeholder: 'e.g. Ocean', help: 'Shown to users who may choose a style. 1–30 letters, digits, spaces, - or _.' })}
      ${colour('accent', 'Accent colour', '#0b63c5')}
      ${colour('header', 'Header colour', '#13294b')}
      ${select('font', 'Font', st?.font ?? '', choices(FONTS))}
      ${select('font_size', 'Font size', st?.font_size ?? '', choices(FONT_SIZES))}
      ${select('radius', 'Corners', st?.radius ?? '', choices(RADII))}
    </div>
    <div class="buttons"><button class="btn btn-hot">${st ? 'Save style' : 'Add style'}</button>
      ${st ? html`<a class="btn" href="${BASE}/apps/${appId}/theme">Cancel</a>` : ''}</div>
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
    const swatch = (hex: string | undefined) => (hex ? html`<input type="color" value="${hex}" disabled aria-label="${hex}" class="swatch"> <code>${hex}</code>` : html`<span class="muted">base</span>`);
    const main = html`${appHeader(a, 'settings')}
      <div class="ide-body">
        ${region('Theme Roller: style variants', html`
          <p class="muted u-mt0">Several saved styles for this application (APEX: theme styles). The base colours under
            <a href="${BASE}/apps/${a.id}/settings">Settings → Theme</a> are the <em>Standard</em> style; each style below
            changes them and may set a font, font size and corners. Colours apply to the light theme; fonts, sizes and corners to both.</p>
          ${styles.length
            ? html`<div class="table-wrap"><table class="report"><thead><tr><th>Name</th><th>Accent</th><th>Header</th><th>Font</th><th>Font size</th><th>Corners</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
                ${styles.map((x) => html`<tr><td>${x.name}${theme.style === x.name ? html` <span class="badge">default</span>` : ''}</td>
                  <td>${swatch(x.accent)}</td><td>${swatch(x.header)}</td><td>${label(FONTS, x.font)}</td><td>${label(FONT_SIZES, x.font_size)}</td><td>${label(RADII, x.radius)}</td>
                  <td><a class="btn btn-sm" href="${BASE}/apps/${a.id}/theme?edit=${encodeURIComponent(x.name)}">${icon('edit')} Edit</a>
                    <form method="post" action="${BASE}/apps/${a.id}/theme/styles/delete" class="u-inline">${csrf(s)}<input type="hidden" name="name" value="${x.name}">
                      <button class="btn btn-sm btn-danger" data-confirm="Delete style ${x.name}?">Delete</button></form></td></tr>`)}
              </tbody></table></div>`
            : html`<p class="muted">No styles yet: the application uses its base colours.</p>`}
          <form method="post" action="${BASE}/apps/${a.id}/theme/settings" class="u-mt1">${csrf(s)}
            <div class="form-grid">
              ${select('style', 'Default style', typeof theme.style === 'string' ? theme.style : '', [['', 'Standard (the base colours)'], ...styles.map((x): [string, string] => [x.name, x.name])], 'What everyone sees unless they chose another style.')}
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="style_choice" value="true"${theme.style_choice === true ? raw(' checked') : ''}> Users may choose a style</label>
              <small class="help">Adds the styles to the user menu and My account (APEX: "Enable End Users to Choose Theme Style"). A user's choice is kept per application on the account; only this application's styles can be chosen.</small></div>
            <div class="buttons"><button class="btn btn-hot">Save</button></div>
          </form>`)}
        ${region(editing ? `Edit style ${editing.name}` : 'Add a style', styles.length >= MAX_STYLES && !editing
          ? html`<p class="muted">At most ${MAX_STYLES} styles per application.</p>`
          : styleForm(a.id, s, editing, theme))}
        ${region('Template options', html`<p class="muted u-mt0">Regions and buttons have <em>Template options</em> in the Page Designer
            (group Appearance): CSS classes from a fixed list, which these styles also affect.</p>
          <ul class="u-mt0"><li>Regions: ${REGION_OPTIONS.map((o, i) => html`${i ? ', ' : ''}<code>${o.cls}</code>`)}</li>
            <li>Buttons: ${BUTTON_OPTIONS.map((o, i) => html`${i ? ', ' : ''}<code>${o.cls}</code>`)}</li></ul>`)}
      </div>`;
    return send(reply, s, shell(s, `${a.name} Theme Roller`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Settings', `${BASE}/apps/${a.id}/settings`], ['Theme Roller']], main));
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
      accent: b.accent_own === 'true' ? b.accent : undefined,
      header: b.header_own === 'true' ? b.header : undefined,
    });
    if (typeof parsed === 'string') {
      flash(s, parsed, 'error');
      return back(reply, s, b.original ? `${target}?edit=${encodeURIComponent(b.original)}` : target);
    }
    const original = typeof b.original === 'string' && STYLE_NAME.test(b.original) ? b.original : null;
    const problem = await updateTheme(id, (t) => {
      const styles = appStyles(t as never);
      const at = original ? styles.findIndex((x) => x.name === original) : -1;
      if (original && at < 0) return `Style ${original} no longer exists.`;
      if (styles.some((x, i) => i !== at && x.name.toLowerCase() === parsed.name.toLowerCase())) return `There is already a style named ${parsed.name}.`;
      if (at < 0 && styles.length >= MAX_STYLES) return `At most ${MAX_STYLES} styles per application.`;
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
    flash(s, `Style ${parsed.name} saved.`);
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
    flash(s, problem ?? `Style ${name} deleted.`, problem ? 'error' : 'ok');
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
      if (!b.style) delete next.style;
      else if (styles.some((x) => x.name === b.style)) next.style = b.style;
      else return 'Choose one of the styles.';
      return next;
    });
    flash(s, problem ?? 'Theme Roller settings saved.', problem ? 'error' : 'ok');
    return back(reply, s, `${BASE}/apps/${id}/theme`);
  });
}
