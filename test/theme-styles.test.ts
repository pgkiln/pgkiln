// Sprint 33 item 6: Theme Roller style variants (several saved styles per
// app, a default, users may switch) and template options on regions and
// buttons (a fixed list of CSS classes per component type).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { COMPONENTS, parseFields } from '../src/builder/components.ts';
import { closePools, owner } from '../src/db.ts';
import { appStyles, chosenStyle, parseStyle, themeCss } from '../src/runtime/styles.ts';
import { templateClasses } from '../src/runtime/template-options.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const alias = 'ts-s33';

const STYLES = [
  { name: 'Ocean', accent: '#0b7285', header: '#0b3d49', font: 'serif', radius: 'none' },
  { name: 'Big text', font_size: 'large' },
];
const styleTag = (body: string) => /<style nonce="[^"]+" id="pgapex-css">([\s\S]*?)<\/style>/.exec(body)?.[1] ?? '';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.app where alias = $1', [alias]);
  appId = (await owner.one(
    `insert into meta.app (alias, name, authentication, theme) values ($1, 'Theme test', 'none', $2) returning id`,
    [alias, JSON.stringify({ accent: '#123456', styles: STYLES, style: 'Ocean', style_choice: true })],
  )).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const r = await owner.one(
    `insert into meta.region (page_id, seq, title, type, source, template_options) values ($1, 10, 'Hello', 'static', '<p>Hi</p>', '{to-accent,to-unknown,to-compact}') returning id`,
    [pageId],
  );
  await owner.query(`insert into meta.button (page_id, region_id, name, label, template_options) values ($1, $2, 'GO', 'Go', '{to-pill,to-large}')`, [pageId, r.id]);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await app.close();
  await closePools();
});

