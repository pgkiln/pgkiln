// The builder in more languages (sprint 121, WS-7): the message files and their coverage of the builder's
// source (the check CI runs), the sign-in page's language links, the language menu in the status bar, the
// choice stored per developer, and the fallback to English.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { html } from '../src/html.ts';
import { BUTTON_ACTIONS, ITEM_TYPES, POSITIONS, REGION_TYPES, SLOTS } from '../src/builder/arrange.ts';
import { BUILDER_LANGUAGES, builderMessages, builderTranslator, translatorFor, validBuilderLanguage, type BuilderKey } from '../src/builder/i18n.ts';
import { en } from '../src/builder/i18n/en.ts';
import { SQL_TOOLS, TOOL_GROUPS } from '../src/builder/sql-tools.ts';
import { Browser } from './helpers.ts';

const DEV = 'i18n_dev';
const OTHER = 'i18n_other';
const PW = 'I18n-dev-password-1!';
const ENGLISH = en as Record<string, string>;
const de = builderMessages('de');
const fr = builderMessages('fr');
const ja = builderMessages('ja');

let app: FastifyInstance;
let appId: number;
let pageNo: number;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.developer where username = any($1)`, [[DEV, OTHER]]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($3), true), ($2, meta.hash_password($3), true)`, [DEV, OTHER, PW]);
  const a = await owner.one<{ id: number }>(`select id from meta.app where alias = 'hr'`);
  appId = a!.id;
  pageNo = (await owner.one<{ page_no: number }>('select min(page_no) as page_no from meta.page where app_id = $1', [appId]))!.page_no;
});
after(async () => {
  await owner.query(`delete from meta.session where username = any($1) and app_id is null`, [[DEV, OTHER]]);
  await owner.query(`delete from meta.developer where username = any($1)`, [[DEV, OTHER]]);
  await app.close();
  await closePools();
});

/** A browser that signs in to the builder, optionally after a language link on the sign-in page. */
async function signIn(user: string, opts: { lang?: string; browser?: Browser } = {}) {
  const b = opts.browser ?? new Browser(app);
  await b.get(opts.lang ? `/builder/login?lang=${opts.lang}` : '/builder/login');
  const r = await b.submit('/builder/login', { username: user, password: PW });
  assert.equal(r.statusCode, 303, `sign-in as ${user}`);
  return b;
}
const stored = async (user: string) => (await owner.one<{ language: string | null }>('select language from meta.developer where username = $1', [user]))?.language ?? null;
const esc = (s: string) => String(html`${s}`);

