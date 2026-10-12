// An application's own login page and "Forgot password?" (sprint 55,
// migration 087). The HR example gets a login page for the length of these
// tests; the password reset mails go through a "log" mail service.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let saved: { login_page: number | null; password_reset: boolean };
const SERVICE = 'LOGIN_PAGE_TEST';
const kingHash = async () => (await owner.one(`select password_hash from meta.account where username = 'king'`)).password_hash as string;
let kingBefore = '';

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  saved = (await owner.one('select login_page, password_reset from meta.app where id = $1', [appId]))!;
  kingBefore = await kingHash();
});

after(async () => {
  await owner.query('update meta.app set login_page = $2, password_reset = $3 where id = $1', [appId, saved.login_page, saved.password_reset]);
  await owner.query(`delete from meta.page where app_id = $1 and name = 'Login' and page_no >= 9999`, [appId]);
  await owner.query('update meta.account set password_hash = $1 where username = $2', [kingBefore, 'king']);
  await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
  await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
  await owner.query(`delete from meta.mail_queue where app_id = $1 and template = 'PASSWORD_RESET'`, [appId]);
  await owner.query('delete from meta.password_reset where app_id = $1', [appId]);
  await owner.query(`delete from meta.activity_log where app_id = $1 and event in ('password_reset_request', 'password_reset')`, [appId]);
  await app.close();
  await closePools();
});

async function developer() {
  const dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  return dev;
}

describe('an application\'s own login page', () => {
  let pageNo = 0;

  test('the builder creates one: a public, minimal page with a login region, made the login page', async () => {
    const dev = await developer();
    const settings = await dev.get(`/builder/apps/${appId}/settings`);
    assert.match(settings.body, /name="login_page"/);
    assert.match(settings.body, new RegExp(`formaction="/builder/apps/${appId}/login-page"`));
    const res = await dev.submit(`/builder/apps/${appId}/login-page`, {});
    assert.equal(res.statusCode, 303);
    const a = await owner.one('select login_page from meta.app where id = $1', [appId]);
    pageNo = a.login_page;
    assert.ok(pageNo >= 9999);
    const p = await owner.one('select id, requires_auth, page_template from meta.page where app_id = $1 and page_no = $2', [appId, pageNo]);
    assert.deepEqual([p.requires_auth, p.page_template], [false, 'minimal']);
    assert.equal((await owner.one(`select count(*)::int as n from meta.region where page_id = $1 and type = 'login'`, [p.id])).n, 1);
    // its region can be edited like any other; the Advisor finds nothing wrong with it
    assert.equal((await dev.get(`/builder/pages/${p.id}`)).statusCode, 200);
  });

  test('/login sends visitors there; the page has no navigation and a form that posts to /login', async () => {
    const b = new Browser(app);
    const res = await b.get('/a/hr/login?next=/a/hr/2');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `/a/hr/${pageNo}?next=%2Fa%2Fhr%2F2`);
    const page = await b.get(res.headers.location as string);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<body class="t-minimal login-body"/);
    assert.doesNotMatch(page.body, /class="t-header"|id="t-nav"/);
    assert.match(page.body, /<form id="pgkiln-login" method="post" action="\/a\/hr\/login"><\/form>/);
    assert.match(page.body, /<input id="username" name="username" value="" autocomplete="username" autofocus required maxlength="100" form="pgkiln-login">/);
    assert.match(page.body, /<input type="hidden" name="next" value="\/a\/hr\/2" form="pgkiln-login">/);
  });

  test('a failed sign-in comes back to the page with the message and the user name; a good one signs in', async () => {
    const b = new Browser(app);
    await b.get(`/a/hr/${pageNo}`);
    const bad = await b.submit('/a/hr/login', { username: 'king', password: 'wrong', next: '/a/hr/2' });
    assert.equal(bad.statusCode, 303);
    assert.equal(bad.headers.location, `/a/hr/${pageNo}?next=%2Fa%2Fhr%2F2`);
    const again = await b.get(bad.headers.location as string);
    assert.match(again.body, /role="alert">Invalid username or password/);
    assert.match(again.body, /name="username" value="king"/);
    // shown once
    assert.doesNotMatch((await b.get(`/a/hr/${pageNo}`)).body, /role="alert">Invalid username or password/);
    const ok = await b.submit('/a/hr/login', { username: 'king', password: 'king', next: '/a/hr/2' });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.headers.location, '/a/hr/2');
  });

  test('export and import keep the login page, its template and region; an older export gets the defaults', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as doc`)).doc;
    assert.equal(doc.app.login_page, pageNo);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_login_rt') as id`, [JSON.stringify(doc)])).id;
    try {
      const a = await owner.one('select login_page, password_reset from meta.app where id = $1', [id]);
      assert.equal(a.login_page, pageNo);
      const p = await owner.one(`select p.page_template, (select count(*)::int from meta.region r where r.page_id = p.id and r.type = 'login') as n
                                   from meta.page p where p.app_id = $1 and p.page_no = $2`, [id, pageNo]);
      assert.deepEqual(p, { page_template: 'minimal', n: 1 });
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
    // an export made before 087
    delete doc.app.login_page;
    delete doc.app.password_reset;
    for (const pg of doc.pages) delete pg.page_template;
    const old = (await owner.one(`select meta.import_app($1::jsonb, 'hr_login_old') as id`, [JSON.stringify(doc)])).id;
    try {
      assert.deepEqual(await owner.one('select login_page, password_reset from meta.app where id = $1', [old]), { login_page: null, password_reset: false });
      assert.equal((await owner.one(`select count(*)::int as n from meta.page where app_id = $1 and page_template <> 'standard'`, [old])).n, 0);
    } finally {
      await owner.query('delete from meta.app where id = $1', [old]);
    }
  });

  test('a login page that requires sign-in is not used: the built-in page shows', async () => {
    await owner.query('update meta.page set requires_auth = true where app_id = $1 and page_no = $2', [appId, pageNo]);
    try {
      const res = await new Browser(app).get('/a/hr/login');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /class="card login-card"/);
    } finally {
      await owner.query('update meta.page set requires_auth = false where app_id = $1 and page_no = $2', [appId, pageNo]);
    }
  });
});