describe('style variants: checking and CSS', () => {
  test('parseStyle keeps values from the fixed lists only', () => {
    assert.deepEqual(parseStyle({ name: ' Ocean ', accent: '#ABCDEF', font: 'serif', font_size: '', radius: 'small' }), { name: 'Ocean', accent: '#abcdef', font: 'serif', radius: 'small' });
    assert.match(parseStyle({ name: '' }) as string, /Name/);
    assert.match(parseStyle({ name: 'x', accent: 'red' }) as string, /Accent colour/);
    assert.match(parseStyle({ name: 'x', font: 'Comic Sans' }) as string, /Font: choose from/);
    assert.match(parseStyle({ name: 'x', radius: 'toString' }) as string, /Corners/, 'no inherited keys');
    assert.match(parseStyle({ name: 'x', font_size: '99px' }) as string, /Font size/);
  });

  test('stored styles are checked again; the CSS holds constants and hex values only', () => {
    const theme = { styles: [{ name: 'Bad', accent: 'red;}body{x' }, { name: 'Good', font: 'mono', font_size: 'small', radius: 'large' }, { name: 'good' }, 'junk'] };
    assert.deepEqual(appStyles(theme).map((s) => s.name), ['Good'], 'invalid, duplicate (case-insensitive) and non-objects skipped');
    const css = themeCss({ accent: '#111111' }, appStyles(theme)[0]);
    assert.match(css, /--accent:#111111/);
    assert.match(css, /--font:ui-monospace/);
    assert.match(css, /--font-size:14px/);
    assert.match(css, /--radius:14px/);
    assert.equal(themeCss({}, null), '');
  });

  test('the request style: the user choice when allowed and existing, else the default', () => {
    const a = { theme: { styles: STYLES, style: 'Ocean', style_choice: true } };
    assert.equal(chosenStyle(a, { state: {} })?.name, 'Ocean');
    assert.equal(chosenStyle(a, { state: { __STYLE: 'Big text' } })?.name, 'Big text');
    assert.equal(chosenStyle(a, { state: { __STYLE: '' } }), null, 'Standard');
    assert.equal(chosenStyle(a, { state: { __STYLE: 'Gone' } })?.name, 'Ocean', 'a deleted style falls back');
    assert.equal(chosenStyle({ theme: { ...a.theme, style_choice: false } }, { state: { __STYLE: 'Big text' } })?.name, 'Ocean', 'no choice: the default');
  });
});

describe('style variants in the application', () => {
  test('the default style is in the page CSS and the user menu offers the styles', async () => {
    const b = new Browser(app);
    const page = await b.get(`/a/${alias}/1`);
    assert.equal(page.statusCode, 200);
    const css = styleTag(page.body);
    assert.match(css, /--accent:#123456/, 'base colours');
    assert.match(css, /--accent:#0b7285/, 'the default style');
    assert.match(css, /--font:Charter/);
    assert.match(css, /--radius:0px/);
    assert.match(page.body, /class="menu-section style-switch"/);
    assert.match(page.body, /<button name="style" value="Big text" aria-pressed="false">/);
    assert.match(page.body, /<button name="style" value="Ocean" aria-pressed="true">/);
    assert.match(page.body, /<button name="style" value="" aria-pressed="false">.*Standard<\/button>/);
  });

  test('a user switches style (session), only to one of the app\'s styles', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/account/style`, { style: 'Big text', next: `/a/${alias}/1` });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `/a/${alias}/1`);
    let css = styleTag((await b.get(`/a/${alias}/1`)).body);
    assert.match(css, /--font-size:16px/);
    assert.doesNotMatch(css, /#0b7285/);
    await b.submit(`/a/${alias}/account/style`, { style: 'Nope', next: `/a/${alias}/1` });
    css = styleTag((await b.get(`/a/${alias}/1`)).body);
    assert.match(css, /--font-size:16px/, 'unknown style ignored');
    await b.submit(`/a/${alias}/account/style`, { style: '', next: `/a/${alias}/1` });
    css = styleTag((await b.get(`/a/${alias}/1`)).body);
    assert.doesNotMatch(css, /--font-size|#0b7285/, 'Standard');
    assert.match(css, /--accent:#123456/);
  });

  test('without "users may choose" there is no switch and the default holds', async () => {
    await owner.query(`update meta.app set theme = theme || '{"style_choice": false}' where id = $1`, [appId]);
    try {
      const b = new Browser(app);
      await b.get(`/a/${alias}/1`);
      await b.submit(`/a/${alias}/account/style`, { style: 'Big text', next: `/a/${alias}/1` });
      const page = (await b.get(`/a/${alias}/1`)).body;
      assert.doesNotMatch(page, /style-switch/);
      assert.match(styleTag(page), /#0b7285/);
      assert.doesNotMatch(styleTag(page), /--font-size/);
    } finally {
      await owner.query(`update meta.app set theme = theme || '{"style_choice": true}' where id = $1`, [appId]);
    }
  });

  test('a signed-in user\'s style is kept on the account per app and applied at the next sign-in', async () => {
    const hr = (await owner.one(`select id, theme from meta.app where alias = 'hr'`));
    await owner.query(`update meta.app set theme = theme || $2::jsonb where id = $1`, [hr.id, JSON.stringify({ styles: STYLES, style_choice: true })]);
    try {
      const b = new Browser(app);
      await b.login('allen');
      const acc = await b.get('/a/hr/account');
      assert.match(acc.body, /<select id="style" name="style">/);
      assert.equal((await b.submit('/a/hr/account', { style: 'Ocean' })).statusCode, 303);
      const row = await owner.one(`select s.style from meta.account_style s join meta.account a on a.id = s.account_id where a.username = 'allen' and s.app_id = $1`, [hr.id]);
      assert.equal(row?.style, 'Ocean');
      const again = new Browser(app);
      await again.login('allen');
      assert.match(styleTag((await again.get('/a/hr/1')).body), /#0b7285/, 'from the account at sign-in');
      // the quick switch saves it too
      await again.submit('/a/hr/account/style', { style: 'Big text', next: '/a/hr/1' });
      assert.equal((await owner.one(`select s.style from meta.account_style s join meta.account a on a.id = s.account_id where a.username = 'allen' and s.app_id = $1`, [hr.id]))?.style, 'Big text');
    } finally {
      await owner.query(`update meta.app set theme = $2 where id = $1`, [hr.id, JSON.stringify(hr.theme)]);
      await owner.query(`delete from meta.account_style where app_id = $1`, [hr.id]);
    }
  });
});

describe('template options', () => {
  test('known classes are rendered, unknown ones ignored', async () => {
    assert.equal(templateClasses('region', ['to-scroll', 'to-accent', 'evil']), ' to-accent to-scroll');
    assert.equal(templateClasses('button', null), '');
    assert.equal(templateClasses('button', ['to-accent']), '', 'per component type');
    const page = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(page, /class="region region-static region-standard col-12 to-accent to-compact"/);
    assert.doesNotMatch(page, /to-unknown/);
    assert.match(page, /class="btn to-large to-pill"/);
  });

  test('the property editor offers them as checkboxes and keeps only listed values', async () => {
    const v = parseFields(COMPONENTS.region, { title: 'x', type: 'static', template_options: ['to-flat', 'nope', 'to-accent'] as unknown as string });
    assert.deepEqual(v.template_options, ['to-accent', 'to-flat']);
    assert.deepEqual(parseFields(COMPONENTS.button, { name: 'X', label: 'x' }).template_options, []);
    assert.deepEqual(parseFields(COMPONENTS.button, { name: 'X', label: 'x', template_options: 'to-pill' }).template_options, ['to-pill']);
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const r = await owner.one('select id from meta.region where page_id = $1', [pageId]);
    const designer = await dev.get(`/builder/pages/${pageId}?c=region-${r.id}`);
    assert.match(designer.body, /<input type="checkbox" name="template_options" value="to-accent" checked>/);
    assert.match(designer.body, /<input type="checkbox" name="template_options" value="to-scroll">/);
    const res = await dev.submit(`/builder/pages/${pageId}/c/region/${r.id}`, {
      title: 'Hello', type: 'static', source: '<p>Hi</p>', columns: '12', template: 'standard', config: '', seq: '10',
      template_options: ['to-scroll', 'to-borderless', 'x-y'],
    });
    assert.equal(res.statusCode, 303);
    assert.deepEqual((await owner.one('select template_options from meta.region where id = $1', [r.id])).template_options, ['to-borderless', 'to-scroll']);
  });

  test('they travel with the export; an export without them still imports', async () => {
    const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
    assert.deepEqual(doc.pages[0].buttons[0].template_options, ['to-pill', 'to-large']);
    assert.equal(doc.app.theme.styles.length, 2);
    for (const r of doc.pages[0].regions) delete r.template_options;
    for (const b of doc.pages[0].buttons) delete b.template_options;
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s33-copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const rows = (await owner.query('select r.template_options from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1', [id])).rows;
      assert.deepEqual(rows.map((x) => x.template_options), [[]]);
      assert.equal((await owner.one('select theme from meta.app where id = $1', [id])).theme.style, 'Ocean');
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });
});

describe('Theme Roller in the builder', () => {
  test('add, rename (default and users follow), delete; app settings keep the styles', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = await dev.get(`/builder/apps/${appId}/theme`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Theme Roller: style variants/);
    assert.match(page.body, /Big text/);
    // add
    let res = await dev.submit(`/builder/apps/${appId}/theme/styles`, { name: 'Forest', accent: '#2b8a3e', accent_own: 'true', header: '#000000', font: 'humanist', font_size: '', radius: 'small' });
    assert.equal(res.statusCode, 303);
    let theme = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.deepEqual(theme.styles.at(-1), { name: 'Forest', accent: '#2b8a3e', font: 'humanist', radius: 'small' }, 'header without "use" is left out');
    // a duplicate name and a bad value are refused
    await dev.get(`/builder/apps/${appId}/theme`);
    await dev.submit(`/builder/apps/${appId}/theme/styles`, { name: 'forest' });
    await dev.submit(`/builder/apps/${appId}/theme/styles`, { name: 'Odd', font: 'papyrus' });
    theme = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.equal(theme.styles.length, 3);
    // rename the default: the default and users' choices follow
    const acc = await owner.one(`select id from meta.account where username = 'allen'`);
    await owner.query(`insert into meta.account_style values ($1, $2, 'Ocean') on conflict (account_id, app_id) do update set style = 'Ocean'`, [acc.id, appId]);
    await dev.get(`/builder/apps/${appId}/theme?edit=Ocean`);
    res = await dev.submit(`/builder/apps/${appId}/theme/styles`, { original: 'Ocean', name: 'Sea', accent: '#0b7285', accent_own: 'true', font: 'serif', radius: 'none' });
    theme = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.equal(theme.style, 'Sea');
    assert.deepEqual(theme.styles.map((x: { name: string }) => x.name), ['Sea', 'Big text', 'Forest']);
    assert.equal((await owner.one('select style from meta.account_style where account_id = $1 and app_id = $2', [acc.id, appId])).style, 'Sea');
    // the default style and the choice
    await dev.get(`/builder/apps/${appId}/theme`);
    await dev.submit(`/builder/apps/${appId}/theme/settings`, { style: 'Forest' });
    theme = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.equal(theme.style, 'Forest');
    assert.equal(theme.style_choice, false);
    await dev.submit(`/builder/apps/${appId}/theme/settings`, { style: 'Missing', style_choice: 'true' });
    assert.equal((await owner.one('select theme from meta.app where id = $1', [appId])).theme.style, 'Forest', 'unknown default refused');
    // delete: the default and users' choices of it go
    await dev.submit(`/builder/apps/${appId}/theme/styles/delete`, { name: 'Sea' });
    theme = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.deepEqual(theme.styles.map((x: { name: string }) => x.name), ['Big text', 'Forest']);
    assert.equal(await owner.one('select style from meta.account_style where account_id = $1 and app_id = $2', [acc.id, appId]), undefined);
    // Settings → Theme saves its own keys and keeps the styles
    const settings = await dev.get(`/builder/apps/${appId}/settings`);
    assert.match(settings.body, /Theme Roller: style variants/);
    await dev.submit(`/builder/apps/${appId}/settings`, { name: 'Theme test', alias, home_page: '1', authentication: 'none', accent: '#222222', header: '#333333', nav: 'top', mode: 'auto', user_choice: 'true', local_login: 'true', language: 'en', language_from: 'browser' });
    theme = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    assert.equal(theme.accent, '#222222');
    assert.equal(theme.nav, 'top');
    assert.equal(theme.styles.length, 2);
    assert.equal(theme.style, 'Forest');
    // restore for the other tests
    await owner.query('update meta.app set theme = $2 where id = $1', [appId, JSON.stringify({ accent: '#123456', styles: STYLES, style: 'Ocean', style_choice: true })]);
  });
});
