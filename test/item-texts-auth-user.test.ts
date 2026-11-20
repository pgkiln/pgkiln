// Sprint 241 (MG-10, MG-11, MG-13, MG-15; migration 197), found migrating an Appsmith application:
//  - MG-10 an item's placeholder (APEX: Value Placeholder) in empty fields, and as a select list's empty choice;
//  - MG-11 &ITEM. substitutions in item labels (and in the messages that name the item);
//  - MG-13 the page template No navigation: Standard without header, menu and title bar, keeping PWA and push;
//  - MG-15 meta.set_auth_user: custom authentication's post-authentication code names the session's user.
// HR page 68 (part 104) shows the first three; the App Gallery's Sample Processes the fourth.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { authUserProblem } from '../src/customauth.ts';
import { advise } from '../src/builder/advisor.ts';
import { apexToDoc } from '../src/apeximport.ts';
import { readFileSync } from 'node:fs';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hrId: number;
let p68: number;
const alias = 'ts-s241';
const ROLE = 'pgkiln_s241_custom';
const SCHEMA = 's241_custom';
let customId: number;

const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag: string, a: string) => new RegExp(`\\s${a}="([^"]*)"`).exec(tag)?.[1];
/** The fields a form posts, found by its action. */
function formOf(page: string, action: string): Record<string, string> {
  const start = page.lastIndexOf('<form', page.indexOf(`action="${action}"`));
  assert.ok(start >= 0, `a form posts to ${action}`);
  const inner = page.slice(start, page.indexOf('</form>', start));
  const out: Record<string, string> = {};
  for (const [tag] of inner.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name');
    const type = attr(tag, 'type') ?? 'text';
    if (!name || ['file', 'submit', 'button'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag)) continue;
    out[name] = decode(attr(tag, 'value') ?? '');
  }
  for (const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(m[1], 'name');
    const sel = /<option\b[^>]*\sselected\b[^>]*>/.exec(m[2])?.[0] ?? /<option\b[^>]*>/.exec(m[2])?.[0];
    if (name) out[name] = decode((sel && attr(sel, 'value')) ?? '');
  }
  for (const m of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = attr(m[1], 'name');
    if (name) out[name] = decode(m[2]);
  }
  return out;
}
const devLogin = async () => {
  const dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
  return dev;
};
const king = async () => {
  const b = new Browser(app);
  await b.login('king');
  return b;
};

before(async () => {
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  p68 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 68', [hrId])).id;
  // a custom authentication scheme that accepts any case of carol's name
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`create table ${SCHEMA}.users (email text primary key check (email = lower(email)), account text not null, pw text not null)`);
  await owner.query(`insert into ${SCHEMA}.users values ('carol@x.nl', 'carol241', 'Carol-pw-241!')`);
  await owner.query(`grant select on ${SCHEMA}.users to ${ROLE}`);
  customId = (await owner.one(
    `insert into meta.app (alias, name, authentication, db_role, custom_auth_code) values ($1, 'Set auth user', 'custom', $2, $3) returning id`,
    [alias, ROLE, `return exists (select 1 from ${SCHEMA}.users where email = lower(p_username) and pw = p_password);`])).id;
  const page = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home') returning id`, [customId])).id;
  await owner.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Who', 'static', '<p>Signed in as [&APP_USER.]</p>')`, [page]);
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value) values ($1, 'ADMIN', 'role', 'admin')`, [customId]);
  await owner.query(`insert into meta.region (page_id, seq, title, type, source, authz) values ($1, 20, 'Admin', 'static', '<p>admin area</p>', 'ADMIN')`, [page]);
  await owner.query(`insert into meta.account (username) values ('carol241') on conflict do nothing`);
  await owner.query(`insert into meta.app_access (app_id, account_id, roles) select $1, id, '{admin}' from meta.account where username = 'carol241'`, [customId]);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [customId]);
  await owner.query(`delete from meta.account where username = 'carol241'`);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop owned by ${ROLE}`);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

