// Sprint 117 (WS-10, APEX 26.2 Universal Theme): the Pillar Light / Pillar Dark navigation
// appearances and the header pillar strip in the Theme Roller, the navigation tree's current
// page and its parents, subtle colour utilities and the lighter processing indicator.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { appStyles, navAppearance, parseStyle, themeCss } from '../src/runtime/styles.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const alias = 'ts-pillar';
const styleTag = (body: string) => /<style nonce="[^"]+" id="pgkiln-css">([\s\S]*?)<\/style>/.exec(body)?.[1] ?? '';
const bodyClass = (body: string) => /<body[^>]* class="([^"]*)"/.exec(body)?.[1] ?? '';
const setTheme = (theme: object) => owner.query('update meta.app set theme = $2 where id = $1', [appId, JSON.stringify(theme)]);

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.app where alias = $1', [alias]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Pillar test', 'none') returning id`, [alias])).id;
  for (const [no, name, parent] of [[1, 'Home', null], [2, 'Employees', 1], [3, 'Employee', 2]] as const)
    await owner.query('insert into meta.page (app_id, page_no, name, requires_auth, parent_page) values ($1, $2, $3, false, $4)', [appId, no, name, parent]);
  const people = (await owner.one(`insert into meta.nav_entry (app_id, seq, label) values ($1, 20, 'People') returning id`, [appId])).id;
  await owner.query(`insert into meta.nav_entry (app_id, seq, label, target_page) values ($1, 10, 'Home', 1)`, [appId]);
  await owner.query(`insert into meta.nav_entry (app_id, parent_id, seq, label, target_page) values ($1, $2, 10, 'Employee list', 2)`, [appId, people]);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await app.close();
  await closePools();
});

describe('appearances: checking and CSS', () => {
  test('parseStyle keeps an appearance from the list and strip colours (hex or item)', () => {
    assert.deepEqual(parseStyle({ name: 'P', appearance: 'pillar_dark', strip: '#E8590C', strip_dark: '&app_brand.' }),
      { name: 'P', appearance: 'pillar_dark', strip: '#e8590c', strip_dark: '&APP_BRAND.' });
    assert.deepEqual(parseStyle({ name: 'P', appearance: 'default' }), { name: 'P', appearance: 'default' });
    assert.deepEqual(parseStyle({ name: 'P', appearance: '' }), { name: 'P' });
    assert.match(parseStyle({ name: 'P', appearance: 'pillar' }) as string, /Navigation appearance/);
    assert.match(parseStyle({ name: 'P', appearance: 'hasOwnProperty' }) as string, /Navigation appearance/);
    assert.match(parseStyle({ name: 'P', strip: 'orange' }) as string, /Header strip colour/);
    assert.match(parseStyle({ name: 'P', strip_dark: '#123' }) as string, /Header strip colour \(dark mode\)/);
  });

  test('the appearance in use: the style, else the application; "default" turns it off', () => {
    assert.equal(navAppearance({ appearance: 'pillar_light' }, null), 'pillar_light');
    assert.equal(navAppearance({ appearance: 'pillar_light' }, { name: 'S', appearance: 'pillar_dark' }), 'pillar_dark');
    assert.equal(navAppearance({ appearance: 'pillar_light' }, { name: 'S', appearance: 'default' }), null);
    assert.equal(navAppearance({ appearance: 'pillar_light' }, { name: 'S' }), 'pillar_light');
    assert.equal(navAppearance({ appearance: 'side' }, null), null);
    assert.equal(navAppearance({ appearance: 'default' }, null), null);
    assert.equal(navAppearance(undefined, null), null);
  });

  test('themeCss: the strip colours, light and dark, and a style\'s own strip', () => {
    const css = themeCss({ strip: '#e8590c', strip_dark: '#ffa94d' }, null);
    assert.match(css, /html:root\{--strip:#e8590c;\}/);
    assert.match(css, /prefers-color-scheme: dark\)\{html:root:not\(\[data-theme="light"\]\)\{--strip:#ffa94d;\}\}html:root\[data-theme="dark"\]\{--strip:#ffa94d;\}/);
    const style = appStyles({ styles: [{ name: 'S', strip: '&BRAND.' }] })[0];
    assert.match(themeCss({}, style, (n) => (n === 'BRAND' ? '#0b7285' : undefined)), /--strip:#0b7285;/);
    assert.doesNotMatch(themeCss({}, style, () => 'red;}body{x:y'), /--strip/);
    assert.doesNotMatch(themeCss({ strip: 'url(x)' }, null), /--strip/);
  });

  test('an accent and a header colour together are separate declarations', () => {
    const css = themeCss({ accent: '#123456', header: '#654321' }, null);
    assert.match(css, /--accent-soft:color-mix\(in srgb, #123456 14%, var\(--surface\)\);--header:#654321;/);
  });
});

describe('appearances at runtime', () => {
  test('the application\'s appearance and strip on every page', async () => {
    await setTheme({ appearance: 'pillar_dark', strip: '#e8590c' });
    const body = (await new Browser(app).get(`/a/${alias}/2`)).body;
    assert.match(bodyClass(body), /\bnav-pillar nav-pillar-dark\b/);
    assert.match(styleTag(body), /--strip:#e8590c;/);
    await setTheme({ appearance: 'pillar_light', nav: 'top' });
    assert.match(bodyClass((await new Browser(app).get(`/a/${alias}/2`)).body), /^t-app nav-top nav-pillar nav-pillar-light$/);
    await setTheme({});
    assert.doesNotMatch(bodyClass((await new Browser(app).get(`/a/${alias}/2`)).body), /nav-pillar/);
  });

  test('a style variant chooses its own appearance, or none', async () => {
    await setTheme({ appearance: 'pillar_light', styles: [{ name: 'Night', appearance: 'pillar_dark' }, { name: 'Plain', appearance: 'default' }], style: 'Night', style_choice: true });
    assert.match(bodyClass((await new Browser(app).get(`/a/${alias}/2`)).body), /nav-pillar-dark/);
    await setTheme({ appearance: 'pillar_light', styles: [{ name: 'Plain', appearance: 'default' }], style: 'Plain' });
    assert.doesNotMatch(bodyClass((await new Browser(app).get(`/a/${alias}/2`)).body), /nav-pillar/);
  });

  test('the current page and its parent entry are marked differently', async () => {
    await setTheme({ appearance: 'pillar_dark' });
    const body = (await new Browser(app).get(`/a/${alias}/2`)).body;
    assert.match(body, /<summary class="in-trail">.*People/);
    assert.match(body, /<a href="[^"]*\/2" aria-current="page">.*Employee list/);
    // a child page (3, not in the menu) keeps its menu parent (page 2) in the trail
    const child = (await new Browser(app).get(`/a/${alias}/3`)).body;
    assert.match(child, /<a href="[^"]*\/2" class="in-trail">/);
    assert.doesNotMatch(child, /aria-current="page"/);
  });

  test('app.css: pillar appearances, tree states, RTL, subtle colours and the processing bar', () => {
    const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    for (const sel of ['body.nav-pillar-light {', 'body.nav-pillar-dark {', 'body.nav-pillar .t-header { box-shadow: inset 0 4px 0 var(--strip, var(--accent)); }',
      '.t-nav .in-trail {', '.t-nav a:focus-visible', '[dir="rtl"] .t-nav { transform: translateX(100%)', '.u-color-1-subtle', '.u-color-15-subtle',
      '.u-color-success-subtle', '.u-color-neutral-subtle', '.region[aria-busy="true"]::after'])
      assert.ok(css.includes(sel), sel);
    // the navigation's own rules use logical properties (RTL)
    const nav = css.slice(css.indexOf('.t-nav { background'), css.indexOf('/* ---------- main'));
    assert.doesNotMatch(nav, /border-right|margin-left|padding-left|inset 3px 0 0/);
  });
});

describe('Theme Roller', () => {
  const login = async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    return dev;
  };

  test('offers Pillar Light and Pillar Dark with the header strip colours', async () => {
    await setTheme({});
    const dev = await login();
    const page = (await dev.get(`/builder/apps/${appId}/theme`)).body;
    assert.match(page, /<option value="pillar_dark"[^>]*>Pillar Dark<\/option>/);
    assert.match(page, /<option value="pillar_light"[^>]*>Pillar Light<\/option>/);
    assert.match(page, /name="strip_own"/);
    assert.match(page, /class="tr-preview-nav"/);
    assert.match(page, /tr-nav-current/);
    await dev.submit(`/builder/apps/${appId}/theme/settings`, { style: '', appearance: 'pillar_dark', strip: '#E8590C', strip_own: 'true', strip_dark: '#ffa94d' });
    const t = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.equal(t.appearance, 'pillar_dark');
    assert.equal(t.strip, '#e8590c');
    assert.equal(t.strip_dark, undefined, 'not ticked: not stored');
    assert.match((await dev.get(`/builder/apps/${appId}/theme`)).body, /data-tr-app-appearance="pillar_dark"/);
    await dev.submit(`/builder/apps/${appId}/theme/settings`, { style: '', appearance: '' });
    const off = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.equal(off.appearance, undefined);
    assert.equal(off.strip, undefined);
  });

  test('a style with an appearance and a strip; the list shows them', async () => {
    await setTheme({});
    const dev = await login();
    await dev.get(`/builder/apps/${appId}/theme`);
    await dev.submit(`/builder/apps/${appId}/theme/styles`, { name: 'Pillar', appearance: 'pillar_dark', strip: '#0b7285', strip_own: 'true', strip_dark_item: '&app_strip.' });
    const t = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.deepEqual(t.styles, [{ name: 'Pillar', appearance: 'pillar_dark', strip: '#0b7285', strip_dark: '&APP_STRIP.' }]);
    const list = (await dev.get(`/builder/apps/${appId}/theme`)).body;
    assert.match(list, /<td>Pillar Dark<\/td>/);
  });

  test('Settings → Theme keeps the appearance and strip (they belong to the Theme Roller)', async () => {
    await setTheme({ appearance: 'pillar_light', strip: '#e8590c' });
    const dev = await login();
    await dev.get(`/builder/apps/${appId}/settings`);
    await dev.submit(`/builder/apps/${appId}/settings`, { name: 'Pillar test', alias, home_page: '1', authentication: 'none', nav: 'side', mode: 'auto', local_login: 'true', language: 'en', language_from: 'browser' });
    const t = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.equal(t.appearance, 'pillar_light');
    assert.equal(t.strip, '#e8590c');
  });

  test('the appearance travels with the export', async () => {
    await setTheme({ appearance: 'pillar_dark', strip: '#e8590c', styles: [{ name: 'Light', appearance: 'pillar_light' }] });
    const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
    assert.equal(doc.app.theme.appearance, 'pillar_dark');
    assert.equal(doc.app.theme.strip, '#e8590c');
    assert.equal(doc.app.theme.styles[0].appearance, 'pillar_light');
  });
});
