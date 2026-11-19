// Sprint 231, parity cards AX-13 and AX-14.
// AX-13: the sign-in form's "Remember username" (APEX: P9999_REMEMBER, migration 189, src/remember-username.ts) next to
// "Keep me signed in" (APEX: P9999_PERSISTENT_AUTH, remember_me_days), on the built-in page and in the Login region;
// the App Builder report's Updated by, Working copies and Lock columns (test/app-list.test.ts has the rest).
// AX-14: the built-in template components as region types of their own in the Page Designer's gallery and Type list
// (src/builder/component-regions.ts). The checks an attacker would try are in test/security.test.ts ("sprint 231").
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { saveLoginSettings } from '../src/builder/login-page.ts';
import { componentOfType, regionTypeValue, withComponentTypes } from '../src/builder/component-regions.ts';
import { BUILTIN_COMPONENTS } from '../src/runtime/builtin-components.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hrId: number;
let saved: { remember_me_days: number | null; remember_username: boolean; login_page: number | null };
let loginPageId: number;
const LOGIN_PAGE = 9231;
const alias = 'tc-231';
let appId: number;
let pageId: number;

before(async () => {
  app = await buildApp({ logger: false });
  const a = await owner.one(`select id, remember_me_days, remember_username, login_page from meta.app where alias = 'hr'`);
  hrId = a.id;
  saved = { remember_me_days: a.remember_me_days, remember_username: a.remember_username, login_page: a.login_page };
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [hrId, LOGIN_PAGE]);
  loginPageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth, page_template) values ($1, $2, 'Login 231', false, 'minimal') returning id`, [hrId, LOGIN_PAGE])).id;
  await owner.query(`insert into meta.region (page_id, seq, title, type, template) values ($1, 10, 'Sign in', 'login', 'standard')`, [loginPageId]);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'TC 231', 'none', 'hr_app') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
});

after(async () => {
  await owner.query('update meta.app set remember_me_days = $2, remember_username = $3, login_page = $4 where id = $1', [hrId, saved.remember_me_days, saved.remember_username, saved.login_page]);
  await owner.query('delete from meta.page where app_id = $1 and page_no = $2', [hrId, LOGIN_PAGE]);
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await app.close();
  await closePools();
});

const setHr = (cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  return owner.query(`update meta.app set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [hrId, ...keys.map((k) => cols[k])]);
};
const cookieName = () => `pgkiln_user_${hrId}`;
const signIn = async (b: Browser, form: Record<string, string>) => {
  await b.get('/a/hr/login');
  return b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'king', password: 'king', ...form });
};
const setCookie = (res: { headers: Record<string, unknown> }, name: string) =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`));

describe('AX-13: Remember username and Keep me signed in on the sign-in card', () => {
  test('the built-in sign-in page offers Remember username; Keep me signed in only where the application allows it', async () => {
    await setHr({ remember_username: true, remember_me_days: null, login_page: null });
    const page = (await new Browser(app).get('/a/hr/login')).body;
    assert.match(page, /<div class="login-checks">\s*<label class="check"><input type="checkbox" name="remember_username" value="true"> Remember username<\/label>/);
    assert.doesNotMatch(page, /name="remember"/, 'no persistent sign-in without remember_me_days');
    await setHr({ remember_me_days: 30 });
    const both = (await new Browser(app).get('/a/hr/login')).body;
    assert.match(both, /name="remember_username"[\s\S]*<input type="checkbox" name="remember" value="true"> Keep me signed in for 30 days/);
    // in Dutch too (one of the 22 languages)
    const nl = (await new Browser(app, { 'accept-language': 'nl' }).get('/a/hr/login')).body;
    if (/lang="nl"/.test(nl)) assert.match(nl, /Gebruikersnaam onthouden/);
  });

  test('checked: the cookie keeps the name and the form is filled in; unchecked later: forgotten', async () => {
    await setHr({ remember_username: true, remember_me_days: null });
    const b = new Browser(app);
    const res = await signIn(b, { remember_username: 'true' });
    assert.equal(res.statusCode, 303);
    const c = setCookie(res, cookieName());
    assert.ok(c, 'the cookie is set');
    assert.match(c!, /^pgkiln_user_\d+=king;/);
    assert.match(c!, /Path=\/a\/hr/);
    assert.match(c!, /SameSite=Lax/);
    assert.match(c!, /HttpOnly/);
    assert.match(c!, /Max-Age=15552000/);
    // a new browser session with only that cookie: the name filled in and the box checked, the cursor in the password
    const next = new Browser(app);
    next.cookies.set(cookieName(), 'king');
    const form = (await next.get('/a/hr/login')).body;
    assert.match(form, /<input id="username" name="username" value="king" autocomplete="username" required/);
    assert.match(form, /<input id="password" name="password" type="password" autocomplete="current-password" autofocus/);
    assert.match(form, /name="remember_username" value="true" checked/);
    // signing in again with the box unchecked removes the cookie
    const again = await signIn(next, {});
    assert.equal(again.statusCode, 303);
    assert.match(setCookie(again, cookieName()) ?? '', /Expires=Thu, 01 Jan 1970/);
    assert.equal(next.cookies.has(cookieName()), false);
  });

  test('the application turns it off: no box, the cookie is neither read nor set', async () => {
    await setHr({ remember_username: false });
    const b = new Browser(app);
    b.cookies.set(cookieName(), 'king');
    const form = (await b.get('/a/hr/login')).body;
    assert.doesNotMatch(form, /remember_username/);
    assert.match(form, /<input id="username" name="username" value="" /);
    const res = await signIn(new Browser(app), { remember_username: 'true' });
    assert.equal(setCookie(res, cookieName()), undefined);
    await setHr({ remember_username: true });
  });

  test('the Login region of an own login page: filled in; {"remember_username": false} and {"persistent_auth": false} leave the boxes out', async () => {
    await setHr({ remember_username: true, remember_me_days: 14 });
    const b = new Browser(app);
    b.cookies.set(cookieName(), 'king');
    const page = (await b.get(`/a/hr/${LOGIN_PAGE}`)).body;
    assert.match(page, /name="username" value="king"[^>]*form="pgkiln-login"/);
    assert.match(page, /name="remember_username" value="true" checked form="pgkiln-login"/);
    assert.match(page, /name="remember" value="true" form="pgkiln-login"> Keep me signed in for 14 days/);
    await owner.query(`update meta.region set config = '{"remember_username": false, "persistent_auth": false}' where page_id = $1`, [loginPageId]);
    const plain = (await b.get(`/a/hr/${LOGIN_PAGE}`)).body;
    assert.doesNotMatch(plain, /name="remember_username"|name="remember"/);
    assert.match(plain, /name="username" value=""/, 'nor is the name filled in');
    await owner.query(`update meta.region set config = '{}' where page_id = $1`, [loginPageId]);
  });

  test('Application settings: the box under Staying signed in, saved with the sign-in settings', async () => {
    const admin = new Browser(app);
    await admin.get('/builder/login');
    assert.equal((await admin.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
    const settings = (await admin.get(`/builder/apps/${hrId}/settings`)).body;
    assert.match(settings, /<input type="checkbox" name="remember_username" value="true" aria-describedby="f_remember_username_help" checked> Offer &quot;Remember username&quot;/);
    const a = await owner.one('select * from meta.app where id = $1', [hrId]);
    const keep = { login_page: a.login_page ? String(a.login_page) : '', password_reset: a.password_reset ? 'true' : '', mfa: a.mfa, mfa_roles: (a.mfa_roles ?? []).join(','), mfa_email: a.mfa_email ? 'true' : '', passkey_signin: a.passkey_signin ? 'true' : '' };
    await saveLoginSettings(String(hrId), keep);
    assert.equal((await owner.one('select remember_username from meta.app where id = $1', [hrId])).remember_username, false);
    await saveLoginSettings(String(hrId), { ...keep, remember_username: 'true' });
    assert.equal((await owner.one('select remember_username from meta.app where id = $1', [hrId])).remember_username, true);
  });

  test('an export made before migration 189 imports with Remember username on', async () => {
    const r = await owner.one(`insert into meta.app (alias, name, authentication, db_role, remember_username) values ('tc-231-old', 'Old', 'none', 'hr_app', null) returning remember_username`);
    assert.equal(r.remember_username, true);
    await owner.query(`delete from meta.app where alias = 'tc-231-old'`);
  });
});

describe('AX-14: template components as region types', () => {
  const admin = async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
    return b;
  };
  const regions = async () => (await owner.query('select id, title, type, source, config from meta.region where page_id = $1 order by id', [pageId])).rows;

  test('the type list: every built-in component right after Template Component', () => {
    const list = withComponentTypes(['cards', 'template_component', 'list']);
    assert.deepEqual(list, ['cards', 'template_component', ...BUILTIN_COMPONENTS.map((c) => `template_component:${c.static_id}`), 'list']);
    assert.equal(componentOfType('template_component:ut_badge'), 'ut_badge');
    assert.equal(componentOfType('template_component:no_such'), null);
    assert.equal(regionTypeValue({ type: 'template_component', config: { component: 'ut_metric_card' } }), 'template_component:ut_metric_card');
    assert.equal(regionTypeValue({ type: 'template_component', config: { component: 'my_own' } }), 'template_component', "an application's own component");
  });

  test('the gallery: Avatar, Badge, Comments, Content Row, Media List, Metric Card and Timeline next to Cards and Chart', async () => {
    const b = await admin();
    const page = (await b.get(`/builder/pages/${pageId}`)).body;
    for (const [id, name] of [['ut_avatar', 'Avatar'], ['ut_badge', 'Badge'], ['ut_comments', 'Comments'], ['ut_content_row', 'Content Row'], ['ut_media_list', 'Media List'], ['ut_metric_card', 'Metric Card'], ['ut_timeline', 'Timeline']])
      assert.match(page, new RegExp(`<a class="pd-gal" href="[^"]*new=region&amp;type=template_component:${id}" draggable="true" data-new="region" data-type="template_component:${id}" title="[^"]*"><svg[^]*?</svg><span>${name}</span></a>`), name);
  });

  test('the create form from the gallery: the type preset (Metric Card), a sample query; creating makes a template_component region of it', async () => {
    const b = await admin();
    const form = (await b.get(`/builder/pages/${pageId}?new=region&type=template_component:ut_metric_card`)).body;
    assert.match(form, /<option value="template_component:ut_metric_card" selected>Metric Card<\/option>/);
    assert.match(form, /<textarea id="f_region_source"[^>]*>select \* from \(values \(&#39;Orders&#39;/);
    const res = await b.submit(`/builder/pages/${pageId}/c/region`, { title: 'Metrics', type: 'template_component:ut_metric_card', columns: '12', template: 'standard', source: '' });
    assert.equal(res.statusCode, 303);
    const r = (await regions()).find((x) => x.title === 'Metrics')!;
    assert.equal(r.type, 'template_component');
    assert.deepEqual(r.config, { component: 'ut_metric_card', display: 'multiple' });
    assert.match(r.source, /as v \(label, value, unit, change, trend, description\)/, 'an empty query gets the sample');
  });

  test('dragged from the gallery: a Badge region with its sample; it renders', async () => {
    const b = await admin();
    await b.get(`/builder/pages/${pageId}`);
    const res = await b.submit(`/builder/pages/${pageId}/layout/create`, { kind: 'region', type: 'template_component:ut_badge', position: 'body' });
    assert.equal(res.statusCode, 303);
    const r = (await regions()).find((x) => x.title === 'New badge')!;
    assert.equal(r.type, 'template_component');
    assert.deepEqual(r.config, { component: 'ut_badge' });
    const run = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(run, /<span class="tc-badge tc-badge-success">Approved<\/span>/);
  });

  test('an existing region shows its component as its type: tree, layout and the Type list', async () => {
    const b = await admin();
    const r = (await regions()).find((x) => x.title === 'New badge')!;
    const page = (await b.get(`/builder/pages/${pageId}?c=region-${r.id}`)).body;
    assert.match(page, /title="New badge \(Badge\)"/, 'the tree');
    assert.match(page, /<div class="pd-region-type">Badge<\/div>/, 'the layout');
    assert.match(page, /<option value="template_component:ut_badge" selected>Badge<\/option>/, 'the Type list');
  });

  test('changing the Type list switches the component (its attributes go); otherwise the Attributes tab decides', async () => {
    const b = await admin();
    const r = (await regions()).find((x) => x.title === 'New badge')!;
    await owner.query(`update meta.region set config = '{"component": "ut_badge", "attributes": {"LABEL": "#label#"}}' where id = $1`, [r.id]);
    await b.get(`/builder/pages/${pageId}?c=region-${r.id}`);
    // the Attributes tab still says Badge: the Type list's Timeline wins (it changed)
    let res = await b.submit(`/builder/pages/${pageId}/c/region/${r.id}`, { title: 'New badge', type: 'template_component:ut_timeline', seq: '10', columns: '12', template: 'standard', source: r.source, __region_type: 'template_component', __settings: 'template-settings', 'template-settings:component': 'ut_badge' });
    assert.equal(res.statusCode, 303);
    let row = (await regions()).find((x) => x.id === r.id)!;
    assert.equal(row.config.component, 'ut_timeline');
    assert.equal(row.config.attributes, undefined);
    // the Type list unchanged (Timeline), the Attributes tab picks Avatar: Avatar
    res = await b.submit(`/builder/pages/${pageId}/c/region/${r.id}`, { title: 'New badge', type: 'template_component:ut_timeline', seq: '10', columns: '12', template: 'standard', source: r.source, __region_type: 'template_component', __settings: 'template-settings', 'template-settings:component': 'ut_avatar' });
    row = (await regions()).find((x) => x.id === r.id)!;
    assert.equal(row.config.component, 'ut_avatar');
    // a report becomes a Badge region
    res = await b.submit(`/builder/pages/${pageId}/c/region`, { title: 'Was a report', type: 'report', columns: '12', template: 'standard', source: 'select 1 as label' });
    const rep = (await regions()).find((x) => x.title === 'Was a report')!;
    await b.submit(`/builder/pages/${pageId}/c/region/${rep.id}`, { title: 'Was a report', type: 'template_component:ut_badge', seq: '20', columns: '12', template: 'standard', source: 'select 1 as label' });
    const now = (await regions()).find((x) => x.id === rep.id)!;
    assert.equal(now.type, 'template_component');
    assert.equal(now.config.component, 'ut_badge');
    assert.equal(now.source, 'select 1 as label', 'its own query stays');
  });

  test('stored as before: the export has a template_component region with config.component', async () => {
    const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
    const text = JSON.stringify(doc);
    assert.match(text, /"type":\s*"template_component"/);
    assert.doesNotMatch(text, /template_component:/, 'the component types are not stored');
  });
});