// ---------------------------------------------------------------- the coverage check (CI: npm test)
describe('builder message files and their coverage', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []);
  const SOURCE = files(new URL('../src/builder', import.meta.url).pathname).filter((f) => !f.includes('/builder/i18n/'));
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

  test('every key the builder uses (tx, tx.rich, tr(s)) has an English text', () => {
    const missing: string[] = [];
    let literal = 0;
    let templated = 0;
    for (const f of SOURCE) {
      const src = readFileSync(f, 'utf8');
      // tx('key'), tx.rich('key', …), tr(s)('key'), tx(cond ? 'a' : 'b')
      for (const m of src.matchAll(/\b(?:tx(?:\.rich)?|tr\([^()]*\))\(\s*([^,)]*)/g)) {
        const arg = m[1];
        for (const k of arg.matchAll(/'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g)) {
          literal++;
          if (!Object.hasOwn(ENGLISH, k[1])) missing.push(`${f.replace(/.*\/src\//, 'src/')}: ${k[1]}`);
        }
        // a key built from a template (`ago.${unit}`): at least one English key of that shape
        for (const k of arg.matchAll(/`([^`]+)`/g)) {
          templated++;
          const re = new RegExp(`^${k[1].replace(/\./g, '\\.').replace(/\$\{[^}]+\}/g, '[a-z0-9_]+')}$`);
          if (!Object.keys(ENGLISH).some((key) => re.test(key))) missing.push(`${f.replace(/.*\/src\//, 'src/')}: \`${k[1]}\``);
        }
      }
    }
    assert.ok(literal > 400, `found ${literal} keyed texts`);
    assert.ok(templated > 3);
    assert.deepEqual(missing, [], 'builder texts without an English key');
  });

  test('(sprint 123) every text the builder\'s JavaScript asks for (msg(\'js.…\')) has an English text', () => {
    const dir = new URL('../public/', import.meta.url).pathname;
    const used = readdirSync(dir).filter((f) => f.endsWith('.js'))
      .flatMap((f) => [...readFileSync(`${dir}${f}`, 'utf8').matchAll(/\bmsg\(\s*'(js\.[a-z0-9_.]+)'/g)].map((m) => [f, m[1]]));
    assert.ok(used.length > 20, `found ${used.length}`);
    assert.deepEqual(used.filter(([, k]) => !Object.hasOwn(ENGLISH, k)), [], 'browser texts without an English key');
  });

  test('keys made at run time: every region type, item type, button action, position, slot, kind and SQL Workshop tool', () => {
    const want = [
      ...REGION_TYPES().map((t) => `gallery.region.${t}`), ...ITEM_TYPES().map((t) => `gallery.item.${t}`), ...BUTTON_ACTIONS().map((t) => `gallery.button.${t}`),
      ...POSITIONS().map((p) => `pos.${p}`), ...SLOTS().map((p) => `slot.${p}`),
      ...['region', 'item', 'button'].map((k) => `comp.${k}.plural`),
      ...['region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'computation', 'branch'].flatMap((k) =>
        [`comp.${k}`, `pd.new.${k}`, `pd.create.${k}`, `pd.delete.${k}`, `pd.delete_confirm.${k}`, `pd.saved.${k}`, `pd.deleted.${k}`]),
      ...SQL_TOOLS.flatMap((t) => [`sql.tool.${t.key}`, `sql.tool.${t.key}.desc`]), ...TOOL_GROUPS.map(([g]) => `sql.group.${g}`),
    ];
    assert.deepEqual(want.filter((k) => !Object.hasOwn(ENGLISH, k)), []);
    // the English texts of tools are the tools' own (sql-tools.ts stays the source of truth)
    for (const t of SQL_TOOLS) assert.equal(ENGLISH[`sql.tool.${t.key}`], t.label, t.key);
  });

  test('every language file has exactly the English keys, with the same placeholders, and is translated', () => {
    assert.deepEqual(BUILDER_LANGUAGES.map(([c]) => c).sort(), ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'zh-CN', 'zh-TW']);
    for (const [lang] of BUILDER_LANGUAGES) {
      if (lang === 'en') continue;
      const own = builderMessages(lang);
      assert.deepEqual(Object.keys(own).filter((k) => !Object.hasOwn(ENGLISH, k)), [], `${lang}: keys English doesn't have`);
      assert.deepEqual(Object.keys(ENGLISH).filter((k) => !Object.hasOwn(own, k)), [], `${lang}: keys missing`);
      const bad = Object.keys(ENGLISH).filter((k) => placeholders(own[k]) !== placeholders(ENGLISH[k]));
      assert.deepEqual(bad, [], `${lang}: placeholders differ`);
      // mostly translated: product names (App Builder, SQL Workshop) and a few terms are the same
      const same = Object.keys(ENGLISH).filter((k) => own[k] === ENGLISH[k]).length;
      assert.ok(same < Object.keys(ENGLISH).length * 0.15, `${lang}: ${same} texts are the same as English`);
      assert.ok(Object.values(own).every((v) => v.trim() === v && v.length > 0), `${lang}: empty or padded texts`);
    }
  });

  test('a missing key falls back to English, never to the raw key; a run-time key to its fallback', () => {
    const partial = builderTranslator('de', { 'rail.home': 'Startseite' });
    assert.equal(partial('rail.home'), 'Startseite');
    assert.equal(partial('rail.app_builder'), 'App Builder', 'English when the language has no text');
    assert.equal(partial('ab.count', { n: 3 }), '3 applications');
    assert.equal(partial.dyn('gallery.region.no_such_type', 'No such type'), 'No such type');
    assert.equal(translatorFor('de').dyn('gallery.region.report', 'x'), de['gallery.region.report']);
    assert.equal(translatorFor('de').label('App Builder'), de['rail.app_builder']);
    assert.equal(translatorFor('de').label('A page of my own'), 'A page of my own', 'unknown labels stay as they are');
    // a placeholder without a value stays visible rather than disappearing
    assert.equal(translatorFor('en')('ab.count', {}), '{n} applications');
  });

  test('only the known language codes are accepted', () => {
    for (const ok of ['en', 'de', 'es', 'fr', 'it', 'nl', 'pt', 'zh-CN', 'zh-TW', 'ja', 'ko']) assert.equal(validBuilderLanguage(ok), ok);
    for (const bad of ['', 'xx', 'DE', 'de-DE', 'de ', 'zh', 'zh-cn', 'zh-Hans', 'ja-JP', 'toString', '__proto__', 'constructor', null, undefined, 3, ['de']]) assert.equal(validBuilderLanguage(bad), null, String(bad));
  });
});