describe('forgot password', () => {
  const link = (body: string) => /\/a\/hr\/password\/reset\?token=([A-Za-z0-9_-]{43})/.exec(body)?.[1];

  before(async () => {
    // the built-in sign-in page for these tests
    await owner.query('update meta.app set login_page = null, password_reset = false where id = $1', [appId]);
    await owner.query('delete from meta.mail_service where name = $1', [SERVICE]);
    const id = (await owner.one(`insert into meta.mail_service (name, provider, senders) values ($1, 'log', '{@example.com}') returning id`, [SERVICE])).id;
    await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address) values ($1, $2, 'hr@example.com')
                       on conflict (app_id) do update set service_id = excluded.service_id, from_address = excluded.from_address`, [appId, id]);
  });

  test('offered only when turned on and the application has an enabled mail service', async () => {
    const b = new Browser(app);
    assert.doesNotMatch((await b.get('/a/hr/login')).body, /Forgot password/);
    assert.equal((await b.get('/a/hr/password/forgot')).statusCode, 404);
    await owner.query('update meta.app set password_reset = true where id = $1', [appId]);
    assert.match((await b.get('/a/hr/login')).body, /<a class="login-forgot" href="\/a\/hr\/password\/forgot">Forgot password\?<\/a>/);
    await owner.query('update meta.mail_service set enabled = false where name = $1', [SERVICE]);
    try {
      assert.doesNotMatch((await b.get('/a/hr/login')).body, /Forgot password/);
      assert.equal((await b.get('/a/hr/password/forgot')).statusCode, 404);
    } finally {
      await owner.query('update meta.mail_service set enabled = true where name = $1', [SERVICE]);
    }
  });

  test('a request: the same answer for an account and for nobody; only the account gets a mail', async () => {
    await owner.query('delete from meta.password_reset where app_id = $1', [appId]);
    await owner.query(`delete from meta.activity_log where app_id = $1 and event = 'password_reset_request'`, [appId]);
    const b = new Browser(app);
    await b.get('/a/hr/password/forgot');
    const before = (await owner.one(`select coalesce(max(id), 0) as id from meta.mail_queue`)).id;
    const known = await b.submit('/a/hr/password/forgot', { login: 'KING@example.com' });
    const unknown = await b.submit('/a/hr/password/forgot', { login: 'nobody-here' });
    assert.equal(known.statusCode, 200);
    assert.equal(unknown.statusCode, 200);
    const strip = (s: string) => s.replace(/value="[0-9a-f]+"/g, '');
    assert.equal(strip(known.body), strip(unknown.body), 'the same page either way');
    const mails = (await owner.query(`select to_addresses, subject, body_text, body_html from meta.mail_queue where id > $1 and template = 'PASSWORD_RESET'`, [before])).rows;
    assert.equal(mails.length, 1);
    assert.deepEqual(mails[0].to_addresses, ['king@example.com']);
    assert.match(mails[0].subject, /Choose a new password for HR Demo/);
    assert.match(mails[0].body_text, /^Hello king,/);
    const token = link(mails[0].body_text);
    assert.ok(token);
    assert.match(mails[0].body_html, new RegExp(`<a href="[^"]+token=${token}">`));
    // only a hash of the token is kept
    assert.equal((await owner.one('select count(*)::int as n from meta.password_reset where token_hash = $1', [token])).n, 0);
  });

  test('the link: the token leaves the address bar, the new password works, the link only once', async () => {
    await owner.query('delete from meta.password_reset where app_id = $1', [appId]);
    const b = new Browser(app);
    await b.get('/a/hr/password/forgot');
    const before = (await owner.one(`select coalesce(max(id), 0) as id from meta.mail_queue`)).id;
    await b.submit('/a/hr/password/forgot', { login: 'king' });
    const token = link((await owner.one(`select body_text from meta.mail_queue where id > $1 and template = 'PASSWORD_RESET'`, [before])).body_text)!;
    // king is signed in elsewhere: that session ends with the reset
    const elsewhere = new Browser(app);
    await elsewhere.login('king');
    assert.equal((await elsewhere.get('/a/hr/2')).statusCode, 200);

    const visitor = new Browser(app);
    const open = await visitor.get(`/a/hr/password/reset?token=${token}`);
    assert.equal(open.statusCode, 303);
    assert.equal(open.headers.location, '/a/hr/password/reset');
    const form = await visitor.get('/a/hr/password/reset');
    assert.match(form.body, /name="username" value="king"/);
    assert.equal((await visitor.submit('/a/hr/password/reset', { new_password: 'Kiln-new-1234', confirm_password: 'other' })).statusCode, 422);
    const done = await visitor.submit('/a/hr/password/reset', { new_password: 'Kiln-new-1234', confirm_password: 'Kiln-new-1234' });
    assert.equal(done.statusCode, 303);
    assert.equal(done.headers.location, '/a/hr/login');
    assert.match((await visitor.get('/a/hr/login')).body, /Your password has been changed/);
    // the old password no longer works, the new one does; the other session is gone
    assert.equal((await new Browser(app).login('king', 'king')).statusCode, 401);
    assert.equal((await new Browser(app).login('king', 'Kiln-new-1234')).statusCode, 303);
    assert.notEqual((await elsewhere.get('/a/hr/2')).statusCode, 200);
    // the link again
    const reuse = new Browser(app);
    await reuse.get(`/a/hr/password/reset?token=${token}`);
    assert.equal((await reuse.get('/a/hr/password/reset')).statusCode, 410);
    await owner.query('update meta.account set password_hash = $1 where username = $2', [kingBefore, 'king']);
  });
});