describe('sprint 241 MG-10: placeholders', () => {
  test('HR page 68: in the empty text, e-mail, date and textarea fields, and as the select list\'s empty choice', async () => {
    const page = (await (await king()).get('/a/hr/68')).body;
    assert.match(page, /<input type="text" id="P68_NAME" name="P68_NAME" value="" placeholder="First and last name"/);
    assert.match(page, /id="P68_EMAIL"[^>]*placeholder="name@example.com"/);
    assert.match(page, /id="P68_VISIT_DATE"[^>]*placeholder="Today, or the day you come"[^>]*data-date-mask=/);
    assert.match(page, /<textarea id="P68_NOTE"[^>]*placeholder="Accessibility needs, a parking space, …"/);
    assert.match(page, /<select id="P68_HOST"[^>]*>\s*<option value="">- Choose your host -<\/option>/);
  });

  test('the attribute is escaped and takes &ITEM. substitutions; null_label wins; a date without one shows its format', async () => {
    const id = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P68_NAME'`, [p68])).id;
    const host = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P68_HOST'`, [p68])).id;
    const date = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P68_VISIT_DATE'`, [p68])).id;
    try {
      await owner.query(`update meta.item set placeholder = $2 where id = $1`, [id, `"><script>x</script> for &P68_LABEL_HOST.`]);
      await owner.query(`update meta.item set config = '{"null_label": "- nobody yet -"}' where id = $1`, [host]);
      await owner.query(`update meta.item set placeholder = null where id = $1`, [date]);
      const page = (await (await king()).get('/a/hr/68')).body;
      assert.match(page, /id="P68_NAME"[^>]*placeholder="&quot;&gt;&lt;script&gt;x&lt;\/script&gt; for Who are you visiting\?"/);
      assert.doesNotMatch(page, /<script>x/);
      assert.match(page, /<option value="">- nobody yet -<\/option>/);
      assert.match(page, /id="P68_VISIT_DATE"[^>]*placeholder="YYYY-MM-DD"/);
      // false still leaves the empty choice out
      await owner.query(`update meta.item set config = '{"null_label": false}' where id = $1`, [host]);
      assert.doesNotMatch((await (await king()).get('/a/hr/68')).body, /<select id="P68_HOST"[^>]*>\s*<option value="">/);
    } finally {
      await owner.query(`update meta.item set placeholder = 'First and last name' where id = $1`, [id]);
      await owner.query(`update meta.item set config = '{}' where id = $1`, [host]);
      await owner.query(`update meta.item set placeholder = 'Today, or the day you come' where id = $1`, [date]);
    }
  });

  test('a read-only item shows no placeholder; the database keeps it at 500 characters', async () => {
    const id = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P68_EMAIL'`, [p68])).id;
    try {
      await owner.query(`update meta.item set readonly_condition = 'true' where id = $1`, [id]);
      assert.doesNotMatch((await (await king()).get('/a/hr/68')).body, /placeholder="name@example.com"/);
    } finally {
      await owner.query(`update meta.item set readonly_condition = null where id = $1`, [id]);
    }
    await assert.rejects(owner.query(`update meta.item set placeholder = repeat('x', 501) where id = $1`, [id]), /check/);
  });

  test('the property editor has Value placeholder (Appearance) and saves it', async () => {
    const dev = await devLogin();
    const id = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P68_EMAIL'`, [p68])).id;
    const page = (await dev.get(`/builder/pages/${p68}?c=item-${id}`)).body;
    assert.match(page, /data-prop="placeholder"[\s\S]*?<small class="help">/);
    const f = formOf(page, `/builder/pages/${p68}/c/item/${id}`);
    assert.equal(f.placeholder, 'name@example.com');
    f.placeholder = 'you@example.org';
    const res = await dev.post(`/builder/pages/${p68}/c/item/${id}`, { ...f, __csrf: dev.lastCsrf });
    assert.equal(res.statusCode, 303);
    try {
      assert.equal((await owner.one('select placeholder from meta.item where id = $1', [id])).placeholder, 'you@example.org');
    } finally {
      await owner.query(`update meta.item set placeholder = 'name@example.com' where id = $1`, [id]);
    }
  });

  test('translated with the application (meta.translation), like a label', async () => {
    const b = new Browser(app, { 'accept-language': 'nl' });
    await b.login('king');
    await b.get('/a/hr/1?lang=nl');
    const page = (await b.get('/a/hr/68')).body;
    assert.match(page, /placeholder="Voor- en achternaam"/);
    assert.match(page, /<option value="">- Kies uw gastheer of gastvrouw -<\/option>/);
  });
});

test('MG-10: the APEX importer carries an item\'s Value Placeholder over', () => {
  const F100 = readFileSync(new URL('fixtures/apex/f100.sql', import.meta.url), 'utf8');
  const src = F100.replace(`,p_prompt=>'E-mail'\n`, `,p_prompt=>'E-mail'\n,p_placeholder=>'name@example.com'\n`);
  assert.notEqual(src, F100);
  const { doc } = apexToDoc(src, { alias: 'ts-s241-apex', dbRole: 'hr_app' });
  const item = doc.pages.flatMap((p: any) => p.items).find((i: any) => i.name === 'P3_EMAIL');
  assert.equal(item.placeholder, 'name@example.com');
});