// ---------------------------------------------------------------- choosing a language
describe('choosing the builder language', () => {
  test('the default is English', async () => {
    await owner.query('update meta.developer set language = null where username = $1', [DEV]);
    const b = await signIn(DEV);
    const home = (await b.get('/builder/apps')).body;
    assert.match(home, /<html lang="en"/);
    assert.ok(home.includes(`>${en['rail.app_builder']}<`));
    assert.ok(home.includes(en['ab.tile.create_text']));
    assert.equal(await stored(DEV), null, 'nothing stored without a choice');
  });

  test('the sign-in page offers the languages as links, in their own language', async () => {
    const page = (await new Browser(app).get('/builder/login')).body;
    assert.match(page, /<nav class="signin-langs" aria-label="Language">/);
    for (const [code, name] of BUILDER_LANGUAGES) assert.ok(page.includes(`href="/builder/login?lang=${code}" lang="${code}" hreflang="${code}"`) && page.includes(`>${esc(name)}</a>`), code);
    // a link keeps where to go after signing in
    assert.ok((await new Browser(app).get('/builder/login?next=%2Fbuilder%2Fsql')).body.includes('href="/builder/login?lang=de&amp;next=%2Fbuilder%2Fsql"'));
  });

  test('choosing Deutsch on the sign-in page: the App Builder, the Page Designer menus and the SQL Workshop tabs in German', async () => {
    const b = new Browser(app);
    const signin = (await b.get('/builder/login?lang=de')).body;
    assert.match(signin, /<html lang="de"/);
    assert.ok(signin.includes(`<h2>${esc(de['signin.welcome'])}</h2>`) && signin.includes(`>${esc(de['signin.submit'])}</button>`));
    assert.ok(signin.includes('href="/builder/login?lang=de" lang="de" hreflang="de" aria-current="true"'));
    assert.ok(b.cookies.get('pgkiln_blang') === 'de', 'the sign-in page remembers it in a cookie');
    await signIn(DEV, { browser: b });
    assert.equal(await stored(DEV), 'de', 'stored for the developer');

    // the shell, the workspace home and the App Builder
    const wh = (await b.get('/builder/home')).body;
    assert.match(wh, /<html lang="de"/);
    for (const k of ['rail.home', 'rail.app_builder', 'rail.admin', 'user.sign_out', 'wh.summary', 'wh.card.apps'] as BuilderKey[]) assert.ok(wh.includes(esc(de[k])), k);
    const ab = (await b.get('/builder/apps')).body;
    for (const k of ['ab.tile.create_text', 'ab.tile.import', 'ab.task.import', 'ab.col.updated_by', 'ab.sort_by', 'ab.recent'] as BuilderKey[]) assert.ok(ab.includes(esc(de[k])), k);
    assert.ok(ab.includes(`placeholder="${esc(de['bar.search_placeholder'])}"`));
    // an application's home: tabs, toolbar, tasks
    const appHome = (await b.get(`/builder/apps/${appId}`)).body;
    for (const k of ['app.tab.pages', 'app.tab.shared', 'app.tab.settings', 'app.create_page', 'app.task.run', 'app.from_table'] as BuilderKey[]) assert.ok(appHome.includes(esc(de[k])), k);

    // the Page Designer: toolbar menus, tree headings, gallery
    const pd = (await b.get(`/builder/apps/${appId}/pages/${pageNo}`)).body;
    assert.match(pd, /<html lang="de"/);
    for (const k of ['pd.menu.create', 'pd.menu.utilities', 'pd.menu.page_item', 'pd.menu.all_pages', 'pd.menu.export', 'pd.undo', 'pd.tab.rendering', 'pd.tab.da', 'pd.tab.processing',
      'pd.tree.pre_rendering', 'pd.gallery.regions', 'gallery.region.report', 'gallery.item.date', 'pd.pane.tree', 'pd.properties'] as BuilderKey[])
      assert.ok(pd.includes(esc(de[k])), k);
    assert.notEqual(de['pd.menu.utilities'], en['pd.menu.utilities']);

    // the SQL Workshop: its tabs, the More menu and the Launchpad
    const sw = (await b.get('/builder/sql')).body;
    const tabs = /<nav class="ide-tabs sw-tabs[\s\S]*?<\/nav>/.exec(sw)![0];
    for (const k of ['rail.home', 'sql.tool.worksheet', 'sql.tool.objects', 'sql.tool.scripts', 'sql.tool.utilities', 'sw.more', 'sql.group.development', 'sql.tool.quicksql'] as BuilderKey[])
      assert.ok(tabs.includes(esc(de[k])), k);
    assert.ok(!tabs.includes('>Object Browser<'), 'not English');
    assert.ok(sw.includes(esc(de['sql.tool.worksheet.desc'])) && sw.includes(esc(de['sw.recent_tables'])));
    // the tabs on a tool's own page too
    assert.ok((await b.get('/builder/sql/scripts')).body.includes(`<span>${esc(de['sql.tool.scripts'])}</span>`));
  });

  test('the choice holds per developer: in a new session on another device, and after signing out', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = $1`, [DEV]);
    const b = await signIn(DEV);
    assert.match((await b.get('/builder/apps')).body, /<html lang="de"/);
    assert.equal(b.cookies.get('pgkiln_blang'), 'de', 'the sign-in page of this device follows');
    await b.get('/builder/apps');
    await b.submit('/builder/logout', {});
    const signin = (await b.get('/builder/login')).body;
    assert.match(signin, /<html lang="de"/, 'the sign-in page after signing out');
    // another developer without a choice, on another device: English
    await owner.query('update meta.developer set language = null where username = $1', [OTHER]);
    assert.match((await (await signIn(OTHER)).get('/builder/apps')).body, /<html lang="en"/);
  });

  test('the language menu in the status bar switches and stores it (a form, no script needed)', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = $1`, [DEV]);
    const b = await signIn(DEV);
    const page = (await b.get('/builder/sql')).body;
    const menu = /<details class="menu ide-lang"[\s\S]*?<\/details>/.exec(page)![0];
    assert.ok(/<footer class="ide-status">[\s\S]*<details class="menu ide-lang"/.test(page), 'in the footer');
    assert.match(menu, /<form method="post" action="\/builder\/language"/);
    assert.match(menu, /name="__csrf"/);
    for (const [code, name] of BUILDER_LANGUAGES) assert.ok(menu.includes(`value="${code}" lang="${code}"`) && menu.includes(esc(name)), code);
    assert.match(menu, /value="de" lang="de" aria-current="true"/);
    const sw = await b.app.inject({ method: 'POST', url: '/builder/language', headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', host: 'builder.test', referer: 'http://builder.test/builder/sql' }, payload: `__csrf=${b.lastCsrf}&language=fr` });
    assert.equal(sw.statusCode, 303);
    assert.equal(sw.headers.location, '/builder/sql', 'back to the page');
    assert.equal(await stored(DEV), 'fr');
    for (const c of sw.cookies as { name: string; value: string }[]) b.cookies.set(c.name, c.value);
    const after = (await b.get('/builder/sql')).body;
    assert.match(after, /<html lang="fr"/);
    assert.ok(after.includes(esc(fr['sql.tool.objects'])));
    // and back to English
    assert.equal((await b.submit('/builder/language', { language: 'en' })).statusCode, 303);
    assert.equal(await stored(DEV), 'en');
    assert.match((await b.get('/builder/apps')).body, /<html lang="en"/);
  });

  test('screens not moved to message files yet stay English inside the translated shell', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = $1`, [DEV]);
    const b = await signIn(DEV);
    const page = (await b.get('/builder/import')).body;
    assert.match(page, /<html lang="de"/);
    assert.ok(page.includes(`>${esc(de['rail.app_builder'])}<`), 'the shell in German');
    assert.ok(page.includes('Import an application'), 'the page itself in English');
    // no raw keys on the translated pages
    for (const url of ['/builder/home', '/builder/apps', `/builder/apps/${appId}`, `/builder/apps/${appId}/pages/${pageNo}`, '/builder/sql']) {
      const body = (await b.get(url)).body.replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/g, '');
      const text = body.replace(/<[^>]+>/g, ' ');
      const raw = Object.keys(ENGLISH).filter((k) => text.includes(` ${k} `) || body.includes(`"${k}"`));
      assert.deepEqual(raw, [], `${url}: raw keys`);
    }
  });

  test('(sprint 123) the SQL Worksheet, the Object Browser and Table Properties in German; the browser texts too', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = $1`, [DEV]);
    const b = await signIn(DEV);
    const ws = (await b.get('/builder/sql/worksheet')).body;
    for (const k of ['ws.run_statement', 'ws.run_script', 'ws.tab.result', 'ws.tab.history', 'ws.continue', 'ws.commit.auto'] as BuilderKey[])
      assert.ok(ws.includes(esc(de[k])), `worksheet: ${k}`);
    assert.doesNotMatch(ws, />Run Statement</);
    // the browser's texts: JSON in an attribute (escaped like any value; no inline script), in the developer's language
    const json = /<div id="builder-texts" hidden data-texts="([^"]*)"><\/div>/.exec(ws);
    assert.ok(json, 'the builder-texts element');
    assert.doesNotMatch(ws, /<script(?![^>]*src=)/, 'no inline script');
    const texts = JSON.parse(json![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert.equal(texts['js.ws.txn_none'], de['js.ws.txn_none']);
    assert.ok(Object.keys(texts).length > 10 && Object.keys(texts).every((k) => k.startsWith('js.')), 'only the js.* keys');
    // a run: the status bar in German
    const run = (await b.submit('/builder/sql/worksheet', { sql: 'select 1 as x', mode: 'statement' })).body;
    assert.match(run, /class="ws-last">1 Zeile in \d+ ms\.</);
    const ob = (await b.get('/builder/sql/objects?schema=hr&k=table&o=hr.emp')).body;
    for (const k of ['ob.tab.columns', 'ob.add_col', 'ob.edit_table', 'ob.system'] as BuilderKey[]) assert.ok(ob.includes(esc(de[k])), `object browser: ${k}`);
    assert.ok(ob.includes(`<span>${esc(de['ob.type.table'])}</span>`), 'the object types');
    const te = (await b.get('/builder/sql/objects/table?o=hr.emp')).body;
    for (const k of ['te.preview', 'te.fks', 'te.pk_name'] as BuilderKey[]) assert.ok(te.includes(esc(de[k])), `table properties: ${k}`);
    for (const [url, body] of [['worksheet', ws], ['objects', ob], ['table', te]]) {
      const text = body.replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/g, '').replace(/<[^>]+>/g, ' ');
      assert.deepEqual(Object.keys(ENGLISH).filter((k) => text.includes(` ${k} `)), [], `${url}: raw keys`);
    }
    await owner.query(`update meta.developer set language = null where username = $1`, [DEV]);
  });

  test('(sprint 124) Shared Components, a component list and the application settings in German', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = $1`, [DEV]);
    const b = await signIn(DEV);
    const sc = (await b.get(`/builder/apps/${appId}/shared`)).body;
    for (const k of ['sc.group.logic', 'sc.group.security', 'sc.item.lists_of_values', 'sc.item.authorization_schemes', 'sc.tree_view'] as BuilderKey[])
      assert.ok(sc.includes(esc(de[k])), `shared components: ${k}`);
    const list = (await b.get(`/builder/apps/${appId}/shared?type=lov`)).body;
    assert.ok(list.includes(`<h1>${esc(de['comp.lov.plural'])}</h1>`), 'the list is named in German');
    assert.ok(list.includes(esc(de['sc.details'])));
    const access = (await b.get(`/builder/apps/${appId}/shared?view=tree`)).body;
    for (const k of ['sc.access', 'sc.grant', 'sc.who']) assert.ok(access.includes(esc(de[k as BuilderKey])), `access control: ${k}`);
    const settings = (await b.get(`/builder/apps/${appId}/settings`)).body;
    for (const k of ['st.tab.definition', 'st.tab.errors', 'st.save_settings', 'st.checklist', 'st.db_role_help'] as BuilderKey[])
      assert.ok(settings.includes(esc(de[k])), `settings: ${k}`);
    for (const [url, body] of [['shared', sc], ['list', list], ['access', access], ['settings', settings]]) {
      const text = body.replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/g, '').replace(/<[^>]+>/g, ' ');
      assert.deepEqual(Object.keys(ENGLISH).filter((k) => text.includes(` ${k} `)), [], `${url}: raw keys`);
    }
    // a flash message in German: saving the error settings
    await b.get(`/builder/apps/${appId}/settings?tab=errors`);
    const app = await owner.one<{ error_function: string | null; session_warning_seconds: number }>('select error_function, session_warning_seconds from meta.app where id = $1', [appId]);
    await b.submit(`/builder/apps/${appId}/settings/behaviour`, { error_function: app!.error_function ?? '', session_warning_seconds: String(app!.session_warning_seconds ?? 120) });
    assert.ok((await b.get(`/builder/apps/${appId}/settings?tab=errors`)).body.includes(esc(de['st.saved'])));
    await owner.query(`update meta.developer set language = null where username = $1`, [DEV]);
  });

  test('(sprint 125) the user directory, identity providers, developers and workspaces in German', async () => {
    await owner.query(`update meta.developer set language = 'de' where username = $1`, [DEV]);
    const b = await signIn(DEV);
    const account = (await owner.one<{ id: number }>('select id from meta.account order by id limit 1'))!.id;
    const pages: [string, BuilderKey[]][] = [
      ['/builder/users', ['us.title', 'us.create', 'us.settings', 'us.providers_btn']],
      [`/builder/users/${account}`, ['us.details', 'us.app_access', 'us.set_password']],
      ['/builder/users/providers', ['idp.title', 'idp.add', 'idp.username_claim']],
      ['/builder/developers', ['dev.change_pw', 'dev.accounts', 'dev.add']],
      ['/builder/workspaces', ['wsp.title', 'wsp.add', 'wsp.first_dev']],
      ['/builder/workspaces/1', ['wsp.developers', 'wsp.service', 'wsp.prefs', 'wsp.links', 'wsp.default_no_delete']],
      ['/builder/workspaces/1/utilization', ['wsp.views30', 'wsp.schemas_help']],
    ];
    for (const [url, keys] of pages) {
      const body = (await b.get(url)).body;
      for (const k of keys) assert.ok(body.includes(esc(de[k])), `${url}: ${k}`);
      const text = body.replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/g, '').replace(/<[^>]+>/g, ' ');
      assert.deepEqual(Object.keys(ENGLISH).filter((k) => text.includes(` ${k} `)), [], `${url}: raw keys`);
    }
    await owner.query(`update meta.developer set language = null where username = $1`, [DEV]);
  });

  test('(sprint 134, SEC-5) eleven languages on the sign-in page; 日本語: the Workspace home, App Builder and Developer › Security in Japanese', async () => {
    const b = new Browser(app);
    const signin = (await b.get('/builder/login?lang=ja')).body;
    const links = /<nav class="signin-langs"[\s\S]*?<\/nav>/.exec(signin)![0];
    assert.equal(links.match(/<li>/g)?.length, 11, 'APEX\'s ten and Nederlands');
    for (const name of ['Italiano', '中文 (简体)', '中文 (繁體)', '日本語', '한국어']) assert.ok(links.includes(`>${name}</a>`), name);
    assert.ok(links.includes('href="/builder/login?lang=zh-TW" lang="zh-TW" hreflang="zh-TW"'));
    assert.match(signin, /<html lang="ja"/);
    assert.ok(signin.includes(`<h2>${esc(ja['signin.welcome'])}</h2>`) && signin.includes(`>${esc(ja['signin.submit'])}</button>`));
    await signIn(DEV, { browser: b });
    assert.equal(await stored(DEV), 'ja', 'stored for the developer');

    const wh = (await b.get('/builder/home')).body;
    assert.match(wh, /<html lang="ja"/);
    for (const k of ['rail.home', 'rail.app_builder', 'user.sign_out', 'wh.summary', 'wh.card.apps'] as BuilderKey[]) assert.ok(wh.includes(esc(ja[k])), k);
    const ab = (await b.get('/builder/apps')).body;
    for (const k of ['ab.tile.create_text', 'ab.tile.import', 'ab.col.updated_by', 'ab.recent'] as BuilderKey[]) assert.ok(ab.includes(esc(ja[k])), k);
    const sec = (await b.get('/builder/security')).body;
    for (const k of ['mfa.title', 'mfa.intro', 'mfa.factors', 'mfa.add_app'] as BuilderKey[]) assert.ok(sec.includes(esc(ja[k])), k);
    // Japanese, not English: written in kana and kanji
    for (const k of ['wh.summary', 'ab.tile.create_text', 'mfa.intro'] as BuilderKey[]) assert.match(ja[k], /[\u3040-\u30ff\u4e00-\u9fff]/, k);
    // no raw keys
    for (const page of [wh, ab, sec]) {
      const text = page.replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/g, '').replace(/<[^>]+>/g, ' ');
      assert.deepEqual(Object.keys(ENGLISH).filter((k) => text.includes(` ${k} `)), []);
    }
    // the status bar's menu switches to Traditional Chinese
    assert.equal((await b.submit('/builder/language', { language: 'zh-TW' })).statusCode, 303);
    assert.equal(await stored(DEV), 'zh-TW');
    const zh = (await b.get('/builder/apps')).body;
    assert.match(zh, /<html lang="zh-TW"/);
    assert.ok(zh.includes(esc(builderMessages('zh-TW')['ab.tile.create_text'])));
    await owner.query(`update meta.developer set language = null where username = $1`, [DEV]);
  });

  test('the builder error pages follow the device language', async () => {
    const b = new Browser(app, { accept: 'text/html' });
    await b.get('/builder/login?lang=de');
    const r = await b.get('/builder/no-such-page');
    assert.equal(r.statusCode, 404);
    assert.match(r.body, /<html lang="de"/);
    assert.ok(r.body.includes(`<h1>${esc(de['error.not_found_title'])}</h1>`));
  });
});