describe('sprint 241 MG-11: &ITEM. in labels', () => {
  test('labels from the administrator\'s table; a change shows at once; values are escaped', async () => {
    const b = await king();
    let page = (await b.get('/a/hr/68')).body;
    assert.match(page, /<label class="label" for="P68_NAME">Your name<span class="req"/);
    assert.match(page, /<label class="label" for="P68_HOST">Who are you visiting\?/);
    await owner.query(`update hr.kiosk_label set label = 'Naam <b>&amp;</b>' where field = 'NAME'`);
    try {
      page = (await b.get('/a/hr/68')).body;
      assert.match(page, /<label class="label" for="P68_NAME">Naam &lt;b&gt;&amp;amp;&lt;\/b&gt;<span/);
    } finally {
      await owner.query(`update hr.kiosk_label set label = 'Your name' where field = 'NAME'`);
    }
  });

  test('the required message names the item by its substituted label; Sign in stores the visit as the user', async () => {
    const b = await king();
    await b.get('/a/hr/68');
    const res = await b.submit('/a/hr/68', { __request: 'SIGN_IN', P68_NAME: '', P68_HOST: '' });
    assert.ok([200, 422].includes(res.statusCode), String(res.statusCode));
    assert.match(res.body, /Your name/);
    assert.doesNotMatch(res.body, /&amp;P68_LABEL_NAME\.|&P68_LABEL_NAME\./);
    const emp = (await owner.one(`select empno from hr.emp order by empno limit 1`)).empno;
    await b.get('/a/hr/68');
    const ok = await b.submit('/a/hr/68', { __request: 'SIGN_IN', P68_NAME: 'Ada Visitor 241', P68_EMAIL: 'ada@example.com', P68_HOST: String(emp), P68_VISIT_DATE: '', P68_NOTE: '' });
    assert.equal(ok.statusCode, 303);
    try {
      const row = await owner.one(`select host_empno, created_by from hr.visitor where name = 'Ada Visitor 241'`);
      assert.deepEqual(row, { host_empno: emp, created_by: 'king' });
    } finally {
      await owner.query(`delete from hr.visitor where name = 'Ada Visitor 241'`);
    }
  });

  test('an item without a label is still named after the item', async () => {
    const id = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P68_EMAIL'`, [p68])).id;
    try {
      await owner.query(`update meta.item set label = null where id = $1`, [id]);
      assert.match((await (await king()).get('/a/hr/68')).body, /<label class="label" for="P68_EMAIL">P68 Email<\/label>/);
    } finally {
      await owner.query(`update meta.item set label = '&P68_LABEL_EMAIL.' where id = $1`, [id]);
    }
  });
});

describe('sprint 241 MG-13: the page template No navigation', () => {
  test('HR page 68: no header, menu or title bar; the PWA, push and live badge attributes stay', async () => {
    const page = (await (await king()).get('/a/hr/68')).body;
    const body = /<body[^>]*>/.exec(page)![0];
    assert.match(body, /class="t-nonav"/);
    assert.match(body, /data-sw="\/a\/hr\/sw.js"/);
    assert.match(body, /data-push="/);
    assert.match(body, /data-live="30"/);
    assert.match(page, /<link rel="manifest"/);
    assert.doesNotMatch(page, /class="t-header"|id="t-nav"|class="t-titlebar"|class="skip-link"/);
    assert.match(page, /<h1 class="sr-only">Welcome<\/h1>/);
    assert.match(page, /<main class="t-main t-nonav-main" id="main">/);
  });

  test('minimal (a sign-in page) still drops push; Standard keeps everything', async () => {
    const b = await king();
    try {
      await owner.query(`update meta.page set page_template = 'minimal' where id = $1`, [p68]);
      const minimal = (await b.get('/a/hr/68')).body;
      assert.doesNotMatch(/<body[^>]*>/.exec(minimal)![0], /data-push=/);
      await owner.query(`update meta.page set page_template = 'standard' where id = $1`, [p68]);
      const standard = (await b.get('/a/hr/68')).body;
      assert.match(standard, /class="t-header"/);
      assert.match(standard, /<div class="t-titlebar">/);
    } finally {
      await owner.query(`update meta.page set page_template = 'no_navigation' where id = $1`, [p68]);
    }
  });

  test('the Page Designer offers and saves it; the UI templates catalogue lists it; other values are refused', async () => {
    const dev = await devLogin();
    const page = (await dev.get(`/builder/pages/${p68}?c=page`)).body;
    assert.match(page, /<option value="no_navigation" selected>Standard without navigation<\/option>/);
    const f = formOf(page, `/builder/pages/${p68}`);
    assert.equal(f.page_template, 'no_navigation');
    assert.equal((await dev.post(`/builder/pages/${p68}`, { ...f, page_template: 'standard', __csrf: dev.lastCsrf })).statusCode, 303);
    assert.equal((await owner.one('select page_template from meta.page where id = $1', [p68])).page_template, 'standard');
    await dev.get(`/builder/pages/${p68}?c=page`);
    assert.equal((await dev.post(`/builder/pages/${p68}`, { ...f, page_template: 'no_navigation', __csrf: dev.lastCsrf })).statusCode, 303);
    assert.equal((await owner.one('select page_template from meta.page where id = $1', [p68])).page_template, 'no_navigation');
    const ui = (await dev.get(`/builder/apps/${hrId}/templates`)).body;
    assert.match(ui, /Standard without navigation[\s\S]*?<code class="small">no_navigation<\/code>/);
    assert.match(ui, /Page 68/);
    await assert.rejects(owner.query(`update meta.page set page_template = 'no_nav' where id = $1`, [p68]), /page_page_template_check/);
  });
});

describe('sprint 241 MG-15: meta.set_auth_user', () => {
  const signIn = async (user: string, password: string) => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/login`);
    return { b, res: await b.submit(`/a/${alias}/login`, { username: user, password }) };
  };
  const setPost = (code: string | null) => owner.query('update meta.app set custom_auth_post_code = $2 where id = $1', [customId, code]);

  test('without it the session\'s user is the name as typed', async () => {
    await setPost(null);
    const { b, res } = await signIn('Carol@X.NL', 'Carol-pw-241!');
    assert.equal(res.statusCode, 303);
    assert.match((await b.get(`/a/${alias}/1`)).body, /Signed in as \[Carol@X.NL\]/);
  });

  test('post-authentication names the user: any case of the e-mail address is one user, with that user\'s roles', async () => {
    await setPost(`perform meta.set_auth_user((select account from ${SCHEMA}.users where email = lower(p_username)));`);
    try {
      for (const typed of ['carol@x.nl', 'CAROL@X.nl', 'Carol@x.NL']) {
        const { b, res } = await signIn(typed, 'Carol-pw-241!');
        assert.equal(res.statusCode, 303, typed);
        const home = (await b.get(`/a/${alias}/1`)).body;
        assert.match(home, /Signed in as \[carol241\]/, typed);
        assert.match(home, /admin area/, 'the roles of the account the name belongs to');
      }
      const log = await owner.one(`select username, detail from meta.activity_log where app_id = $1 and event = 'login' order by id desc limit 1`, [customId]);
      assert.equal(log.username, 'carol241');
      assert.match(log.detail, /^custom; signed in as typed: /);
    } finally {
      await setPost(null);
    }
  });

  test('the sample app Sample Processes signs DEMO in as demo', () => {
    const sql = readFileSync(new URL('../examples/gallery/samples/sample-processes.sql', import.meta.url), 'utf8');
    assert.match(sql, /perform meta\.set_auth_user\(lower\(p_username\)\);/);
  });

  test('the name rules, in Node and in the database alike', async () => {
    const cases = ['jan', ' jan ', '', '   ', 'x'.repeat(100), 'x'.repeat(101), 'a\nb', 'a‮b', 'a​b', 'a\u0085b', 'nobody', 'NoBody', 'Jan@X.nl', 'é'.repeat(100)];
    for (const c of cases) {
      const db = (await owner.one('select meta.auth_user_problem($1) as p', [c])).p;
      assert.equal(authUserProblem(c), db, JSON.stringify(c));
    }
  });

  test('the Advisor: set_auth_user outside post-authentication, a placeholder no type shows', async () => {
    const id = (await owner.one(`select id from meta.item where page_id = $1 and name = 'P68_LABEL_NOTE'`, [p68])).id;
    const proc = (await owner.one(`insert into meta.process (page_id, seq, name, type, point, code) values ($1, 99, 'S241 wrong place', 'sql', 'submit', 'select meta.set_auth_user(''x'')') returning id`, [p68])).id;
    try {
      await owner.query(`update meta.item set placeholder = 'never shown' where id = $1`, [id]);
      const { findings } = await advise(hrId);
      assert.ok(findings.some((f) => f.severity === 'error' && /meta\.set_auth_user works only in the post-authentication code/.test(f.message)));
      assert.ok(findings.some((f) => f.field === 'Value placeholder' && /hidden item shows no placeholder/.test(f.message)));
    } finally {
      await owner.query('delete from meta.process where id = $1', [proc]);
      await owner.query(`update meta.item set placeholder = null where id = $1`, [id]);
    }
  });
});
