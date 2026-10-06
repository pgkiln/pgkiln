// Security regression tests. They run the real app (in-process, via
// fastify.inject) against the development database with the HR sample:
//   npm run setup && npm test
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { appTx, closePools, owner, runtime } from '../src/db.ts';
import { signText, urlChecksum } from '../src/security.ts';
import { PageCss } from '../src/css.ts';
import { markdownHtml, sanitizeHtml } from '../src/richtext.ts';
import { cacheKey, cacheOf, clearRegionCache, regionCacheStats } from '../src/runtime/region-cache.ts';
import { maxRows } from '../src/runtime/report.ts';
import { lovMax } from '../src/runtime/items.ts';
import { loadWithDefinition } from '../src/dataload.ts';
import { Browser as FileBrowser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;

/** A tiny cookie-keeping browser on top of fastify.inject. */
class Browser {
  cookies = new Map<string, string>();
  lastCsrf = '';
  async request(method: 'GET' | 'POST', url: string, form?: Record<string, string | string[]>) {
    const res = await app.inject({
      method,
      url,
      // an array posts the field once per value (checkboxes with one name)
      payload: form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => [v].flat().map((x) => [k, x]))).toString() : undefined,
      headers: {
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const m = /name="__csrf" value="([^"]+)"/.exec(res.body);
    if (m) this.lastCsrf = m[1];
    return res;
  }
  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, form: Record<string, string | string[]>) {
    return this.request('POST', url, form);
  }
  async login(user: string, password = user, alias = 'hr') {
    await this.get(`/a/${alias}/login`);
    return this.post(`/a/${alias}/login`, { __csrf: this.lastCsrf, username: user, password });
  }
}

const as = async (user: string) => {
  const b = new Browser();
  const res = await b.login(user);
  assert.equal(res.statusCode, 303, `login as ${user}`);
  return b;
};
const link = (user: string, page: number, items: Record<string, string>) =>
  `/a/hr/${page}?${new URLSearchParams({ ...items, cs: urlChecksum(appId, page, user, items) })}`;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await app.close();
  await closePools();
});

describe('authentication', () => {
  test('wrong password and unknown user get the same answer', async () => {
    const a = await new Browser().login('demo', 'wrong');
    const b = await new Browser().login('no_such_user', 'wrong');
    assert.equal(a.statusCode, 401);
    assert.equal(b.statusCode, 401);
    assert.match(a.body, /Invalid username or password/);
    assert.match(b.body, /Invalid username or password/);
  });

  test('accounts lock after repeated failures, even with the right password', async () => {
    const user = `locktest_${Date.now()}`;
    await owner.query(`insert into meta.app_user (app_id, username, password_hash) values ($1, $2, meta.hash_password('correct-horse'))`, [appId, user]);
    try {
      for (let i = 0; i < 5; i++) assert.equal((await new Browser().login(user, `bad${i}`)).statusCode, 401);
      const locked = await new Browser().login(user, 'correct-horse');
      assert.equal(locked.statusCode, 429);
      assert.match(locked.body, /Too many failed sign-in attempts/);
    } finally {
      await owner.query('delete from meta.activity_log where lower(username) = lower($1)', [user]);
      await owner.query('delete from meta.account where username = $1', [user]);
    }
  });

  test('the session id changes at login (no session fixation)', async () => {
    const b = new Browser();
    await b.get('/a/hr/login');
    const before = b.cookies.get(`pgapex_app_${appId}`);
    await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'demo', password: 'demo' });
    const afterLogin = b.cookies.get(`pgapex_app_${appId}`);
    assert.ok(before && afterLogin && before !== afterLogin);
  });

  test('session tokens are stored hashed', async () => {
    const b = await as('demo');
    const token = b.cookies.get(`pgapex_app_${appId}`)!;
    const hit = await owner.one('select count(*)::int as n from meta.session where token_hash = $1', [token]);
    assert.equal(hit.n, 0);
  });

  test('login refuses open redirects', async () => {
    const b = new Browser();
    await b.get('/a/hr/login');
    const res = await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'demo', password: 'demo', next: '//evil.example/a/hr/' });
    assert.equal(res.headers.location, '/a/hr/1');
  });

  test('sign-out requires POST with a CSRF token', async () => {
    const b = await as('demo');
    assert.equal((await b.get('/a/hr/logout')).statusCode, 404);
    await b.post('/a/hr/logout', { __csrf: 'forged' });
    assert.equal((await b.get('/a/hr/1')).statusCode, 200, 'still signed in');
    await b.post('/a/hr/logout', { __csrf: b.lastCsrf });
    assert.equal((await b.get('/a/hr/1')).statusCode, 302, 'signed out');
  });

  test('unauthenticated users are sent to the login page', async () => {
    const res = await new Browser().get('/a/hr/2');
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), /^\/a\/hr\/login\?next=/);
  });
});

describe('authorization', () => {
  test('page authorization schemes are enforced', async () => {
    const allen = await as('allen');
    assert.equal((await allen.get('/a/hr/3')).statusCode, 403, 'employee form needs MANAGER');
    assert.equal((await allen.get('/a/hr/9')).statusCode, 403, 'audit trail needs ADMIN');
    const blake = await as('blake');
    assert.equal((await blake.get('/a/hr/9')).statusCode, 403);
    assert.equal((await blake.get(link('blake', 3, { P3_EMPNO: '7499' }))).statusCode, 200);
  });

  test('menu entries and links to unauthorized pages are hidden', async () => {
    const allen = await as('allen');
    const page = (await allen.get('/a/hr/2')).body;
    assert.doesNotMatch(page, /Audit trail/);
    assert.doesNotMatch(page, /href="\/a\/hr\/3(?![0-9])/, 'no edit links for non-managers');
  });

  test('a button that is not rendered cannot be pressed', async () => {
    const blake = await as('blake');
    await blake.get(link('blake', 3, { P3_EMPNO: '7499' }));
    // DELETE requires ADMIN; blake is only a manager
    const del = await blake.post('/a/hr/3', { __csrf: blake.lastCsrf, __request: 'DELETE' });
    assert.equal(del.statusCode, 403);
    // CREATE is only shown when P3_EMPNO is null
    const create = await blake.post('/a/hr/3', { __csrf: blake.lastCsrf, __request: 'CREATE', P3_ENAME: 'X' });
    assert.equal(create.statusCode, 403);
    const exists = await owner.one(`select count(*)::int as n from hr.emp where empno = 7499`);
    assert.equal(exists.n, 1);
  });

  test('hidden items cannot be changed by the browser', async () => {
    const king = await as('king');
    await king.get(link('king', 3, { P3_EMPNO: '7934' }));
    const before = await owner.one('select ename, job from hr.emp where empno = 7902');
    const res = await king.post('/a/hr/3', {
      __csrf: king.lastCsrf, __request: 'SAVE', P3_EMPNO: '7902', // tampered primary key
      P3_ENAME: 'MILLER', P3_JOB: 'CLERK', P3_DEPTNO: '10', P3_MGR: '7782', P3_HIREDATE: '1982-01-23', P3_SAL: '1300', P3_ACTIVE: 'true',
    });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(await owner.one('select ename, job from hr.emp where empno = 7902'), before, 'FORD untouched');
  });

  test('URL item values need a valid checksum', async () => {
    const king = await as('king');
    assert.equal((await king.get('/a/hr/3?P3_EMPNO=7839')).statusCode, 403, 'missing checksum');
    assert.equal((await king.get(`/a/hr/3?P3_EMPNO=7839&cs=${'0'.repeat(32)}`)).statusCode, 403, 'forged checksum');
    const blakesLink = link('blake', 3, { P3_EMPNO: '7839' });
    assert.equal((await king.get(blakesLink)).statusCode, 403, "another user's link");
    assert.equal((await king.get(link('king', 3, { P3_EMPNO: '7839' }))).statusCode, 200);
  });

  test('checksums from meta.page_url() match the runtime', async () => {
    const url = await runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'king', true)`, [String(appId)]);
      return (await c.query(`select meta.page_url(3, '{"P3_EMPNO": 7839}') as u`)).rows[0].u;
    });
    const king = await as('king');
    assert.equal((await king.get(url)).statusCode, 200);
  });

  test('row level security hides other people’s leave requests', async () => {
    const allen = await as('allen');
    const start = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 46 * 864e5).toISOString().slice(0, 10); // a full week: always has working days
    await allen.get('/a/hr/7?clear=1');
    const res = await allen.post('/a/hr/7', { __csrf: allen.lastCsrf, __request: 'CREATE', P7_START_DATE: start, P7_END_DATE: end, P7_REASON: 'test' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const id = (await owner.one(`select max(id) as id from hr.leave_request`)).id;
    try {
      const jones = await as('jones');
      const view = await jones.get(link('jones', 7, { P7_ID: String(id) }));
      assert.match(view.body, /record not found/);
      assert.doesNotMatch(view.body, /value="test"|>test</);
      assert.doesNotMatch((await jones.get('/a/hr/6')).body, /ALLEN/);
      // allen cannot approve his own request, even by forging the button
      await allen.get(link('allen', 7, { P7_ID: String(id) }));
      assert.equal((await allen.post('/a/hr/7', { __csrf: allen.lastCsrf, __request: 'APPROVE' })).statusCode, 403);
      // blake (allen's manager) can
      const blake = await as('blake');
      await blake.get(link('blake', 7, { P7_ID: String(id) }));
      assert.equal((await blake.post('/a/hr/7', { __csrf: blake.lastCsrf, __request: 'APPROVE' })).statusCode, 303);
      assert.equal((await owner.one('select status from hr.leave_request where id = $1', [id])).status, 'APPROVED');
    } finally {
      await owner.query('delete from hr.leave_request where id = $1', [id]);
    }
  });

  test('dynamic action endpoints check CSRF and page authorization', async () => {
    const daId = (await owner.one(`select d.id from meta.dynamic_action d join meta.page p on p.id = d.page_id where p.app_id = $1 and p.page_no = 3 and d.action = 'set_value'`, [appId])).id;
    const allen = await as('allen');
    await allen.get('/a/hr/1');
    assert.equal((await allen.post(`/a/hr/3/da/${daId}`, { __csrf: allen.lastCsrf, P3_JOB: 'CLERK' })).statusCode, 403);
    const king = await as('king');
    await king.get(link('king', 3, { P3_EMPNO: '7839' }));
    assert.equal((await king.post(`/a/hr/3/da/${daId}`, { __csrf: 'forged', P3_JOB: 'CLERK' })).statusCode, 403);
    const ok = await king.post(`/a/hr/3/da/${daId}`, { __csrf: king.lastCsrf, P3_JOB: 'CLERK', P3_SAL: '' });
    assert.equal(ok.statusCode, 200);
    assert.ok(Number(JSON.parse(ok.body).items.P3_SAL) > 0);
  });
});

describe('injection and output encoding', () => {
  test('CSRF token is required on page submits', async () => {
    const king = await as('king');
    await king.get(link('king', 3, { P3_EMPNO: '7839' }));
    assert.equal((await king.post('/a/hr/3', { __request: 'SAVE' })).statusCode, 403);
  });

  test('search, sort and filters cannot inject SQL', async () => {
    const king = await as('king');
    const rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2`, [appId])).id;
    const q = (params: Record<string, string>) => king.get(`/a/hr/2?${new URLSearchParams(params)}`);
    const search = await q({ [`r${rid}_q`]: "' or 1=1 --" });
    assert.equal(search.statusCode, 200);
    assert.match(search.body, /No data found/);
    assert.equal((await q({ [`r${rid}_s`]: '1; drop table hr.emp' })).statusCode, 200);
    const filter = await q({ [`r${rid}_f`]: 'ename" is not null; drop table hr.emp; --|eq|x' });
    assert.equal(filter.statusCode, 200);
    assert.equal((await owner.one('select count(*)::int as n from hr.emp')).n > 0, true);
  });

  test('values are HTML-escaped', async () => {
    const king = await as('king');
    const rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2`, [appId])).id;
    const res = await king.get(`/a/hr/2?r${rid}_q=${encodeURIComponent('<script>alert(1)</script>')}`);
    assert.doesNotMatch(res.body, /<script>alert/);
    assert.match(res.body, /&lt;script&gt;/);
  });

  test('CSV export neutralises spreadsheet formulas', async () => {
    const empno = (await owner.one(`insert into hr.emp (ename, job, sal, deptno) values ('=HYPERLINK("http://x")', 'CLERK', 100, 40) returning empno`)).empno;
    try {
      const king = await as('king');
      const rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2`, [appId])).id;
      const csv = await king.get(`/a/hr/2?r${rid}_csv=1`);
      assert.equal(csv.statusCode, 200);
      assert.match(csv.body, /"'=HYPERLINK\(""http:\/\/x""\)"/);
    } finally {
      await owner.query('delete from hr.emp where empno = $1', [empno]);
    }
  });

  test('database error details are not shown to end users', async () => {
    const pageId = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 8`, [appId])).id;
    const r = await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 99, 'Broken', 'report', 'select * from secret_table_name') returning id`, [pageId]);
    try {
      const body = (await (await as('king')).get('/a/hr/8')).body;
      assert.doesNotMatch(body, /secret_table_name/);
      assert.match(body, /An unexpected error occurred \(reference #\d+\)/);
    } finally {
      await owner.query('delete from meta.region where id = $1', [r.id]);
    }
  });

  test('security headers are sent', async () => {
    const res = await (await as('demo')).get('/a/hr/1');
    assert.match(String(res.headers['content-security-policy']), /script-src 'self'/);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.doesNotMatch(res.body, /<script>(?!\s*$)|on(click|change|load)=/i, 'no inline scripts or handlers');
  });
});

describe('database privileges', () => {
  test('the runtime role cannot read secrets or password hashes', async () => {
    await assert.rejects(runtime.query('select * from meta.developer'), /permission denied/);
    await assert.rejects(runtime.query('select password_hash from meta.app_user'), /permission denied/);
    await assert.rejects(runtime.query('select * from meta.instance_setting'), /permission denied/);
    await assert.rejects(runtime.query('select password_hash from meta.account'), /permission denied/);
  });

  test('application SQL runs as the app role, not the runtime role', async () => {
    await assert.rejects(runtime.query('select * from hr.emp'), /permission denied/, 'runtime role has no direct data access');
  });
});

describe('sprint 3 features', () => {
  const gridRegion = async () =>
    (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 10 and r.type = 'grid'`, [appId])).id as number;

  /** The posted form fields of the grid as rendered for this user. */
  const gridForm = (body: string) => {
    const form: Record<string, string> = {};
    for (const m of body.matchAll(/<input([^>]*)name="(g\d+_\d+_[a-z0-9]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
      if (/type="checkbox"/.test(m[0]) && !/ checked/.test(m[0])) continue; // like a browser
      form[m[2]] = m[3].replace(/&quot;/g, '"');
    }
    return form;
  };

  test('grid pages follow their authorization scheme', async () => {
    const allen = await as('allen');
    assert.equal((await allen.get('/a/hr/10')).statusCode, 403);
    await allen.get('/a/hr/1');
    const rid = await gridRegion();
    assert.equal((await allen.post('/a/hr/10', { __csrf: allen.lastCsrf, __request: `GRID_SAVE_${rid}` })).statusCode, 403);
  });

  test('grid rows cannot be redirected to another primary key', async () => {
    const king = await as('king');
    const page = await king.get('/a/hr/10');
    const rid = await gridRegion();
    const form = gridForm(page.body);
    const g = `g${rid}`;
    const victim = form[`${g}_1_pk`];
    const before = await owner.one('select dname, loc from hr.dept where deptno = $1', [victim]);
    // row 0's checksum with row 1's key, and a changed location
    const res = await king.post('/a/hr/10', {
      ...form, __csrf: king.lastCsrf, __request: `GRID_SAVE_${rid}`,
      [`${g}_0_pk`]: victim, [`${g}_0_c2`]: 'HACKED',
    });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /changed outside the grid/);
    assert.deepEqual(await owner.one('select dname, loc from hr.dept where deptno = $1', [victim]), before);
  });

  test('grid saves only changed cells and rolls back on errors', async () => {
    const king = await as('king');
    const rid = await gridRegion();
    const g = `g${rid}`;
    const form = gridForm((await king.get('/a/hr/10')).body);
    const pk = form[`${g}_0_pk`];
    const orig = await owner.one('select loc from hr.dept where deptno = $1', [pk]);
    try {
      const ok = await king.post('/a/hr/10', { ...form, __csrf: king.lastCsrf, __request: `GRID_SAVE_${rid}`, [`${g}_0_c2`]: 'GRID TEST' });
      assert.equal(ok.statusCode, 303);
      assert.equal((await owner.one('select loc from hr.dept where deptno = $1', [pk])).loc, 'GRID TEST');
      // a duplicate name in another row fails the whole save
      const form2 = gridForm((await king.get('/a/hr/10')).body);
      const other = form2[`${g}_1_c1`];
      const bad = await king.post('/a/hr/10', {
        ...form2, __csrf: king.lastCsrf, __request: `GRID_SAVE_${rid}`, [`${g}_0_c2`]: 'SHOULD ROLL BACK', [`${g}_2_c1`]: other,
      });
      assert.equal(bad.statusCode, 422);
      assert.match(bad.body, /already exists/);
      assert.equal((await owner.one('select loc from hr.dept where deptno = $1', [pk])).loc, 'GRID TEST');
    } finally {
      await owner.query('update hr.dept set loc = $2 where deptno = $1', [pk, orig.loc]);
    }
  });

  test('facet and calendar parameters cannot inject SQL', async () => {
    const king = await as('king');
    const rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 11 and r.type = 'report'`, [appId])).id;
    const res = await king.get(`/a/hr/11?${new URLSearchParams([[`r${rid}_x_job"; drop table hr.emp; --`, 'x'], [`r${rid}_x_job`, "Clerk' or '1'='1"]])}`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /No data found/);
    const cal = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 12`, [appId])).id;
    assert.equal((await king.get(`/a/hr/12?r${cal}_m=2026-01'); drop table hr.emp; --`)).statusCode, 200);
    assert.ok((await owner.one('select count(*)::int as n from hr.emp')).n > 0);
  });

  test('theme colours cannot inject CSS', async () => {
    await owner.query(`update meta.app set theme = '{"accent": "red;}body{display:none", "header": "#123456"}' where id = $1`, [appId]);
    try {
      const body = (await (await as('king')).get('/a/hr/1')).body;
      assert.doesNotMatch(body, /display:none/);
      assert.match(body, /--header:#123456/);
    } finally {
      await owner.query(`update meta.app set theme = '{}' where id = $1`, [appId]);
    }
  });
});

describe('user directory', () => {
  // A second app sharing the directory; cleaned up afterwards.
  let otherId: number;
  const user = `dir_${Date.now()}`;
  before(async () => {
    otherId = (await owner.one(`insert into meta.app (alias, name, db_role) values ($1, 'Directory test', 'hr_app') returning id`, [`dirtest${Date.now()}`])).id;
    await owner.query(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home')`, [otherId]);
    const acc = (await owner.one(`insert into meta.account (username, password_hash) values ($1, meta.hash_password('correct-horse')) returning id`, [user])).id;
    await owner.query(`insert into meta.app_access (app_id, account_id, roles) values ($1, $2, '{admin}'), ($3, $2, '{}')`, [appId, acc, otherId]);
  });
  after(async () => {
    await owner.query('delete from meta.activity_log where lower(username) = lower($1)', [user]);
    await owner.query('delete from meta.account where username = $1', [user]);
    await owner.query('delete from meta.app where id = $1', [otherId]);
  });
  const alias = async () => (await owner.one('select alias from meta.app where id = $1', [otherId])).alias as string;

  test('one account signs in to several apps, with roles per app', async () => {
    const b = new Browser();
    assert.equal((await b.login(user, 'correct-horse')).statusCode, 303);
    assert.equal((await b.get('/a/hr/9')).statusCode, 200, 'admin in hr');
    const other = new Browser();
    assert.equal((await other.login(user, 'correct-horse', await alias())).statusCode, 303);
    const roles = await runtime.one(`select roles from meta.session where app_id = $1 and username = $2 order by created_at desc limit 1`, [otherId, user]);
    assert.deepEqual(roles.roles, [], 'no admin role in the other app');
  });

  test('accounts without access cannot sign in; "any user" apps let them in', async () => {
    const stranger = `stranger_${Date.now()}`;
    await owner.query(`insert into meta.account (username, password_hash) values ($1, meta.hash_password('correct-horse'))`, [stranger]);
    try {
      const res = await new Browser().login(stranger, 'correct-horse', await alias());
      assert.equal(res.statusCode, 401);
      assert.match(res.body, /Invalid username or password/, 'same answer as a wrong password');
      await owner.query(`update meta.app set access_control = 'any_user' where id = $1`, [otherId]);
      assert.equal((await new Browser().login(stranger, 'correct-horse', await alias())).statusCode, 303);
    } finally {
      await owner.query(`update meta.app set access_control = 'assigned' where id = $1`, [otherId]);
      await owner.query('delete from meta.activity_log where lower(username) = lower($1)', [stranger]);
      await owner.query('delete from meta.account where username = $1', [stranger]);
    }
  });

  test('deactivating an account ends its sessions and blocks sign-in', async () => {
    const b = new Browser();
    await b.login(user, 'correct-horse');
    assert.equal((await b.get('/a/hr/1')).statusCode, 200);
    const { endSessions } = await import('../src/builder/users.ts');
    const acc = (await owner.one('select id from meta.account where username = $1', [user])).id;
    await owner.query('update meta.account set active = false where id = $1', [acc]);
    await endSessions(acc);
    try {
      assert.equal((await b.get('/a/hr/1')).statusCode, 302, 'signed out');
      assert.equal((await new Browser().login(user, 'correct-horse')).statusCode, 401);
    } finally {
      await owner.query('update meta.account set active = true where id = $1', [acc]);
    }
  });

  test('the compatibility view meta.app_user still creates accounts with access', async () => {
    const legacy = `legacy_${Date.now()}`;
    await owner.query(`insert into meta.app_user (app_id, username, password_hash, roles) values ($1, $2, meta.hash_password('correct-horse'), '{manager}')`, [appId, legacy]);
    try {
      const b = new Browser();
      assert.equal((await b.login(legacy, 'correct-horse')).statusCode, 303);
      assert.equal((await b.get(link(legacy, 3, { P3_EMPNO: '7839' }))).statusCode, 200, 'manager role works');
    } finally {
      await owner.query('delete from meta.activity_log where lower(username) = lower($1)', [legacy]);
      await owner.query('delete from meta.account where username = $1', [legacy]);
    }
  });
});

describe('HR sample', () => {
  test('read notifications keep their message after "Mark all read"', async () => {
    const b = await as('king');
    const before = await owner.query(`select id, read_at from hr.notification where username = 'king'`);
    try {
      await owner.query(`update hr.notification set read_at = null where username = 'king'`);
      await b.get('/a/hr/1');
      assert.equal((await b.post('/a/hr/1', { __csrf: b.lastCsrf, __request: 'MARK_READ' })).statusCode, 303);
      const page = (await b.get('/a/hr/1')).body;
      assert.equal((await owner.one(`select count(*)::int as n from hr.notification where username = 'king' and read_at is null`)).n, 0);
      assert.match(page, /requested \d+ day\(s\) of leave/, 'messages still shown (NULL || text is NULL in Postgres)');
      assert.doesNotMatch(page, /●/);
    } finally {
      for (const r of before.rows) await owner.query('update hr.notification set read_at = $2 where id = $1', [r.id, r.read_at]);
    }
  });
});

describe('sprint 5: accounts and globalization', () => {
  test('the runtime role cannot change accounts beyond preferences', async () => {
    for (const sql of [
      'select password_hash from meta.account',
      `update meta.account set active = true where username = 'king'`,
      `update meta.account set must_change_password = false where username = 'king'`,
      `update meta.account set email = 'x@evil.example' where username = 'king'`,
      `select meta.set_password('king', 'hijack-hijack')`,
      `select meta.expire_password('king')`,
    ])
      await assert.rejects(runtime.query(sql), /permission denied/, sql);
    await runtime.query(`update meta.account set theme_pref = theme_pref where username = 'king'`);
  });

});

describe('sprint 11: report views and row selection', () => {
  const report2 = async () => (await owner.one(`select r.id, r.page_id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId]));
  const state = async (b: Browser) => (await owner.one('select state from meta.session where csrf_token = $1', [b.lastCsrf])).state;

  test('computed columns, group by, pivot and chart parameters cannot inject SQL', async () => {
    const king = await as('king');
    const { id } = await report2();
    const get = (params: [string, string][]) => king.get(`/a/hr/2?${new URLSearchParams(params.map(([k, v]) => [`r${id}_${k}`, v]))}`);
    for (const params of [
      [['c', 'H|(select password_hash from meta.account limit 1)']],
      [['c', 'H|ename) from meta.account; --']],
      [['c', 'H|current_user']],
      [['g', 'job" from meta.account --'], ['ga', 'sum|sal) from meta.account --'], ['v', 'group']],
      [['pv', 'job|department" from meta.account --|count|empno'], ['v', 'pivot']],
      [['pv', 'job|department|sum|sal); drop table hr.emp; --'], ['v', 'pivot']],
      [['ch', 'bar|job"; drop table hr.emp; --|count|empno'], ['v', 'chart']],
      [['ch', 'bar|job|pg_sleep|empno'], ['v', 'chart']],
    ] as [string, string][][]) {
      const res = await get(params);
      assert.equal(res.statusCode, 200, JSON.stringify(params));
      assert.doesNotMatch(res.body, /\$2[aby]\$/, 'no password hashes');
      assert.doesNotMatch(res.body, /pgapex_runtime|syntax error/, JSON.stringify(params));
    }
    assert.ok((await owner.one('select count(*)::int as n from hr.emp')).n > 0);
  });

  test('pivot values with quotes are literals', async () => {
    const king = await as('king');
    const { id } = await report2();
    const res = await king.get(`/a/hr/2?${new URLSearchParams([[`r${id}_c`, `Q|job || ''' or ''1''=''1'`], [`r${id}_pv`, 'department|Q|count|empno'], [`r${id}_v`, 'pivot']])}`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /CLERK&#39; or &#39;1&#39;=&#39;1|CLERK&#x27; or/);
    assert.doesNotMatch(res.body, /alert-error/);
  });

  test('only a configured selection item accepts posted values', async () => {
    const r = await report2();
    await owner.query(`insert into meta.item (page_id, name, type) values ($1, 'P2_PICKED', 'hidden')`, [r.page_id]);
    try {
      const king = await as('king');
      await king.get('/a/hr/2');
      await king.post('/a/hr/2', { __csrf: king.lastCsrf, P2_PICKED: '7839' });
      assert.equal((await state(king)).P2_PICKED ?? null, null, 'a hidden item is not posted');
      await owner.query('update meta.region set config = config || $2 where id = $1', [r.id, JSON.stringify({ selection: { column: 'empno', item: 'P2_PICKED' } })]);
      await king.get('/a/hr/2');
      await king.post('/a/hr/2', { __csrf: king.lastCsrf, P2_PICKED: '7839' });
      assert.equal((await state(king)).P2_PICKED, '7839');
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
      await owner.query(`delete from meta.item where page_id = $1 and name = 'P2_PICKED'`, [r.page_id]);
    }
  });
});

describe('sprint 12: Content-Security-Policy without inline styles', () => {
  const policy = (res: { headers: Record<string, unknown> }) => String(res.headers['content-security-policy'] ?? '');
  const nonceOf = (res: { headers: Record<string, unknown> }) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy(res))?.[1];

  test('pages allow only their own nonce\'d <style> and no style attributes', async () => {
    const king = await as('king');
    const pages = (await owner.query(`select p.page_no from meta.page p where p.app_id = $1 order by 1`, [appId])).rows.map((r) => `/a/hr/${r.page_no}`);
    const nonces = new Set<string>();
    for (const url of [...pages, '/a/hr/login', '/a/hr/account']) {
      const res = await king.get(url);
      if (res.statusCode !== 200) continue;
      const csp = policy(res);
      assert.match(csp, /style-src 'self' 'nonce-/, url);
      assert.doesNotMatch(csp, /unsafe-inline/, url);
      assert.doesNotMatch(res.body, /\sstyle="/, `${url} has a style attribute`);
      const nonce = nonceOf(res)!;
      for (const m of res.body.matchAll(/<style([^>]*)>/g)) assert.equal(m[1], ` nonce="${nonce}" id="pgapex-css"`, `${url}: <style> without the nonce`);
      nonces.add(nonce);
    }
    assert.ok(nonces.size > 5, 'a new nonce for every response');
  });

  test('builder pages have no style attributes either', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    for (const url of ['/builder', `/builder/apps/${appId}`, `/builder/apps/${appId}/shared`, `/builder/apps/${appId}/settings`, `/builder/apps/${appId}/api`,
      `/builder/apps/${appId}/globalization`, '/builder/sql', '/builder/sql/load', '/builder/users', '/builder/users/providers',
      `/builder/apps/${appId}/shared?new=template_component`, ...(await owner.query('select id from meta.template_component where app_id = $1', [appId])).rows.map((r) => `/builder/apps/${appId}/shared?c=template_component-${r.id}`)]) {
      const res = await dev.get(url);
      assert.equal(res.statusCode, 200, url);
      assert.doesNotMatch(policy(res), /unsafe-inline/);
      assert.doesNotMatch(res.body, /\sstyle="/, `${url} has a style attribute`);
    }
  });

  test('chart geometry becomes classes; declarations cannot break out of the rule', async () => {
    const res = await (await as('king')).get('/a/hr/1');
    const css = /<style nonce="[^"]+" id="pgapex-css">([\s\S]*?)<\/style>/.exec(res.body)![1];
    assert.match(css, /\.x[A-Za-z0-9]{10}\{bottom:[\d.]+%;height:[\d.]+%\}/);
    const cls = /\.(x[A-Za-z0-9]{10})\{bottom:[\d.]+%;height/.exec(css)![1];
    assert.match(res.body, new RegExp(`class="col s\\d+ ${cls}"`), 'a column carries its geometry class');
    const sheet = new PageCss();
    assert.equal(sheet.cls('width:1%'), sheet.cls('width:1%'), 'equal declarations share a class');
    for (const bad of ['x}body{display:none', '</style><script>', 'a{b']) assert.throws(() => sheet.cls(bad));
  });
});

describe('sprint 13: builder search, Advisor and Top SQL', () => {
  test('developers only, CSRF on the reset, the query is escaped', async () => {
    const anon = new Browser();
    for (const url of [`/builder/apps/${appId}/search?q=x`, `/builder/apps/${appId}/advisor`, `/builder/apps/${appId}/top-sql`])
      assert.equal((await anon.get(url)).statusCode, 302, url);
    assert.equal((await anon.post(`/builder/apps/${appId}/top-sql/reset`, {})).statusCode, 302);
    // an application user is not a developer
    const king = await as('king');
    assert.equal((await king.get(`/builder/apps/${appId}/advisor`)).statusCode, 302);

    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const res = await dev.get(`/builder/apps/${appId}/search?q=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /<img src=x/);
    assert.equal((await dev.post(`/builder/apps/${appId}/top-sql/reset`, { __csrf: 'forged' })).statusCode, 403);
  });
});

describe('sprint 15: document templates', () => {
  test('data is never interpreted: tags and HTML in values print as text', async () => {
    const { fillTemplate } = await import('../src/runtime/document.ts');
    const out = fillTemplate('<p>{{name}}</p>{{#rows}}<td>{{x}}</td>{{/rows}}', {
      name: '{{secret}}<img src="logo"><div class="page-break"></div>',
      secret: 'LEAK',
      rows: [{ x: '</td></tr></table><h1>forged</h1>' }],
    });
    assert.doesNotMatch(out, /LEAK/);
    assert.doesNotMatch(out, /<img|<div|<h1>/);
    assert.match(out, /\{\{secret\}\}&lt;img src=&quot;logo&quot;&gt;/);
  });

  test('downloads need a session with access to the page; the preview is for developers', async () => {
    const anon = new Browser();
    const res = await anon.get('/a/hr/3?doc=EMPLOYEE_SHEET');
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), /\/a\/hr\/login/);
    const king = await as('king');
    const t = await owner.one(`select id from meta.document_template where app_id = $1 and name = 'EMPLOYEE_SHEET'`, [appId]);
    assert.equal((await king.get(`/builder/apps/${appId}/documents/${t.id}/preview`)).statusCode, 302);
  });
});

describe('sprint 16: approvals', () => {
  test('task functions check the user; meta.tasks shows only what the user may see', async () => {
    const t = await owner.one(`select t.id from meta.task t where t.app_id = $1 order by t.id limit 1`, [appId]);
    if (!t) return;
    const run = (user: string, sql: string, params: unknown[] = []) =>
      owner.tx(async (c) => {
        await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true)`, [String(appId), user]);
        await c.query('set local role hr_app');
        return c.query(sql, params);
      });
    // no session roles and not a participant: nothing visible, every action refused
    assert.equal((await run('smith', 'select count(*)::int as n from meta.tasks')).rows[0].n, 0);
    for (const sql of ['select meta.claim_task($1)', `select meta.complete_task($1, 'approved')`, 'select meta.cancel_task($1)', `select meta.add_task_comment($1, 'x')`, `select meta.delegate_task($1, 'smith')`])
      await assert.rejects(run('smith', sql, [t.id]), /cannot|not found/, sql);
    // another application's tasks don't exist from here
    await assert.rejects(owner.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', '-1', true), set_config('pgapex.app_user', 'king', true)`);
      return c.query('select meta.claim_task($1)', [t.id]);
    }), /not found/);
    // the app role can't touch the tables themselves
    await assert.rejects(run('king', 'update meta.task set state = $1', ['cancelled']), /permission denied/);
  });
});

describe('sprint 17: workflows', () => {
  const run = (user: string, sql: string, params: unknown[] = [], appIdOverride?: number) =>
    owner.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true)`, [String(appIdOverride ?? appId), user]);
      await c.query('set local role hr_app');
      return c.query(sql, params);
    });

  test('workflow functions check the app and the user; the tables are closed', async () => {
    // a definition of another application can't be started from this one
    await assert.rejects(run('king', `select meta.start_workflow('ONBOARDING', null, '{}')`, [], -1), /does not exist in this application/);
    const id = (await run('allen', `select meta.start_workflow('ONBOARDING', '7499', '{"ENAME": "Allen", "SAL": 1}') as id`)).rows[0].id;
    try {
      // others don't see it and can't stop it; nobody without the admin role retries it
      assert.equal((await run('smith', 'select count(*)::int as n from meta.workflows where id = $1', [id])).rows[0].n, 0);
      await assert.rejects(run('smith', 'select meta.terminate_workflow($1)', [id]), /cannot terminate/);
      await assert.rejects(run('allen', 'select meta.retry_workflow($1)', [id]), /cannot retry/);
      await assert.rejects(run('king', 'update meta.workflow set state = $1', ['completed']), /permission denied/);
      await assert.rejects(run('king', 'select * from meta.workflow_event'), /permission denied/);
      // variables can't inject SQL: they are binds (escaped literals) in the steps
      const { applyBinds } = await import('../src/binds.ts');
      assert.equal(applyBinds(':SAL::numeric >= 2500', { SAL: "1; drop table hr.emp; --" }), "'1; drop table hr.emp; --'::numeric >= 2500");
    } finally {
      // a running pgapex server may have taken a step meanwhile: remove its task too
      await owner.query('delete from meta.task where workflow_id = $1', [id]);
      // a running pgapex server may have taken a step meanwhile: remove its task too
      await owner.query('delete from meta.task where workflow_id = $1', [id]);
      await owner.query('delete from meta.workflow where id = $1', [id]);
    }
  });
});

describe('sprint 18: Progressive Web App', () => {
  test('camera and position only for the app itself; no PWA files for other apps or unknown ones', async () => {
    const res = await new Browser().get('/a/hr/login');
    assert.equal(res.headers['permissions-policy'], 'camera=(self), microphone=(), geolocation=(self)');
    for (const url of ['/a/nope/sw.js', '/a/nope/manifest.webmanifest', '/a/nope/icon-512.png', '/a/nope/offline'])
      assert.equal((await new Browser().get(url)).statusCode, 404, url);
    // the service worker carries settings only, no session or user data
    const settings = (await new Browser().get('/a/hr/sw.js')).body.split('\n')[0];
    assert.deepEqual(Object.keys(JSON.parse(settings.replace(/^const PGAPEX = |;$/g, ''))), ['base', 'offlinePages', 'offlineSubmit', 'version']);
  });
});

describe('sprint 19: REST modules', () => {
  test('values from the path, query and body are binds; a browser session is no credential', async () => {
    const { issueApiToken } = await import('../src/api.ts');
    const tok = (await issueApiToken(appId, 'king', 1)).token;
    const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${tok}` }) => app.inject({ url: `/a/hr/rest/v1/${path}`, headers });
    // a path parameter that tries to break out of the literal
    const inj = await get(`employees/${encodeURIComponent("7839' or '1'='1")}`);
    assert.equal(inj.statusCode, 400, 'invalid input for ::int, not a widened query');
    assert.ok((await owner.one('select count(*)::int as n from hr.emp')).n > 0);
    // a signed-in browser (session cookie) without a token gets nothing: no CSRF through the API
    const king = await as('king');
    const cookie = [...king.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    assert.equal((await get('employees', { cookie })).statusCode, 401);
    // a PostgREST token without the app claim is refused
    const { SignJWT } = await import('jose');
    const { jwtSecret } = await import('../src/api.ts');
    const noApp = await new SignJWT({ role: 'hr_api', app_user: 'king' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(jwtSecret());
    assert.equal((await get('employees', { authorization: `Bearer ${noApp}` })).statusCode, 401);
    // "none" algorithm tokens are refused
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"app":"hr","app_user":"king"}').toString('base64url')}.`;
    assert.equal((await get('employees', { authorization: `Bearer ${unsigned}` })).statusCode, 401);
  });
});


describe('sprint 20: map and tree regions', () => {
  test('images: only this server, data: and the tile server; no tile origin for a non-http template', async () => {
    const { tileOrigin } = await import('../src/maptiles.ts');
    const king = await as('king');
    const csp = String((await king.get('/a/hr/4')).headers['content-security-policy']);
    assert.match(csp, new RegExp(`img-src 'self' data: ${tileOrigin()!.replace(/[.*]/g, '\\$&')}(;|$)`));
    const was = process.env.MAP_TILE_URL;
    process.env.MAP_TILE_URL = 'javascript:alert(1)//{z}/{x}/{y}';
    try {
      assert.equal(tileOrigin(), null);
    } finally {
      if (was === undefined) delete process.env.MAP_TILE_URL;
      else process.env.MAP_TILE_URL = was;
    }
  });

  test('tree labels and map titles from the data are text, not markup', async () => {
    await owner.query(`update hr.emp set ename = '<img src=x>', work_location = '1,1' where empno = 7788`);
    try {
      const king = await as('king');
      for (const page of ['/a/hr/4', '/a/hr/8']) {
        const body = (await king.get(page)).body;
        assert.doesNotMatch(body, /<img src=x>/i, page);
      }
    } finally {
      await owner.query(`update hr.emp set ename = 'SCOTT', work_location = null where empno = 7788`);
    }
  });
});

describe('sprint 21: chart types and several files per upload item', () => {
  test('a report chart view only takes single-series kinds; other kinds from the URL are ignored', async () => {
    const king = await as('king');
    const { id } = await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId]);
    const view = (kind: string) => king.get(`/a/hr/2?${new URLSearchParams([[`r${id}_ch`, `${kind}|job|sum|sal`], [`r${id}_v`, 'chart']])}`);
    const pie = await view('pie');
    assert.match(pie.body, /class="chart chart-pie"/);
    for (const kind of ['stacked', 'combo', 'scatter', 'pie"><script>', 'pie3d']) {
      const res = await view(kind);
      assert.equal(res.statusCode, 200, kind);
      assert.doesNotMatch(res.body, /class="chart chart-/, `${kind}: no chart view`);
      assert.doesNotMatch(res.body, /<script>|alert-error/, kind);
    }
  });

  test('chart labels and series names from the data are text, not markup', async () => {
    await owner.query(`update hr.emp set job = '<img src=x>' where empno = 7788`);
    try {
      const king = await as('king');
      const res = await king.get('/a/hr/15');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /&lt;img src=x&gt;/i, 'the label is shown, escaped');
      assert.doesNotMatch(res.body, /<img src=x>/i);
    } finally {
      await owner.query(`update hr.emp set job = 'ANALYST' where empno = 7788`);
    }
  });

  test('a multiple file item takes only uploads: posted ids and remove boxes cannot reach other sessions or records', async () => {
    const MILLER = { P3_ENAME: 'MILLER', P3_JOB: 'CLERK', P3_DEPTNO: '10', P3_MGR: '7782', P3_HIREDATE: '1982-01-23', P3_SAL: '1300', P3_ACTIVE: 'true' };
    await as('blake'); // a session of someone else, with a temporary file
    const foreign = (await owner.one(`insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content)
      select id, 'P3_DOCUMENTS', 'foreign.pdf', 'application/pdf', 1, '\\x00' from meta.session where username = 'blake' order by created_at desc limit 1 returning id`)).id;
    const kings = (await owner.one(`insert into hr.emp_document (empno, filename, mime_type, content) values (7839, 'king.pdf', 'application/pdf', '\\x00') returning id`)).id;
    try {
      const king = await as('king');
      await king.get(link('king', 3, { P3_EMPNO: '7934' }));
      const res = await king.post('/a/hr/3', { __csrf: king.lastCsrf, __request: 'SAVE', ...MILLER, P3_DOCUMENTS: foreign, P3_DOCUMENTS__REMOVE: [`temp:${foreign}`, String(kings)] });
      assert.equal(res.statusCode, 303);
      assert.equal((await owner.one(`select count(*)::int as n from hr.emp_document where empno = 7934`)).n, 0, 'a posted id is not saved');
      assert.equal((await owner.one(`select count(*)::int as n from meta.temp_file where id = $1`, [foreign])).n, 1, "another session's file is not removed");
      assert.equal((await owner.one(`select count(*)::int as n from hr.emp_document where id = $1`, [kings])).n, 1, "another record's file is not removed");
    } finally {
      await owner.query('delete from meta.temp_file where id = $1', [foreign]);
      await owner.query('delete from hr.emp_document where id = $1', [kings]);
    }
  });
});

describe('sprint 22: map areas and dropped files', () => {
  test('a map area from the URL becomes numbers in SQL, never text', async () => {
    const king = await as('king');
    const { id } = await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 16 and r.type = 'report'`, [appId]);
    for (const bb of ["0,0,1,1) or (1=1", "0,0,1,1'; drop table hr.emp; --", '0,0,1,1 union select password_hash from meta.account', '1e2,0,1,1', 'NaN,0,1,1', 'Infinity,0,1,1']) {
      const res = await king.get(`/a/hr/16?${new URLSearchParams([[`r${id}_bb`, bb]])}`);
      assert.equal(res.statusCode, 200, bb);
      assert.doesNotMatch(res.body, /Map area|syntax error|pgapex_runtime|\$2[aby]\$/, bb);
    }
    assert.ok((await owner.one('select count(*)::int as n from hr.emp')).n > 0);
  });

  test('the URLs a map uses to filter its report stay on this page', async () => {
    const king = await as('king');
    const page = (await king.get('/a/hr/16')).body;
    const data = [...page.matchAll(/class="map-data">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]));
    for (const d of data) if (d.filter) for (const u of [d.filter.url, d.filter.clear]) assert.match(u, /^\/a\/hr\/16(\?|$)/);
  });
});


describe('sprint 23: workflow branches and versions', () => {
  test('only developers manage versions (with CSRF); applications cannot call the version functions or read branches', async () => {
    const d = await owner.one(`select id, version, dev_version from meta.workflow_definition where app_id = $1 and name = 'ONBOARDING'`, [appId]);
    const url = `/builder/apps/${appId}/shared/workflow_definition/${d.id}/versions`;
    assert.equal((await new Browser().post(url, { action: 'new' })).statusCode, 302, 'not signed in');
    const king = await as('king');
    assert.equal((await king.post(url, { __csrf: king.lastCsrf, action: 'new' })).statusCode, 302, 'an application user is not a developer');
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    assert.equal((await dev.post(url, { __csrf: 'forged', action: 'new' })).statusCode, 403);
    // a label is checked before it reaches the database or the page
    await dev.get(`/builder/apps/${appId}/shared?c=workflow_definition-${d.id}`);
    await dev.post(url, { __csrf: dev.lastCsrf, action: 'new', version: "1'); drop table hr.emp; --" });
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=workflow_definition-${d.id}`)).body;
    assert.match(page, /A version label is letters, digits/);
    const after = await owner.one('select version, dev_version from meta.workflow_definition where id = $1', [d.id]);
    assert.deepEqual(after, { version: d.version, dev_version: d.dev_version });

    const run = (sql: string, params: unknown[] = []) =>
      owner.tx(async (c) => {
        await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'king', true)`, [String(appId)]);
        await c.query('set local role hr_app');
        return c.query(sql, params);
      });
    for (const sql of ['select meta.new_workflow_version($1)', 'select meta.activate_workflow_version($1)', 'select meta.discard_workflow_version($1)'])
      await assert.rejects(run(sql, [d.id]), /permission denied/, sql);
    await assert.rejects(run('select * from meta.workflow_branch'), /permission denied/);
    await assert.rejects(run(`update meta.workflow_definition set version = '9'`), /permission denied/);
  });
});


describe('sprint 23: template components and plug-ins', () => {
  const pageId = async () => (await owner.one('select id from meta.page where app_id = $1 and page_no = 19', [appId])).id as number;

  test('a value from the data cannot become a javascript: link or new markup', async () => {
    const report = await owner.one(`select r.id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 19 and r.type = 'report'`, [appId]);
    await owner.query(`insert into meta.template_component (app_id, static_id, name, template) values ($1, 'sec_link', 'Link', '<a href="#URL#" title="#EMPLOYEE#">#EMPLOYEE#</a>')`, [appId]);
    await owner.query('update meta.region set config = $2 where id = $1', [report.id, JSON.stringify({ ...report.config, column_templates: { employee: { component: 'sec_link', attributes: { URL: '#employee#' } } } })]);
    const ename = (await owner.one('select ename from hr.emp where empno = 7566')).ename;
    try {
      for (const evil of ['javascript:alert(1)', 'JAVA\tSCRIPT:alert(1)', '" onclick="alert(1)', '<svg onload=alert(1)>']) {
        await owner.query('update hr.emp set ename = $1 where empno = 7566', [evil]);
        const body = (await (await as('king')).get('/a/hr/19')).body;
        assert.doesNotMatch(body, /href="\s*java\s*script:/i, evil);
        assert.doesNotMatch(body, /<svg onload|" onclick="/i, evil);
      }
    } finally {
      await owner.query('update hr.emp set ename = $1 where empno = 7566', [ename]);
      await owner.query('update meta.region set config = $2 where id = $1', [report.id, JSON.stringify(report.config)]);
      await owner.query(`delete from meta.template_component where app_id = $1 and static_id = 'sec_link'`, [appId]);
    }
  });

  test('templates with scripts, handlers or styles are refused in the builder, in plug-ins and in SQL', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get('/builder');
    const evil = ['<script>alert(1)</script>', '<img src="x" onerror="alert(1)">', '<svg onload="alert(1)"></svg>', '<a href="javascript:alert(1)">x</a>',
      '<p style="background:url(x)">x</p>', '<iframe srcdoc="x"></iframe>', '<p>#X!RAW#</p>', '<form action="/x"><button>x</button></form>', '<a href="x" data-dialog>x</a>'];
    for (const template of evil) {
      const plugin = JSON.stringify({ format: 'pgapex-plugin/1', type: 'template_component', static_id: 'sec_evil', name: 'Evil', template });
      assert.equal((await dev.post(`/builder/apps/${appId}/template-components/import`, { __csrf: dev.lastCsrf, plugin })).statusCode, 303, template);
      assert.equal((await dev.post(`/builder/apps/${appId}/shared/template_component`, { __csrf: dev.lastCsrf, static_id: 'sec_evil', name: 'Evil', template, attributes: '[]' })).statusCode, 303);
      assert.equal((await owner.one(`select count(*)::int as n from meta.template_component where static_id = 'sec_evil'`)).n, 0, template);
    }
    for (const template of evil.slice(0, 7))
      await assert.rejects(owner.query(`insert into meta.template_component (app_id, static_id, name, template) values ($1, 'sec_evil', 'Evil', $2)`, [appId, template]), /not allowed/, template);
    await assert.rejects(runtime.query(`update meta.template_component set template = '<p>x</p>'`), /permission denied/);
    await assert.rejects(runtime.query(`select meta.import_template_component(1, '{}'::jsonb)`), /permission denied/);
  });

  test('plug-in and settings routes: developers only, with a CSRF token, within the application', async () => {
    const pid = await pageId();
    const { id: rid } = await owner.one(`select id from meta.region where page_id = $1 and type = 'template_component' order by seq limit 1`, [pid]);
    const { id: tid } = await owner.one(`select id from meta.template_component where app_id = $1 and static_id = 'status_badge'`, [appId]);
    const posts = [`/builder/apps/${appId}/template-components/import`, `/builder/pages/${pid}/region/${rid}/template-settings`, `/builder/pages/${pid}/region/${rid}/column-templates`];
    const king = await as('king'); // an application session is not a builder session
    for (const b of [new Browser(), king]) {
      assert.equal((await b.get(`/builder/apps/${appId}/template-components/${tid}/export`)).statusCode, 302);
      for (const url of posts) assert.equal((await b.post(url, { __csrf: b.lastCsrf, plugin: '{}' })).statusCode, 302, url);
    }
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get('/builder');
    for (const url of posts) assert.equal((await dev.post(url, { __csrf: 'forged', plugin: '{}' })).statusCode, 403, url);
    const other = (await owner.one(`select id from meta.app where alias <> 'hr' order by id limit 1`))?.id ?? appId + 100000;
    assert.equal((await dev.get(`/builder/apps/${other}/template-components/${tid}/export`)).statusCode, 404, "another app's id");
    assert.equal((await dev.get(`/builder/apps/${appId}/template-components/1%20or%201=1/export`)).statusCode, 404);
    assert.equal((await dev.post(`/builder/apps/0/template-components/import`, { __csrf: dev.lastCsrf, plugin: '{}' })).statusCode, 404);
  });
});


describe('sprint 23: code editor', () => {
  const developer = async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    return dev;
  };

  test('completions are for developers only: no data without a builder session', async () => {
    const anon = new Browser();
    const king = await as('king');
    for (const b of [anon, king]) {
      const res = await b.get(`/builder/code/completions?app=${appId}`);
      assert.equal(res.statusCode, 302);
      assert.doesNotMatch(res.body, /empno|hr_app|relations/);
    }
    const dev = await developer();
    assert.equal((await dev.get(`/builder/code/completions?app=${appId}`)).statusCode, 200);
  });

  test("completions list only what the app's role can reach, as JSON text", async () => {
    await owner.query(`create table hr."<img src=x onerror=alert(1)>" ("<b>c</b>" int)`);
    await owner.query(`create table hr.sec23_closed (secret text)`);
    await owner.query(`revoke all on hr.sec23_closed from hr_app`);
    await owner.query(`grant select on hr."<img src=x onerror=alert(1)>" to hr_app`);
    const { clearCompletions } = await import('../src/builder/code-editor.ts');
    clearCompletions();
    try {
      const dev = await developer();
      const res = await dev.get(`/builder/code/completions?app=${appId}`);
      assert.match(String(res.headers['content-type']), /^application\/json/);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      const data = JSON.parse(res.body);
      const names = data.relations.map((r: any) => `${r.schema}.${r.name}`);
      assert.ok(names.includes('hr.<img src=x onerror=alert(1)>'), 'odd names are data');
      assert.ok(!names.includes('hr.sec23_closed'), 'no ungranted tables');
      assert.ok(!names.some((n: string) => /^meta\.(developer|account|session|instance_setting|app)$/.test(n)), 'no closed metadata');
      assert.ok(!JSON.stringify(data).includes('password_hash'));
      // the editor never parses suggestions or code as HTML
      const js = (await app.inject({ method: 'GET', url: '/static/code-editor.js' })).body;
      assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\('style'/);
    } finally {
      await owner.query(`drop table hr."<img src=x onerror=alert(1)>"`);
      await owner.query('drop table hr.sec23_closed');
      clearCompletions();
    }
  });

  test('the inline check needs the CSRF token, plans as the app role and runs nothing', async () => {
    const dev = await developer();
    await dev.get(`/builder/apps/${appId}/shared`);
    const csrf = dev.lastCsrf;
    assert.equal((await dev.post('/builder/code/check', { app: String(appId), shape: 'statements', sql: 'delete from hr.emp' })).statusCode, 403);
    const anon = new Browser();
    const anonRes = await anon.post('/builder/code/check', { __csrf: 'x', app: String(appId), shape: 'select', sql: 'select 1' });
    assert.equal(anonRes.statusCode, 302, 'no session: to the sign-in page');
    assert.doesNotMatch(anonRes.body, /planned|No problems/);
    const n = (await owner.one('select count(*)::int as n from hr.emp')).n;
    for (const sql of ['delete from hr.emp', 'update hr.emp set sal = 0', 'do $$ begin delete from hr.emp; end $$', "select 1; delete from hr.emp", 'drop table hr.emp']) {
      const res = await dev.post('/builder/code/check', { __csrf: csrf, app: String(appId), shape: 'statements', sql });
      assert.equal(res.statusCode, 200, sql);
    }
    assert.equal((await owner.one('select count(*)::int as n from hr.emp')).n, n, 'nothing ran');
    const res = JSON.parse((await dev.post('/builder/code/check', { __csrf: csrf, app: String(appId), shape: 'select', sql: 'select password_hash from meta.account' })).body);
    assert.equal(res.ok, false);
    assert.match(res.message, /permission denied/);
    // a GET can't check (or run) anything
    assert.equal((await dev.get(`/builder/code/check?app=${appId}&shape=statements&sql=delete%20from%20hr.emp`)).statusCode, 404);
    assert.equal((await dev.get(`/builder/code/completions?app=${appId}&sql=delete%20from%20hr.emp`)).statusCode, 200);
    assert.equal((await owner.one('select count(*)::int as n from hr.emp')).n, n);
  });

  test("one app's completions never include another app's items or tables, nor what only the owner sees", async () => {
    await owner.query('create schema sec23');
    await owner.query('create table sec23.other_secret (other_col text)');
    await owner.query('create role sec23_role nologin');
    await owner.query('grant usage on schema sec23 to sec23_role');
    await owner.query('grant select on sec23.other_secret to sec23_role');
    const other = (await owner.one(`insert into meta.app (alias, name, db_role) values ('sec23other', 'Other', 'sec23_role') returning id`)).id;
    const noRole = (await owner.one(`insert into meta.app (alias, name) values ('sec23norole', 'No role') returning id`)).id;
    const { clearCompletions } = await import('../src/builder/code-editor.ts');
    clearCompletions();
    try {
      const dev = await developer();
      const get = async (id: number) => JSON.parse((await dev.get(`/builder/code/completions?app=${id}`)).body);
      const hr = await get(appId);
      const o = await get(other);
      // the other app: its own table, none of hr's; no hr items
      assert.equal(o.role, 'sec23_role');
      assert.ok(o.relations.some((r: any) => r.schema === 'sec23' && r.name === 'other_secret'));
      assert.ok(!o.relations.some((r: any) => r.schema === 'hr'), "no hr tables for another app's role");
      assert.ok(!o.items.some((i: any) => /^P\d+_|^AI_/.test(i.name)), "no hr items");
      assert.ok(!o.schemas.includes('hr'));
      // and the other way round
      assert.ok(!hr.relations.some((r: any) => r.schema === 'sec23'), "hr doesn't see the other app's schema");
      assert.ok(!JSON.stringify(hr).includes('other_col'));
      // no role of its own: what the runtime connection may use, never the owner's view
      const n = await get(noRole);
      assert.equal(n.role, (await runtime.one('select current_user as u')).u);
      assert.ok(!n.relations.some((r: any) => r.schema === 'sec23'));
      assert.ok(!n.relations.some((r: any) => /^meta\.(developer|instance_setting)$/.test(`${r.schema}.${r.name}`)));
      // only the columns granted to that role (never the password hash)
      const account = n.relations.find((r: any) => r.schema === 'meta' && r.name === 'account');
      assert.ok(!account || !account.columns.some((c: any) => c.name === 'password_hash'));
      assert.ok(!JSON.stringify(n).includes('password_hash'));
      assert.deepEqual(n.items, []);
      // the cache is per app: asking for one app never answers for another
      assert.notDeepEqual((await get(other)).relations, (await get(appId)).relations);
    } finally {
      await owner.query('delete from meta.app where id = any($1)', [[other, noRole]]);
      await owner.query('drop schema sec23 cascade');
      await owner.query('drop role sec23_role');
      clearCompletions();
    }
  });
});

describe('sprint 23: page designer layout and builder theme', () => {
  const devLogin = async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    return dev;
  };
  // two scratch pages, so a component of one page can be aimed at the other
  const scratch = async () => {
    const page = async (no: number) => {
      const p = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Layout test') returning id`, [appId, no])).id as number;
      const r1 = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'One', 'static', '<p>1</p>') returning id`, [p])).id as number;
      const r2 = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 20, 'Two', 'static', '<p>2</p>') returning id`, [p])).id as number;
      const item = (await owner.one(`insert into meta.item (page_id, region_id, seq, name, label) values ($1, $2, 10, $3, 'Item') returning id`, [p, r1, `P${no}_A`])).id as number;
      return { p, r1, r2, item };
    };
    return { a: await page(9101), b: await page(9102) };
  };
  const drop = () => owner.query('delete from meta.page where app_id = $1 and page_no in (9101, 9102)', [appId]);

  test('layout changes need a signed-in developer and the CSRF token', async () => {
    await drop();
    const { a } = await scratch();
    try {
      const anon = new Browser();
      const king = await as('king');
      const dev = await devLogin();
      for (const [op, form] of [
        ['move', { kind: 'region', id: String(a.r1), dir: 'down' }],
        ['span', { id: String(a.r1), columns: '6' }],
        ['create', { kind: 'region', type: 'static' }],
        ['undo', {}],
        ['redo', {}],
      ] as [string, Record<string, string>][]) {
        const url = `/builder/pages/${a.p}/layout/${op}`;
        assert.equal((await anon.post(url, { ...form, __csrf: 'x' })).statusCode, 302, `${op}: anonymous`);
        assert.equal((await king.post(url, { ...form, __csrf: king.lastCsrf })).statusCode, 302, `${op}: an application user is not a developer`);
        assert.equal((await dev.post(url, { ...form, __csrf: 'forged' })).statusCode, 403, `${op}: forged token`);
      }
      const r = await owner.one('select seq, columns from meta.region where id = $1', [a.r1]);
      assert.deepEqual([r.seq, r.columns], [10, 12], 'nothing changed');
      assert.equal((await owner.one('select count(*)::int as n from meta.region where page_id = $1', [a.p])).n, 2);
      // the theme switch, too
      assert.equal((await anon.post('/builder/theme', { __csrf: 'x', theme: 'light' })).statusCode, 302);
      assert.equal((await dev.post('/builder/theme', { __csrf: 'forged', theme: 'light' })).statusCode, 403);
    } finally {
      await drop();
    }
  });

  test('ids and target regions must belong to the page in the URL', async () => {
    await drop();
    const { a, b } = await scratch();
    try {
      const dev = await devLogin();
      await dev.get(`/builder/pages/${a.p}`);
      const post = (op: string, form: Record<string, string>) => dev.post(`/builder/pages/${a.p}/layout/${op}`, { ...form, __csrf: dev.lastCsrf });
      // another page's components cannot be moved or resized through this page
      assert.equal((await post('move', { kind: 'item', id: String(b.item), dir: 'up' })).statusCode, 404);
      assert.equal((await post('span', { id: String(b.r1), columns: '3' })).statusCode, 404);
      // nor can this page's item go into another page's region, before another page's item, or be created there
      assert.equal((await post('move', { kind: 'item', id: String(a.item), region: String(b.r1), before: '' })).statusCode, 400);
      assert.equal((await post('move', { kind: 'item', id: String(a.item), region: String(a.r2), before: String(b.item) })).statusCode, 400);
      assert.equal((await post('create', { kind: 'item', type: 'text', region: String(b.r1) })).statusCode, 400);
      // only known kinds, types and spans
      assert.equal((await post('move', { kind: 'process', id: String(a.item), dir: 'up' })).statusCode, 400);
      assert.equal((await post('create', { kind: 'region', type: "static'; drop table hr.emp; --" })).statusCode, 400);
      assert.equal((await post('span', { id: String(a.r1), columns: '13' })).statusCode, 400);
      assert.equal((await post('span', { id: String(a.r1), columns: '1 or 1=1' })).statusCode, 400);
      // the JSON answer builder.js uses
      const json = await app.inject({
        method: 'POST', url: `/builder/pages/${a.p}/layout/move`,
        payload: new URLSearchParams({ __csrf: dev.lastCsrf, kind: 'item', id: String(b.item), dir: 'up' }).toString(),
        headers: { cookie: [...dev.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      });
      assert.equal(json.statusCode, 404);
      assert.equal(json.json().ok, false);
      // nothing on the other page moved
      const bi = await owner.one('select region_id, seq from meta.item where id = $1', [b.item]);
      assert.deepEqual([bi.region_id, bi.seq], [b.r1, 10]);
      const br = await owner.one('select columns from meta.region where id = $1', [b.r1]);
      assert.equal(br.columns, 12);
      // the property editor's region field only takes regions of this page, too
      const res = await post('move', { kind: 'item', id: String(a.item), region: String(a.r2), before: '' });
      assert.equal(res.statusCode, 303);
      assert.equal((await owner.one('select region_id from meta.item where id = $1', [a.item])).region_id, a.r2);
      const save = await dev.post(`/builder/pages/${a.p}/c/item/${a.item}`, { __csrf: dev.lastCsrf, name: 'P9101_A', label: 'Item', type: 'text', seq: '10', region_id: String(b.r1) });
      assert.equal(save.statusCode, 303);
      assert.equal((await owner.one('select region_id from meta.item where id = $1', [a.item])).region_id, a.r2, 'not saved into the other page');
      // undo puts the move back
      assert.equal((await post('undo', {})).statusCode, 303);
      assert.equal((await owner.one('select region_id from meta.item where id = $1', [a.item])).region_id, a.r1);
    } finally {
      await drop();
    }
  });

  test('the designer and the theme switch: no style attributes, no open redirect', async () => {
    await drop();
    const { a } = await scratch();
    try {
      const dev = await devLogin();
      for (const url of [`/builder/pages/${a.p}`, `/builder/pages/${a.p}?c=region-${a.r1}`, `/builder/pages/${a.p}?new=item&type=text`]) {
        const res = await dev.get(url);
        assert.equal(res.statusCode, 200, url);
        assert.doesNotMatch(res.body, /\sstyle="/, `${url} has a style attribute`);
        assert.match(res.body, /src="\/static\/builder\.js"/);
      }
      // the runtime never loads the builder's assets
      assert.doesNotMatch((await (await as('king')).get('/a/hr/1')).body, /builder\.(css|js)/);
      assert.equal((await dev.post('/builder/theme', { __csrf: dev.lastCsrf, theme: '"><script>' })).statusCode, 400);
      const res = await app.inject({
        method: 'POST', url: '/builder/theme',
        payload: new URLSearchParams({ __csrf: dev.lastCsrf, theme: 'light' }).toString(),
        headers: { cookie: [...dev.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', referer: 'https://evil.example/builder/x' },
      });
      assert.equal(res.statusCode, 303);
      assert.equal(res.headers.location, '/builder');
      assert.match((await dev.get('/builder')).body, /<html lang="en" data-theme="light">/);
    } finally {
      await drop();
    }
  });
});


describe('sprint 24: App Builder home, dashboard and utilities', () => {
  test('the workspace pages are for signed-in developers only', async () => {
    const king = await as('king'); // an application session is not a builder session
    for (const b of [new Browser(), king])
      for (const url of ['/builder', '/builder/create', '/builder/import', '/builder/dashboard', '/builder/utilities']) {
        const res = await b.get(url);
        assert.equal(res.statusCode, 302, url);
        assert.equal(res.headers.location, '/builder/login', url);
      }
  });

  test('the search term and application names are escaped', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const evil = '"><script>alert(1)</script>';
    const body = (await dev.get(`/builder?q=${encodeURIComponent(evil)}`)).body;
    assert.ok(!body.includes('<script>alert(1)'), 'search term');
    const { name } = await owner.one('select name from meta.app where id = $1', [appId]);
    try {
      await owner.query('update meta.app set name = $2 where id = $1', [appId, `<img src=x onerror=alert(1)>`]);
      for (const url of ['/builder?view=report', '/builder?view=grid', '/builder/dashboard']) {
        const page = (await dev.get(url)).body;
        assert.ok(!page.includes('<img src=x'), url);
        assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'), url);
      }
    } finally {
      await owner.query('update meta.app set name = $2 where id = $1', [appId, name]);
      await dev.get('/builder?view=report');
    }
  });
});


describe('sprint 25: malformed ids in builder URLs', () => {
  test('a URL id that is not a number, or too big, is a 404 without a database error', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    for (const url of ['/builder/users/settings', '/builder/users/abc', '/builder/users/99999999999999', '/builder/users/providers/abc',
      '/builder/apps/abc', '/builder/apps/abc/settings', '/builder/pages/abc', "/builder/apps/1'/settings"]) {
      const res = await dev.get(url);
      assert.equal(res.statusCode, 404, url);
      assert.doesNotMatch(res.body, /invalid input syntax|22P02|out of range/, url);
    }
  });
});


describe('sprint 26 views: calendar drag and drop, create links, chart drill-down', () => {
  const page24 = async (type: string, title?: string) =>
    (await owner.one(`select r.id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 24 and r.type = $2${title ? ' and r.title = $3' : ''}`, title ? [appId, type, title] : [appId, type])) as { id: number; config: any };
  const meetingRow = async (title: string) => (await owner.one(`select id, starts_at::text as s, ends_at::text as e from hr.meeting where title = $1`, [title])) as { id: number; s: string; e: string };
  const move = (b: Browser, rid: number, form: Record<string, string>, csrf = b.lastCsrf) => b.post(`/a/hr/24/calendar/${rid}/move`, { __csrf: csrf, ...form });
  const day = (m: { s: string }) => m.s.slice(0, 10);

  test('moving needs the session\'s CSRF token and a signed-in user', async () => {
    const cal = await page24('calendar');
    const m = await meetingRow('Team stand-up');
    const king = await as('king');
    await king.get('/a/hr/24');
    for (const csrf of ['', 'forged']) assert.equal((await move(king, cal.id, { key: String(m.id), to: `${day(m)}T12:00` }, csrf)).statusCode, 403, csrf);
    const anon = new Browser();
    await anon.get('/a/hr/login');
    const res = await move(anon, cal.id, { key: String(m.id), to: `${day(m)}T12:00` });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(await meetingRow('Team stand-up'), m);
  });

  test('only events the user sees in the calendar can be moved (the region query, as the app role, with RLS)', async () => {
    const cal = await page24('calendar');
    const secret = await meetingRow('One-to-one with Jones'); // king's private meeting
    const blake = await as('blake');
    const body = (await blake.get('/a/hr/24')).body;
    assert.doesNotMatch(body, /One-to-one/);
    // an event outside the region's query (or a key crafted to widen it) is refused before the move SQL runs
    for (const key of [String(secret.id), `${secret.id}' or '1'='1`, `0 or true`, 'x'.repeat(201)]) {
      const res = await move(blake, cal.id, { key, to: `${day(secret)}T08:00` });
      assert.equal(res.statusCode, 403, key);
      assert.match(res.json().error, /can no longer be moved/);
    }
    assert.deepEqual(await meetingRow('One-to-one with Jones'), secret);
    const log = await owner.one(`select detail from meta.activity_log where event = 'forbidden' and detail like 'calendar move%' order by id desc limit 1`);
    assert.equal(log.detail, `calendar move: region ${cal.id}`);
  });

  test('the drop target is validated and never becomes SQL text', async () => {
    const cal = await page24('calendar');
    const m = await meetingRow('Team stand-up');
    const king = await as('king');
    await king.get('/a/hr/24');
    for (const to of [`${day(m)}'); delete from hr.meeting; --`, '2026-02-30', `${day(m)}T25:00`, `${day(m)} 10:00`, '']) {
      const res = await move(king, cal.id, { key: String(m.id), to });
      assert.equal(res.statusCode, 400, to);
      assert.match(res.json().error, /not a valid date/);
    }
    assert.deepEqual(await meetingRow('Team stand-up'), m);
    assert.ok((await owner.one('select count(*)::int as n from hr.meeting')).n >= 7);
  });

  test('regions without drag and drop, other region types, hidden regions and move_authz are refused', async () => {
    const cal = await page24('calendar');
    const chart = await page24('chart', 'Jobs per department');
    const leave = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 12`, [appId])).id;
    const m = await meetingRow('Team stand-up');
    const king = await as('king');
    await king.get('/a/hr/24');
    for (const rid of [chart.id, leave, 999999]) assert.equal((await move(king, rid, { key: String(m.id), to: `${day(m)}T12:00` })).statusCode, 403, String(rid));
    // the leave calendar on its own page: no move SQL configured
    await king.get('/a/hr/12');
    assert.equal((await king.post(`/a/hr/12/calendar/${leave}/move`, { __csrf: king.lastCsrf, key: '1', to: '2026-10-05' })).statusCode, 403);
    const allen = await as('allen');
    try {
      // an authorization scheme for dragging: allen is no manager
      await owner.query(`update meta.region set config = config || '{"move_authz": "MANAGER"}' where id = $1`, [cal.id]);
      const body = (await allen.get('/a/hr/24')).body;
      assert.doesNotMatch(body, /data-calendar=|draggable=|data-drop=/);
      assert.equal((await move(allen, cal.id, { key: String(m.id), to: `${day(m)}T12:00` })).statusCode, 403);
      // a region hidden by its condition can't be used either
      await owner.query(`update meta.region set config = config - 'move_authz', condition = 'false' where id = $1`, [cal.id]);
      await king.get('/a/hr/24');
      assert.equal((await move(king, cal.id, { key: String(m.id), to: `${day(m)}T12:00` })).statusCode, 403);
    } finally {
      await owner.query(`update meta.region set config = $2, condition = null where id = $1`, [cal.id, JSON.stringify(cal.config)]);
    }
    assert.deepEqual(await meetingRow('Team stand-up'), m);
  });

  test('the move SQL runs as the application role with the values as literals', async () => {
    const cal = await page24('calendar');
    const m = await meetingRow('Research demo');
    const king = await as('king');
    try {
      await owner.query(`update meta.region set config = config || $2::jsonb where id = $1`, [cal.id, JSON.stringify({
        move: `update hr.meeting set title = current_user || ':' || :EVENT_ID || ':' || :NEW_START, starts_at = :NEW_START::timestamp, ends_at = :NEW_END::timestamp where id = :EVENT_ID::int`,
      })]);
      await king.get('/a/hr/24');
      const res = await move(king, cal.id, { key: String(m.id), to: `${day(m)}T08:00` });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await owner.one('select title from hr.meeting where id = $1', [m.id])).title, `hr_app:${m.id}:${day(m)} 08:00`);
    } finally {
      await owner.query(`update meta.region set config = $2 where id = $1`, [cal.id, JSON.stringify(cal.config)]);
      await owner.query('update hr.meeting set title = $2, starts_at = $3, ends_at = $4 where id = $1', [m.id, 'Research demo', m.s, m.e]);
    }
  });

  test('create links are checksummed: a changed slot is refused', async () => {
    const king = await as('king');
    const body = (await king.get('/a/hr/24')).body;
    const href = /<a class="cal-add" href="([^"]+)"/.exec(body)![1].replace(/&amp;/g, '&');
    assert.equal((await king.get(href)).statusCode, 200);
    const forged = href.replace(/P24_STARTS_AT=[^&]+/, 'P24_STARTS_AT=2000-01-01');
    assert.equal((await king.get(forged)).statusCode, 403);
    // another user can't reuse king's link either (the checksum includes the user)
    assert.equal((await (await as('allen')).get(href)).statusCode, 403);
  });

  test('chart drill-down: checksummed links, escaped values, none to pages the user may not open', async () => {
    const chart = await page24('chart', 'Departments: service, pay and size');
    const { source } = await owner.one('select source from meta.region where id = $1', [chart.id]);
    const allen = await as('allen');
    const body = (await allen.get('/a/hr/24')).body;
    const href = /<a class="bubble s1 \w+ drill" href="([^"]+)"/.exec(body)![1].replace(/&amp;/g, '&');
    const q = new URLSearchParams(href.split('?')[1]);
    assert.equal(q.get('cs'), urlChecksum(appId, 2, 'allen', { P2_DEPTNO: q.get('P2_DEPTNO')! }));
    assert.equal((await allen.get(href)).statusCode, 200);
    try {
      // a label with markup, a link item from it, and a target page allen may not open
      await owner.query(`update meta.region set source = $2, config = config || '{"link": {"page": 2, "items": {"P2_DEPTNO": "#department#"}}}' where id = $1`,
        [chart.id, `select '"><img src=x onerror=alert(1)>' as department, 1 as x, 2 as y, 3 as z`]);
      const page = (await allen.get('/a/hr/24')).body;
      assert.ok(!page.includes('<img src=x'));
      assert.match(page, /P2_DEPTNO=%22%3E%3Cimg/);
      await owner.query(`update meta.region set config = config || '{"link": {"page": 3, "items": {"P3_EMPNO": "#x#"}}}' where id = $1`, [chart.id]);
      const none = (await allen.get('/a/hr/24')).body;
      assert.doesNotMatch(none, /\/a\/hr\/3\?/, 'page 3 needs MANAGER');
      assert.match(none, /class="bubble s1 \w+" role="img" data-tip=/);
    } finally {
      await owner.query(`update meta.region set config = $2, source = $3 where id = $1`, [chart.id, JSON.stringify(chart.config), source]);
    }
  });
});

describe('sprint 26 regions: smart filters, facet kinds, display selector', () => {
  const region = async (title: string) =>
    (await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                       where a.alias = 'hr' and p.page_no = 21 and r.title = $1`, [title])) as { id: number; page_id: number };
  const rows = (body: string, rid: number) => (new RegExp(`id="R${rid}"[\\s\\S]*?<tbody>([\\s\\S]*?)</tbody>`).exec(body)?.[1].match(/data-label="Name"/g) ?? []).length;
  const url = (params: [string, string][]) => `/a/hr/21?${new URLSearchParams(params)}`;

  test('facet values, range bounds and search terms are query parameters: injection finds nothing', async () => {
    const { id: rid } = await region('Employee list');
    const king = await as('king');
    const n: [string, string] = [`r${rid}_n`, '50'];
    const all = rows((await king.get(url([n]))).body, rid);
    for (const params of [
      [[`r${rid}_x_job`, "Clerk' or '1'='1"]],
      [[`r${rid}_q`, "%' or 1=1 --"]],
      [[`r${rid}_rf_salary`, '0 or 1=1'], [`r${rid}_rt_salary`, "1); drop table hr.emp; --"]],
      [[`r${rid}_rg_salary`, "3000|' or 1=1 --"]],
      [[`r${rid}_rf_hiredate`, '1980-02-30']],
      [[`r${rid}_x_job"; drop table hr.emp; --`, 'x']],
      [[`r${rid}_rg_rating`, '0|']], // not one of the star facet's ranges
    ] as [string, string][][]) {
      const res = await king.get(url([n, ...params]));
      assert.equal(res.statusCode, 200, JSON.stringify(params));
      assert.doesNotMatch(res.body, /alert-error/, JSON.stringify(params));
      const shown = rows(res.body, rid);
      assert.ok(shown === 0 || shown === all, `${JSON.stringify(params)}: no rows, or the filter ignored (${shown})`);
    }
    // a malformed exclude switch is just "not excluded": the four clerks
    assert.equal(rows((await king.get(url([n, [`r${rid}_x_job`, 'Clerk'], [`r${rid}_xn_job`, "1' or '1'='1"]]))).body, rid), 4);
    assert.equal((await owner.one('select count(*)::int as n from hr.emp')).n, 14);
  });

  test('a NUL byte, huge and repeated values do not fail the page', async () => {
    const { id: rid } = await region('Employee list');
    const king = await as('king');
    const res = await king.get(`/a/hr/21?r${rid}_x_job=a%00b&r${rid}_q=x%00&${Array.from({ length: 300 }, (_, i) => `r${rid}_x_job=v${i}`).join('&')}&r${rid}_rf_salary=${'9'.repeat(400)}`);
    assert.ok([200, 400].includes(res.statusCode), String(res.statusCode));
    assert.doesNotMatch(res.body, /invalid byte sequence|22021|stack/);
  });

  test('values typed by users are escaped in chips, suggestions and the search field', async () => {
    const { id: rid } = await region('Employees');
    const king = await as('king');
    const body = (await king.get(url([[`r${rid}_q`, '<script>alert(1)</script>'], [`r${rid}_x_job`, '"><img src=x onerror=alert(1)>']]))).body;
    assert.doesNotMatch(body, /<script>alert\(1\)|<img src=x/);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('only facets of regions the user may see filter a report', async () => {
    const sf = await region('Find employees');
    const { id: rid } = await region('Employees');
    const king = await as('king');
    const filtered = url([[`r${rid}_n`, '50'], [`r${rid}_x_department`, 'SALES']]);
    assert.equal(rows((await king.get(filtered)).body, rid), 6);
    try {
      await owner.query(`update meta.region set authz = 'ADMIN' where id = $1`, [sf.id]);
      const blake = await as('blake');
      assert.equal(rows((await blake.get(filtered)).body, rid), 14, 'the smart filters are hidden from blake: their facets do not apply');
    } finally {
      await owner.query(`update meta.region set authz = null where id = $1`, [sf.id]);
    }
  });

  test('the display selector lists no tab for a region the user may not see', async () => {
    const chart = await region('Average salary by job');
    try {
      await owner.query(`update meta.region set authz = 'ADMIN' where id = $1`, [chart.id]);
      const body = (await (await as('blake')).get('/a/hr/21')).body;
      assert.doesNotMatch(body, />Salaries</);
      assert.doesNotMatch(body, new RegExp(`R${chart.id}\\b`));
    } finally {
      await owner.query(`update meta.region set authz = null where id = $1`, [chart.id]);
    }
  });

  test('settings routes: developers only, with a CSRF token, on the region\'s own page', async () => {
    const sel = await region('Views');
    const sf = await region('Find employees');
    const before = (await owner.query('select id, config from meta.region where page_id = $1 order by id', [sel.page_id])).rows;
    const king = await as('king');
    for (const b of [new Browser(), king])
      assert.equal((await b.post(`/builder/pages/${sel.page_id}/region/${sel.id}/settings`, { __csrf: b.lastCsrf, style: 'select', members: '1' })).statusCode, 302);
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get(`/builder/pages/${sel.page_id}`);
    assert.equal((await dev.post(`/builder/pages/${sel.page_id}/region/${sel.id}/settings`, { __csrf: 'forged', style: 'select', members: '1' })).statusCode, 403);
    const otherPage = (await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2`)).id;
    assert.equal((await dev.post(`/builder/pages/${otherPage}/region/${sel.id}/settings`, { __csrf: dev.lastCsrf, style: 'select', members: '1' })).statusCode, 404, 'a region of another page');
    // a smart filters region can only point at a report region of its own page
    const otherReport = (await owner.one(`select r.id from meta.region r where r.page_id = $1 and r.type = 'report'`, [otherPage])).id;
    try {
      await dev.post(`/builder/pages/${sf.page_id}/region/${sf.id}/settings`, { __csrf: dev.lastCsrf, report: String(otherReport), n: '1', col_0: 'job', on_0: 'true' });
      const cfg = (await owner.one('select config from meta.region where id = $1', [sf.id])).config;
      assert.notEqual(Number(cfg.report), otherReport);
    } finally {
      for (const r of before) await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
    }
    assert.deepEqual((await owner.query('select id, config from meta.region where page_id = $1 order by id', [sel.page_id])).rows, before);
  });
});

describe('sprint 26 logic: computations, branches, menus, badges, dynamic actions, build options', () => {
  const page22 = async () => (await owner.one(`select p.id from meta.page p where p.app_id = $1 and p.page_no = 22`, [appId])).id as number;
  const king = async () => {
    const b = await as('king');
    await b.get('/a/hr/22');
    return b;
  };

  test('computation SQL and function bodies run as the application role; item values stay literals', async () => {
    const pid = await page22();
    const ids = (
      await owner.query(
        `insert into meta.computation (page_id, seq, item_name, point, type, expression) values
           ($1, 95, 'P22_NAME', 'after_submit', 'function_body', 'return current_user || '':'' || :P22_DAYS;'),
           ($1, 96, 'P22_PENDING', 'after_submit', 'sql_query', 'select session_user = current_user') returning id`,
        [pid],
      )
    ).rows.map((r) => r.id);
    // (the example's rounding computation would refuse this value: left out with a build option)
    await owner.query(`update meta.computation set build_option = 'LEAVE_FORECAST' where page_id = $1 and seq = 40 and point = 'after_submit'`, [pid]);
    // a number item refuses text that is not a number (sprint 31): a text item carries it here
    await owner.query(`update meta.item set type = 'text' where page_id = $1 and name = 'P22_DAYS'`, [pid]);
    try {
      const b = await king();
      const evil = `1'; drop table hr.emp; --$pgapex_x$ $$`;
      assert.equal((await b.post('/a/hr/22', { __csrf: b.lastCsrf, P22_EMPNO: '7839', P22_DAYS: evil, __request: 'PLAN' })).statusCode, 303);
      const state = (await owner.one(`select state from meta.session where username = 'king' order by last_seen desc limit 1`)).state;
      assert.equal(state.P22_NAME, `hr_app:${evil}`);
      assert.equal(state.P22_PENDING, 'false', 'not the connection role');
      assert.ok(await owner.one(`select to_regclass('hr.emp') as t`).then((r) => r.t));
      // the temporary function does not outlive the request
      assert.equal((await owner.one(`select count(*)::int as n from pg_proc where proname like 'pgapex_computation_%'`)).n, 0);
    } finally {
      await owner.query('delete from meta.computation where id = any($1)', [ids]);
      await owner.query(`update meta.computation set build_option = null where page_id = $1`, [pid]);
      await owner.query(`update meta.item set type = 'number' where page_id = $1 and name = 'P22_DAYS'`, [pid]);
    }
  });

  test('the database checks computation and branch definitions', async () => {
    const pid = await page22();
    const bad: [string, string][] = [
      ['computation', `(page_id, item_name, type, expression) values (${pid}, 'p22_x', 'static', 'x')`],
      ['computation', `(page_id, item_name, type, expression) values (${pid}, 'P22_X', 'item', 'P22_X; drop')`],
      ['computation', `(page_id, item_name, type, expression) values (${pid}, 'P22_X', 'sql_query', ' ')`],
      ['computation', `(page_id, item_name, condition_type, condition_expr) values (${pid}, 'P22_X', 'item_null', 'x or 1=1')`],
      ['computation', `(page_id, item_name, condition_type, condition_value) values (${pid}, 'P22_X', 'request_in', 'SAVE; x')`],
      ['branch', `(page_id, name, target_type, target_url) values (${pid}, 'x', 'url', 'https://evil.example')`],
      ['branch', `(page_id, name, target_type, target_url) values (${pid}, 'x', 'url', '//evil.example')`],
      ['branch', `(page_id, name, target_type, target_url) values (${pid}, 'x', 'url', '/\\\\evil.example')`],
      ['branch', `(page_id, name, target_type, target_url) values (${pid}, 'x', 'url', '../other/1')`],
      ['branch', `(page_id, name, target_type, target_url) values (${pid}, 'x', 'url', 'javascript:alert(1)')`],
      ['branch', `(page_id, name, target_type, target_url) values (${pid}, 'x', 'url', '1?a=b//evil')`],
      ['branch', `(page_id, name, target_type) values (${pid}, 'x', 'url')`],
      ['branch', `(page_id, name, when_button) values (${pid}, 'x', 'save')`],
    ];
    for (const [table, values] of bad) await assert.rejects(owner.query(`insert into meta.${table} ${values}`), /violates check constraint/, values);
  });

  test('a URL branch encodes substituted values, so an item cannot leave the application', async () => {
    const pid = await page22();
    const b = await owner.one(`insert into meta.branch (page_id, seq, name, when_button, target_type, target_url) values ($1, 4, 'u', 'CHECK', 'url', '&P22_NAME.') returning id`, [pid]);
    const c = await owner.one(`insert into meta.computation (page_id, seq, item_name, point, type, expression) values ($1, 97, 'P22_NAME', 'after_submit', 'static', '//evil.example/x') returning id`, [pid]);
    try {
      const k = await king();
      const res = await k.post('/a/hr/22', { __csrf: k.lastCsrf, P22_EMPNO: '7839', P22_DAYS: '3', __request: 'CHECK' });
      assert.equal(res.headers.location, `/a/hr/${encodeURIComponent('//evil.example/x')}`);
    } finally {
      await owner.query('delete from meta.branch where id = $1', [b.id]);
      await owner.query('delete from meta.computation where id = $1', [c.id]);
    }
  });

  test('menu requests: only entries the user is authorized for, never a hidden button of the same name', async () => {
    const pid = await page22();
    const before = (await owner.one(`select menu from meta.button where page_id = $1 and name = 'MORE'`, [pid])).menu;
    try {
      await owner.query(`update meta.button set menu = $2 where page_id = $1 and name = 'MORE'`,
        [pid, JSON.stringify([{ label: 'Admins', request: 'ADMIN_ONLY', authz: 'ADMIN' }, { label: 'Plan', request: 'PLAN' }])]);
      await owner.query(`update meta.button set condition = 'false' where page_id = $1 and name = 'PLAN'`, [pid]);
      const scott = await as('scott');
      const body = (await scott.get('/a/hr/22')).body;
      assert.doesNotMatch(body, /value="ADMIN_ONLY"/);
      assert.doesNotMatch(body, /value="PLAN"/);
      for (const request of ['ADMIN_ONLY', 'PLAN', 'NOT_IN_ANY_MENU'])
        assert.equal((await scott.post('/a/hr/22', { __csrf: scott.lastCsrf, P22_DAYS: '3', __request: request })).statusCode, 403, request);
      // an authorized user may send the entry's request
      const k = await king();
      assert.match((await k.get('/a/hr/22')).body, /value="ADMIN_ONLY"/);
      assert.equal((await k.post('/a/hr/22', { __csrf: k.lastCsrf, P22_EMPNO: '7839', P22_DAYS: '3', __request: 'ADMIN_ONLY' })).statusCode, 303);
      // the database checks entries
      for (const menu of [[{ label: 'x' }], [{ label: 'x', page: 1, request: 'X' }], [{ label: 'x', request: 'x; drop' }], [{ label: 'x', page: 'javascript:1' }], [{ label: 'x', page: 1, authz: 'a b' }], { label: 'x' }])
        await assert.rejects(owner.query(`update meta.button set menu = $2 where page_id = $1 and name = 'MORE'`, [pid, JSON.stringify(menu)]), /violates check constraint/, JSON.stringify(menu));
    } finally {
      await owner.query(`update meta.button set menu = $2 where page_id = $1 and name = 'MORE'`, [pid, JSON.stringify(before)]);
      await owner.query(`update meta.button set condition = null where page_id = $1 and name = 'PLAN'`, [pid]);
    }
  });

  test('menu labels and badges are escaped; a badge query runs as the application role', async () => {
    const pid = await page22();
    const before = (await owner.one(`select menu from meta.button where page_id = $1 and name = 'MORE'`, [pid])).menu;
    try {
      await owner.query(`update meta.button set menu = $2, badge = '<b>&APP_USER.</b>' where page_id = $1 and name = 'MORE'`,
        [pid, JSON.stringify([{ label: '<img src=x onerror=alert(1)>', page: 6, confirm: '"><script>' }])]);
      await owner.query(`update meta.button set badge_query = 'select current_user' where page_id = $1 and name = 'PLAN'`, [pid]);
      const body = (await (await king()).get('/a/hr/22')).body;
      assert.ok(!body.includes('<img src=x'));
      assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'));
      assert.ok(!body.includes('"><script>'));
      assert.ok(body.includes('&lt;b&gt;king&lt;/b&gt;'));
      assert.match(body, /value="PLAN"[^>]*>Plan <span class="btn-badge">hr_app<\/span>/);
    } finally {
      await owner.query(`update meta.button set menu = $2, badge = null where page_id = $1 and name = 'MORE'`, [pid, JSON.stringify(before)]);
      await owner.query(`update meta.button set badge_query = null where page_id = $1 and name = 'PLAN'`, [pid]);
    }
  });

  test('dynamic action CSS classes: only safe names, in the database, the builder and the page', async () => {
    const pid = await page22();
    for (const bad of ['Upper', 'a"b', 'x onclick=1', 'a{color:red}', '-x', 'a b c d e f', 'a  b', ' a'])
      await assert.rejects(owner.query(`update meta.dynamic_action set css_classes = $2 where page_id = $1 and action = 'add_class'`, [pid, bad]), /violates check constraint/, bad);
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const da = await owner.one(`select * from meta.dynamic_action where page_id = $1 and action = 'add_class'`, [pid]);
    await dev.get(`/builder/pages/${pid}?c=dynamic_action-${da.id}`);
    await dev.post(`/builder/pages/${pid}/c/dynamic_action/${da.id}`, { __csrf: dev.lastCsrf, name: da.name, event: 'click', action: 'add_class', css_classes: 'x" onmouseover="alert(1)', seq: '40' });
    assert.equal((await owner.one('select css_classes from meta.dynamic_action where id = $1', [da.id])).css_classes, 'is-highlight');
    assert.match(await import('node:fs').then((fs) => fs.readFileSync('public/app.js', 'utf8')), /CLASS_NAME = \/\^\[a-z\]\[a-z0-9_-\]\{0,39\}\$\//);
  });

  test('build options: excluded buttons, dynamic actions and pages cannot be used by forged requests', async () => {
    const pid = await page22();
    const da = await owner.one(`select id from meta.dynamic_action where page_id = $1 and action = 'show_success'`, [pid]);
    await owner.query(`update meta.button set build_option = 'LEAVE_FORECAST' where page_id = $1 and name = 'CHECK'`, [pid]);
    await owner.query(`update meta.dynamic_action set build_option = 'LEAVE_FORECAST' where id = $1`, [da.id]);
    try {
      const k = await king();
      assert.doesNotMatch((await k.get('/a/hr/22')).body, /value="CHECK"/);
      assert.equal((await k.post('/a/hr/22', { __csrf: k.lastCsrf, P22_DAYS: '3', __request: 'CHECK' })).statusCode, 403);
      assert.equal((await k.post(`/a/hr/22/da/${da.id}`, { __csrf: k.lastCsrf })).statusCode, 403);
      await owner.query(`update meta.page set build_option = 'NO_SUCH_OPTION' where id = $1`, [pid]);
      assert.equal((await k.post('/a/hr/22', { __csrf: k.lastCsrf, P22_DAYS: '3', __request: 'PLAN' })).statusCode, 404);
      // the database checks the reference
      await assert.rejects(owner.query(`update meta.page set build_option = 'lower' where id = $1`, [pid]), /violates check constraint/);
      await assert.rejects(owner.query(`update meta.page set build_option = '!!X' where id = $1`, [pid]), /violates check constraint/);
    } finally {
      await owner.query(`update meta.page set build_option = null where id = $1`, [pid]);
      await owner.query(`update meta.button set build_option = null where page_id = $1`, [pid]);
      await owner.query(`update meta.dynamic_action set build_option = null where id = $1`, [da.id]);
    }
  });

  test('build options, computations and branches: developers only, with CSRF; the runtime role cannot change them', async () => {
    const pid = await page22();
    const k = await king();
    for (const url of [`/builder/pages/${pid}/c/computation`, `/builder/pages/${pid}/c/branch`, `/builder/apps/${appId}/shared/build_option`]) {
      const res = await k.post(url, { __csrf: k.lastCsrf, name: 'X', item_name: 'P22_X' });
      assert.notEqual(res.statusCode, 303, url);
    }
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    assert.equal((await dev.post(`/builder/apps/${appId}/shared/build_option`, { __csrf: 'wrong', name: 'CSRF_TEST' })).statusCode, 403);
    assert.equal(await owner.one(`select 1 from meta.build_option where name = 'CSRF_TEST'`), undefined);
    for (const sql of [`update meta.build_option set status = 'include'`, `insert into meta.computation (page_id, item_name) values (${pid}, 'P22_X')`, `delete from meta.branch`])
      await assert.rejects(runtime.query(sql), /permission denied/, sql);
  });
});

describe('sprint 26 data: REST data sources, web credentials, invoke_api', () => {
  const env = { ...process.env };
  let mock: import('node:http').Server;
  let mockBase = '';
  const hits: { url: string; auth: string | null }[] = [];
  const dev = new Browser();
  const cleanup: string[] = [];

  before(async () => {
    process.env.PGAPEX_SECRET_KEY = 'security-test-secret-key-0123456789abcdef';
    process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1';
    process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';
    const http = await import('node:http');
    mock = http.createServer((req, res) => {
      hits.push({ url: req.url!, auth: req.headers.authorization ?? null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, path: req.url, items: [{ v: "it's $$ \"x\" ); drop table hr.emp; --" }] }));
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    mockBase = `http://127.0.0.1:${(mock.address() as import('node:net').AddressInfo).port}`;
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get('/builder');
  });

  after(async () => {
    await owner.query(`delete from meta.web_credential where app_id = $1 and name like 'SEC\\_%'`, [appId]);
    await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'SEC\\_%'`, [appId]);
    for (const sql of cleanup) await owner.query(sql);
    mock.close();
    for (const k of ['PGAPEX_SECRET_KEY', 'PGAPEX_REST_ALLOWED_HOSTS', 'PGAPEX_REST_PRIVATE_HOSTS'])
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  });

  test('a web credential secret is write-only: encrypted, never shown, exported or readable by the runtime role', async () => {
    const { decryptSecret } = await import('../src/secrets.ts');
    const secret = 'sec-test-Secret-value-4711';
    // a forged secret_enc in the form is ignored; only "secret" is taken, and encrypted
    const res = await dev.post(`/builder/apps/${appId}/shared/web_credential`, {
      __csrf: dev.lastCsrf, name: 'SEC_CRED', type: 'bearer', secret, secret_enc: 'v1:forged', valid_for: `${mockBase}/`,
    });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select id, secret_enc from meta.web_credential where app_id = $1 and name = 'SEC_CRED'`, [appId]);
    assert.match(row.secret_enc, /^v1:/);
    assert.notEqual(row.secret_enc, 'v1:forged');
    assert.ok(!row.secret_enc.includes(secret));
    assert.equal(decryptSecret(row.secret_enc), secret);
    // the builder shows that a secret is stored, never the secret or its ciphertext
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=web_credential-${row.id}`)).body;
    assert.match(page, /A secret is stored/);
    assert.ok(!page.includes(secret) && !page.includes(row.secret_enc), 'not in the builder page');
    // saving without a secret keeps the stored one
    assert.equal((await dev.post(`/builder/apps/${appId}/shared/web_credential/${row.id}`, { __csrf: dev.lastCsrf, name: 'SEC_CRED', type: 'bearer', secret: '', valid_for: `${mockBase}/` })).statusCode, 303);
    assert.equal((await owner.one('select secret_enc from meta.web_credential where id = $1', [row.id])).secret_enc, row.secret_enc);
    // exports (JSON, directory) and the search leave it out
    const doc = JSON.stringify((await owner.one(`select meta.export_app('hr') as d`)).d);
    assert.ok(doc.includes('SEC_CRED') && !doc.includes('secret_enc') && !doc.includes(row.secret_enc));
    const zip = await dev.get(`/builder/apps/${appId}/export?format=dir`);
    assert.ok(!zip.rawPayload.includes(Buffer.from(row.secret_enc)));
    assert.ok(!(await dev.get(`/builder/apps/${appId}/search?q=${encodeURIComponent(row.secret_enc.slice(3, 20))}`)).body.includes(row.secret_enc));
    // the runtime role (and so application SQL) can't read it
    await assert.rejects(runtime.query('select secret_enc from meta.web_credential'), /permission denied/);
    assert.ok((await runtime.query(`select name from meta.web_credential where name = 'SEC_CRED'`)).rowCount === 1, 'the other columns are readable');
    // an imported document can't bring a secret along
    const imported = await owner.one(`select meta.import_app(meta.export_app('hr') || jsonb_build_object('web_credentials',
      jsonb_build_array(jsonb_build_object('name', 'SEC_IMPORTED', 'type', 'bearer', 'secret_enc', $1::text))), 'sec_import_26') as id`, [row.secret_enc]);
    cleanup.push(`delete from meta.app where id = ${Number(imported.id)}`);
    assert.equal((await owner.one(`select secret_enc from meta.web_credential where app_id = $1 and name = 'SEC_IMPORTED'`, [imported.id])).secret_enc, null);
    // removing the secret needs a developer, the CSRF token and the right application
    const anon = new Browser();
    assert.equal((await anon.post(`/builder/apps/${appId}/web-credentials/${row.id}/clear`, { __csrf: 'x' })).statusCode, 302);
    assert.equal((await dev.post(`/builder/apps/${appId}/web-credentials/${row.id}/clear`, { __csrf: 'wrong' })).statusCode, 403);
    await dev.post(`/builder/apps/${imported.id}/web-credentials/${row.id}/clear`, { __csrf: dev.lastCsrf });
    assert.ok((await owner.one('select secret_enc from meta.web_credential where id = $1', [row.id])).secret_enc, 'another app id: not removed');
    await dev.post(`/builder/apps/${appId}/web-credentials/${row.id}/clear`, { __csrf: dev.lastCsrf });
    assert.equal((await owner.one('select secret_enc from meta.web_credential where id = $1', [row.id])).secret_enc, null);
  });

  test('"Test" of a source: developers only, CSRF, the right application; the credential stays with its URLs', async () => {
    const { encryptSecret } = await import('../src/secrets.ts');
    await owner.query(`insert into meta.web_credential (app_id, name, type, secret_enc, valid_for) values ($1, 'SEC_KEY', 'bearer', $2, $3)`,
      [appId, encryptSecret('only-for-the-mock'), [`${mockBase}/ok/`]]);
    const src = await owner.one(`insert into meta.rest_source (app_id, name, url, credential) values ($1, 'SEC_SRC', $2, 'SEC_KEY') returning id`, [appId, `${mockBase}/ok/data`]);
    const url = `/builder/apps/${appId}/rest-sources/${src.id}/test`;
    const n = hits.length;
    assert.equal((await new Browser().post(url, { __csrf: 'x' })).statusCode, 302, 'not signed in: to the login page');
    assert.equal((await dev.post(url, { __csrf: 'wrong' })).statusCode, 403);
    assert.equal((await dev.post(`/builder/apps/${appId + 100000}/rest-sources/${src.id}/test`, { __csrf: dev.lastCsrf })).statusCode, 404);
    assert.equal(hits.length, n, 'no request was made');
    assert.equal((await dev.post(url, { __csrf: dev.lastCsrf })).statusCode, 303);
    assert.deepEqual(hits.slice(n), [{ url: '/ok/data', auth: 'Bearer only-for-the-mock' }]);
    // pointed elsewhere, the source fails instead of sending the secret
    await owner.query('update meta.rest_source set url = $2 where id = $1', [src.id, `${mockBase}/other`]);
    await dev.post(url, { __csrf: dev.lastCsrf });
    assert.equal(hits.length, n + 1);
    assert.match((await dev.get(`/builder/apps/${appId}/shared?c=rest_source-${src.id}`)).body, /not valid for this URL/);
    // "Use these columns" checks the column names
    await dev.post(`/builder/apps/${appId}/rest-sources/${src.id}/columns`, { __csrf: dev.lastCsrf, columns: '[{"name": "x\\"); drop table hr.emp; --"}]' });
    assert.deepEqual((await owner.one('select columns from meta.rest_source where id = $1', [src.id])).columns, []);
  });

  test('parameter values can not change the host, add headers or break out of the SQL', async () => {
    const ws = await import('../src/websources.ts');
    const { invokeProblems } = await import('../src/runtime/rest-sources.ts');
    const s = {
      id: 0, app_id: appId, name: 'SEC', url: `${mockBase}/a/{p}`, method: 'GET', credential: null, headers: {}, body: null, row_selector: null,
      params: [{ name: 'p', in: 'path' as const }, { name: 'q', in: 'query' as const }, { name: 'h', in: 'header' as const }], columns: [], cache_seconds: 0, timeout_s: 5, max_rows: 10,
    };
    for (const p of ['@evil.example/', '//evil.example/x', '../../admin', 'x?y=1#z', 'http://evil.example/'])
      assert.equal(new URL(ws.buildRequest(s, { p }).url).host, new URL(mockBase).host, p);
    for (const p of ['.', '..']) assert.throws(() => ws.buildRequest(s, { p }), /not a valid value/);
    assert.throws(() => ws.buildRequest(s, { p: 'x', h: 'a\r\nX-Injected: 1' }), /one line/);
    assert.throws(() => ws.buildRequest(s, { nope: 'x' }), /no parameter nope/);
    // a definition written straight into the table is checked again before a call
    assert.throws(() => ws.buildRequest({ ...s, url: 'http://{p}.example.com/' }, { p: 'x' }), /host is fixed/);
    assert.throws(() => ws.buildRequest({ ...s, headers: { Authorization: 'Bearer x' } }, { p: 'x' }), /not allowed/);
    assert.ok(invokeProblems({ url: 'https://&P1_HOST./x' }).length);
    assert.ok(invokeProblems({ url: 'https://api.example.com&P1_X./x' }).length);
    assert.ok(invokeProblems({ url: 'https://api.example.com/x', source: 'Y' }).length);
    assert.deepEqual(invokeProblems({ url: 'https://api.example.com/x/&P1_X.' }), []);
    // response values are data: one escaped literal, checked column names
    const { json } = await ws.fetchSource({ ...s, url: `${mockBase}/rows`, params: [] }, {});
    const { columns, rows } = ws.toRows(json, { row_selector: 'items', columns: [{ name: 'v', type: 'text' }], max_rows: 10 });
    const sql = ws.withRest(ws.rowsSql(columns, rows), null);
    assert.deepEqual((await runtime.query(sql)).rows, [{ v: "it's $$ \"x\" ); drop table hr.emp; --" }]);
    assert.throws(() => ws.rowsSql([{ name: 'v" text); drop table hr.emp; --' }], []), /not a valid SQL name/);
    // no calls to hosts outside the allow-list, metadata services or other loopback names
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:169.254.169.254]/', 'http://10.0.0.1/', 'https://example.com/', 'gopher://127.0.0.1/'])
      await assert.rejects(ws.call({ url: u }), /allow-list|private|Only http/, u);
  });

  test('invoke_api only sets items of its page (or application items), and shows no details of a failure', async () => {
    const { Browser: B, formFields } = await import('./helpers.ts');
    const page = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 23`, [appId])).id;
    const p = await owner.one(`insert into meta.process (page_id, seq, name, type, point, when_button, config)
      values ($1, 5, 'sec invoke', 'invoke_api', 'submit', 'LOOKUP', $2) returning id`,
      [page, JSON.stringify({ url: `${mockBase}/inv/&P23_DEPTNO.`, items: { P1_SECRET_FLAG: 'path' } })]);
    cleanup.push(`delete from meta.process where id = ${Number(p.id)}`);
    const b = new B(app);
    await b.login('allen');
    const form = formFields((await b.get('/a/hr/23')).body);
    const n = hits.length;
    await b.submit('/a/hr/23', { ...form, P23_DEPTNO: '../x?a=1', __request: 'LOOKUP' });
    assert.deepEqual(hits.slice(n).map((h) => h.url), ['/inv/..%2Fx%3Fa%3D1'], 'the value is encoded into the path');
    const after = (await b.get('/a/hr/23')).body;
    assert.doesNotMatch(after, /P1_SECRET_FLAG is not an item/, 'the details go to the activity log');
    assert.ok(await owner.one(`select 1 from meta.activity_log where event = 'error' and detail like '%P1_SECRET_FLAG is not an item%' and at > now() - interval '1 minute'`));
  });
});

describe('sprint 26 items: rich text, Markdown, rating, combobox, date range, password reveal, QR code', () => {
  const page20 = (user: string, id: string) => `/a/hr/20?${new URLSearchParams({ P20_ID: id, cs: urlChecksum(appId, 20, user, { P20_ID: id }) })}`;
  const base = { __request: 'SAVE', P20_EMPNO: '7698', P20_PERIOD: ['2026-01-01', '2026-06-30'], P20_RATING: '3', P20_SKILLS: 'Sales', P20_NOTES: '' };
  const XSS = [
    '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<a href="javascript:alert(1)">a</a>', '<a href="java&#x09;script:alert(1)">b</a>',
    '<svg onload=alert(1)>', '<p style="background:url(javascript:alert(1))" onmouseover="alert(1)">p</p>', '<iframe src="https://evil.example"></iframe>',
    '<math><mi xlink:href="javascript:alert(1)">m</mi></math>', '<a href="data:text/html,<script>alert(1)</script>">d</a>', '"><script>alert(1)</script>',
    '<<script>script>alert(1)<</script>/script>', '<!--><script>alert(1)</script>-->', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ].join('');
  // unsafe = any real tag outside the allow-list, or any attribute but a safe link's href and rel
  const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'sub', 'sup', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'a', 'hr', 'div']);
  const unsafe = (html: string) =>
    [...html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)].some(([, tag, attrs]) => {
      if (!ALLOWED.has(tag.toLowerCase())) return true;
      const rest = attrs.replace(/\s(href)="(https?:|mailto:|tel:|\/|#)[^"]*"/, '').replace(' rel="noopener noreferrer nofollow"', '');
      return rest.trim() !== '';
    }) || /<!--/.test(html);
  let id: string;

  before(async () => {
    id = String((await owner.one(`insert into hr.review (empno, period, rating, created_by) values (7698, '2026-01-01:2026-06-30', 3, 'sec-test') returning id`)).id);
  });
  after(async () => {
    await owner.query(`delete from hr.review where created_by = 'sec-test'`);
    await owner.query(`update meta.item i set readonly_condition = null from meta.page p join meta.app a on a.id = p.app_id
                        where i.page_id = p.id and a.alias = 'hr' and p.page_no = 20 and i.name like 'P20_%'`);
  });

  test('posted rich text is rebuilt from the allow-list before it is stored', async () => {
    const b = await as('king');
    await b.get(page20('king', id));
    const res = await b.post('/a/hr/20', { __csrf: b.lastCsrf, ...base, P20_SUMMARY: XSS });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const { summary } = await owner.one('select summary from hr.review where id = $1', [id]);
    assert.ok(!unsafe(summary), summary);
    const body = (await b.get(page20('king', id))).body;
    const area = /<textarea id="P20_SUMMARY"[^>]*>([\s\S]*?)<\/textarea>/.exec(body)![1];
    assert.ok(!/</.test(area), 'textarea content is escaped');
  });

  test('stored hostile HTML and Markdown are made safe when shown read-only', async () => {
    await owner.query('update hr.review set summary = $2, notes = $3 where id = $1', [id, XSS, `[x](javascript:alert(1)) <img src=x onerror=alert(1)> ${XSS}`]);
    await owner.query(`update meta.item i set readonly_condition = 'true' from meta.page p join meta.app a on a.id = p.app_id
                        where i.page_id = p.id and a.alias = 'hr' and p.page_no = 20 and i.name in ('P20_SUMMARY', 'P20_NOTES')`);
    const b = await as('king');
    const body = (await b.get(page20('king', id))).body;
    for (const name of ['P20_SUMMARY', 'P20_NOTES']) {
      const shown = new RegExp(`<div class="display-value rich-text" id="${name}">([\\s\\S]*?)</div>\\s*(?:<small|</div>|</fieldset>)`).exec(body)?.[1];
      assert.ok(shown !== undefined, name);
      assert.ok(!unsafe(shown!), `${name}: ${shown}`);
    }
    // editable again: the textarea gets the sanitised HTML, never the raw value
    await owner.query(`update meta.item i set readonly_condition = null from meta.page p join meta.app a on a.id = p.app_id
                        where i.page_id = p.id and a.alias = 'hr' and p.page_no = 20 and i.name like 'P20_%'`);
    const edit = (await b.get(page20('king', id))).body;
    const area = /<textarea id="P20_SUMMARY"[^>]*>([\s\S]*?)<\/textarea>/.exec(edit)![1];
    assert.ok(!unsafe(area.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')), area);
  });

  test('combobox, date range and QR code values are escaped', async () => {
    const evil = '"><script>alert(1)</script>';
    await owner.query('update hr.review set skills = $2 where id = $1', [id, `${evil}:x`]);
    const b = await as('king');
    const body = (await b.get(page20('king', id))).body;
    assert.ok(!body.includes('<script>alert(1)'), 'combobox value');
    assert.match(body, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;:x"/);
    // a QR code's text comes from session state: a load process here; check the label escaping directly
    const res = await b.post('/a/hr/20', { __csrf: b.lastCsrf, ...base, P20_PERIOD: [`2026-01-01${evil}`, '2026-06-30'] });
    assert.equal(res.statusCode, 422);
    assert.ok(!res.body.includes('<script>alert(1)'), 'date range value');
  });

  test('a QR code item is display only: a posted value is ignored', async () => {
    const b = await as('king');
    await b.get(page20('king', id));
    const res = await b.post('/a/hr/20', { __csrf: b.lastCsrf, ...base, P20_RATING: '99', P20_SHARE: 'INJECTED' });
    assert.equal(res.statusCode, 422);
    assert.doesNotMatch(res.body, /QR code: INJECTED/);
  });

  test('malformed rating and date range values are refused and not stored', async () => {
    for (const change of [{ P20_RATING: '0' }, { P20_RATING: '1e1' }, { P20_RATING: '-1' }, { P20_PERIOD: ['x', 'y'] },
      { P20_PERIOD: ["2026-01-01'; drop table hr.review; --", '2026-06-30'] }, { P20_PERIOD: ['2026-01-01', '2026-06-30', '2026-07-01'] }, { P20_PERIOD: '2026-01-01:2026-06-30:x' }]) {
      const b = await as('king');
      await b.get(page20('king', id));
      const res = await b.post('/a/hr/20', { __csrf: b.lastCsrf, ...base, ...change });
      assert.equal(res.statusCode, 422, JSON.stringify(change));
    }
    const row = await owner.one('select period, rating from hr.review where id = $1', [id]);
    assert.equal(row.period, '2026-01-01:2026-06-30');
  });

  test('the password item never echoes its value, reveal button or not', async () => {
    const b = await as('king');
    await b.get(page20('king', id));
    const res = await b.post('/a/hr/20', { __csrf: b.lastCsrf, ...base, P20_RATING: '99', P20_PIN: 'topsecret' });
    assert.equal(res.statusCode, 422);
    assert.doesNotMatch(res.body, /topsecret/);
    assert.match(res.body, /<input type="password" id="P20_PIN" name="P20_PIN" value="" autocomplete="new-password"/);
  });

  test('the new item types need the app\'s session like any item (no page for anonymous users)', async () => {
    const res = await new Browser().get(page20('king', id));
    assert.equal(res.statusCode, 302);
  });

  test('rich text and Markdown take linear time on hostile input (no regular-expression backtracking)', () => {
    const hostile = [
      '# ' + ' #'.repeat(100_000) + 'x', '[a]('.repeat(100_000), '['.repeat(400_000), ('[a](' + 'x'.repeat(1990)).repeat(200),
      '**a'.repeat(100_000), '-' + ' -'.repeat(100_000) + 'x', '>'.repeat(200_000), '<a '.repeat(100_000), '<b>'.repeat(100_000),
    ];
    for (const input of hostile) {
      const t = performance.now();
      markdownHtml(input);
      sanitizeHtml(input);
      assert.ok(performance.now() - t < 2000, `${input.slice(0, 20)}… took ${Math.round(performance.now() - t)} ms`);
    }
  });
});

describe('sprint 27 large tables', () => {
  const page25 = async () => (await owner.one(`select id from meta.page where app_id = $1 and page_no = 25`, [appId])).id as number;
  const regionId = async (title: string) => (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 25 and r.title = $2`, [appId, title])).id as number;
  const addRegion = async (pageNo: number, fields: Record<string, unknown>) => {
    const pid = (await owner.one(`select id from meta.page where app_id = $1 and page_no = $2`, [appId, pageNo])).id;
    const f = { seq: 95, title: 'Test region', type: 'dynamic', source: `select '<p>' || clock_timestamp() || '</p>'`, ...fields };
    const cols = Object.keys(f);
    return (await owner.one(`insert into meta.region (page_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
      [pid, ...cols.map((c) => (c === 'config' ? JSON.stringify((f as any)[c]) : (f as any)[c]))])).id as number;
  };
  const section = (body: string, id: number) => {
    const at = body.indexOf(`id="R${id}"`);
    return at < 0 ? '' : body.slice(at, body.indexOf('</section>', at));
  };

  test('page numbers, page sizes and row limits are clamped on the server', async () => {
    const king = await as('king');
    const all = await regionId('All readings');
    for (const p of ['99999999999999999999', '1e30', '-7', 'x', '1000001']) {
      const res = await king.get(`/a/hr/25?r${all}_p=${p}`);
      assert.equal(res.statusCode, 200, p);
      assert.match(section(res.body, all), /Rows 1–25/, `page ${p} falls back to the first page`);
    }
    assert.match(section((await king.get(`/a/hr/25?r${all}_n=1000000`)).body, all), /Rows 1–500/, 'at most 500 rows per page');
    assert.equal(maxRows({ config: { max_rows: 1e12 } }, null), 1_000_000);
    assert.equal(maxRows({ config: { max_rows: '5; drop table hr.emp' } }, 7), 7);
    assert.equal(maxRows({ config: { max_rows: -3 } }, null), null);
    assert.equal(lovMax({ config: { max_rows: 1e9 } } as any), 50_000);
    assert.equal(lovMax({ config: { max_rows: 'all' } } as any), 5000);
    const r = { id: 1, type: 'report', config: {} } as any;
    assert.deepEqual(cacheOf({ ...r, config: { cache: { scope: 'all', seconds: 1e9 } } }), { scope: 'all', seconds: 86_400 });
    assert.equal(cacheOf({ ...r, config: { cache: { scope: 'everyone', seconds: 60 } } }), null);
    assert.equal(cacheOf({ ...r, type: 'form', config: { cache: { scope: 'user', seconds: 60 } } }), null, 'forms are never cached');
  });

  test('the lazy region endpoint checks the session, page access, the region and its condition and authorization', async () => {
    const king = await as('king');
    const allen = await as('allen');
    const lazy = await regionId('Readings of sensor A');
    assert.equal((await king.get(`/a/hr/25/region/${lazy}`)).statusCode, 200);
    assert.equal((await new Browser().get(`/a/hr/25/region/${lazy}`)).statusCode, 401, 'no session');
    assert.equal((await king.get(`/a/hr/2/region/${lazy}`)).statusCode, 403, 'a region of another page');
    assert.equal((await king.get(`/a/hr/25/region/${await regionId('All readings')}`)).statusCode, 403, 'not a lazy region');
    assert.equal((await king.get(`/a/hr/25/region/abc`)).statusCode, 403);
    const hidden = await addRegion(25, { condition: 'false', config: { lazy: true } });
    const admin = await addRegion(25, { seq: 96, authz: 'ADMIN', config: { lazy: true } });
    const onAdminPage = await addRegion(5, { config: { lazy: true } });
    const form = await addRegion(25, { seq: 97, type: 'form', source: null, config: { lazy: true } });
    try {
      assert.equal((await king.get(`/a/hr/25/region/${hidden}`)).statusCode, 403, 'condition false');
      assert.equal((await allen.get(`/a/hr/25/region/${admin}`)).statusCode, 403, 'region authorization');
      assert.equal((await king.get(`/a/hr/25/region/${admin}`)).statusCode, 200);
      assert.equal((await allen.get(`/a/hr/5/region/${onAdminPage}`)).statusCode, 403, 'page authorization');
      assert.equal((await king.get(`/a/hr/25/region/${form}`)).statusCode, 403, 'forms are never lazy');
      assert.doesNotMatch(section((await allen.get('/a/hr/25')).body, admin), /./, 'no placeholder for a region the user may not see');
    } finally {
      await owner.query('delete from meta.region where id = any($1)', [[hidden, admin, onAdminPage, form]]);
    }
  });

  test('cached regions never cross sessions or users where their scope says so', async () => {
    clearRegionCache();
    const perSession = await addRegion(25, { config: { cache: { scope: 'session', seconds: 300 } } });
    const perUser = await addRegion(25, { seq: 96, type: 'report', source: 'select empno, ename from hr.emp', config: { cache: { scope: 'user', seconds: 300 } } });
    const forAll = await addRegion(25, { seq: 97, type: 'report', source: 'select empno, ename from hr.emp',
      config: { cache: { scope: 'all', seconds: 300 }, link: { column: 'ename', page: 3, items: { P3_EMPNO: '#empno#' } } } });
    try {
      const a = await as('king');
      const b = await as('king');
      const ts = (body: string) => /<p>([^<]+)<\/p>/.exec(section(body, perSession))![1];
      const first = (await a.get('/a/hr/25')).body;
      assert.equal(ts((await a.get('/a/hr/25')).body), ts(first), 'the same session hits the cache');
      const other = (await b.get('/a/hr/25')).body;
      assert.notEqual(ts(other), ts(first), 'another session of the same user does not');
      // the per-user report holds the session's CSRF token (saved reports): each session gets its own
      assert.ok(a.lastCsrf && b.lastCsrf && a.lastCsrf !== b.lastCsrf);
      assert.doesNotMatch(other, new RegExp(a.lastCsrf), 'no CSRF token of another session');
      assert.match(other, new RegExp(`action="/a/hr/25/report/${perUser}/save"><input type="hidden" name="__csrf" value="${b.lastCsrf}"`));
      // links with per-user checksums are not cached for all users
      const blake = await as('blake');
      const blakes = section((await blake.get('/a/hr/25')).body, forAll);
      const kings = section(first, forAll);
      const cs = (html: string) => [...html.matchAll(/cs=([\w-]+)/g)].map((m) => m[1]);
      assert.ok(cs(kings).length && cs(blakes).length);
      assert.ok(!cs(blakes).some((x) => cs(kings).includes(x)), 'blake never sees links signed for king');
      assert.ok(regionCacheStats().entries > 0);
    } finally {
      await owner.query('delete from meta.region where id = any($1)', [[perSession, perUser, forAll]]);
      clearRegionCache();
    }
  });

  test('a cache key always holds the application, page, region, user and language', () => {
    const ctx = (over: Record<string, any> = {}) => ({
      app: { id: 1, alias: 'x' }, page: { page_no: 1, items: [] }, session: { id: 's1', state: {}, csrf_token: 't' },
      user: 'king', roles: ['admin'], params: new URLSearchParams(), request: '', dialog: false, locale: { lang: 'en' },
      vis: { regions: new Set([1]) }, ...over,
    }) as any;
    const r = { id: 1, type: 'dynamic', source: 'select :P1_X', title: 'T', config: {} } as any;
    const all = { scope: 'all', seconds: 60 } as const;
    const user = { scope: 'user', seconds: 60 } as const;
    const base = cacheKey(ctx(), r, all);
    assert.notEqual(cacheKey(ctx({ app: { id: 2, alias: 'y' } }), r, all), base, 'another application');
    assert.notEqual(cacheKey(ctx({ roles: [] }), r, all), base, 'other roles');
    assert.notEqual(cacheKey(ctx({ locale: { lang: 'nl' } }), r, all), base, 'another language');
    assert.notEqual(cacheKey(ctx({ session: { id: 's1', state: { P1_X: '2' }, csrf_token: 't' } }), r, all), base, 'an item the source uses');
    assert.notEqual(cacheKey(ctx({ params: new URLSearchParams('r1_p=2') }), r, all), base, 'the query string');
    assert.notEqual(cacheKey(ctx({ user: 'blake' }), r, user), cacheKey(ctx(), r, user), 'per user');
    assert.notEqual(cacheKey(ctx(), { ...r, source: 'select 2' }, all), base, 'a changed region');
    assert.ok(base.startsWith('1:1:1:'));
  });

  test('a submit of the page drops its cached regions; downloads keep the access checks', async () => {
    clearRegionCache();
    const cached = await addRegion(25, { config: { cache: { scope: 'all', seconds: 300 } } });
    const hidden = await addRegion(25, { seq: 96, type: 'report', source: 'select 1 as x', condition: 'false' });
    try {
      const king = await as('king');
      const ts = (body: string) => /<p>([^<]+)<\/p>/.exec(section(body, cached))![1];
      const jones = await as('jones');
      const before = ts((await jones.get('/a/hr/25')).body);
      const blake = await as('blake');
      assert.equal(ts((await blake.get('/a/hr/25')).body), before, 'shared by all users with the same roles');
      assert.notEqual(ts((await king.get('/a/hr/25')).body), before, 'not with other roles');
      assert.equal((await blake.post('/a/hr/25', { __csrf: blake.lastCsrf })).statusCode, 303);
      assert.notEqual(ts((await jones.get('/a/hr/25')).body), before);
      for (const f of ['csv', 'xlsx']) assert.equal((await king.get(`/a/hr/25?r${hidden}_${f}=1`)).statusCode, 403, f);
      assert.equal((await new Browser().get(`/a/hr/25?r${await regionId('All readings')}_csv=1`)).statusCode, 302, 'no session, no download');
    } finally {
      await owner.query('delete from meta.region where id = any($1)', [[cached, hidden]]);
      clearRegionCache();
    }
  });
});

describe('sprint 28 popup LOV', () => {
  const search = (b: Browser, form: Record<string, string>, item = 'P26_EMPNO', path = '/a/hr/26') =>
    b.post(`${path}/lov/${item}/search`, { __csrf: b.lastCsrf, ...form });
  const setItem = (name: string, set: string, values: unknown[] = []) =>
    owner.query(`update meta.item i set ${set} from meta.page p where p.id = i.page_id and p.app_id = $1 and i.name = '${name}'`, [appId, ...values]);
  const outcome = async (b: Browser, res: { statusCode: number; body: string; headers: Record<string, unknown> }) =>
    res.statusCode === 303 ? (await b.get(String(res.headers.location))).body : res.body;

  test('the search term is a parameter: quotes, wildcards and SQL text match nothing', async () => {
    const king = await as('king');
    await king.get('/a/hr/26');
    const hit = await search(king, { q: 'KIN' });
    assert.equal(hit.statusCode, 200);
    const json = hit.json();
    assert.deepEqual(json.rows.map((r: any) => r.value), ['7839']);
    assert.equal(json.headings.length, 3, 'display column plus job and department, not the return value');
    assert.deepEqual(json.rows[0].columns, ['King', 'President', 'ACCOUNTING']);
    assert.ok((await search(king, { q: 'research' })).json().rows.length >= 3, 'extra columns are searched');
    for (const q of [`' or 1=1 --`, '%', '_', `x'); drop table hr.emp; --`, '\\'])
      assert.deepEqual((await search(king, { q })).json().rows, [], q);
    assert.ok((await owner.one('select count(*)::int as n from hr.emp')).n > 0);
  });

  test("only the item's own LOV, on its own page and application", async () => {
    const king = await as('king');
    await king.get('/a/hr/26');
    assert.equal((await search(king, { q: '' }, 'P3_MGR')).statusCode, 403, 'an item of another page');
    assert.equal((await search(king, { q: '' }, 'P26_NOPE')).statusCode, 403);
    assert.equal((await search(king, { q: '' }, 'P3_EMPNO', '/a/hr/3')).statusCode, 403, 'not a popup LOV');
    assert.equal((await search(king, { q: '' }, 'P26_EMPNO', '/a/nope/26')).statusCode, 404);
    assert.equal((await king.post('/a/hr/26/lov/P26_EMPNO/search', { q: '' })).statusCode, 403, 'no CSRF token');
    assert.equal((await new Browser().post('/a/hr/26/lov/P26_EMPNO/search', { q: '' })).statusCode, 401, 'not signed in');
  });

  test('a hidden, read-only or unauthorized item is not searchable', async () => {
    try {
      await setItem('P26_EMPNO', `authz = 'ADMIN'`);
      const blake = await as('blake');
      await blake.get('/a/hr/26');
      assert.equal((await search(blake, { q: '' })).statusCode, 403);
      const king = await as('king');
      await king.get('/a/hr/26');
      assert.equal((await search(king, { q: '' })).statusCode, 200);
      await setItem('P26_EMPNO', `authz = null, readonly_condition = 'true'`);
      assert.equal((await search(king, { q: '' })).statusCode, 403);
    } finally {
      await setItem('P26_EMPNO', 'authz = null, readonly_condition = null');
    }
  });

  test('the page size is clamped to 100 rows', async () => {
    try {
      await setItem('P26_EMPNO', `lov = 'select sensor || '' #'' || id, id from hr.reading order by id', config = '{"page_size": 100000}'`);
      const king = await as('king');
      await king.get('/a/hr/26');
      const big = (await search(king, { q: '', n: '100000' })).json();
      assert.equal(big.rows.length, 100);
      assert.equal(big.more, true);
      assert.equal((await search(king, { q: '', n: '3', p: '2' })).json().rows[0].value, '7');
      assert.equal((await search(king, { q: '', n: '-5' })).json().rows.length, 25);
    } finally {
      await setItem('P26_EMPNO', `lov = $2, config = '{"page_size": 5}'`, [
        `select initcap(e.ename) as name, e.empno, initcap(e.job) as job, d.dname as department
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 order by e.ename`,
      ]);
    }
  });

  test('a forged posted value is rejected; a value from the LOV is kept', async () => {
    const king = await as('king');
    await king.get('/a/hr/26');
    const bad = await outcome(king, await king.post('/a/hr/26', { __csrf: king.lastCsrf, P26_EMPNO: '99999', P26_DEPTNO: '10', __request: 'SHOW' }));
    assert.match(bad, /Employee: choose a value from the list\./);
    const bad2 = await outcome(king, await king.post('/a/hr/26', { __csrf: king.lastCsrf, P26_EMPNO: '', P26_DEPTNO: `10' or '1'='1`, __request: 'SHOW' }));
    assert.match(bad2, /Department: choose a value from the list\./);
    const good = await outcome(king, await king.post('/a/hr/26', { __csrf: king.lastCsrf, P26_EMPNO: '7788', P26_DEPTNO: '20', __request: 'SHOW' }));
    assert.doesNotMatch(good, /choose a value from the list/);
    assert.match(good, /<option value="7788" selected>Scott<\/option>/);
  });
});

describe('sprint 29 header authentication', () => {
  const alias = `hdr${Date.now()}`;
  let hdrApp: number;
  const users = ['hdr_alice', 'hdr_bob', 'hdr_off', 'hdr_noaccess'];
  const envBefore = process.env.PGAPEX_AUTH_HEADER_PROXIES;
  const PROXY = '10.1.2.3';

  /** a cookie-keeping client that talks to pgapex from a given socket address */
  class Client {
    cookies = new Map<string, string>();
    constructor(public remoteAddress = PROXY) {}
    async request(method: 'GET' | 'POST', url: string, headers: Record<string, string | string[]> = {}, form?: Record<string, string>) {
      const res = await app.inject({
        method, url, remoteAddress: this.remoteAddress,
        payload: form ? new URLSearchParams(form).toString() : undefined,
        headers: {
          cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...headers,
        },
      });
      for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
        if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
        else this.cookies.set(c.name, c.value);
      }
      return res;
    }
    get(user?: string | string[], url = `/a/${alias}/1`, extra: Record<string, string> = {}) {
      return this.request('GET', url, { ...(user === undefined ? {} : { 'x-remote-user': user }), ...extra });
    }
  }
  const sessions = async (user: string) =>
    (await owner.one<{ n: number }>(`select count(*)::int as n from meta.session where app_id = $1 and lower(username) = lower($2)`, [hdrApp, user]))!.n;
  const lastLog = async () =>
    owner.one<{ event: string; detail: string; username: string | null }>(
      `select event, detail, username from meta.activity_log where app_id = $1 and event <> 'page_view' order by id desc limit 1`, [hdrApp]);

  before(async () => {
    process.env.PGAPEX_AUTH_HEADER_PROXIES = `${PROXY}, 192.168.50.0/24, not-an-ip`;
    hdrApp = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Header test', 'header') returning id`, [alias])).id;
    await owner.query(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home')`, [hdrApp]);
    for (const u of users) await owner.query(`insert into meta.account (username, active) values ($1, $2) on conflict do nothing`, [u, u !== 'hdr_off']);
    await owner.query(
      `insert into meta.app_access (app_id, account_id) select $1, id from meta.account where username = any($2) on conflict do nothing`,
      [hdrApp, ['hdr_alice', 'hdr_bob', 'hdr_off']]);
  });

  after(async () => {
    if (envBefore === undefined) delete process.env.PGAPEX_AUTH_HEADER_PROXIES;
    else process.env.PGAPEX_AUTH_HEADER_PROXIES = envBefore;
    await owner.query('delete from meta.app where id = $1', [hdrApp]);
    await owner.query(`delete from meta.account where username like 'hdr\\_%'`);
  });

  test('a trusted proxy signs the user in; the session is reused while the header stays the same', async () => {
    const c = new Client();
    const res = await c.get('hdr_alice');
    assert.equal(res.statusCode, 200);
    assert.equal(await sessions('hdr_alice'), 1);
    assert.match((await lastLog())!.detail ?? '', /header/);
    assert.equal((await c.get('hdr_alice')).statusCode, 200);
    assert.equal(await sessions('hdr_alice'), 1, 'no second session');
    // a proxy inside the configured CIDR, also as an IPv4-mapped IPv6 address
    assert.equal((await new Client('192.168.50.77').get('hdr_bob')).statusCode, 200);
    assert.equal((await new Client('::ffff:192.168.50.78').get('hdr_bob')).statusCode, 200);
  });

  test('the header from an untrusted peer is refused, and a spoofed X-Forwarded-For does not help', async () => {
    const before = await sessions('hdr_alice');
    const res = await new Client('203.0.113.9').get('hdr_alice');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /did not come through it/);
    const log = (await lastLog())!;
    assert.equal(log.event, 'login_failed');
    assert.match(log.detail, /untrusted peer 203\.0\.113\.9/);
    const spoof = await new Client('203.0.113.9').get('hdr_alice', undefined, { 'x-forwarded-for': PROXY, 'x-real-ip': PROXY });
    assert.equal(spoof.statusCode, 403);
    assert.equal((await new Client('192.168.51.1').get('hdr_alice')).statusCode, 403, 'outside the CIDR');
    assert.equal(await sessions('hdr_alice'), before);
    // a session cookie taken elsewhere does not work without the proxy either
    const c = new Client();
    await c.get('hdr_alice');
    c.remoteAddress = '203.0.113.9';
    assert.equal((await c.get('hdr_alice')).statusCode, 403);
    assert.equal((await c.get()).statusCode, 403);
  });

  test('without PGAPEX_AUTH_HEADER_PROXIES header authentication is refused', async () => {
    const saved = process.env.PGAPEX_AUTH_HEADER_PROXIES;
    try {
      delete process.env.PGAPEX_AUTH_HEADER_PROXIES;
      for (const addr of ['127.0.0.1', PROXY]) {
        const res = await new Client(addr).get('hdr_alice');
        assert.equal(res.statusCode, 403);
        assert.match(res.body, /did not come through it/);
      }
      assert.match((await lastLog())!.detail, /untrusted peer/);
    } finally {
      process.env.PGAPEX_AUTH_HEADER_PROXIES = saved;
    }
  });

  test('a changed or missing header ends the session', async () => {
    const c = new Client();
    await c.get('hdr_alice');
    const first = c.cookies.get(`pgapex_app_${hdrApp}`);
    const aliceBefore = await sessions('hdr_alice');
    // another user through the same browser: the old session ends, a new one for bob
    assert.equal((await c.get('hdr_bob')).statusCode, 200);
    assert.notEqual(c.cookies.get(`pgapex_app_${hdrApp}`), first);
    assert.equal(await sessions('hdr_alice'), aliceBefore - 1);
    // header gone: the session ends
    const bobBefore = await sessions('hdr_bob');
    const gone = await c.get();
    assert.equal(gone.statusCode, 401);
    assert.match(gone.body, /did not send a user name/);
    assert.equal(await sessions('hdr_bob'), bobBefore - 1);
  });

  test('unknown user without automatic accounts, deactivated accounts and apps without access are refused', async () => {
    const unknown = await new Client().get('hdr_nobody');
    assert.equal(unknown.statusCode, 403);
    assert.match(unknown.body, /There is no account for &quot;hdr_nobody&quot;|There is no account for "hdr_nobody"/);
    assert.equal((await owner.one(`select count(*)::int as n from meta.account where username = 'hdr_nobody'`)).n, 0);
    const off = await new Client().get('hdr_off');
    assert.equal(off.statusCode, 403);
    assert.match(off.body, /disabled/);
    assert.equal(await sessions('hdr_off'), 0);
    const noAccess = await new Client().get('hdr_noaccess');
    assert.equal(noAccess.statusCode, 403);
    assert.match(noAccess.body, /has no access/);
    assert.equal(await sessions('hdr_noaccess'), 0);
    // case differences map to the same account
    assert.equal((await new Client().get('HDR_ALICE')).statusCode, 200);
  });

  test('automatic accounts are created with access to the app, never active again once deactivated', async () => {
    try {
      await owner.query('update meta.app set header_auto_create = true where id = $1', [hdrApp]);
      assert.equal((await new Client().get('hdr_new')).statusCode, 200);
      const acc = await owner.one(`select a.active, exists (select 1 from meta.app_access x where x.account_id = a.id and x.app_id = $1) as access
                                     from meta.account a where username = 'hdr_new'`, [hdrApp]);
      assert.deepEqual(acc, { active: true, access: true });
      assert.equal((await new Client().get('hdr_off')).statusCode, 403, 'auto-create does not revive a deactivated account');
      assert.equal((await new Client().get('hdr_noaccess')).statusCode, 403, 'existing accounts still need access');
    } finally {
      await owner.query('update meta.app set header_auto_create = false where id = $1', [hdrApp]);
    }
  });

  test('the header value is checked: length, characters, repeated headers', async () => {
    for (const bad of ['x'.repeat(101), 'hdr alice', 'hdr:alice', 'hdr,alice', 'hdré', ['hdr_alice', 'hdr_bob']]) {
      const res = await new Client().get(bad as string);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
      assert.match(res.body, /invalid user name/);
    }
    assert.equal((await lastLog())!.detail, 'header: invalid user header');
    // a custom header name: X-Remote-User is ignored then
    try {
      await owner.query(`update meta.app set header_name = 'X-Auth-User' where id = $1`, [hdrApp]);
      assert.equal((await new Client().get('hdr_alice')).statusCode, 401);
      assert.equal((await new Client().get(undefined, undefined, { 'x-auth-user': 'hdr_alice' })).statusCode, 200);
      await assert.rejects(owner.query(`update meta.app set header_name = 'X-Bad Header' where id = $1`, [hdrApp]));
      await assert.rejects(owner.query(`update meta.app set logout_url = 'javascript:alert(1)' where id = $1`, [hdrApp]));
      await assert.rejects(owner.query(`update meta.app set logout_url = '//evil.example' where id = $1`, [hdrApp]));
    } finally {
      await owner.query(`update meta.app set header_name = null where id = $1`, [hdrApp]);
    }
  });

  test('POSTs still need the CSRF token; password and SSO sign-in are not available; sign-out', async () => {
    const c = new Client();
    const page = await c.get('hdr_alice');
    const csrf = /name="__csrf" value="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(csrf);
    const h = { 'x-remote-user': 'hdr_alice' };
    assert.equal((await c.request('POST', `/a/${alias}/1`, h, { __request: 'SAVE' })).statusCode, 403, 'no CSRF token');
    assert.equal((await c.request('POST', `/a/${alias}/1`, h, { __csrf: 'forged', __request: 'SAVE' })).statusCode, 403);
    // a POST with the header but no session cookie: a fresh session, so the token cannot match
    assert.equal((await new Client().request('POST', `/a/${alias}/1`, h, { __csrf: csrf!, __request: 'SAVE' })).statusCode, 403);
    // the login page redirects; the password form is refused
    assert.equal((await c.request('GET', `/a/${alias}/login`, h)).statusCode, 302);
    const pw = await c.request('POST', `/a/${alias}/login`, h, { __csrf: csrf!, username: 'hdr_alice', password: 'x' });
    assert.equal(pw.statusCode, 403);
    // sign-out ends the session and goes to the logout URL
    await owner.query(`update meta.app set logout_url = 'https://sso.example.com/logout' where id = $1`, [hdrApp]);
    const n = await sessions('hdr_alice');
    const out = await c.request('POST', `/a/${alias}/logout`, h, { __csrf: csrf! });
    assert.equal(out.statusCode, 303);
    assert.equal(out.headers.location, 'https://sso.example.com/logout');
    assert.equal(await sessions('hdr_alice'), n - 1);
  });

  test('the builder settings offer the header type and save its fields', async () => {
    const b = new Browser();
    await b.get('/builder/login');
    assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' })).statusCode, 303);
    const form = await b.get(`/builder/apps/${hdrApp}/settings`);
    assert.match(form.body, /<option value="header" selected>HTTP header/);
    assert.match(form.body, /name="header_name"/);
    const saved = await b.post(`/builder/apps/${hdrApp}/settings`, {
      __csrf: b.lastCsrf, name: 'Header test', alias, home_page: '1', authentication: 'header',
      header_name: 'X-Forwarded-User', header_auto_create: 'true', logout_url: '/a/other',
    });
    assert.equal(saved.statusCode, 303);
    assert.deepEqual(
      await owner.one('select authentication, header_name, header_auto_create, logout_url from meta.app where id = $1', [hdrApp]),
      { authentication: 'header', header_name: 'X-Forwarded-User', header_auto_create: true, logout_url: '/a/other' });
  });
});

describe('sprint 30', () => {
  // keyset paging: the r<id>_k position is signed; whatever it holds only becomes query parameters
  let region: number;
  const firstId = (body: string) => Number(/<tr[^>]*>\s*<td[^>]*>(\d+)<\/td>/.exec(body.slice(body.indexOf(`id="R${region}"`)))?.[1]);
  const token = (v: unknown, extra: Record<string, unknown> = {}, scope = `keyset:${appId}:25:${region}`) => {
    const payload = Buffer.from(JSON.stringify({ d: 'n', s: 0, o: 0, p: 2, v, ...extra })).toString('base64url');
    return `${payload}.${signText(scope, payload)}`;
  };
  before(async () => {
    region = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 25 and r.title = 'All readings'`, [appId])).id;
    await owner.query(`update meta.region set config = config || '{"keyset": ["id"]}' where id = $1`, [region]);
  });
  after(async () => {
    await owner.query(`update meta.region set config = config - 'keyset' where id = $1`, [region]);
  });

  test('keyset paging: a signed position seeks; a tampered, foreign or oversized one is ignored (offset paging)', async () => {
    const king = await as('king');
    const page = (k: string, extra = '') => king.get(`/a/hr/25?r${region}_p=2&r${region}_k=${encodeURIComponent(k)}${extra}`);
    assert.equal(firstId((await page(token(['1000']))).body), 1001, 'a valid position');
    // the payload changed, the signature kept
    const good = token(['1000']);
    const forged = `${Buffer.from(JSON.stringify({ d: 'n', s: 0, o: 0, p: 2, v: ['5000'] })).toString('base64url')}.${good.split('.')[1]}`;
    assert.equal(firstId((await page(forged)).body), 26);
    assert.equal(firstId((await page(`${good.split('.')[0]}.`)).body), 26, 'no signature');
    assert.equal(firstId((await page(token(['1000'], {}, `keyset:${appId}:25:${region + 1}`))).body), 26, 'signed for another region');
    assert.equal(firstId((await page(token(['1000'], { p: 3 }))).body), 26, 'for another page');
    assert.equal(firstId((await page(token(['1000'], { s: 2 }))).body), 26, 'for another sort');
    assert.equal(firstId((await page(token(Array(6).fill('1')))).body), 26, 'too many values');
    assert.equal(firstId((await page(token(['x'.repeat(1001)]))).body), 26, 'a value too long');
    assert.equal(firstId((await page(token([{ a: 1 }]))).body), 26, 'not a string');
    assert.equal(firstId((await page('a'.repeat(9000))).body), 26, 'oversized');
  });

  test('keyset paging: values are query parameters, never SQL; a value of the wrong type falls back', async () => {
    const king = await as('king');
    for (const v of ["1) or true --", "1'; drop table hr.reading; --", 'abc', '']) {
      const res = await king.get(`/a/hr/25?r${region}_p=2&r${region}_k=${encodeURIComponent(token([v]))}`);
      assert.equal(res.statusCode, 200);
      assert.equal(firstId(res.body), 26, v);
      assert.doesNotMatch(res.body.slice(res.body.indexOf(`id="R${region}"`)), /class="alert[^"]*error|syntax error|invalid input/);
    }
    assert.equal((await owner.one('select count(*)::int as n from hr.reading')).n, 200000);
    // a null key value is refused (keys are not null)
    assert.equal(firstId((await king.get(`/a/hr/25?r${region}_p=2&r${region}_k=${encodeURIComponent(token([null]))}`)).body), 26);
    // a sort column number past the columns: offset paging, no error
    const res = await king.get(`/a/hr/25?r${region}_s=99&r${region}_p=2`);
    assert.equal(res.statusCode, 200);
  });

  test('streamed REST collections: authentication, roles and limits as before; a failure mid-stream cuts the response', async () => {
    const handlers = [
      { method: 'GET', path: 'open', type: 'collection', auth: 'public', source: 'select g as n from generate_series(1, 2000) g order by g' },
      { method: 'GET', path: 'closed', type: 'collection', source: 'select g as n from generate_series(1, 10) g' },
      { method: 'GET', path: 'admins', type: 'collection', roles: ['nobody_has_this_role_30'], source: 'select g as n from generate_series(1, 10) g' },
      { method: 'GET', path: 'fails', type: 'collection', auth: 'public', source: 'select 1 / (150 - g) as x from generate_series(1, 300) g' },
      { method: 'GET', path: 'broken', type: 'collection', auth: 'public', source: 'select * from no_such_table_30' },
    ];
    await owner.query(`insert into meta.rest_module (app_id, name, title, handlers) values ($1, 'sec30', 'Sprint 30', $2)
      on conflict (app_id, name) do update set handlers = excluded.handlers`, [appId, JSON.stringify(handlers)]);
    try {
      const get = (path: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/a/hr/rest/sec30/${path}`, headers });
      assert.equal((await get('closed')).statusCode, 401);
      assert.equal((await get('closed', { authorization: 'Bearer forged' })).statusCode, 401);
      const { issueApiToken } = await import('../src/api.ts');
      const tok = (await issueApiToken(appId, 'king', 1)).token;
      assert.equal((await get('closed', { authorization: `Bearer ${tok}` })).statusCode, 200);
      assert.equal((await get('admins', { authorization: `Bearer ${tok}` })).statusCode, 403);
      const big = (await get('open?limit=100000&offset=-5')).json();
      assert.deepEqual([big.items.length, big.limit, big.offset, big.has_more], [500, 500, 0, true]);
      const inj = await get(`open?limit=${encodeURIComponent('1; drop table meta.app')}&offset=${encodeURIComponent('0) x; --')}`);
      assert.equal(inj.statusCode, 200);
      assert.equal(inj.json().items.length, 25);
      // an error before the first rows is still a status
      const broken = await get('broken');
      assert.equal(broken.statusCode, 500);
      assert.doesNotMatch(broken.body, /no_such_table_30/);
      // past the first batch the response has started: it ends short, never as complete JSON
      const fails = await get('fails?limit=300').then((r) => r.body, () => null);
      if (fails !== null) {
        assert.throws(() => JSON.parse(fails));
        assert.doesNotMatch(fails, /has_more/);
      }
    } finally {
      await owner.query(`delete from meta.rest_module where app_id = $1 and name = 'sec30'`, [appId]);
    }
  });

  describe('database accounts', () => {
    const dbAlias = 'dbauth-sec30';
    let dbApp: number;
    const R = { ann: 'pgapex_s30_ann', eve: 'pgapex_s30_eve', off: 'pgapex_s30_off', boss: 'pgapex_s30_boss' };
    before(async () => {
      for (const r of Object.values(R)) await owner.query(`drop role if exists ${r}`);
      await owner.query(`create role ${R.ann} login password 'Ann-pw-30!'`);
      await owner.query(`create role ${R.eve} login password 'Eve-pw-30!'`);
      await owner.query(`create role ${R.off} nologin password 'Off-pw-30!'`);
      await owner.query(`create role ${R.boss} superuser login password 'Boss-pw-30!'`);
      dbApp = (await owner.one(`insert into meta.app (alias, name, authentication, db_auth_roles) values ($1, 'DB sec', 'database', $2) returning id`,
        [dbAlias, [R.ann, R.off, R.boss, 'pgapex', 'pgapex_runtime']])).id;
      await owner.query(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home')`, [dbApp]);
    });
    after(async () => {
      await owner.query('delete from meta.app where id = $1', [dbApp]);
      for (const r of Object.values(R)) await owner.query(`drop role if exists ${r}`);
    });
    const attempt = async (user: string, password: string) => {
      const b = new Browser();
      await b.get(`/a/${dbAlias}/login`);
      const res = await b.post(`/a/${dbAlias}/login`, { __csrf: b.lastCsrf, username: user, password });
      return { b, res };
    };
    const failures = async () => (await owner.query(`select username, detail from meta.activity_log where app_id = $1 and event = 'login_failed' order by id`, [dbApp])).rows;

    test('wrong passwords, unlisted, NOLOGIN, superuser and pgapex\'s own roles are refused alike; no password is logged', async () => {
      for (const [user, pw] of [[R.ann, 'wrong'], [R.eve, 'Eve-pw-30!'], [R.off, 'Off-pw-30!'], [R.boss, 'Boss-pw-30!'], ['pgapex', 'pgapex'], ['no_such_role_s30', 'x'],
        [`${R.ann}\u0000x`, 'Ann-pw-30!'], ['x'.repeat(64), 'x'], [`${R.ann}' or '1'='1`, "' or '1'='1"], [R.ann, '']] as const) {
        const { b, res } = await attempt(user, pw);
        assert.ok([401, 400].includes(res.statusCode), `${user}: ${res.statusCode}`);
        assert.match(res.body, /Invalid|invalid/);
        assert.equal((await b.get(`/a/${dbAlias}/1`)).statusCode, 302, 'no session');
      }
      const log = await failures();
      assert.ok(log.some((l) => l.username === R.eve && /role not allowed/.test(l.detail)), 'unlisted: refused before connecting');
      assert.ok(log.some((l) => l.username === R.boss && /superuser refused/.test(l.detail)));
      assert.ok(log.some((l) => l.username === 'pgapex' && /role not allowed/.test(l.detail)));
      assert.ok(log.some((l) => l.username === R.off && /connection refused/.test(l.detail)));
      const all = JSON.stringify((await owner.query(`select * from meta.activity_log where app_id = $1`, [dbApp])).rows);
      for (const pw of ['Ann-pw-30!', 'Eve-pw-30!', 'Off-pw-30!', 'Boss-pw-30!', 'wrong']) assert.ok(!all.includes(pw), 'no password in the log');
      await owner.query(`delete from meta.activity_log where app_id = $1`, [dbApp]);
    });

    test('throttling: after too many failures even the right password is refused', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await attempt(R.ann, `wrong-${i}`)).res.statusCode, 401);
      const locked = await attempt(R.ann, 'Ann-pw-30!');
      assert.equal(locked.res.statusCode, 429);
      assert.equal((await locked.b.get(`/a/${dbAlias}/1`)).statusCode, 302);
      await owner.query(`delete from meta.activity_log where app_id = $1`, [dbApp]);
      assert.equal((await attempt(R.ann, 'Ann-pw-30!')).res.statusCode, 303);
    });

    test('no other way in: no CSRF token, the password-change form, remember me, SSO, an app_users account of the same name', async () => {
      const b = new Browser();
      await b.get(`/a/${dbAlias}/login`);
      assert.equal((await b.post(`/a/${dbAlias}/login`, { username: R.ann, password: 'Ann-pw-30!' })).statusCode, 403);
      assert.equal((await b.post(`/a/${dbAlias}/password`, { __csrf: b.lastCsrf, username: R.ann, password: 'Ann-pw-30!', new_password: 'Xx-new-pw-30!', confirm_password: 'Xx-new-pw-30!' })).statusCode, 403);
      assert.equal((await b.get(`/a/${dbAlias}/sso/any`)).statusCode >= 400 || (await b.get(`/a/${dbAlias}/1`)).statusCode === 302, true);
      // an app user's password does not open a database-account app
      assert.equal((await b.post(`/a/${dbAlias}/login`, { __csrf: b.lastCsrf, username: 'king', password: 'king' })).statusCode, 401);
      assert.equal((await b.get(`/a/${dbAlias}/1`)).statusCode, 302);
      // a session of a database-account app does not reach another app
      const ok = await attempt(R.ann, 'Ann-pw-30!');
      assert.equal(ok.res.statusCode, 303);
      assert.equal((await ok.b.get('/a/hr/1')).statusCode, 302);
      // with nothing allowed, nobody signs in
      await owner.query('update meta.app set db_auth_roles = null where id = $1', [dbApp]);
      try {
        assert.equal((await attempt(R.ann, 'Ann-pw-30!')).res.statusCode, 401);
      } finally {
        await owner.query('update meta.app set db_auth_roles = $2 where id = $1', [dbApp, [R.ann, R.off, R.boss, 'pgapex', 'pgapex_runtime']]);
      }
    });
  });

  test('keyset paging: another user\'s token for this region only seeks in the viewer\'s own query', async () => {
    // the position is not a permission: the rows still come from the region's query as the app's role
    const blake = await as('blake');
    const res = await blake.get(`/a/hr/25?r${region}_p=2&r${region}_k=${encodeURIComponent(token(['199990']))}`);
    if (res.statusCode === 200) assert.equal(firstId(res.body), 199991);
    else assert.ok([302, 303, 403].includes(res.statusCode));
  });
});

describe('sprint 31 i18n: time zones and format masks', () => {
  // the browser's time zone, the sign-in form's __tz and My account's time zone only ever
  // become one of pg_timezone_names' names; format masks only shape output that is escaped
  let page29: number;
  const zoneOn29 = async (b: Browser) => /data-label="Time zone">([^<]*)</.exec((await b.get('/a/hr/29')).body)?.[1];
  before(async () => {
    page29 = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 29`, [appId])).id;
    await owner.query(`update meta.account set time_zone = null where username in ('king', 'blake')`);
  });
  after(async () => {
    await owner.query(`update meta.account set time_zone = null where username in ('king', 'blake')`);
    await owner.query(`update meta.app set time_zone = null, time_zone_auto = true where id = $1`, [appId]);
  });

  test('POST /tz needs the session\'s CSRF token and takes only known time zone names', async () => {
    const king = await as('king');
    const before = await zoneOn29(king);
    assert.equal((await king.post('/a/hr/tz', { tz: 'Asia/Tokyo' })).statusCode, 403, 'no token');
    assert.equal((await king.post('/a/hr/tz', { __csrf: 'x'.repeat(48), tz: 'Asia/Tokyo' })).statusCode, 403, 'a wrong token');
    for (const tz of ["UTC'; drop table hr.emp; --", 'utc', '../../etc/passwd', 'posix/Europe/Amsterdam', 'Europe/Amsterdam\u0000', 'x'.repeat(65), '', 'GMT+5,UTC']) {
      const res = await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz });
      assert.equal(res.statusCode, 422, JSON.stringify(tz));
    }
    assert.equal((await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz: ['Asia/Tokyo', 'UTC'] })).statusCode, 422, 'a list is not a name');
    assert.equal(await zoneOn29(king), before, 'nothing changed');
    assert.equal((await owner.one(`select count(*)::int as n from hr.emp`)).n > 0, true);
    assert.equal((await king.post('/a/nosuchapp/tz', { __csrf: king.lastCsrf, tz: 'UTC' })).statusCode, 404);
  });

  test('one session\'s time zone does not reach another session or user', async () => {
    const king = await as('king');
    await king.get('/a/hr/29');
    assert.equal((await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz: 'Pacific/Auckland' })).statusCode, 200);
    assert.equal(await zoneOn29(king), 'Pacific/Auckland');
    const blake = await as('blake');
    assert.notEqual(await zoneOn29(blake), 'Pacific/Auckland');
    // the browser's zone is the session's, not the account's
    assert.equal((await owner.one(`select time_zone from meta.account where username = 'king'`)).time_zone, null);
  });

  test('the sign-in form\'s __tz and My account\'s time zone refuse unknown names', async () => {
    const b = new Browser();
    await b.get('/a/hr/login');
    assert.equal((await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'blake', password: 'blake', __tz: "Europe/Paris' or '1'='1" })).statusCode, 303);
    assert.notEqual(await zoneOn29(b), "Europe/Paris' or '1'='1");
    await b.get('/a/hr/account');
    const res = await b.post('/a/hr/account', { __csrf: b.lastCsrf, time_zone: "UTC'; select pg_sleep(5); --" });
    assert.equal(res.statusCode, 422);
    assert.equal((await owner.one(`select time_zone from meta.account where username = 'blake'`)).time_zone, null);
    // without the token nothing is saved
    assert.equal((await b.post('/a/hr/account', { time_zone: 'Asia/Tokyo' })).statusCode, 303);
    assert.equal((await owner.one(`select time_zone from meta.account where username = 'blake'`)).time_zone, null);
    // a username field doesn't pick another account
    await b.get('/a/hr/account');
    await b.post('/a/hr/account', { __csrf: b.lastCsrf, time_zone: 'Asia/Tokyo', username: 'king' });
    assert.equal((await owner.one(`select time_zone from meta.account where username = 'king'`)).time_zone, null);
    assert.equal((await owner.one(`select time_zone from meta.account where username = 'blake'`)).time_zone, 'Asia/Tokyo');
  });

  test('without an automatic time zone neither the browser nor the user can choose one', async () => {
    await owner.query(`update meta.app set time_zone_auto = false, time_zone = 'UTC' where id = $1`, [appId]);
    try {
      const king = await as('king');
      await king.get('/a/hr/29');
      assert.equal((await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz: 'Asia/Tokyo' })).json().reload, false);
      await king.get('/a/hr/account');
      await king.post('/a/hr/account', { __csrf: king.lastCsrf, time_zone: 'Asia/Tokyo' });
      assert.equal((await owner.one(`select time_zone from meta.account where username = 'king'`)).time_zone, null);
      assert.equal(await zoneOn29(king), 'UTC');
    } finally {
      await owner.query(`update meta.app set time_zone = null, time_zone_auto = true where id = $1`, [appId]);
    }
  });

  test('the database refuses a time zone that is not a name, whoever writes it', async () => {
    await assert.rejects(owner.query(`update meta.app set time_zone = 'UTC''; --' where id = $1`, [appId]), /check/);
    await assert.rejects(runtime.query(`update meta.account set time_zone = 'a b' where username = 'king'`), /check/);
    await assert.rejects(owner.query(`update meta.app set currency = 'eu<' where id = $1`, [appId]), /check/);
  });

  test('builder settings: an unknown time zone or currency is refused, nothing is saved', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const before = await owner.one('select time_zone, currency from meta.app where id = $1', [appId]);
    for (const [time_zone, currency] of [['Mars/Olympus', 'EUR'], ['UTC', '<b>'], ["UTC'; --", 'EUR']]) {
      const page = (await dev.get(`/builder/apps/${appId}/settings`)).body;
      assert.match(page, /name="time_zone"/);
      await dev.post(`/builder/apps/${appId}/settings`, { __csrf: dev.lastCsrf, time_zone, currency });
      assert.deepEqual(await owner.one('select time_zone, currency from meta.app where id = $1', [appId]), before, `${time_zone} ${currency}`);
    }
    // an app user is not a developer
    const king = await as('king');
    assert.notEqual((await king.post(`/builder/apps/${appId}/settings`, { __csrf: king.lastCsrf, time_zone: 'UTC' })).statusCode, 200);
  });

  test('format masks: literal text and currency symbols are escaped; a bad mask falls back to the plain value', async () => {
    const r = (await owner.one(`select id, config from meta.region where page_id = $1 and title = 'Salaries'`, [page29]));
    await owner.query(`update meta.region set config = config || $2 where id = $1`,
      [r.id, JSON.stringify({ formats: { hiredate: 'DD "<img src=x onerror=alert(1)>" YYYY', salary: '9G<script>', yearly: '9'.repeat(5000) } })]);
    await owner.query(`insert into meta.text_message (app_id, name, language, text) values ($1, 'FORMAT.CURRENCY', 'en', '<script>') on conflict do nothing`, [appId]);
    try {
      const king = await as('king');
      const body = (await king.get('/a/hr/29?lang=en')).body;
      assert.equal(body.includes('<img src=x'), false);
      assert.equal(body.includes('<script>'), false);
      assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(body, /data-label="Salary">5000\.00</, 'an invalid mask: the plain value');
    } finally {
      await owner.query(`update meta.region set config = $2 where id = $1`, [r.id, r.config]);
      await owner.query(`delete from meta.text_message where app_id = $1 and name = 'FORMAT.CURRENCY'`, [appId]);
    }
  });

  test('a masked number item: odd input is kept as text for validation and only ever bound', async () => {
    const king = await as('king');
    await king.get('/a/hr/29?lang=en');
    for (const v of ["1'; drop table hr.emp; --", '<b>1</b>', 'NaN', 'Infinity', '1e99999', '--1']) {
      await king.get('/a/hr/29');
      const res = await king.post('/a/hr/29', { __csrf: king.lastCsrf, P29_AMOUNT: v, __request: 'CONVERT' });
      assert.equal(res.statusCode, 422, v.slice(0, 20));
      assert.equal(res.body.includes('<b>1</b>'), false);
    }
    assert.equal((await owner.one(`select count(*)::int as n from hr.emp`)).n > 0, true);
  });
});

describe('sprint 31 workshop: SQL scripts, Quick SQL, query builder, XML loading, data load definitions', () => {
  const builder = async () => {
    const b = new FileBrowser(app);
    await b.get('/builder/login');
    const res = await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
    assert.equal(res.statusCode, 303, 'builder login');
    return b;
  };
  const csv = (text: string) => ({ name: 'x.csv', type: 'text/csv', data: Buffer.from(text) });
  after(async () => {
    await owner.query(`delete from meta.sql_script_run where script_name like 'sec31%'; delete from meta.sql_script where name like 'sec31%';
      delete from meta.data_load_def where name like 'SEC31%'; delete from meta.app where alias = 'sec31other'; drop table if exists public.sec31_csrf, public.sec31_qs`);
  });

  test('SQL Workshop pages need a builder login; an application session is not enough', async () => {
    const king = await as('king');
    for (const url of ['/builder/sql/scripts', '/builder/sql/scripts/new', '/builder/sql/quick', '/builder/sql/query', '/builder/sql/load', '/builder/sql/scripts/runs/1']) {
      for (const b of [new Browser(), king]) {
        const res = await b.get(url);
        assert.equal(res.statusCode, 302, url);
        assert.match(String(res.headers.location), /^\/builder\/login/, url);
      }
    }
    const anon = new Browser();
    const res = await anon.post('/builder/sql/scripts', { name: 'sec31 anon', content: 'create table public.sec31_csrf ()', action: 'run' });
    assert.equal(res.statusCode, 302);
    assert.equal((await owner.one(`select to_regclass('public.sec31_csrf') as t`)).t, null);
  });

  test('every workshop POST needs the CSRF token', async () => {
    const dev = await builder();
    await dev.get('/builder/sql/scripts/new');
    const script = (await owner.one(`insert into meta.sql_script (name, content) values ('sec31 keep', 'select 1') returning id`)).id;
    const posts: [string, Record<string, string>][] = [
      ['/builder/sql/scripts', { name: 'sec31 csrf', content: 'create table public.sec31_csrf ()', action: 'run' }],
      [`/builder/sql/scripts/${script}`, { name: 'sec31 keep', content: 'create table public.sec31_csrf ()', action: 'run' }],
      [`/builder/sql/scripts/${script}/delete`, {}],
      ['/builder/sql/quick', { source: 'sec31_qs\n  name', action: 'run' }],
      [`/builder/apps/${appId}/shared/data_load_def`, { name: 'SEC31_CSRF', table_name: 'hr.emp', columns: '[]' }],
    ];
    for (const [url, form] of posts) {
      for (const token of [undefined, 'wrong']) {
        const res = await dev.post(url, token ? { __csrf: token, ...form } : form);
        assert.equal(res.statusCode, 403, `${url} ${token ?? 'no token'}`);
      }
    }
    dev.lastCsrf = 'wrong';
    for (const url of ['/builder/sql/scripts/upload', '/builder/sql/load']) {
      const res = await dev.upload(url, {}, { file: { name: 'sec31.sql', type: 'application/sql', data: Buffer.from('create table public.sec31_csrf ()') } });
      assert.equal(res.statusCode, 403, url);
    }
    assert.equal((await owner.one(`select to_regclass('public.sec31_csrf') as t, to_regclass('public.sec31_qs') as q`)).t, null);
    assert.equal((await owner.one(`select count(*)::int as n from meta.sql_script where name like 'sec31%'`)).n, 1, 'nothing saved, nothing deleted');
    assert.equal(await owner.one(`select 1 from meta.data_load_def where name = 'SEC31_CSRF'`), undefined);
    assert.equal(await owner.one(`select 1 from meta.sql_script_run where script_id = $1`, [script]), undefined, 'not run');
  });

  test('script names, SQL, results and errors are escaped; the download file name is safe', async () => {
    const dev = await builder();
    await dev.get('/builder/sql/scripts/new');
    const name = 'sec31 <img src=x onerror=alert(1)>"; x=1';
    const res = await dev.submit('/builder/sql/scripts', {
      name,
      content: `select '<script>alert(1)</script>' as "<b>col</b>";\nselect 1/0 as "<i>x</i>";`,
      action: 'run',
      on_error: 'continue',
    });
    assert.equal(res.statusCode, 303);
    const run = await dev.get(String(res.headers.location));
    assert.equal(run.statusCode, 200);
    assert.doesNotMatch(run.body, /<script>alert|<img src=x|<b>col<\/b>|<i>x<\/i>/);
    assert.match(run.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(run.body, /division by zero/);
    const list = await dev.get('/builder/sql/scripts');
    assert.doesNotMatch(list.body, /<img src=x/);
    const id = (await owner.one('select id from meta.sql_script where name = $1', [name])).id;
    const dl = await dev.get(`/builder/sql/scripts/${id}/download`);
    assert.equal(dl.statusCode, 200);
    const disposition = String(dl.headers['content-disposition']);
    assert.match(disposition, /^attachment; filename="[\w.-]+\.sql"$/);
    // ids that are not numbers: 404, not an error
    for (const url of [`/builder/sql/scripts/1'`, '/builder/sql/scripts/x/download', '/builder/sql/scripts/runs/1%20or%201=1']) assert.equal((await dev.get(url)).statusCode, 404, url);
  });

  test('Quick SQL: names and values become quoted identifiers and literals; the preview is escaped', async () => {
    const dev = await builder();
    await dev.get('/builder/sql/quick');
    const src = `sec31_qs\n  "x; drop table hr.emp; --" vc20\n  status /check a'); drop table hr.emp; --, b /default '); drop table hr.dept; --\n  note [<script>alert(1)</script>]`;
    const preview = await dev.submit('/builder/sql/quick', { source: src, action: 'preview' });
    assert.equal(preview.statusCode, 200);
    assert.doesNotMatch(preview.body, /<script>alert/);
    await dev.get('/builder/sql/quick');
    const res = await dev.submit('/builder/sql/quick', { source: src, action: 'run', name: 'sec31 qs' });
    assert.equal(res.statusCode, 303);
    assert.ok((await owner.one(`select to_regclass('hr.emp') as e, to_regclass('hr.dept') as d`)).e, 'hr.emp still there');
    assert.ok((await owner.one(`select to_regclass('hr.dept') as d`)).d, 'hr.dept still there');
  });

  test('query builder: only catalog names, fixed operators, literal values; the page escapes them', async () => {
    const dev = await builder();
    const res = await dev.get(`/builder/sql/query?schema=hr&t=emp&t=${encodeURIComponent('dept"; drop table hr.emp; --')}&wc=t1.ename&wo=${encodeURIComponent('= 1 or 1=1 --')}&wv=1&wc=t1.ename&wo=%3D&wv=${encodeURIComponent("x'); drop table hr.emp; --<script>")}`);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /drop table hr\.emp; --&quot;|1=1|<script>/);
    assert.match(res.body, /where t1\.&quot;ename&quot; = &#39;x&#39;&#39;\); drop table hr\.emp; --&lt;script&gt;&#39;/);
    assert.equal((await dev.get(`/builder/sql/query?schema=${encodeURIComponent("hr'; drop")}`)).statusCode, 200);
  });

  test('XML loading refuses DTDs, entity declarations and deep nesting; nothing is fetched or expanded', async () => {
    const dev = await builder();
    const files = {
      xxe: `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r><row><a>&x;</a></row></r>`,
      laughs: `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><r><row><a>&b;</a></row></r>`,
      param: `<!DOCTYPE r SYSTEM "http://127.0.0.1:1/evil.dtd"><r><row><a>1</a></row></r>`,
      undeclared: `<r><row><a>&x;</a></row></r>`,
      deep: `<r>${'<a>'.repeat(5000)}1${'</a>'.repeat(5000)}</r>`,
    };
    for (const [k, xml] of Object.entries(files)) {
      await dev.get('/builder/sql/load');
      const res = await dev.upload('/builder/sql/load', {}, { file: { name: `${k}.xml`, type: 'application/xml', data: Buffer.from(xml) } });
      assert.equal(res.statusCode, 200, k);
      assert.match(res.body, /This is not XML that can be loaded/, k);
      assert.doesNotMatch(res.body, /root:|aaaaaaaaaaaaaaaaaaaa/, k);
      assert.equal(await owner.one(`select 1 from meta.temp_file where filename = $1`, [`${k}.xml`]), undefined, `${k}: not kept`);
    }
  });

  test('Load Data: the temporary file belongs to the builder session that uploaded it', async () => {
    const a = await builder();
    await a.get('/builder/sql/load');
    const up = await a.upload('/builder/sql/load', { headers: 'true' }, { file: csv('ename\nsec31\n') });
    assert.equal(up.statusCode, 303);
    const url = String(up.headers.location);
    assert.equal((await a.get(url)).statusCode, 200);
    const b = await builder();
    const other = await b.get(url);
    assert.equal(other.statusCode, 302, 'another session');
    await b.get('/builder/sql/load');
    const post = await b.submit(url.split('?')[0], { h: '1', target: 'existing', table: 'hr.emp', map_0: 'ename' });
    assert.equal(post.statusCode, 302);
    assert.equal(await owner.one(`select 1 from hr.emp where ename = 'sec31'`), undefined);
    assert.equal((await b.get('/builder/sql/load/..%2F..%2Fetc')).statusCode, 302);
  });

  test('data load definitions: table names and mappings are validated; format masks and values are never SQL', async () => {
    const dev = await builder();
    for (const [table, columns] of [
      ['hr.emp; drop table hr.dept', '[]'],
      ['hr.emp', '[{"source": "ename", "column": "ename", "transform": ["upper); drop"]}]'],
      ['hr.emp', '{"ename": "ename"}'],
      ['hr.emp', '[{"source": "ename", "column": "ename", "evil": 1}]'],
    ]) {
      await dev.get(`/builder/apps/${appId}/shared?new=data_load_def`);
      await dev.submit(`/builder/apps/${appId}/shared/data_load_def`, { name: 'SEC31_BAD', table_name: table, columns });
      assert.equal(await owner.one(`select 1 from meta.data_load_def where name = 'SEC31_BAD'`), undefined, `${table} ${columns}`);
    }
    await assert.rejects(owner.query(`insert into meta.data_load_def (app_id, name, table_name) values ($1, 'SEC31_SQL', 'hr.emp; drop table hr.dept')`, [appId]), /check/);
    const def = {
      name: 'SEC31_MASK', table_name: 'hr.emp', format: 'csv' as const, headers: true, row_tag: null, mode: 'append' as const, skip_errors: false,
      columns: [
        { source: 'empno', column: 'empno' },
        { source: 'ename', column: 'ename', default: "'); drop table hr.dept; --" },
        { source: 'hiredate', column: 'hiredate', format: "YYYY'); drop table hr.dept; --" },
      ],
    };
    const ok = def;
    const r = await owner.tx(async (c) => {
      const out = await loadWithDefinition(c, ok, { filename: 'x.csv', content: Buffer.from('empno,ename,hiredate\n9531,,2026\n') });
      const row = (await c.query('select ename, hiredate::text from hr.emp where empno = 9531')).rows[0];
      await c.query('rollback; begin');
      return { out, row };
    });
    assert.equal(r.out.inserted, 1);
    assert.equal(r.row.ename, "'); drop table hr.dept; --", 'the default is a value');
    assert.equal(r.row.hiredate, '2026-01-01', 'the mask is a to_date literal');
    assert.ok((await owner.one(`select to_regclass('hr.dept') as d`)).d);
  });

  test('the data_load process: definitions of other applications are not found; it loads as the application role', async () => {
    const other = (await owner.one(`insert into meta.app (alias, name, db_role) values ('sec31other', 'Other 31', 'hr_app') returning id`)).id;
    await owner.query(`insert into meta.data_load_def (app_id, name, table_name, format) values ($1, 'SEC31_OTHER', 'hr.emp', 'csv'), ($2, 'SEC31_META', 'meta.app', 'csv')`, [other, appId]);
    const proc = await owner.one(`select p.id, p.config from meta.process p join meta.page g on g.id = p.page_id where g.app_id = $1 and g.page_no = 13 and p.type = 'data_load'`, [appId]);
    try {
      for (const [name, file] of [
        ['sec31_other', 'empno,ename\n9532,SEC31\n'],
        ['sec31_meta', 'alias,name\nsec31x,Sec 31\n'],
      ]) {
        await owner.query(`update meta.process set config = $2 where id = $1`, [proc.id, JSON.stringify({ file_item: 'P13_FILE', definition: name })]);
        const king = new FileBrowser(app);
        await king.get('/a/hr/login');
        await king.post('/a/hr/login', { __csrf: king.lastCsrf, username: 'king', password: 'king' });
        await king.get('/a/hr/13');
        const res = await king.upload('/a/hr/13', { __request: 'LOAD' }, { P13_FILE: csv(file) });
        assert.equal(res.statusCode, 422, name);
        assert.doesNotMatch(res.body, /permission denied|meta\.app/, `${name}: no internals`);
      }
      assert.equal(await owner.one(`select 1 from hr.emp where empno = 9532`), undefined);
      assert.equal(await owner.one(`select 1 from meta.app where alias = 'sec31x'`), undefined, 'the app role cannot write meta tables');
    } finally {
      await owner.query('update meta.process set config = $2 where id = $1', [proc.id, proc.config]);
    }
  });
});

describe('sprint 31 grid: interactive grid layouts, saved grid reports, master-detail', () => {
  const R: Record<string, number> = {};
  const sel = (user: string, region: number, value: string) =>
    `r${region}_sel=${encodeURIComponent(value)}&r${region}_selcs=${urlChecksum(appId, 27, user, { [`S${region}`]: value })}`;
  const staffOf = (body: string) => {
    const start = body.indexOf(`id="R${R.Staff}"`);
    return body.slice(start, body.indexOf('</section>', start));
  };
  const shows = (body: string, ename: string) => new RegExp(`value="${ename}"`).test(staffOf(body));
  before(async () => {
    for (const r of (await owner.query(`select r.id, r.title from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 27`, [appId])).rows) R[r.title] = r.id;
    await owner.query(`delete from meta.saved_report where region_id = any($1)`, [Object.values(R)]);
  });
  after(async () => {
    await owner.query(`delete from meta.saved_report where region_id = any($1)`, [Object.values(R)]);
  });

  test('a master row selection needs this user\'s signature for this value and region', async () => {
    const blake = await as('blake');
    // unsigned, another user's signature, another value's signature, signed for another region
    const forged = [
      `r${R.Departments}_sel=10`,
      sel('king', R.Departments, '10'),
      `r${R.Departments}_sel=10&r${R.Departments}_selcs=${urlChecksum(appId, 27, 'blake', { [`S${R.Departments}`]: '20' })}`,
      `r${R.Departments}_sel=10&r${R.Departments}_selcs=${urlChecksum(appId, 27, 'blake', { [`S${R.Staff}`]: '10' })}`,
    ];
    for (const q of forged) {
      const res = await blake.get(`/a/hr/27?${q}`);
      assert.equal(res.statusCode, 200, q);
      assert.ok(!shows(res.body, 'KING'), `${q}: no selection`);
      const json = await blake.get(`/a/hr/27/region/${R.Staff}?${q}`);
      if (json.statusCode === 200) assert.ok(!shows(JSON.parse(json.body).html, 'KING'), `${q}: no selection through the region endpoint`);
    }
    // the item can't be set by URL (checksum protection) or by posting it (hidden items aren't posted)
    assert.equal((await blake.get('/a/hr/27?P27_DEPTNO=10')).statusCode, 403);
    await blake.post('/a/hr/27', { __csrf: blake.lastCsrf, P27_DEPTNO: '10', __request: `GRID_SAVE_${R.Staff}` });
    assert.ok(!shows((await blake.get('/a/hr/27')).body, 'KING'));
    // the right one works
    assert.ok(shows((await blake.get(`/a/hr/27?${sel('blake', R.Departments, '10')}`)).body, 'KING'));
    // a user without access to the page gets nothing, signed or not
    const allen = await as('allen');
    assert.notEqual((await allen.get(`/a/hr/27?${sel('allen', R.Departments, '10')}`)).statusCode, 200);
    assert.equal((await allen.get(`/a/hr/27/region/${R.Staff}?${sel('allen', R.Departments, '10')}`)).statusCode, 403);
  });

  test('the region endpoint serves a detail region, not any region of the page', async () => {
    const blake = await as('blake');
    // the master grid is neither lazy nor a detail
    assert.equal((await blake.get(`/a/hr/27/region/${R.Departments}?${sel('blake', R.Departments, '10')}`)).statusCode, 403);
    // a region of another page under this page's URL
    const other = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 limit 1`, [appId])).id;
    assert.equal((await blake.get(`/a/hr/27/region/${other}`)).statusCode, 403);
  });

  test('layout endpoints: CSRF, the grid must be on the page and visible, the input is cleaned', async () => {
    const blake = await as('blake');
    await blake.get('/a/hr/27');
    const url = `/a/hr/27/grid/${R.Staff}/layout`;
    assert.equal((await blake.post(url, { layout: '{"order":["sal"]}' })).statusCode, 403, 'no CSRF token');
    assert.equal((await blake.post(url, { __csrf: 'x', layout: '{"order":["sal"]}' })).statusCode, 403, 'wrong CSRF token');
    // a report region, a region of another page, an unknown one
    const report = R['Jobs in the department'];
    const other = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 limit 1`, [appId])).id;
    for (const id of [report, other, 999999]) {
      assert.equal((await blake.post(`/a/hr/27/grid/${id}/layout`, { __csrf: blake.lastCsrf, layout: '{}' })).statusCode, 403, `region ${id}`);
      assert.equal((await blake.post(`/a/hr/27/grid/${id}/layout/reset`, { __csrf: blake.lastCsrf })).statusCode, 403);
    }
    // a user who can't open the page can't keep a layout on it
    const allen = await as('allen');
    await allen.get('/a/hr/1');
    assert.notEqual((await allen.post(url, { __csrf: allen.lastCsrf, layout: '{"order":["sal"]}' })).statusCode, 303);
    assert.equal((await owner.query(`select 1 from meta.saved_report where region_id = $1 and username = 'allen'`, [R.Staff])).rowCount, 0);
    // hostile values: markup in names, CSS in widths, huge frozen counts, oversized JSON
    const res = await blake.post(url, {
      __csrf: blake.lastCsrf,
      layout: JSON.stringify({ order: ['"><script>alert(1)</script>', 'sal'], hidden: ['ename'], widths: { sal: '100px;background:url(//x)', job: 1e9, comm: -5 }, frozen: 99 }),
    });
    assert.equal(res.statusCode, 303);
    const stored = (await owner.one(`select params from meta.saved_report where region_id = $1 and username = 'blake' and kind = 'layout'`, [R.Staff])).params;
    const lay = JSON.parse(new URLSearchParams(stored).get(`r${R.Staff}_lay`)!);
    assert.deepEqual(lay.widths, { job: 1000 }, 'widths are numbers within bounds');
    assert.equal(lay.frozen, 5);
    const body = (await blake.get(`/a/hr/27?${sel('blake', R.Departments, '20')}`)).body;
    assert.ok(!body.includes('<script>alert(1)'));
    assert.ok(!/background:url\(\/\/x\)/.test(body));
    assert.equal((await blake.post(url, { __csrf: blake.lastCsrf, layout: `{"order":["${'x'.repeat(7000)}"]}` })).statusCode, 403, 'oversized layout');
    assert.equal((await blake.post(url, { __csrf: blake.lastCsrf, layout: 'not json' })).statusCode, 403);
    await blake.post(`${url}/reset`, { __csrf: blake.lastCsrf });
  });

  test('saved grid reports: own and public ones only, publishing needs the authorization', async () => {
    const king = await as('king');
    const blake = await as('blake');
    await king.get('/a/hr/27');
    await blake.get('/a/hr/27');
    // blake (not ADMIN) asks for a public report: saved private
    assert.equal((await blake.post(`/a/hr/27/report/${R.Staff}/save`, { __csrf: blake.lastCsrf, name: 'Mine', public: 'true', params: '' })).statusCode, 303);
    const mine = await owner.one(`select id, public from meta.saved_report where region_id = $1 and username = 'blake' and name = 'Mine'`, [R.Staff]);
    assert.equal(mine.public, false);
    // king may publish (ADMIN)
    await king.post(`/a/hr/27/report/${R.Staff}/save`, { __csrf: king.lastCsrf, name: 'Shared', public: 'true', params: '' });
    await king.post(`/a/hr/27/report/${R.Staff}/save`, { __csrf: king.lastCsrf, name: 'Private', params: '' });
    const shared = await owner.one(`select id, public from meta.saved_report where region_id = $1 and username = 'king' and name = 'Shared'`, [R.Staff]);
    const priv = (await owner.one(`select id from meta.saved_report where region_id = $1 and username = 'king' and name = 'Private'`, [R.Staff])).id;
    assert.equal(shared.public, true);
    // blake applies king's public report, not his private one, nor one under another grid's URL
    assert.equal((await blake.post(`/a/hr/27/grid/${R.Staff}/saved/${shared.id}/apply`, { __csrf: blake.lastCsrf, params: '' })).statusCode, 303);
    assert.equal((await blake.post(`/a/hr/27/grid/${R.Staff}/saved/${priv}/apply`, { __csrf: blake.lastCsrf, params: '' })).statusCode, 403);
    assert.equal((await blake.post(`/a/hr/27/grid/${R.Departments}/saved/${shared.id}/apply`, { __csrf: blake.lastCsrf, params: '' })).statusCode, 403);
    assert.equal((await blake.post(`/a/hr/27/grid/${R.Staff}/saved/${shared.id}/apply`, { params: '' })).statusCode, 403, 'no CSRF token');
    // nor delete king's report
    await blake.post(`/a/hr/27/report/${R.Staff}/saved/${shared.id}/delete`, { __csrf: blake.lastCsrf, params: '' });
    assert.equal((await owner.query('select 1 from meta.saved_report where id = $1', [shared.id])).rowCount, 1);
    // the public user can't save reports
    const anon = new Browser();
    await anon.get('/a/hr/login');
    assert.notEqual((await anon.post(`/a/hr/27/report/${R.Staff}/save`, { __csrf: anon.lastCsrf, name: 'x', params: '' })).statusCode, 303);
  });

  test('in the database: layouts stay private, the functions check the region and the user', async () => {
    const c = await runtime.pool.connect();
    try {
      const as = async (user: string, sql: string, params: unknown[] = []) => {
        await c.query('begin');
        try {
          await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true)`, [String(appId), user]);
          return await c.query(sql, params);
        } finally {
          await c.query('rollback');
        }
      };
      await owner.query(`delete from meta.saved_report where region_id = $1 and kind = 'layout'`, [R.Staff]);
      await owner.query(`insert into meta.saved_report (app_id, region_id, username, name, public, params, kind) values ($1, $2, 'king', 'current', true, 'x', 'layout')`, [appId, R.Staff]);
      // a layout row, even one marked public, is only its owner's
      assert.deepEqual((await as('blake', `select username from meta.saved_reports where kind = 'layout'`)).rows, []);
      assert.equal((await as('king', `select 1 from meta.saved_reports where kind = 'layout'`)).rowCount, 1);
      // blake can't reset king's layout, nor delete it as a saved report
      assert.equal((await as('blake', 'select meta.reset_grid_layout($1) as d', [R.Staff])).rows[0].d, false);
      const kingRow = (await owner.one(`select id from meta.saved_report where username = 'king' and kind = 'layout' and region_id = $1`, [R.Staff])).id;
      assert.equal((await as('king', 'select meta.delete_saved_report($1) as d', [kingRow])).rows[0].d, false, 'the layout is not a saved report');
      // not signed in, a report region, a region of another app
      await assert.rejects(as('nobody', 'select meta.save_grid_layout($1, $2)', [R.Staff, '']), /sign in/);
      await assert.rejects(as('blake', 'select meta.save_grid_layout($1, $2)', [R['Jobs in the department'], '']), /unknown grid region/);
      const foreign = await owner.query(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id <> $1 and r.type = 'grid' limit 1`, [appId]);
      if (foreign.rowCount) await assert.rejects(as('blake', 'select meta.save_grid_layout($1, $2)', [foreign.rows[0].id, '']), /unknown grid region/);
      // the runtime role can't write the table directly
      await assert.rejects(as('blake', `insert into meta.saved_report (app_id, region_id, username, name, params, kind) values ($1, $2, 'king', 'x', '', 'layout')`, [appId, R.Staff]), /permission denied/);
    } finally {
      c.release();
      await owner.query(`delete from meta.saved_report where region_id = $1 and kind = 'layout'`, [R.Staff]);
    }
  });
});

// ---------------------------------------------------------------- sprint 31 logic
// Download processes, execution chains (background jobs), workflow processes,
// branches to a function's URL or another application, "dialog closed".
describe('sprint 31 logic', () => {
  let page28: number;
  const undo: string[] = [];
  const browser = async (user: string) => {
    const { Browser: B } = await import('./helpers.ts');
    const b = new B(app);
    assert.equal((await b.login(user)).statusCode, 303);
    await b.get('/a/hr/28');
    return b;
  };
  /** A process on page 28 for one test (deleted at the end). */
  const process28 = async (cols: Record<string, unknown>) => {
    const names = Object.keys(cols);
    const p = await owner.one(
      `insert into meta.process (page_id, ${names.join(', ')}) values ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
      [page28, ...Object.values(cols)],
    );
    undo.push(`delete from meta.process where id = ${Number(p.id)}`);
    return p.id as number;
  };
  before(async () => {
    page28 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 28', [appId])).id;
  });
  afterEach(async () => {
    for (const sql of undo.splice(0).reverse()) await owner.query(sql);
  });
  after(async () => {
    await owner.query(`delete from meta.process_job where app_id = $1`, [appId]);
  });

  test('download: file name and MIME type from the data cannot inject headers or paths', async () => {
    const { safeFileName, safeMime, disposition } = await import('../src/runtime/processes.ts');
    const name = safeFileName('a"b\r\nSet-Cookie: x=1;/..\\c.txt');
    assert.doesNotMatch(name, /[\r\n"\\/]/);
    assert.doesNotMatch(disposition('attachment', 'ü "x"\r\n.txt'), /[\r\n]|"x"/);
    assert.equal(safeMime('text/html\r\nX-Evil: 1'), 'application/octet-stream');
    assert.equal(safeMime('../../x'), 'application/octet-stream');
    assert.equal(safeFileName('...'), 'download');
    await process28({ seq: 1, name: 'sec download', type: 'download', when_button: 'CARD', config: '{}',
      code: `select 'x' as content, E'evil"\\r\\nSet-Cookie: a=1.html' as filename, E'text/html\\r\\nX-Evil: 1' as mime_type` });
    const b = await browser('king');
    const res = await b.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'CARD' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-evil'], undefined);
    assert.equal(res.headers['set-cookie'] === undefined || !String(res.headers['set-cookie']).includes('a=1'), true);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(String(res.headers['content-disposition']), /^attachment; /);
    assert.match(String(res.headers['content-security-policy']), /sandbox/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('download: an "inline" HTML file is still an attachment; the query runs as the app role with literal binds', async () => {
    const id = await process28({ seq: 1, name: 'sec inline', type: 'download', when_button: 'CARD', config: '{"disposition": "inline"}',
      code: `select '<script>alert(1)</script>' as content, 'x.html' as filename, 'text/html' as mime_type` });
    const b = await browser('king');
    let res = await b.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'CARD' });
    assert.match(String(res.headers['content-disposition']), /^attachment; /);
    await owner.query(`update meta.process set code = $2 where id = $1`, [id, `select convert_to(password_hash, 'UTF8'), username, 'text/plain' from meta.app_user`]);
    res = await b.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'CARD' });
    assert.equal(res.statusCode, 422, 'the app role cannot read pgapex\'s tables');
    assert.doesNotMatch(res.body, /\$2[aby]\$|scrypt/);
    await owner.query(`update meta.process set code = $2 where id = $1`, [id, `select ename, ename || '.txt', 'text/plain' from hr.emp where empno::text = :P28_EMPNO`]);
    res = await b.submit('/a/hr/28', { P28_EMPNO: "7839' or '1'='1", __request: 'CARD' });
    assert.notEqual(res.headers['content-type'], 'text/plain', 'the value is a literal: no row');
  });

  test('background jobs: not readable by applications, queued only for a background chain of the app, with the session\'s roles', async () => {
    const hrApp = (await owner.one('select db_role from meta.app where id = $1', [appId])).db_role;
    const chain = (await owner.one(`select id from meta.process where page_id = $1 and name = 'Year-end check'`, [page28])).id;
    const onboard = (await owner.one(`select id from meta.process where page_id = $1 and name = 'Onboard'`, [page28])).id;
    const asApp = async <T>(user: string, fn: (q: (sql: string, p?: unknown[]) => Promise<any>) => Promise<T>) =>
      runtime.tx(async (c) => {
        await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', $2, true), set_config('pgapex.session_id', '', true)`, [String(appId), user]);
        await c.query(`set local role ${hrApp}`);
        return fn((sql, p) => c.query(sql, p));
      });
    await assert.rejects(asApp('king', (q) => q('select * from meta.process_job')), /permission denied/);
    await assert.rejects(asApp('king', (q) => q('select meta.enqueue_process_job($1, $2)', [onboard, '{}'])), /not a background chain/);
    const other = await owner.one(`insert into meta.app (alias, name) values ('logic-other-sec', 'Other') returning id`);
    undo.push(`delete from meta.app where id = ${Number(other.id)}`);
    await assert.rejects(
      runtime.tx(async (c) => {
        await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'king', true)`, [String(other.id)]);
        await c.query('select meta.enqueue_process_job($1, $2)', [chain, '{}']);
      }),
      /not a background chain of this application/,
    );
    // called by application SQL without a session: no roles at all
    const id = await asApp('king', async (q) => (await q('select meta.enqueue_process_job($1, $2)::text as id', [chain, '{"P28_EMPNO": "7839"}'])).rows[0].id);
    const job = await owner.one('select roles, app_user from meta.process_job where id = $1', [id]);
    assert.deepEqual(job.roles, []);
    // a forged job id does not lend its roles: only the running job of the same user
    await owner.query(`update meta.process_job set roles = '{admin}', state = 'completed' where id = $1`, [id]);
    const forged = await runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'scott', true), set_config('pgapex.process_job_id', $2, true)`, [String(appId), id]);
      return (await c.query(`select meta.has_role('admin') as ok`)).rows[0].ok;
    });
    assert.equal(forged, false);
    // the view shows each user their own jobs only
    const seen = await asApp('scott', async (q) => (await q('select id from meta.process_jobs')).rows.map((r: any) => r.id));
    assert.ok(!seen.map(String).includes(String(id)));
  });

  test('background chains: no passwords in the job; the job runs as the app role and shows no SQL details', async () => {
    const region = (await owner.one(`select id from meta.region where page_id = $1 and title = 'Employee'`, [page28])).id;
    const item = await owner.one(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 99, 'P28_PIN', 'PIN', 'password') returning id`, [page28, region]);
    undo.push(`delete from meta.item where id = ${Number(item.id)}`);
    await process28({ seq: 59, name: 'sec read pgapex', type: 'sql', parent_process: 'Year-end check', code: 'select count(*) from meta.session' });
    const b = await browser('king');
    assert.equal((await b.submit('/a/hr/28', { P28_EMPNO: '7839', P28_PIN: 'secret-pin', __request: 'RECALC' })).statusCode, 303);
    const job = await owner.one(`select id, binds from meta.process_job where app_id = $1 order by id desc limit 1`, [appId]);
    assert.equal(job.binds.P28_PIN, undefined);
    assert.doesNotMatch(JSON.stringify(job.binds), /secret-pin/);
    const { runProcessJobs } = await import('../src/process-jobs.ts');
    await runProcessJobs();
    const done = await owner.one('select state, error from meta.process_job where id = $1', [job.id]);
    assert.equal(done.state, 'failed');
    assert.doesNotMatch(done.error, /meta\.session/, 'details go to the activity log');
  });

  test('branches: a function result is a path inside the app; another app only if it exists, signed for it', async () => {
    for (const [path, ok] of [['10?x=1', true], ['account', true], ['//evil.example', false], ['https://evil.example', false], ['java\tscript:x', false],
      ['../builder', false], ['.', false], ['\\\\evil', false], ['10\r\nX: y', false], ['javascript:alert(1)', false], ['', false]] as const)
      assert.equal((await owner.one('select meta.branch_path_ok($1) as ok', [path])).ok, ok, path);
    await assert.rejects(owner.query(`insert into meta.branch (page_id, name, target_type, target_app, target_page) values ($1, 'x', 'app', 'Bad App', 1)`, [page28]), /check/);
    await assert.rejects(owner.query(`insert into meta.branch (page_id, name, target_type, target_app) values ($1, 'x', 'app', 'other')`, [page28]), /check/);
    await assert.rejects(owner.query(`insert into meta.branch (page_id, name, target_type) values ($1, 'x', 'function')`, [page28]), /check/);
    const br = await owner.one(`insert into meta.branch (page_id, seq, name, when_button, target_type, target_app, target_page) values ($1, 1, 'sec app', 'OPEN', 'app', 'no-such-app', 1) returning id`, [page28]);
    undo.push(`delete from meta.branch where id = ${Number(br.id)}`);
    const b = await browser('king');
    const res = await b.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'OPEN' });
    assert.doesNotMatch(String(res.headers.location), /no-such-app/);
    // a checksum is bound to its application
    assert.notEqual(urlChecksum(appId, 1, 'king', { P1_X: '1' }), urlChecksum(appId + 1, 1, 'king', { P1_X: '1' }));
  });

  test('dialog closed: a dynamic action the user may not run is neither sent nor accepted', async () => {
    const da = await owner.one(`insert into meta.dynamic_action (page_id, seq, name, event, action, message, authz) values ($1, 99, 'sec dlg', 'dialog_closed', 'execute_sql', null, 'NO_SUCH_SCHEME') returning id`, [page28]);
    undo.push(`delete from meta.dynamic_action where id = ${Number(da.id)}`);
    await owner.query(`update meta.dynamic_action set code = 'select 1' where id = $1`, [da.id]);
    const b = await browser('king');
    const body = (await b.get('/a/hr/28')).body;
    assert.doesNotMatch(body, new RegExp(`"id":${da.id},`));
    const res = await b.submit(`/a/hr/28/da/${da.id}`, { __dialog_closed: '1' });
    assert.equal(res.statusCode, 403);
    assert.equal((await b.post(`/a/hr/28/da/${da.id}`, { __dialog_closed: '1' })).statusCode, 403, 'no CSRF token');
  });
});

describe('sprint 31 builder: custom authentication, lists, locks, comments, supporting objects', () => {
  const alias = 'sec31-builder';
  const ROLE = 'pgapex_s31_builder';
  const SCHEMA = 's31_builder';
  const DEV_A = 'dev_s31a';
  const DEV_B = 'dev_s31b';
  const DEV_PW = 'Dev-s31-password!';
  const CHECK = `return exists (select 1 from ${SCHEMA}.users where name = p_username and pw_hash = crypt(p_password, pw_hash));`;
  let sApp: number;
  let sPage: number;

  before(async () => {
    await owner.query(`drop schema if exists ${SCHEMA} cascade`);
    await owner.query(`drop role if exists ${ROLE}`);
    await owner.query(`create role ${ROLE} nologin`);
    await owner.query(`grant ${ROLE} to pgapex_runtime`);
    await owner.query(`create schema ${SCHEMA}`);
    await owner.query(`grant usage on schema ${SCHEMA} to ${ROLE}`);
    await owner.query(`create table ${SCHEMA}.users (name text primary key, pw_hash text not null)`);
    await owner.query(`insert into ${SCHEMA}.users values ('erin', crypt('Erin-pw-31!', gen_salt('bf', 4)))`);
    await owner.query(`grant select on ${SCHEMA}.users to ${ROLE}`);
    await owner.query(`delete from meta.developer where username in ($1, $2)`, [DEV_A, DEV_B]);
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($3), false), ($2, meta.hash_password($3), false)`, [DEV_A, DEV_B, DEV_PW]);
    sApp = (await owner.one(`insert into meta.app (alias, name, authentication, db_role, custom_auth_code) values ($1, 'S31 builder', 'custom', $2, $3) returning id`, [alias, ROLE, CHECK])).id;
    sPage = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Home') returning id`, [sApp])).id;
    await owner.query(`insert into meta.page (app_id, page_no, name) values ($1, 2, 'Second')`, [sApp]);
    await owner.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Who', 'static', '<p>Signed in as &APP_USER.</p>')`, [sPage]);
  });

  after(async () => {
    await owner.query('delete from meta.app where id = $1', [sApp]);
    await owner.query(`delete from meta.app where alias = 'sec31-builder-copy'`);
    await owner.query(`delete from meta.developer where username in ($1, $2)`, [DEV_A, DEV_B]);
    await owner.query(`drop schema if exists ${SCHEMA} cascade`);
    await owner.query(`drop owned by ${ROLE}`);
    await owner.query(`drop role if exists ${ROLE}`);
  });

  const attempt = async (username: string, password: string) => {
    const b = new Browser();
    await b.get(`/a/${alias}/login`);
    return { b, res: await b.post(`/a/${alias}/login`, { __csrf: b.lastCsrf, username, password }) };
  };
  const dev = async (user = 'admin', password = 'admin') => {
    const b = new Browser();
    await b.get('/builder/login');
    assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username: user, password })).statusCode, 303, `builder sign-in as ${user}`);
    await b.get('/builder');
    return b;
  };
  const setCode = (code: string | null, fn: string | null = null) => owner.query('update meta.app set custom_auth_code = $2, custom_auth_function = $3 where id = $1', [sApp, code, fn]);

  describe('custom authentication', () => {
    test('injection attempts, NUL bytes and empty passwords are refused; nobody signs in without a check', async () => {
      for (const [u, p] of [["erin' or '1'='1", "' or '1'='1"], ['erin', "x' or true --"], ['erin', ''], ['erin\u0000', 'Erin-pw-31!'], ['', 'Erin-pw-31!'], ['erin', 'Erin-pw-31!\u0000']] as const) {
        const { b, res } = await attempt(u, p);
        assert.ok([400, 401].includes(res.statusCode), `${JSON.stringify(u)}: ${res.statusCode}`);
        assert.equal((await b.get(`/a/${alias}/1`)).statusCode, 302);
      }
      await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
      await setCode(null);
      try {
        assert.equal((await attempt('erin', 'Erin-pw-31!')).res.statusCode, 401);
      } finally {
        await setCode(CHECK);
        await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
      }
    });

    test('a check that errors, returns null or echoes the password refuses, and the password is never logged', async () => {
      for (const code of [`raise exception 'pw %', p_password;`, 'return null;', `return p_password::int > 0;`, 'select 1/0;']) {
        await setCode(code);
        const { b, res } = await attempt('erin', 'Erin-pw-31!');
        assert.equal(res.statusCode, 401, code);
        assert.doesNotMatch(res.body, /Erin-pw-31!/);
        assert.equal((await b.get(`/a/${alias}/1`)).statusCode, 302);
      }
      await setCode(CHECK);
      const log = JSON.stringify((await owner.query('select * from meta.activity_log where app_id = $1', [sApp])).rows);
      assert.ok(log.includes('check failed'), 'failures are logged');
      assert.ok(!log.includes('Erin-pw-31!'), 'no password in the log');
      await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
    });

    test('the check runs as the app\'s role: pgapex\'s own tables are out of reach, and its temporary function is gone afterwards', async () => {
      await setCode(`return exists (select 1 from meta.developer);`);
      try {
        assert.equal((await attempt('erin', 'Erin-pw-31!')).res.statusCode, 401);
        await setCode(`return current_user = '${ROLE}' and session_user <> current_user;`);
        assert.equal((await attempt('erin', 'Erin-pw-31!')).res.statusCode, 303);
        // a body can't escape its function with a guessed dollar-quote tag
        await setCode(`return true; $pgapex$; create table ${SCHEMA}.pwned(x int); $pgapex$`);
        assert.equal((await attempt('erin', 'Erin-pw-31!')).res.statusCode, 401);
        assert.equal((await owner.one(`select to_regclass('${SCHEMA}.pwned') as t`)).t, null);
        assert.equal((await owner.one(`select count(*)::int as n from pg_proc where proname like 'pgapex_auth_%'`)).n, 0);
      } finally {
        await setCode(CHECK);
        await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
      }
    });

    test('a function name must be a plain name; the database refuses anything else', async () => {
      for (const bad of ['x; drop table y', 'App.Check', 'a.b.c', 'f()', '"x"'])
        await assert.rejects(owner.query('update meta.app set custom_auth_function = $2 where id = $1', [sApp, bad]), /check/, bad);
      // a function that doesn't exist (or isn't granted) refuses the sign-in
      await setCode(CHECK, `${SCHEMA}.no_such_function`);
      try {
        assert.equal((await attempt('erin', 'Erin-pw-31!')).res.statusCode, 401);
      } finally {
        await setCode(CHECK);
        await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
      }
    });

    test('no other way in: no CSRF token, the password-change form, SSO, an app_users password; the session stays in its app; throttling', async () => {
      const b = new Browser();
      await b.get(`/a/${alias}/login`);
      assert.equal((await b.post(`/a/${alias}/login`, { username: 'erin', password: 'Erin-pw-31!' })).statusCode, 403);
      assert.equal((await b.post(`/a/${alias}/password`, { __csrf: b.lastCsrf, username: 'erin', password: 'Erin-pw-31!', new_password: 'Xx-new-pw-31!', confirm_password: 'Xx-new-pw-31!' })).statusCode, 403);
      assert.ok((await b.get(`/a/${alias}/sso/any`)).statusCode >= 300);
      assert.equal((await b.get(`/a/${alias}/1`)).statusCode, 302);
      assert.equal((await b.post(`/a/${alias}/login`, { __csrf: b.lastCsrf, username: 'king', password: 'king' })).statusCode, 401);
      const ok = await attempt('erin', 'Erin-pw-31!');
      assert.equal(ok.res.statusCode, 303);
      assert.match((await ok.b.get(`/a/${alias}/1`)).body, /Signed in as erin/);
      assert.equal((await ok.b.get('/a/hr/1')).statusCode, 302);
      await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
      for (let i = 0; i < 5; i++) assert.equal((await attempt('erin', `wrong-${i}`)).res.statusCode, 401);
      assert.equal((await attempt('erin', 'Erin-pw-31!')).res.statusCode, 429);
      await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
    });
  });

  describe('lists', () => {
    before(async () => {
      await owner.query('update meta.app set authentication = $2 where id = $1', [sApp, 'none']);
      await owner.query(`update meta.page set requires_auth = false where app_id = $1`, [sApp]);
    });
    after(() => owner.query('update meta.app set authentication = $2 where id = $1', [sApp, 'custom']));

    test('unsafe entry URLs are refused by the database; labels, badges and descriptions are escaped', async () => {
      await owner.query(`insert into meta.list (app_id, name) values ($1, 'SEC')`, [sApp]);
      for (const url of ['javascript:alert(1)', '//evil.example', '../builder', 'data:text/html,x', 'JaVaScRiPt:x', 'https://a" onclick="x', '\\\\evil', ' javascript:x', '.hidden'])
        await assert.rejects(owner.query(`insert into meta.list_entry (app_id, list_name, label, target_url) values ($1, 'SEC', 'x', $2)`, [sApp, url]), /check/, url);
      await owner.query(
        `insert into meta.list_entry (app_id, list_name, seq, label, badge, description, target_page) values ($1, 'SEC', 10, '<img src=x onerror=alert(1)>', '<b>7</b>', '<script>x()</script>', 2)`,
        [sApp],
      );
      const region = (await owner.one(`insert into meta.region (page_id, title, type, config) values ($1, 'Sec list', 'list', '{"list": "SEC", "template": "cards"}') returning id`, [sPage])).id;
      try {
        const body = (await new Browser().get(`/a/${alias}/1`)).body;
        assert.doesNotMatch(body, /<img src=x/);
        assert.doesNotMatch(body, /<b>7<\/b>/);
        assert.doesNotMatch(body, /<script>x\(\)/);
        assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
      } finally {
        await owner.query('delete from meta.region where id = $1', [region]);
      }
    });

    test('a SQL list runs as the app\'s role; unsafe URLs and bad item names from rows are dropped; item values are signed', async () => {
      await owner.query(`insert into meta.list (app_id, name, type, query) values ($1, 'SECQ', 'sql', $2)`, [
        sApp,
        `select * from (values (current_user::text, 2, '{"P2_X": "1", "bad name\\"": "2"}', null::text), ('js', null, null, 'javascript:alert(1)'), ('proto', null, null, '//evil.example')) v(label, page, items, url)`,
      ]);
      const region = (await owner.one(`insert into meta.region (page_id, title, type, config) values ($1, 'Sql list', 'list', '{"list": "SECQ"}') returning id`, [sPage])).id;
      try {
        const body = (await new Browser().get(`/a/${alias}/1`)).body;
        assert.match(body, new RegExp(`<span>${ROLE}</span>`));
        assert.match(body, /href="\/a\/sec31-builder\/2\?P2_X=1&amp;cs=[0-9a-f]+"/);
        assert.doesNotMatch(body, /bad\+name|bad%20name/);
        assert.doesNotMatch(body, /javascript:|evil\.example/);
        // a query the app's role can't run shows an error, not pgapex's data
        await owner.query(`update meta.list set query = 'select username as label from meta.developer' where app_id = $1 and name = 'SECQ'`, [sApp]);
        const denied = (await new Browser().get(`/a/${alias}/1`)).body;
        assert.doesNotMatch(denied, /<span>admin<\/span>/);
      } finally {
        await owner.query('delete from meta.region where id = $1', [region]);
      }
    });

    test('the builder refuses a bad list name in the region settings and in the app settings', async () => {
      const b = await dev();
      const region = (await owner.one(`insert into meta.region (page_id, title, type, config) values ($1, 'Rs', 'list', '{}') returning id`, [sPage])).id;
      try {
        await b.get(`/builder/pages/${sPage}?c=region-${region}`);
        await b.post(`/builder/pages/${sPage}/region/${region}/settings`, { __csrf: b.lastCsrf, list: '"><script>', template: '"><b>' });
        assert.deepEqual((await owner.one('select config from meta.region where id = $1', [region])).config, {});
        await assert.rejects(owner.query(`update meta.app set nav_list = 'x"><y' where id = $1`, [sApp]), /check/);
      } finally {
        await owner.query('delete from meta.region where id = $1', [region]);
      }
    });
  });

  describe('locks and comments', () => {
    test('another developer\'s page or application lock refuses changes (also as JSON), not just in the UI', async () => {
      const a = await dev(DEV_A, DEV_PW);
      const bb = await dev(DEV_B, DEV_PW);
      await a.get(`/builder/apps/${sApp}`);
      assert.equal((await a.post(`/builder/apps/${sApp}/lock`, { __csrf: a.lastCsrf, page_no: '1', note: '<b>mine</b>' })).statusCode, 303);
      try {
        await bb.get(`/builder/pages/${sPage}`);
        const before = (await owner.one('select count(*)::int as n from meta.region where page_id = $1', [sPage])).n;
        const res = await bb.post(`/builder/pages/${sPage}/c/region`, { __csrf: bb.lastCsrf, title: 'Sneaky', type: 'static', columns: '12', template: 'standard', config: '' });
        assert.ok([302, 303].includes(res.statusCode));
        const json = await app.inject({
          method: 'POST', url: `/builder/pages/${sPage}/delete`,
          payload: new URLSearchParams({ __csrf: bb.lastCsrf }).toString(),
          headers: { cookie: [...bb.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        });
        assert.equal(json.statusCode, 423);
        assert.equal((await owner.one('select count(*)::int as n from meta.region where page_id = $1', [sPage])).n, before);
        assert.ok(await owner.one('select 1 as ok from meta.page where id = $1', [sPage]), 'page not deleted');
        // the note is escaped where it is shown
        const page = (await bb.get(`/builder/pages/${sPage}`)).body;
        assert.doesNotMatch(page, /<b>mine<\/b>/);
        assert.match(page, /&lt;b&gt;mine&lt;\/b&gt;/);
        // a developer who is not an administrator can't break it
        assert.equal((await bb.post(`/builder/apps/${sApp}/unlock`, { __csrf: bb.lastCsrf, page_no: '1' })).statusCode, 403);
        assert.ok(await owner.one('select 1 as ok from meta.builder_lock where app_id = $1 and page_no = 1', [sApp]));
        // a page number that isn't a page of this app can't be locked; nor without a CSRF token
        assert.equal((await bb.post(`/builder/apps/${sApp}/lock`, { __csrf: bb.lastCsrf, page_no: '999' })).statusCode, 404);
        assert.equal((await bb.post(`/builder/apps/${sApp}/lock`, { __csrf: bb.lastCsrf, page_no: '1; drop' })).statusCode, 404);
        assert.equal((await bb.post(`/builder/apps/${sApp}/lock`, { page_no: '2' })).statusCode, 403);
        // the application lock: settings, shared components and deleting the app are refused
        await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 0, $2)`, [sApp, DEV_A]);
        await bb.get(`/builder/apps/${sApp}/settings`);
        await bb.post(`/builder/apps/${sApp}/settings`, { __csrf: bb.lastCsrf, name: 'Renamed', alias, home_page: '1', authentication: 'none', language: 'en' });
        await bb.post(`/builder/apps/${sApp}/shared/lov`, { __csrf: bb.lastCsrf, name: 'SNEAKY', query: 'select 1, 1' });
        await bb.post(`/builder/apps/${sApp}/delete`, { __csrf: bb.lastCsrf });
        const appRow = await owner.one('select name from meta.app where id = $1', [sApp]);
        assert.equal(appRow?.name, 'S31 builder');
        assert.equal(await owner.one(`select 1 from meta.lov where app_id = $1 and name = 'SNEAKY'`, [sApp]), undefined);
        // the administrator breaks it, and that is logged
        const admin = await dev();
        await admin.get(`/builder/apps/${sApp}`);
        assert.equal((await admin.post(`/builder/apps/${sApp}/unlock`, { __csrf: admin.lastCsrf, page_no: '0' })).statusCode, 303);
        assert.ok(await owner.one(`select 1 as ok from meta.activity_log where app_id = $1 and event = 'lock_broken'`, [sApp]));
      } finally {
        await owner.query('delete from meta.builder_lock where app_id = $1', [sApp]);
        await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
      }
    });

    test('comments: escaped, length-limited, only the author or an administrator deletes; ids of another app are refused', async () => {
      const a = await dev(DEV_A, DEV_PW);
      const bb = await dev(DEV_B, DEV_PW);
      await a.get(`/builder/apps/${sApp}`);
      await a.post(`/builder/apps/${sApp}/comments`, { __csrf: a.lastCsrf, page_no: '1', body: '<script>alert(1)</script>' });
      await a.post(`/builder/apps/${sApp}/comments`, { __csrf: a.lastCsrf, page_no: '1', body: 'x'.repeat(4001) });
      await a.post(`/builder/apps/${sApp}/comments`, { __csrf: a.lastCsrf, page_no: '1', body: '   ' });
      const rows = (await owner.query('select id, body from meta.dev_comment where app_id = $1', [sApp])).rows;
      assert.equal(rows.length, 1);
      const page = (await bb.get(`/builder/pages/${sPage}`)).body;
      assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
      assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.equal((await bb.post(`/builder/apps/${sApp}/comments/${rows[0].id}/delete`, { __csrf: bb.lastCsrf })).statusCode, 403);
      const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
      assert.equal((await a.post(`/builder/apps/${hr}/comments/${rows[0].id}/delete`, { __csrf: a.lastCsrf })).statusCode, 404);
      assert.equal((await a.post(`/builder/apps/${sApp}/comments/${rows[0].id}/delete`, { __csrf: a.lastCsrf })).statusCode, 303);
      assert.equal((await owner.one('select count(*)::int as n from meta.dev_comment where app_id = $1', [sApp])).n, 0);
    });

    test('only administrators add, remove or promote developers; nobody demotes themselves', async () => {
      const a = await dev(DEV_A, DEV_PW);
      await a.get('/builder/developers');
      assert.equal((await a.post('/builder/developers', { __csrf: a.lastCsrf, username: 'dev_s31_evil', password: 'Evil-s31-password!', is_admin: 'true' })).statusCode, 403);
      assert.equal((await a.post('/builder/developers/admin', { __csrf: a.lastCsrf, username: DEV_A, is_admin: 'true' })).statusCode, 403);
      assert.equal((await a.post('/builder/developers/delete', { __csrf: a.lastCsrf, username: DEV_B })).statusCode, 403);
      assert.equal(await owner.one(`select 1 from meta.developer where username = 'dev_s31_evil'`), undefined);
      assert.equal((await owner.one('select is_admin from meta.developer where username = $1', [DEV_A])).is_admin, false);
      const admin = await dev();
      await admin.get('/builder/developers');
      await admin.post('/builder/developers/admin', { __csrf: admin.lastCsrf, username: 'admin', is_admin: 'false' });
      assert.equal((await owner.one(`select is_admin from meta.developer where username = 'admin'`)).is_admin, true);
    });

    test('locks and comments are not exported', async () => {
      await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 1, $2)`, [sApp, DEV_A]);
      await owner.query(`insert into meta.dev_comment (app_id, page_no, author, body) values ($1, 1, $2, 'secret note s31')`, [sApp, DEV_A]);
      try {
        const doc = JSON.stringify((await owner.one('select meta.export_app($1) as d', [alias])).d);
        assert.doesNotMatch(doc, /secret note s31|builder_lock|dev_comment/);
      } finally {
        await owner.query('delete from meta.builder_lock where app_id = $1', [sApp]);
        await owner.query('delete from meta.dev_comment where app_id = $1', [sApp]);
      }
    });
  });

  describe('supporting objects', () => {
    test('import never runs them; running needs a developer and a CSRF token; they run as the app\'s role and an error undoes everything', async () => {
      await owner.query(
        `insert into meta.supporting_script (app_id, name, kind, seq, script) values
          ($1, 'make', 'install', 10, 'create table ${SCHEMA}.s31_made (x int); insert into ${SCHEMA}.s31_made values (1);'),
          ($1, 'escalate', 'upgrade', 10, 'create table ${SCHEMA}.s31_up (x int); select username from meta.developer;')`,
        [sApp],
      );
      await owner.query(`grant create on schema ${SCHEMA} to ${ROLE}`);
      try {
        const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
        const copy = (await owner.one(`select meta.import_app($1::jsonb, 'sec31-builder-copy') as id`, [JSON.stringify(doc)])).id;
        assert.equal((await owner.one('select count(*)::int as n from meta.supporting_script where app_id = $1', [copy])).n, 2);
        assert.equal((await owner.one(`select to_regclass('${SCHEMA}.s31_made') as t`)).t, null, 'not run on import');
        // without a builder session, or without a CSRF token
        const anon = new Browser();
        assert.ok([302, 303, 401, 403].includes((await anon.post(`/builder/apps/${sApp}/supporting-objects/run`, { kind: 'install' })).statusCode));
        const b = await dev();
        await b.get(`/builder/apps/${sApp}/supporting-objects`);
        assert.equal((await b.post(`/builder/apps/${sApp}/supporting-objects/run`, { kind: 'install' })).statusCode, 403);
        assert.equal((await b.post(`/builder/apps/${sApp}/supporting-objects/run`, { __csrf: b.lastCsrf, kind: 'drop everything' })).statusCode, 400);
        assert.equal(await owner.one(`select to_regclass('${SCHEMA}.s31_made') as t`).then((r) => r.t), null);
        // the upgrade reads pgapex's own table: refused for the app's role, and the table it made is gone too
        const up = await b.post(`/builder/apps/${sApp}/supporting-objects/run`, { __csrf: b.lastCsrf, kind: 'upgrade' });
        assert.equal(up.statusCode, 200);
        assert.match(up.body, /rolled back/);
        assert.equal((await owner.one(`select to_regclass('${SCHEMA}.s31_up') as t`)).t, null);
        assert.ok(await owner.one(`select 1 as ok from meta.activity_log where app_id = $1 and event = 'supporting_objects'`, [sApp]));
        // the install runs as the app's role: the table belongs to it
        await b.post(`/builder/apps/${sApp}/supporting-objects/run`, { __csrf: b.lastCsrf, kind: 'install' });
        assert.equal((await owner.one(`select tableowner from pg_tables where schemaname = '${SCHEMA}' and tablename = 's31_made'`)).tableowner, ROLE);
        await owner.query(`delete from meta.app where id = $1`, [copy]);
      } finally {
        await owner.query(`drop table if exists ${SCHEMA}.s31_made, ${SCHEMA}.s31_up`);
        await owner.query('delete from meta.supporting_script where app_id = $1', [sApp]);
        await owner.query(`delete from meta.activity_log where app_id = $1`, [sApp]);
      }
    });
  });
});

describe('sprint 32 automations: actions, error handling per row, meta.run_automation', () => {
  const OTHER = 'sec32-automations';
  let other: number;
  let hrAuto: number;

  before(async () => {
    await owner.query(`delete from meta.app where alias = $1`, [OTHER]);
    other = (await owner.one(`insert into meta.app (alias, name) values ($1, 'S32 automations') returning id`, [OTHER])).id;
    await owner.query(`insert into meta.automation (app_id, name, enabled, code) values ($1, 'sec32 other', false, 'select 1')`, [other]);
    hrAuto = (await owner.one(`insert into meta.automation (app_id, name, enabled, code, roles) values ($1, 'sec32 hr', false, 'select 1', '{admin}') returning id`, [appId])).id;
  });

  after(async () => {
    await owner.query('delete from meta.app where id = $1', [other]);
    await owner.query(`delete from meta.automation where app_id = $1 and name like 'sec32%'`, [appId]);
  });

  const dev = async () => {
    const b = new Browser();
    await b.get('/builder/login');
    await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
    await b.get('/builder');
    return b;
  };
  /** In a transaction as the HR application's role (as application code runs). */
  const asHr = <T>(fn: (c: import('pg').PoolClient) => Promise<T>) =>
    runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'allen', true)`, [String(appId)]);
      await c.query('set local role hr_app');
      return fn(c);
    });

  test('applications cannot read or change actions, definitions or logs directly', async () => {
    for (const sql of [
      'select * from meta.automation_action',
      `insert into meta.automation_action (app_id, automation_name, name, code) values (${appId}, 'sec32 hr', 'x', 'select 1')`,
      `update meta.automation_action set code = 'drop table hr.emp'`,
      `select meta.automation_definition(${hrAuto})`,
    ])
      await assert.rejects(asHr((c) => c.query(sql)), /permission denied/, sql);
  });

  test('meta.run_automation runs only automations of the current application, as the caller\'s role', async () => {
    await assert.rejects(asHr((c) => c.query(`select meta.run_automation('sec32 other')`)), /does not exist in this application/);
    // the definition helper is limited to the current application too
    await assert.rejects(asHr((c) => c.query(`select meta.automation_begin('sec32 other')`)), /does not exist in this application/);
    // the code runs with the caller's grants: pgapex's own tables stay closed
    await owner.query(`update meta.automation_action set code = 'select password_hash from meta.account' where app_id = $1 and automation_name = 'sec32 hr'`, [appId]);
    await assert.rejects(asHr((c) => c.query(`select meta.run_automation('sec32 hr')`)), /permission denied/);
    // binds are literals: a row value can't inject SQL
    await owner.query(`create table if not exists public.sec32_auto (v text)`);
    await owner.query(`grant insert, select on public.sec32_auto to hr_app`);
    try {
      await owner.query(`update meta.automation set query = $2 where id = $1`, [hrAuto, `select $x$'); drop table public.sec32_auto; --$x$ as v`]);
      await owner.query(`update meta.automation_action set code = 'insert into public.sec32_auto values (:V)' where app_id = $1 and automation_name = 'sec32 hr'`, [appId]);
      const r = (await asHr((c) => c.query(`select meta.run_automation('sec32 hr') as r`))).rows[0].r;
      assert.equal(r.status, 'ok');
      assert.equal((await owner.one(`select v from public.sec32_auto`)).v, `'); drop table public.sec32_auto; --`);
    } finally {
      await owner.query(`drop table if exists public.sec32_auto`);
      await owner.query(`update meta.automation set query = null where id = $1`, [hrAuto]);
    }
    // finishing a run of another application is refused
    const log = (await owner.one(`insert into meta.automation_log (automation_id, trigger) values ((select id from meta.automation where app_id = $1), 'sql') returning id`, [other])).id;
    await assert.rejects(asHr((c) => c.query(`select meta.automation_end($1, 'ok', '{}', null)`, [log])), /is not running/);
    assert.equal((await owner.one('select status from meta.automation_log where id = $1', [log])).status, 'running');
  });

  test('builder: actions need a developer and a CSRF token, and belong to an automation of the same application', async () => {
    const anon = new Browser();
    assert.equal((await anon.post(`/builder/apps/${appId}/shared/automation_action`, { automation_name: 'sec32 hr', name: 'x', code: 'select 1' })).statusCode, 302);
    const b = await dev();
    await b.get(`/builder/apps/${appId}/shared?c=automation-${hrAuto}`);
    assert.equal((await b.post(`/builder/apps/${appId}/shared/automation_action`, { automation_name: 'sec32 hr', name: 'x', code: 'select 1' })).statusCode, 403);
    // an automation of another application, posted under this one: refused by the foreign key
    await b.post(`/builder/apps/${appId}/shared/automation_action`, { __csrf: b.lastCsrf, automation_name: 'sec32 other', name: 'sneaky', seq: '10', code: 'select 1' });
    assert.equal((await owner.one(`select count(*)::int as n from meta.automation_action where name = 'sneaky'`)).n, 0);
    // moving: CSRF, and only actions of this application
    const act = (await owner.one(`select id from meta.automation_action where app_id = $1 and automation_name = 'sec32 other'`, [other])).id;
    await b.get(`/builder/apps/${appId}/shared?c=automation-${hrAuto}`);
    assert.equal((await b.post(`/builder/apps/${appId}/shared/automation_action/${act}/move`, { __csrf: b.lastCsrf, dir: 'up' })).statusCode, 404);
    assert.equal((await b.post(`/builder/apps/${other}/shared/automation_action/${act}/move`, { dir: 'up' })).statusCode, 403);
    // the run history escapes row errors
    await owner.query(
      `insert into meta.automation_log (automation_id, trigger, status, finished_at, rows, rows_failed, errors, message)
       values ($1, 'manual', 'warning', now(), 2, 1, $2, '1 of 2 row(s) failed')`,
      [hrAuto, JSON.stringify([{ row: 1, action: '<b>x</b>', message: '<script>alert(1)</script>', values: '{"v": "<img src=x onerror=alert(1)>"}' }])],
    );
    const page = (await b.get(`/builder/apps/${appId}/shared?c=automation-${hrAuto}`)).body;
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(page, /<script>alert|<img src=x/);
  });
});

describe('sprint 32 item 2: workflow invoke_api steps', () => {
  const env = { ...process.env };
  const OTHER = 'sec32-invoke';
  let other: number;
  let mock: import('node:http').Server;
  let mockBase = '';
  const hits: { host: string; url: string; auth: string | null }[] = [];
  let runWorkflow: (id: string) => Promise<number>;

  before(async () => {
    process.env.PGAPEX_SECRET_KEY = 'security-test-secret-key-0123456789abcdef';
    process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1';
    process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';
    ({ runWorkflow } = await import('../src/workflow.ts'));
    const http = await import('node:http');
    mock = http.createServer((req, res) => {
      hits.push({ host: req.headers.host ?? '', url: req.url!, auth: req.headers.authorization ?? null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [{ detail_pk: 'forged', workflow_id: '1', initiator: 'king', v: "x'); drop table hr.emp; --" }] }));
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    mockBase = `http://127.0.0.1:${(mock.address() as import('node:net').AddressInfo).port}`;
    await owner.query(`delete from meta.app where alias = $1`, [OTHER]);
    other = (await owner.one(`insert into meta.app (alias, name) values ($1, 'S32 invoke') returning id`, [OTHER])).id;
    await owner.query(`insert into meta.rest_source (app_id, name, url) values ($1, 'SEC32_FOREIGN', $2)`, [other, `${mockBase}/foreign`]);
    const { encryptSecret } = await import('../src/secrets.ts');
    await owner.query(`insert into meta.web_credential (app_id, name, type, secret_enc, valid_for) values ($1, 'SEC32_CRED', 'bearer', $2, $3)`,
      [appId, encryptSecret('sec32-secret'), ['https://api.example.com/']]);
    await owner.query(`insert into meta.rest_source (app_id, name, url, row_selector, columns) values ($1, 'SEC32_ROWS', $2, 'items', $3)`,
      [appId, `${mockBase}/rows`, JSON.stringify([{ name: 'detail_pk', type: 'text' }, { name: 'workflow_id', type: 'text' }, { name: 'initiator', type: 'text' }, { name: 'v', type: 'text' }])]);
  });

  after(async () => {
    await owner.query(`delete from meta.workflow where app_id = $1 and name like 'SEC32\\_%'`, [appId]);
    await owner.query(`delete from meta.workflow_definition where app_id = $1 and name like 'SEC32\\_%'`, [appId]);
    await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'SEC32\\_%'`, [appId]);
    await owner.query(`delete from meta.web_credential where app_id = $1 and name like 'SEC32\\_%'`, [appId]);
    await owner.query('delete from meta.app where id = $1', [other]);
    mock.close();
    for (const k of ['PGAPEX_SECRET_KEY', 'PGAPEX_REST_ALLOWED_HOSTS', 'PGAPEX_REST_PRIVATE_HOSTS'])
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  });

  /** Define (straight into the table, as SQL or an import could) and run a one-step workflow. */
  const run = async (name: string, steps: unknown, vars: Record<string, unknown> = {}, detail: string | null = null) => {
    await owner.query(`insert into meta.workflow_definition (app_id, name, title, steps) values ($1, $2, 'x', $3)`, [appId, name, JSON.stringify(steps)]);
    const id = await owner.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'allen', true)`, [String(appId)]);
      return (await c.query('select meta.start_workflow($1, $2, $3) as id', [name, detail, vars])).rows[0].id as string;
    });
    await runWorkflow(id);
    return owner.one('select state, error, vars from meta.workflow where id = $1', [id]);
  };

  test('variable values are URL-encoded after a fixed host; a host from a variable is refused, even in a definition written by SQL', async () => {
    let n = hits.length;
    const w = await run('SEC32_PATH', [{ name: 'CALL', type: 'invoke_api', url: `${mockBase}/x/&V.?q=&V.` }], { v: '@evil.example/../a?b=1#c' });
    assert.equal(w.state, 'completed', w.error);
    assert.deepEqual(hits.slice(n).map((h) => [h.host, h.url]), [[new URL(mockBase).host, '/x/%40evil.example%2F..%2Fa%3Fb%3D1%23c?q=%40evil.example%2F..%2Fa%3Fb%3D1%23c']]);
    n = hits.length;
    for (const [i, url] of ['http://&HOST./x', `${mockBase}&P./x`, 'http://{h}.example.com/'].entries()) {
      const bad = await run(`SEC32_HOST_${i}`, [{ name: 'CALL', type: 'invoke_api', url }], { host: '127.0.0.1' });
      assert.equal(bad.state, 'faulted', url);
      assert.match(bad.error, /fixed host/, url);
    }
    const dot = await run('SEC32_DOT', [{ name: 'CALL', type: 'invoke_api', url: `${mockBase}/x/&V./y` }], { v: '..' });
    assert.match(dot.error, /not a valid value in a URL/);
    assert.equal(hits.length, n, 'no request');
  });

  test('the outgoing allow-list and address checks apply; private addresses need PGAPEX_REST_PRIVATE_HOSTS', async () => {
    const n = hits.length;
    for (const [i, url] of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'https://example.com/', 'file:///etc/passwd'].entries()) {
      const w = await run(`SEC32_SSRF_${i}`, [{ name: 'CALL', type: 'invoke_api', url }]);
      assert.equal(w.state, 'faulted', url);
      assert.match(w.error, /allow-list|private|http/, url);
    }
    process.env.PGAPEX_REST_PRIVATE_HOSTS = '';
    try {
      const w = await run('SEC32_LOOPBACK', [{ name: 'CALL', type: 'invoke_api', url: `${mockBase}/x` }]);
      assert.equal(w.state, 'faulted');
      assert.match(w.error, /private, loopback/);
    } finally {
      process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';
    }
    assert.equal(hits.length, n, 'no request');
  });

  test('REST data sources and credentials of another application are not found; "valid for" keeps a secret to its URLs', async () => {
    const n = hits.length;
    const w = await run('SEC32_FOREIGN', [{ name: 'CALL', type: 'invoke_api', source: 'SEC32_FOREIGN' }]);
    assert.equal(w.state, 'faulted');
    assert.match(w.error, /REST data source SEC32_FOREIGN does not exist/);
    const c = await run('SEC32_VALIDFOR', [{ name: 'CALL', type: 'invoke_api', url: `${mockBase}/x`, credential: 'SEC32_CRED' }]);
    assert.equal(c.state, 'faulted');
    assert.match(c.error, /not valid for this URL/);
    assert.doesNotMatch(JSON.stringify(c), /sec32-secret/);
    assert.equal(hits.length, n, 'no request');
  });

  test('response values are data: they never replace DETAIL_PK, WORKFLOW_ID or INITIATOR, and bind as literals in later SQL', async () => {
    const w = await run('SEC32_ROWS', [
      { name: 'CALL', type: 'invoke_api', source: 'SEC32_ROWS' },
      { name: 'USE', type: 'sql', code: 'select :V as v_back, :DETAIL_PK as pk_back, :INITIATOR as who_back' },
    ], {}, '7369');
    assert.equal(w.state, 'completed', w.error);
    assert.equal(w.vars.DETAIL_PK, undefined);
    assert.equal(w.vars.INITIATOR, undefined);
    assert.equal(w.vars.V_BACK, "x'); drop table hr.emp; --");
    assert.equal(w.vars.PK_BACK, '7369');
    assert.equal(w.vars.WHO_BACK, 'allen');
    assert.ok((await owner.one(`select count(*)::int as n from hr.emp`)).n > 0);
  });

  test('builder: saving steps checks them, needs a developer and a CSRF token', async () => {
    const anon = new Browser();
    const form = { name: 'SEC32_BUILDER', title: 'x', steps: JSON.stringify([{ name: 'CALL', type: 'invoke_api', url: 'http://&HOST./x' }]) };
    assert.equal((await anon.post(`/builder/apps/${appId}/shared/workflow_definition`, form)).statusCode, 302);
    const b = new Browser();
    await b.get('/builder/login');
    await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
    await b.get(`/builder/apps/${appId}/shared`);
    assert.equal((await b.post(`/builder/apps/${appId}/shared/workflow_definition`, form)).statusCode, 403);
    await b.get(`/builder/apps/${appId}/shared`);
    const res = await b.post(`/builder/apps/${appId}/shared/workflow_definition`, { __csrf: b.lastCsrf, ...form });
    assert.notEqual(res.statusCode, 500);
    assert.equal((await owner.one(`select count(*)::int as n from meta.workflow_definition where name = 'SEC32_BUILDER'`)).n, 0);
    // the same form with a valid step is saved
    await b.get(`/builder/apps/${appId}/shared`);
    await b.post(`/builder/apps/${appId}/shared/workflow_definition`, { __csrf: b.lastCsrf, ...form, steps: JSON.stringify([{ name: 'CALL', type: 'invoke_api', url: 'http://api.example.com/&HOST.' }]) });
    assert.equal((await owner.one(`select count(*)::int as n from meta.workflow_definition where name = 'SEC32_BUILDER'`)).n, 1);
  });
});

describe('sprint 32 item 3: SQL Workshop unload data', () => {
  const builder = async () => {
    const b = new Browser();
    await b.get('/builder/login');
    await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
    await b.get('/builder/sql/unload?source=query');
    return b;
  };
  before(async () => {
    await owner.query(`drop table if exists public.sec32_unload; create table public.sec32_unload (id int, note text);
      insert into public.sec32_unload values (1, '=1+2'), (2, '@SUM(A1)'), (3, '<x>&</x>'), (4, '-cmd');
      create or replace function public.sec32_unload_write() returns int language sql as $$ insert into public.sec32_unload values (99, 'written') returning id $$;`);
  });
  after(async () => {
    delete process.env.UNLOAD_STATEMENT_TIMEOUT;
    await owner.query('drop function if exists public.sec32_unload_write(); drop table if exists public.sec32_unload');
  });

  test('needs a builder login; an application session is not enough; POST needs the CSRF token', async () => {
    const king = new Browser();
    await king.login('king');
    for (const b of [new Browser(), king]) {
      const res = await b.get('/builder/sql/unload');
      assert.equal(res.statusCode, 302);
      assert.match(String(res.headers.location), /^\/builder\/login/);
      const post = await b.post('/builder/sql/unload', { source: 'query', query: 'select * from public.sec32_unload', format: 'csv' });
      assert.equal(post.statusCode, 302);
      assert.doesNotMatch(post.body, /cmd/);
    }
    const dev = await builder();
    for (const token of [undefined, 'wrong']) {
      const form = { source: 'query', query: 'select * from public.sec32_unload', format: 'csv' };
      const res = await dev.post('/builder/sql/unload', token ? { __csrf: token, ...form } : form);
      assert.equal(res.statusCode, 403);
      assert.doesNotMatch(res.body, /cmd/);
    }
  });

  test('read only: no writes through a data-modifying CTE or a function; one statement only', async () => {
    const dev = await builder();
    for (const query of [
      'select public.sec32_unload_write()',
      'with w as (insert into public.sec32_unload values (98, \'x\') returning id) select * from w',
      'select 1; insert into public.sec32_unload values (97, \'x\')',
      'insert into public.sec32_unload values (96, \'x\') returning id',
      'select 1 \\g /tmp/x',
    ]) {
      const res = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'query', query, format: 'csv' });
      assert.equal(res.statusCode, 422, query);
    }
    // WHERE / ORDER BY text of the table form can't smuggle in a second statement either
    for (const [where, order] of [['true); insert into public.sec32_unload values (95, \'x\'); select (1', ''], ['', '1; insert into public.sec32_unload values (94, \'x\')']]) {
      const res = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'table', table: 'sec32_unload', columns: 'id', where, order, format: 'csv' });
      assert.equal(res.statusCode, 422, where + order);
    }
    assert.equal((await owner.one('select count(*)::int as n from public.sec32_unload')).n, 4);
  });

  test('settings made by the query do not leak into the pool; the statement timeout applies', async () => {
    const dev = await builder();
    const res = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'query', query: `select set_config('application_name', 'sec32_leak', false) as x`, format: 'csv' });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await owner.one(`select count(*)::int as n from pg_stat_activity where application_name = 'sec32_leak'`)).n, 0, 'the connection was closed');
    process.env.UNLOAD_STATEMENT_TIMEOUT = '200ms';
    const slow = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'query', query: 'select pg_sleep(3)', format: 'csv' });
    delete process.env.UNLOAD_STATEMENT_TIMEOUT;
    assert.equal(slow.statusCode, 422);
    assert.match(slow.body, /statement timeout/);
  });

  test('CSV neutralises formulas, XML escapes markup; the unload is in the activity log; the table must exist', async () => {
    const dev = await builder();
    const csv = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'query', query: 'select note from public.sec32_unload order by id', format: 'csv', header: '1' });
    assert.equal(csv.body, `note\r\n'=1+2\r\n'@SUM(A1)\r\n<x>&</x>\r\n'-cmd\r\n`);
    const xml = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'query', query: 'select note as "a<b" from public.sec32_unload where id = 3', format: 'xml' });
    assert.match(xml.body, /<a_b>&lt;x&gt;&amp;&lt;\/x&gt;<\/a_b>/);
    const bad = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'query', query: 'select 1', format: 'xml', row_tag: 'r><evil', root_tag: 'x' });
    assert.equal(bad.statusCode, 422);
    assert.doesNotMatch(bad.body, /<evil/);
    const log = await owner.one(`select username, detail from meta.activity_log where event = 'sql_unload' order by id desc limit 1`);
    assert.equal(log.username, 'admin');
    assert.match(log.detail, /^xml: select note as "a<b"/);
    const missing = await dev.post('/builder/sql/unload', { __csrf: dev.lastCsrf, source: 'table', table: 'pg_catalog.pg_authid', columns: 'rolpassword', format: 'csv' });
    assert.equal(missing.statusCode, 422, 'only listed tables and views');
  });
});

describe('sprint 32 item 4: create page wizards', () => {
  const alias = 'sec32-wizards';
  let wizApp: number;
  const builder = async () => {
    const b = new Browser();
    await b.get('/builder/login');
    await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' });
    await b.get(`/builder/apps/${wizApp}`);
    return b;
  };
  const generate = (table: string, kind: string, page: number, options: Record<string, unknown>) =>
    owner.one('select meta.generate_page($1, $2, $3::regclass, $4, $5::jsonb) as id', [alias, kind, table, page, JSON.stringify(options)]);
  before(async () => {
    await owner.query(`delete from meta.app where alias = '${alias}'`);
    await owner.query(`drop table if exists public.sec32_wiz; create table public.sec32_wiz (id int primary key, "na""me; drop table x" text, d date, n int);
      insert into public.sec32_wiz values (1, '<script>alert(1)</script>', current_date, 5); grant select on public.sec32_wiz to pgapex_runtime`);
    wizApp = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Wizard security', 'none') returning id`, [alias])).id;
  });
  after(async () => {
    await owner.query('delete from meta.app where id = $1', [wizApp]);
    await owner.query('delete from meta.builder_lock where app_id = $1', [wizApp]).catch(() => undefined);
    await owner.query('drop table if exists public.sec32_wiz');
  });

  test('needs a builder login (an application session is not enough); POST needs the CSRF token', async () => {
    const king = new Browser();
    await king.login('king');
    const form = { kind: 'cards', table: 'public.sec32_wiz', report_page: '10' };
    for (const b of [new Browser(), king]) {
      const res = await b.get(`/builder/apps/${wizApp}/wizard?kind=cards&table=public.sec32_wiz`);
      assert.equal(res.statusCode, 302);
      assert.equal((await b.post(`/builder/apps/${wizApp}/wizard`, form)).statusCode, 302);
    }
    const dev = await builder();
    for (const token of [undefined, 'wrong']) assert.equal((await dev.post(`/builder/apps/${wizApp}/wizard`, token ? { __csrf: token, ...form } : form)).statusCode, 403);
    assert.equal((await owner.one('select count(*)::int as n from meta.page where app_id = $1', [wizApp])).n, 0);
  });

  test('an application locked by another developer refuses the wizard', async () => {
    await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 0, 'sec32_other')`, [wizApp]);
    try {
      const dev = await builder();
      const res = await dev.post(`/builder/apps/${wizApp}/wizard`, { __csrf: dev.lastCsrf, kind: 'cards', table: 'public.sec32_wiz', report_page: '10' });
      assert.equal(res.statusCode, 303);
      assert.equal((await owner.one('select count(*)::int as n from meta.page where app_id = $1', [wizApp])).n, 0);
    } finally {
      await owner.query(`delete from meta.builder_lock where app_id = $1`, [wizApp]);
    }
  });

  test('option values never become SQL: columns must exist and are quoted, kinds and functions come from lists', async () => {
    for (const [kind, options, error] of [
      ['cards', { title: 'id as title from public.sec32_wiz; drop table public.sec32_wiz; --' }, /is not a column/],
      ['chart', { label_column: 'd', function: 'pg_sleep' }, /unknown function/],
      ['chart', { label_column: 'd', chart: "bar'; drop" }, /unknown chart type/],
      ['calendar', { start: 'n' }, /date or timestamp start column/],
      ['facets', { facets: ['n) or (true'] }, /is not a column/],
      ['master_detail', { detail: 'public.sec32_wiz; drop table x', detail_column: 'id' }, /./],
      ['cards', { form_page: '1 or 1=1' }, /./],
    ] as [string, Record<string, unknown>, RegExp][])
      await assert.rejects(generate('public.sec32_wiz', kind, 20, options), error, `${kind} ${JSON.stringify(options)}`);
    // an odd column name is quoted: the generated query runs and shows the value escaped
    await generate('public.sec32_wiz', 'cards', 21, { title: 'na"me; drop table x', label: '<img src=x onerror=alert(1)>' });
    const src = (await owner.one(`select r.source from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 21`, [wizApp])).source;
    assert.match(src, /t\."na""me; drop table x" as title/);
    await owner.query('update meta.page set requires_auth = false where app_id = $1', [wizApp]);
    const page = (await new Browser().get(`/a/${alias}/21`)).body;
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(page, /<img src=x/);
    assert.equal((await owner.one(`select to_regclass('public.sec32_wiz') is not null as ok`)).ok, true);
  });

  test("pgapex's and the system's tables are refused; the functions are not granted to application roles", async () => {
    for (const t of ['meta.account', 'pg_catalog.pg_authid', 'information_schema.tables'])
      await assert.rejects(generate(t, 'cards', 30, {}), /can't be generated/, t);
    const dev = await builder();
    const res = await dev.get(`/builder/apps/${wizApp}/wizard?kind=cards&table=meta.account`);
    assert.equal(res.statusCode, 303, 'step 2 refuses it too');
    const post = await dev.post(`/builder/apps/${wizApp}/wizard`, { __csrf: dev.lastCsrf, kind: 'facets', table: 'meta.account', report_page: '30' });
    assert.equal(post.statusCode, 303);
    assert.equal((await owner.one('select count(*)::int as n from meta.page where app_id = $1 and page_no = 30', [wizApp])).n, 0);
    for (const fn of ['meta.generate_page(text, text, regclass, int, jsonb)', 'meta.wizard_defaults(text, regclass)', 'meta.wizard_catalog(regclass)', 'meta.wizard_form(meta.app, regclass, int, text, int, boolean, text[])'])
      for (const role of ['pgapex_runtime', 'hr_app'])
        assert.equal((await owner.one('select has_function_privilege($1, $2, \'execute\') as ok', [role, fn])).ok, false, `${role} ${fn}`);
  });

  test('drag and drop is off unless chosen; the generated move statement uses the binds as typed literals', async () => {
    await generate('public.sec32_wiz', 'calendar', 40, {});
    const off = (await owner.one(`select r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 40`, [wizApp])).config;
    assert.equal(off.move, undefined);
    await generate('public.sec32_wiz', 'calendar', 41, { drag: true });
    const on = (await owner.one(`select r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 41`, [wizApp])).config;
    assert.equal(on.move, 'update public.sec32_wiz set d = :NEW_START::date where id = :EVENT_ID::integer');
    assert.equal(on.key, 'id');
  });
});

describe('sprint 32 item 5: create application from a file', () => {
  const ALIASES = ['sec32-ff', 'sec32-ff-meta', 'sec32-ff-blank'];
  const DEV = 'sec32_ff_dev';
  const DEV_PW = 'Sec32-ff-developer!';
  const CSV = 'Name,"<script>alert(1)</script>",Amount\nAnn,<b>x</b>,5\nBob,y,7\n';
  const cleanup = async () => {
    for (const alias of ALIASES) {
      const schema = alias.replace(/-/g, '_');
      await owner.query('delete from meta.app where alias = $1', [alias]);
      await owner.query(`drop schema if exists ${schema} cascade`);
      if ((await owner.query('select 1 from pg_roles where rolname = $1', [`app_${schema}`])).rowCount) {
        await owner.query(`drop owned by app_${schema}`);
        await owner.query(`drop role app_${schema}`);
      }
    }
    await owner.query('delete from meta.developer where username = $1', [DEV]);
  };
  const builder = async (user = 'admin', password = 'admin') => {
    const b = new FileBrowser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: user, password })).statusCode, 303);
    await b.get('/builder/create/file');
    return b;
  };
  const file = { file: { name: 'sec.csv', type: 'text/csv', data: Buffer.from(CSV) } };
  const step2 = async (b: FileBrowser) => {
    const res = await b.upload('/builder/create/file', { headers: 'true' }, file);
    assert.equal(res.statusCode, 303);
    const url = res.headers.location as string;
    const page = await b.get(url);
    return { url, body: page.body };
  };
  const base = { h: '1', name: 'Sec ff', alias: 'sec32-ff', schema: '', authentication: 'none', table: 'sec', name_0: 'name', type_0: 'text', name_1: 'note', type_1: 'text', name_2: 'amount', type_2: 'integer' };
  before(async () => {
    await cleanup();
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  });
  after(cleanup);

  test('needs a builder login (an application session is not enough) and the CSRF token on both steps', async () => {
    const king = new FileBrowser(app);
    await king.login('king');
    for (const b of [new FileBrowser(app), king]) {
      assert.equal((await b.get('/builder/create/file')).statusCode, 302);
      assert.equal((await b.upload('/builder/create/file', { headers: 'true' }, file)).statusCode, 302);
    }
    const dev = await builder();
    const good = dev.lastCsrf;
    dev.lastCsrf = 'wrong';
    assert.equal((await dev.upload('/builder/create/file', { headers: 'true' }, file)).statusCode, 403);
    dev.lastCsrf = good;
    const { url } = await step2(dev);
    for (const token of [undefined, 'wrong']) assert.equal((await dev.post(url, token ? { __csrf: token, ...base } : base)).statusCode, 403);
    assert.equal((await new FileBrowser(app).post(url, base)).statusCode, 302);
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'sec32-ff'`)).rowCount, 0);
  });

  test("another developer's session can't use the uploaded file", async () => {
    const admin = await builder();
    const { url } = await step2(admin);
    const other = await builder(DEV, DEV_PW);
    const get = await other.get(url);
    assert.equal(get.statusCode, 302);
    assert.equal(get.headers.location, '/builder/create/file');
    const post = await other.submit(url, base);
    assert.equal(post.statusCode, 303);
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'sec32-ff'`)).rowCount, 0);
    for (const bad of ['/builder/create/file/not-a-uuid', "/builder/create/file/00000000-0000-0000-0000-000000000000'"])
      assert.equal((await admin.get(bad)).statusCode, 302);
  });

  test("file headings and values are escaped; table and column names never become SQL", async () => {
    const dev = await builder();
    const { url, body } = await step2(dev);
    assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(body, /name="name_1" value="script_alert_1_script"/, 'a heading becomes a plain identifier');
    for (const [form, error] of [
      [{ table: 'sec; drop table meta.app; --' }, /lower-case name/],
      [{ table: 'meta.app' }, /without a schema/],
      [{ name_0: 'name text); drop table meta.app; --' }, /is not a valid column name/],
      [{ type_2: 'int); drop table meta.app; --' }, /Unknown column type/],
      [{ alias: "x'; drop table meta.app; --" }, /The alias must start with a letter/],
    ] as [Record<string, string>, RegExp][]) {
      const res = await dev.submit(url, { ...base, ...form });
      assert.equal(res.statusCode, 422, JSON.stringify(form));
      assert.match(res.body, error);
    }
    assert.equal((await owner.one(`select to_regclass('meta.app') is not null as ok`)).ok, true);
    const ok = await dev.submit(url, base);
    assert.equal(ok.statusCode, 200);
    // the values are data: shown escaped by the generated report
    const page = (await new FileBrowser(app).get('/a/sec32-ff/2')).body;
    assert.match(page, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(page, /<b>x<\/b>/);
  });

  test("the new app's role can use only its own schema; pgapex's and the system's schemas are refused", async () => {
    const priv = await owner.one(
      `select has_table_privilege('app_sec32_ff', 'sec32_ff.sec', 'select,insert,update,delete') as own,
              has_table_privilege('app_sec32_ff', 'meta.account', 'select') as meta,
              has_schema_privilege('app_sec32_ff', 'hr', 'usage') as other,
              pg_has_role('pgapex_runtime', 'app_sec32_ff', 'member') as runtime`,
    );
    assert.deepEqual(priv, { own: true, meta: false, other: false, runtime: true });
    const dev = await builder();
    const { url } = await step2(dev);
    for (const schema of ['meta', 'pg_catalog', 'information_schema', 'PG_TOAST']) {
      const res = await dev.submit(url, { ...base, alias: 'sec32-ff-meta', schema });
      assert.equal(res.statusCode, 422, schema);
      assert.match(res.body, /can&#39;t be the parsing schema/);
    }
    // the blank application wizard refuses them too
    await dev.get('/builder/create');
    const blank = await dev.submit('/builder/apps', { name: 'Blank', alias: 'sec32-ff-blank', schema: 'meta', authentication: 'none' });
    assert.equal(blank.statusCode, 303);
    assert.equal(blank.headers.location, '/builder/create');
    assert.equal((await owner.query(`select 1 from meta.app where alias in ('sec32-ff-meta', 'sec32-ff-blank')`)).rowCount, 0);
    assert.equal((await owner.one(`select has_schema_privilege('app_sec32_ff_meta', 'meta', 'usage') as x where exists (select 1 from pg_roles where rolname = 'app_sec32_ff_meta')`))?.x ?? false, false);
  });
});

describe('sprint 33 item 1: Gantt, pyramid and polar charts', () => {
  const region = async (title: string) =>
    (await owner.one(`select r.id, r.source, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 32 and r.title = $2`, [appId, title])) as { id: number; source: string; config: any };

  test('the leave Gantt runs as the app role: each user sees only the leave RLS lets them see', async () => {
    const blake = (await (await as('blake')).get('/a/hr/32')).body;
    assert.match(blake, /WARD \(approved\)/, 'blake manages Ward');
    assert.doesNotMatch(blake, /FORD \(approved\)|CLARK \(approved\)/);
    const king = (await (await as('king')).get('/a/hr/32')).body;
    assert.match(king, /FORD \(approved\)/, 'king is an admin');
  });

  test('drill-down from a task: checksummed links per user; forged or reused links are refused', async () => {
    const blake = await as('blake');
    const body = (await blake.get('/a/hr/32')).body;
    const href = /<a class="gantt-bar s1 \w+ \w+ drill" href="(\/a\/hr\/7\?[^"]+)"/.exec(body)![1].replace(/&amp;/g, '&');
    const q = new URLSearchParams(href.split('?')[1]);
    assert.equal(q.get('cs'), urlChecksum(appId, 7, 'blake', { P7_ID: q.get('P7_ID')! }));
    assert.equal((await blake.get(href)).statusCode, 200);
    assert.equal((await blake.get(href.replace(/P7_ID=\d+/, 'P7_ID=1'))).statusCode, 403);
    assert.equal((await (await as('allen')).get(href)).statusCode, 403);
  });

  test('labels, dates and dependency ids from the query are escaped and never become markup or styles; no links to pages the user may not open', async () => {
    const r = await region('Office move');
    try {
      await owner.query(`update meta.region set source = $2, config = '{"kind": "gantt", "link": {"page": 3, "items": {"P3_EMPNO": "#task_id#"}}}' where id = $1`, [r.id,
        `select '"><img src=x onerror=alert(1)>' as task, '2026-01-01' as s, '2026-01-09"><script>' as e, '50"><b>' as progress, 1 as task_id, '1"><svg onload=alert(1)>' as depends_on
         union all select '<script>alert(2)</script>', '2026-01-03', null, null, 2, '1,"><x'`]);
      const allen = await as('allen');
      const page = (await allen.get('/a/hr/32')).body;
      assert.ok(!page.includes('<img src=x') && !page.includes('<script>alert') && !page.includes('<svg onload') && !page.includes('"><b>'));
      assert.match(page, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
      assert.doesNotMatch(page, /\sstyle=/, 'geometry goes into the nonce stylesheet');
      assert.doesNotMatch(page, /\/a\/hr\/3\?/, 'page 3 needs MANAGER: no drill-down for allen');
      // path data is numbers only
      for (const [, d] of page.matchAll(/class="gantt-dep" d="([^"]*)"/g)) assert.match(d, /^[MHV\d., ]+$/);
      for (const kind of ['pyramid', 'polar']) {
        await owner.query(`update meta.region set source = $2, config = $3 where id = $1`, [r.id, `select '<img src=y>' as l, 3 as a, 2 as b union all select 'b', 1, 4`, JSON.stringify({ kind })]);
        const body = (await allen.get('/a/hr/32')).body;
        assert.ok(!body.includes('<img src=y>'), kind);
        assert.match(body, new RegExp(`chart-${kind}`), kind);
      }
    } finally {
      await owner.query(`update meta.region set source = $2, config = $3 where id = $1`, [r.id, r.source, JSON.stringify(r.config)]);
    }
  });

  test('a query that is no Gantt data shows a message, not an error', async () => {
    const r = await region('Office move');
    try {
      await owner.query(`update meta.region set source = $2 where id = $1`, [r.id, `select 'a' as t, 'tomorrow' as s, 'later' as e`]);
      assert.match((await (await as('king')).get('/a/hr/32')).body, /A Gantt chart needs a label column, a start date and an end date/);
    } finally {
      await owner.query(`update meta.region set source = $2 where id = $1`, [r.id, r.source]);
    }
  });
});

describe('sprint 33 item 2: map layers, clustering and spatial filtering', () => {
  const regions = async () =>
    (await owner.query(`select r.id, r.type, r.source, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 33 order by r.seq`, [appId])).rows as { id: number; type: string; source: string; config: any }[];
  const mapData = (page: string) => JSON.parse(/<script type="application\/json" class="map-data">([^<]*)<\/script>/.exec(page)![1]);

  test("every layer's query runs as the app role: no owner rights, the other layers still draw", async () => {
    const [map] = await regions();
    try {
      await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify({ ...map.config, layers: [
        { name: 'Who', source: `select current_user as title, 1 as lat, 1 as lng` },
        { name: 'Meta', source: `select name as title, 1 as lat, 1 as lng from meta.app` },
      ] })]);
      const page = (await (await as('allen')).get('/a/hr/33')).body;
      const d = mapData(page);
      assert.deepEqual(d.layers.map((l: any) => l.name), ['Visits', 'Who']);
      assert.equal(d.layers[1].points[0].title, 'hr_app');
      assert.match(page, /<div class="alert alert-error" role="alert">/, 'the meta schema is not readable by the app role');
      assert.doesNotMatch(page, /Directory test|"title":"HR/, 'no application names leak');
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify(map.config)]);
    }
  });

  test("a layer's link only to a page the user may open; names, titles and texts are escaped", async () => {
    const [map] = await regions();
    try {
      await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify({ ...map.config, layers: [
        { name: '</script><img src=x onerror=alert(1)>', source: `select '<img src=y onerror=alert(2)>' as title, '</script><script>alert(3)</script>' as body, empno, 1 as lat, 1 as lng from hr.emp where empno = 7499`, link: { page: 3, items: { P3_EMPNO: '#empno#' } } },
      ] })]);
      const allen = (await (await as('allen')).get('/a/hr/33')).body;
      assert.ok(!allen.includes('<img src=x') && !allen.includes('<img src=y') && !allen.includes('<script>alert(3)'));
      assert.match(allen, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;: 1 place\(s\) as a list/);
      const layer = mapData(allen).layers[1];
      assert.equal(layer.name, '</script><img src=x onerror=alert(1)>', 'the JSON keeps the text; the page escapes "<" in it');
      assert.equal(layer.points[0].href, null, 'page 3 needs MANAGER: no link for allen');
      const king = mapData((await (await as('king')).get('/a/hr/33')).body).layers[1];
      assert.match(king.points[0].href, /^\/a\/hr\/3\?.*P3_EMPNO=7499/);
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [map.id, JSON.stringify(map.config)]);
    }
  });

  test('the distance and area from the URL: numbers only, otherwise ignored; they only narrow the rows the user may see', async () => {
    const [, report] = await regions();
    const allen = await as('allen');
    for (const bad of ["41,-87,10'; drop table hr.emp; --", '41,-87,10,1', '41,-87,1e9', '41,-87,Infinity', '41,-87,NaN', '0x10,0,1', '41,-87,-1'])
      assert.doesNotMatch((await allen.get(`/a/hr/33?r${report.id}_near=${encodeURIComponent(bad)}`)).body, /Within|alert-error/, bad);
    const { parseNear, nearCondition, postgisNearCondition } = await import('../src/runtime/spatial.ts');
    const near = parseNear('41.5,-87.25,12.5')!;
    // the only things in the SQL besides fixed text are the parsed numbers and quoted column names
    assert.doesNotMatch(nearCondition(near, { lat: 'lat', lng: 'lng' }).replace(/"__q"\."(lat|lng)"/g, ''), /["';]/);
    assert.doesNotMatch(postgisNearCondition({ schema: 'public', version: '3', geometry: 1, geography: 2 }, { name: 'g', kind: 'geometry' }, near).replace(/"(__q|g|public)"/g, ''), /["';]/);
    // a report with RLS stays filtered by it: the area only takes rows away
    const all = (await allen.get(`/a/hr/33?r${report.id}_n=100`)).body;
    const near100 = (await allen.get(`/a/hr/33?r${report.id}_n=100&r${report.id}_near=${encodeURIComponent('41.8781,-87.6298,2000')}`)).body;
    const count = (p: string) => (p.match(/<td[^>]*>(Chicago|Boston|New York|Dallas)<\/td>/g) ?? []).length;
    assert.ok(count(near100) <= count(all) && count(near100) > 0);
  });

  test('only developers save map layers (CSRF-checked), and a layer link only to a page of the application', async () => {
    const [map] = await regions();
    const pageId = (await owner.one('select page_id from meta.region where id = $1', [map.id])).page_id;
    const url = `/builder/pages/${pageId}/region/${map.id}/settings`;
    const res = await new FileBrowser(app).post(url, { layers: '1', layer0_source: 'select 1' });
    assert.equal(res.statusCode, 302, 'not signed in to the builder');
    assert.deepEqual((await owner.one('select config from meta.region where id = $1', [map.id])).config, map.config);
    const { mergeMapSettings } = await import('../src/builder/region-settings.ts');
    const merged = mergeMapSettings({}, { layers: '1', layer0_source: 'select 1', layer0_link_page: '424242' }, { pages: new Set([1]), lovs: new Set(), reports: new Map() });
    assert.deepEqual(merged.layers, [{ name: 'Layer 2', source: 'select 1' }]);
  });
});

describe('sprint 33 item 3: REST write-back, synchronisation, OAuth2 password and refresh tokens', () => {
  const env = { ...process.env };
  let mock: import('node:http').Server;
  let mockBase = '';
  const hits: { method: string; url: string; body: string }[] = [];
  const dev = new Browser();
  const cleanup: string[] = [];
  let crmUrl = '';

  before(async () => {
    process.env.PGAPEX_SECRET_KEY = 'security-test-secret-key-0123456789abcdef';
    process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1';
    process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';
    const http = await import('node:http');
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ method: req.method!, url: req.url!, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] }));
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    mockBase = `http://127.0.0.1:${(mock.address() as import('node:net').AddressInfo).port}`;
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get('/builder');
    crmUrl = (await owner.one(`select url from meta.rest_source where app_id = $1 and name = 'CRM_CONTACTS'`, [appId])).url;
  });

  after(async () => {
    await owner.query(`update meta.rest_source set url = $2 where app_id = $1 and name = 'CRM_CONTACTS'`, [appId, crmUrl]);
    await owner.query(`delete from meta.web_credential where app_id = $1 and name like 'SEC3\\_%'`, [appId]);
    await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'SEC3\\_%'`, [appId]);
    for (const sql of cleanup) await owner.query(sql);
    mock.close();
    for (const k of ['PGAPEX_SECRET_KEY', 'PGAPEX_REST_ALLOWED_HOSTS', 'PGAPEX_REST_PRIVATE_HOSTS'])
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  });

  test('row values in an operation can not change the host or the path above the source', async () => {
    const ws = await import('../src/websources.ts');
    const s = {
      id: 0, app_id: appId, name: 'SEC3', url: `${mockBase}/api/items?x=1`, method: 'GET', credential: null, headers: {}, body: null, row_selector: null,
      params: [], columns: [{ name: 'id' }, { name: 'name' }], cache_seconds: 0, timeout_s: 5, max_rows: 10, key_columns: ['id'],
      operations: { update: { path: '/{id}', body: '{"name": {name}}' }, delete: { path: '?id={id}' } },
    };
    for (const id of ['@evil.example/', '//evil.example/x', '../../admin', 'x?y=1#z', 'http://evil.example/', '%2e%2e']) {
      const u = new URL(ws.buildOperation(s, 'update', { id, name: 'n' }).url);
      assert.equal(u.host, new URL(mockBase).host, id);
      assert.ok(u.pathname.startsWith('/api/items/') && u.pathname.split('/').length === 4, `${id}: one segment under the source's path`);
      assert.equal(new URL(ws.buildOperation(s, 'delete', { id }).url).searchParams.get('id'), id, 'a query value stays one value');
    }
    for (const id of ['.', '..']) assert.throws(() => ws.buildOperation(s, 'update', { id, name: 'n' }), /not a valid value/);
    // a body template takes JSON values: a value can't add keys
    const body = JSON.parse(ws.buildOperation(s, 'update', { id: 1, name: '", "admin": true, "x": "' }).body!);
    assert.deepEqual(Object.keys(body), ['name']);
    // a definition written straight into the table is checked again before a call
    assert.throws(() => ws.buildOperation({ ...s, operations: { update: { path: '/../../{id}' } } }, 'update', { id: 1 }), /"path" follows/);
    assert.equal(new URL(ws.buildOperation({ ...s, operations: { update: { path: '@evil.example/{id}' } } }, 'update', { id: 1 }).url).host, new URL(mockBase).host);
    assert.throws(() => ws.buildOperation({ ...s, operations: { update: { path: '//evil.example/{id}' } } }, 'update', { id: 1 }), /"path" follows/);
  });

  test('a REST grid: row keys are signed, and only the operations the source defines are used', async () => {
    await owner.query(`update meta.rest_source set url = $2 where app_id = $1 and name = 'CRM_CONTACTS'`, [appId, `${mockBase}/crm`]);
    const { clearResponseCache } = await import('../src/websources.ts');
    clearResponseCache();
    const grid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 34 and r.type = 'grid'`, [appId])).id;
    const king = await as('king');
    const page = (await king.get('/a/hr/34')).body;
    const g = `g${grid}`;
    const pk = (n: string) => new RegExp(`name="${g}_(\\d+)_pk" value="${n}"`).exec(page)?.[1];
    const cs = /name="g\d+_\d+_cs" value="([^"]+)"/.exec(page)![1];
    assert.ok(pk('1') && pk('2'), 'the rows of the service');
    // a key that was not signed for this row: refused, nothing is sent
    let n = hits.length;
    const res = await king.post('/a/hr/34', { __csrf: king.lastCsrf, __request: `GRID_SAVE_${grid}`, [`${g}_0_pk`]: '999', [`${g}_0_cs`]: cs, [`${g}_0_del`]: 'true' });
    assert.notEqual(res.statusCode, 303);
    assert.ok(!hits.slice(n).some((h) => h.method === 'DELETE'), 'no DELETE for an unsigned key');
    // without a delete operation, Delete is not offered and a posted delete does nothing
    const ops = (await owner.one(`select operations from meta.rest_source where app_id = $1 and name = 'CRM_CONTACTS'`, [appId])).operations;
    try {
      await owner.query(`update meta.rest_source set operations = operations - 'delete' where app_id = $1 and name = 'CRM_CONTACTS'`, [appId]);
      const p2 = (await king.get('/a/hr/34')).body;
      assert.doesNotMatch(p2, new RegExp(`name="${g}_\\d+_del"`));
      const i = new RegExp(`name="${g}_(\\d+)_pk" value="1"`).exec(p2)![1];
      const sig = new RegExp(`name="${g}_${i}_cs" value="([^"]+)"`).exec(p2)![1];
      n = hits.length;
      await king.post('/a/hr/34', { __csrf: king.lastCsrf, __request: `GRID_SAVE_${grid}`, [`${g}_${i}_pk`]: '1', [`${g}_${i}_cs`]: sig, [`${g}_${i}_del`]: 'true' });
      assert.ok(!hits.slice(n).some((h) => h.method === 'DELETE'));
    } finally {
      await owner.query(`update meta.rest_source set operations = $2 where app_id = $1 and name = 'CRM_CONTACTS'`, [appId, JSON.stringify(ops)]);
    }
    // the form's key item is signed like a table form's: a forged P34_ID is refused
    n = hits.length;
    const forged = await king.post('/a/hr/34', { __csrf: king.lastCsrf, __request: 'DELETE', P34_ID: '2', P34_NAME: 'x' });
    assert.ok(!hits.slice(n).some((h) => h.method === 'DELETE'), `status ${forged.statusCode}: no DELETE with a forged key`);
  });

  test('a synchronisation writes as the application role: grants and RLS apply, the meta schema is out of reach', async () => {
    const { runSync } = await import('../src/restsync.ts');
    const src = await owner.one(
      `insert into meta.rest_source (app_id, name, url, row_selector, columns, key_columns, sync_table, sync_mode)
       values ($1, 'SEC3_SYNC', $2, 'items', '[{"name": "id", "type": "integer"}, {"name": "name", "type": "text"}]', '{id}', 'meta.app', 'merge') returning id`,
      [appId, `${mockBase}/sync`],
    );
    const before = (await owner.one('select count(*)::int as n from meta.app')).n;
    let r = await runSync(src.id, 'manual');
    assert.equal(r.status, 'error');
    assert.match(r.message!, /permission denied/);
    assert.equal((await owner.one('select count(*)::int as n from meta.app')).n, before);
    // a table the app role may only read
    await owner.query(`update meta.rest_source set sync_table = 'hr.dept' where id = $1`, [src.id]);
    r = await runSync(src.id, 'manual');
    assert.equal(r.status, 'error');
    // the log and the request function: the current application's sources only
    await assert.rejects(runtime.query('select * from meta.rest_sync_log'), /permission denied/);
    await assert.rejects(runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', '0', true)`);
      await c.query(`select meta.request_rest_sync('SEC3_SYNC')`);
    }), /does not exist in this application/);
    await assert.rejects(runtime.query(`select meta.request_rest_sync('SEC3_SYNC')`), /no current application/);
    // the table name is checked in the builder
    const { syncProblems } = await import('../src/restsync.ts');
    assert.ok(syncProblems({ sync_table: 'hr.dept; drop table hr.emp', key_columns: ['id'] }).length);
  });

  test('builder: synchronise now and removing secrets need a developer, the CSRF token and the right application', async () => {
    const src = await owner.one(`insert into meta.rest_source (app_id, name, url, sync_table, sync_mode) values ($1, 'SEC3_NOW', $2, 'hr.t_none', 'append') returning id`, [appId, `${mockBase}/now`]);
    const url = `/builder/apps/${appId}/rest-sources/${src.id}/sync`;
    const n = hits.length;
    assert.equal((await new Browser().post(url, { __csrf: 'x' })).statusCode, 302);
    assert.equal((await dev.post(url, { __csrf: 'wrong' })).statusCode, 403);
    assert.equal((await dev.post(`/builder/apps/${appId + 100000}/rest-sources/${src.id}/sync`, { __csrf: dev.lastCsrf })).statusCode, 404);
    assert.equal(hits.length, n, 'no request was made');
    assert.equal((await dev.post(url, { __csrf: dev.lastCsrf })).statusCode, 303);
    assert.equal(hits.length, n + 1);
    // "what" only picks from a fixed list of secret columns
    const { encryptSecret } = await import('../src/secrets.ts');
    const c = await owner.one(
      `insert into meta.web_credential (app_id, name, type, username, token_url, grant_type, oauth_username, secret_enc, password_enc, refresh_token_enc)
       values ($1, 'SEC3_PW', 'oauth2', 'cid', $2, 'password', 'robot', $3, $4, $5) returning id`,
      [appId, `${mockBase}/token`, encryptSecret('cs'), encryptSecret('pw-Secret-42'), encryptSecret('rt-Secret-43')],
    );
    await dev.get(`/builder/apps/${appId}/shared?c=web_credential-${c.id}`);
    await dev.post(`/builder/apps/${appId}/web-credentials/${c.id}/clear`, { __csrf: dev.lastCsrf, what: 'name' });
    const row = await owner.one('select name, secret_enc, password_enc, refresh_token_enc from meta.web_credential where id = $1', [c.id]);
    assert.equal(row.name, 'SEC3_PW');
    assert.equal(row.secret_enc, null, 'an unknown "what" means the secret');
    assert.ok(row.password_enc && row.refresh_token_enc);
    await dev.post(`/builder/apps/${appId}/web-credentials/${c.id}/clear`, { __csrf: dev.lastCsrf, what: 'refresh' });
    assert.equal((await owner.one('select refresh_token_enc from meta.web_credential where id = $1', [c.id])).refresh_token_enc, null);
  });

  test('OAuth2 passwords and refresh tokens are write-only: encrypted, never shown, exported, imported or readable by the runtime role', async () => {
    const { decryptSecret, encryptSecret } = await import('../src/secrets.ts');
    const res = await dev.post(`/builder/apps/${appId}/shared/web_credential`, {
      __csrf: dev.lastCsrf, name: 'SEC3_OAUTH', type: 'oauth2', username: 'cid', token_url: `${mockBase}/token`, grant_type: 'password', oauth_username: 'robot',
      password: 'pw-Plain-777', refresh_token: 'rt-Plain-888', password_enc: 'v1:forged', refresh_token_enc: 'v1:forged',
    });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select id, password_enc, refresh_token_enc from meta.web_credential where app_id = $1 and name = 'SEC3_OAUTH'`, [appId]);
    assert.equal(decryptSecret(row.password_enc), 'pw-Plain-777');
    assert.equal(decryptSecret(row.refresh_token_enc), 'rt-Plain-888');
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=web_credential-${row.id}`)).body;
    assert.match(page, /A password is stored/);
    assert.match(page, /A refresh token is stored/);
    for (const v of ['pw-Plain-777', 'rt-Plain-888', row.password_enc, row.refresh_token_enc]) assert.ok(!page.includes(v));
    // empty keeps them
    await dev.post(`/builder/apps/${appId}/shared/web_credential/${row.id}`, { __csrf: dev.lastCsrf, name: 'SEC3_OAUTH', type: 'oauth2', username: 'cid', token_url: `${mockBase}/token`, grant_type: 'password', oauth_username: 'robot', password: '', refresh_token: '' });
    assert.equal((await owner.one('select password_enc from meta.web_credential where id = $1', [row.id])).password_enc, row.password_enc);
    for (const col of ['password_enc', 'refresh_token_enc']) await assert.rejects(runtime.query(`select ${col} from meta.web_credential`), /permission denied/, col);
    assert.equal((await runtime.query(`select grant_type, oauth_username from meta.web_credential where name = 'SEC3_OAUTH'`)).rows[0].grant_type, 'password');
    const doc = JSON.stringify((await owner.one(`select meta.export_app('hr') as d`)).d);
    assert.ok(doc.includes('SEC3_OAUTH') && !doc.includes('password_enc') && !doc.includes('refresh_token_enc') && !doc.includes(row.password_enc) && !doc.includes('sync_last_at'));
    // an import can't bring them along, and synchronisations arrive switched off
    const imported = await owner.one(`select meta.import_app(meta.export_app('hr') || jsonb_build_object(
        'web_credentials', jsonb_build_array(jsonb_build_object('name', 'SEC3_IMP', 'type', 'oauth2', 'password_enc', $1::text, 'refresh_token_enc', $1::text)),
        'rest_sources', jsonb_build_array(jsonb_build_object('name', 'SEC3_IMPSRC', 'url', 'https://api.example.com/x', 'sync_table', 'hr.dept', 'sync_enabled', true, 'sync_schedule', '@hourly'))),
      'sec_import_33_3') as id`, [encryptSecret('x')]);
    cleanup.push(`delete from meta.app where id = ${Number(imported.id)}`);
    const cred = await owner.one(`select password_enc, refresh_token_enc, grant_type from meta.web_credential where app_id = $1 and name = 'SEC3_IMP'`, [imported.id]);
    assert.deepEqual(cred, { password_enc: null, refresh_token_enc: null, grant_type: 'client_credentials' });
    assert.equal((await owner.one(`select sync_enabled from meta.rest_source where app_id = $1 and name = 'SEC3_IMPSRC'`, [imported.id])).sync_enabled, false);
  });
});

describe('sprint 33 item 4: debug messages and the installation log', () => {
  const dev = new Browser();
  let reviewId: string;
  const hrViews = async () => (await owner.query('select id from meta.debug_view where app_id = $1 order by id', [appId])).rows.map((r) => r.id as string);

  before(async () => {
    reviewId = String((await owner.one(`insert into hr.review (empno, period, rating, created_by) values (7698, '2026-01-01:2026-06-30', 3, 'sec33-4') returning id`)).id);
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get('/builder');
  });
  after(async () => {
    await owner.query(`update meta.app set debug_level = 0, debug_retention_days = 7 where id = $1`, [appId]);
    await owner.query('delete from meta.debug_view where app_id = $1', [appId]);
    await owner.query(`delete from hr.review where created_by = 'sec33-4'`);
    await owner.query(`delete from meta.developer where username = 'sec33_dev'`);
  });

  test('application roles can not read or write the debug tables, nor call the save and purge functions', async () => {
    const role = (await owner.one('select db_role from meta.app where id = $1', [appId])).db_role;
    for (const t of ['meta.debug_view', 'meta.debug_message'])
      for (const r of [role, 'pgapex_runtime'])
        assert.equal((await owner.one(`select has_table_privilege($1, $2, 'select,insert,update,delete') as ok`, [r, t])).ok, false, `${r} ${t}`);
    for (const fn of ['meta.debug_save(int, int, text, uuid, text, text, int, int, timestamptz, numeric, jsonb)', 'meta.debug_purge()'])
      assert.equal((await owner.one(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn])).ok, false, `${role} ${fn}`);
    assert.equal((await owner.one(`select has_function_privilege($1, 'meta.debug(int, text)', 'execute') as ok`, [role])).ok, true);
  });

  test('with debug off a request writes nothing; meta.debug_save refuses an application not in debug', async () => {
    await owner.query('update meta.app set debug_level = 0 where id = $1', [appId]);
    await owner.query('delete from meta.debug_view where app_id = $1', [appId]);
    const b = await as('king');
    await b.get('/a/hr/1');
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await hrViews(), []);
    assert.equal((await runtime.one(`select meta.debug_save($1, 1, 'x', null, 'GET', '/forged', 200, 9, now(), 1, '[]') as id`, [appId])).id, null);
  });

  test('password item values and query string values are never recorded, even at level 9', async () => {
    await owner.query('update meta.app set debug_level = 9 where id = $1', [appId]);
    const b = await as('king');
    const url = `/a/hr/20?${new URLSearchParams({ P20_ID: reviewId, cs: urlChecksum(appId, 20, 'king', { P20_ID: reviewId }) })}`;
    await b.get(url);
    const res = await b.post('/a/hr/20', { __csrf: b.lastCsrf, __request: 'SAVE', P20_EMPNO: '7698', P20_PERIOD: ['2026-01-01', '2026-06-30'], P20_RATING: '99', P20_SKILLS: 'Sales', P20_NOTES: '', P20_PIN: 'pin-s33-secret' });
    assert.equal(res.statusCode, 422);
    let rows: unknown[] = [];
    for (let i = 0; i < 50 && !rows.some((r) => JSON.stringify(r).includes('P20_PIN')); i++) {
      await new Promise((r) => setTimeout(r, 40));
      rows = (await owner.query('select v.path, m.message from meta.debug_view v join meta.debug_message m on m.view_id = v.id where v.app_id = $1', [appId])).rows;
    }
    const all = JSON.stringify(rows);
    assert.match(all, /P20_PIN posted: \(password, not shown\)/);
    assert.doesNotMatch(all, /pin-s33-secret/);
    assert.doesNotMatch(all, new RegExp(`P20_ID=${reviewId}|cs=`), 'query values are left out');
  });

  test('the viewer escapes messages and only shows a page view under its own application', async () => {
    await owner.query('update meta.app set debug_level = 9 where id = $1', [appId]);
    const id = (await runtime.one(`select meta.debug_save($1, 1, 'x', null, 'GET', '/a/hr/1', 200, 9, now(), 1, $2::jsonb) as id`,
      [appId, JSON.stringify([{ ms: 0, level: 4, component: '<b>c</b>', text: '<script>alert(1)</script>' }])])).id;
    const res = await dev.get(`/builder/apps/${appId}/debug/${id}`);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /<script>alert\(1\)/);
    assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const other = (await owner.one(`insert into meta.app (alias, name, authentication) values ('sec33-other', 'Other', 'none') returning id`)).id;
    try {
      assert.equal((await dev.get(`/builder/apps/${other}/debug/${id}`)).statusCode, 404);
    } finally {
      await owner.query('delete from meta.app where id = $1', [other]);
    }
    assert.equal((await dev.get(`/builder/apps/${appId}/debug/1%20or%201=1`)).statusCode, 404);
    // filters are parameters: a quote in the user filter is just text
    assert.equal((await dev.get(`/builder/apps/${appId}/debug?user=${encodeURIComponent("x' or '1'='1")}&page=abc&before=1;drop`)).statusCode, 200);
  });

  test('the viewer needs a developer session, and its changes need the CSRF token', async () => {
    const anon = new Browser();
    assert.equal((await anon.get(`/builder/apps/${appId}/debug`)).statusCode, 302);
    assert.equal((await anon.get('/builder/installation')).statusCode, 302);
    const before = (await owner.one('select count(*)::int as n from meta.debug_view where app_id = $1', [appId])).n;
    assert.ok(before > 0);
    assert.equal((await dev.post(`/builder/apps/${appId}/debug/purge`, { __csrf: 'wrong' })).statusCode, 403);
    assert.equal((await dev.post(`/builder/apps/${appId}/debug/settings`, { __csrf: 'wrong', debug_level: '0', debug_retention_days: '7' })).statusCode, 403);
    assert.equal((await owner.one('select count(*)::int as n from meta.debug_view where app_id = $1', [appId])).n, before);
    assert.equal((await owner.one('select debug_level from meta.app where id = $1', [appId])).debug_level, 9);
    // out-of-range settings are refused
    await dev.get(`/builder/apps/${appId}/debug`);
    await dev.post(`/builder/apps/${appId}/debug/settings`, { __csrf: dev.lastCsrf, debug_level: '9', debug_retention_days: '3650' });
    assert.equal((await owner.one('select debug_retention_days from meta.app where id = $1', [appId])).debug_retention_days, 7);
  });

  test('the installation log is for administrators only', async () => {
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ('sec33_dev', meta.hash_password('Sec33-dev-password!'), false) on conflict do nothing`);
    const d = new Browser();
    await d.get('/builder/login');
    await d.post('/builder/login', { __csrf: d.lastCsrf, username: 'sec33_dev', password: 'Sec33-dev-password!' });
    const res = await d.get('/builder/installation');
    assert.equal(res.statusCode, 403);
    assert.doesNotMatch(res.body, /051_debug_messages/);
    assert.doesNotMatch((await d.get('/builder/utilities')).body, /\/builder\/installation/);
    assert.equal((await dev.get('/builder/installation')).statusCode, 200);
  });
});

describe('sprint 33 item 5: meta.web_request and meta.parse_data', () => {
  const env = { ...process.env };
  let role = '';
  let other = 0;
  let mock: import('node:http').Server;
  let mockBase = '';
  const hits: { url: string; headers: Record<string, unknown> }[] = [];
  /** SQL as an application's code (its role, meta.app_id() set). */
  const asApp = <T>(app: number, fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>, dbRole: string | null = role) =>
    runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.app_user', 'sec', true)`, [String(app)]);
      if (dbRole) await c.query(`set local role ${dbRole}`);
      return fn(async (sql, params = []) => (await c.query(sql, params)).rows);
    });
  const fails = (app: number, sql: string, params: unknown[], re: RegExp, dbRole?: string | null) =>
    assert.rejects(asApp(app, (q) => q(sql, params), dbRole), re);

  before(async () => {
    process.env.PGAPEX_SECRET_KEY = 'security-test-secret-key-0123456789abcdef';
    process.env.PGAPEX_REST_ALLOWED_HOSTS = '127.0.0.1,api.example.com';
    delete process.env.PGAPEX_REST_PRIVATE_HOSTS;
    role = (await owner.one('select db_role from meta.app where id = $1', [appId])).db_role;
    other = (await owner.one(`insert into meta.app (alias, name, authentication) values ('sec33-wr', 'Other', 'none') returning id`)).id;
    const { encryptSecret } = await import('../src/secrets.ts');
    await owner.query(`insert into meta.web_credential (app_id, name, type, secret_enc) values ($1, 'SEC5_TOKEN', 'bearer', $2)`, [other, encryptSecret('other-app-s3cret')]);
    const http = await import('node:http');
    mock = http.createServer((req, res) => {
      hits.push({ url: req.url!, headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('private');
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    mockBase = `http://127.0.0.1:${(mock.address() as import('node:net').AddressInfo).port}`;
  });

  after(async () => {
    await owner.query('delete from meta.web_request_log where app_id = any($1)', [[appId, other]]);
    await owner.query('delete from meta.app where id = $1', [other]);
    mock.close();
    for (const k of ['PGAPEX_SECRET_KEY', 'PGAPEX_REST_ALLOWED_HOSTS', 'PGAPEX_REST_PRIVATE_HOSTS'])
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  });

  test('application roles can not read or change the request table; take/done only see their own transaction', async () => {
    for (const sql of ['select * from meta.web_request_log', `insert into meta.web_request_log (app_id, url) values (${other}, 'http://x')`, 'update meta.web_request_log set status = $$ok$$', 'delete from meta.web_request_log'])
      await fails(appId, sql, [], /permission denied/);
    await assert.rejects(runtime.query('select * from meta.web_request_log'), /permission denied/);
    await assert.rejects(runtime.query('select meta.web_request_check()'), /permission denied/);
    // a committed request of another application: not taken, not finished, not readable
    const id = (await asApp(other, (q) => q(`select meta.web_request('https://api.example.com/x') as id`), null))[0].id;
    const r = await asApp(appId, async (q) => ({
      taken: await q(`select set_config('pgapex.web_pending', '1', true)`).then(() => q('select * from meta.web_request_take(20)')),
      response: (await q('select meta.web_response($1) as r, meta.web_response_blob($1) as b', [id]))[0],
    }));
    assert.deepEqual(r.taken, []);
    assert.deepEqual(r.response, { r: null, b: null });
    // even the same application can't take or finish a committed request from SQL: only the scheduler does
    const own = await asApp(other, async (q) => {
      await q(`select set_config('pgapex.web_pending', '1', true)`);
      const taken = await q('select * from meta.web_request_take(20)');
      await q(`select meta.web_request_done($1, 'ok', 200, null, '{}', 'forged', null)`, [id]);
      return taken;
    }, null);
    assert.equal(own.length, 0);
    const row = await owner.one('select status, response_body from meta.web_request_log where id = $1', [id]);
    assert.deepEqual([row.status, row.response_body], ['queued', null]);
  });

  test('requests are checked when queued: URL, method, headers, credential of the app, sizes, the queue limit', async () => {
    const bad: [string, unknown[], RegExp][] = [
      ['select meta.web_request($1)', ['file:///etc/passwd'], /must start with http/],
      ['select meta.web_request($1)', ['javascript:alert(1)'], /must start with http/],
      ['select meta.web_request($1)', ['http://user:pw@api.example.com/'], /must start with http/],
      ['select meta.web_request($1)', ['http://api.example.com/a b'], /no spaces/],
      ['select meta.web_request($1)', ['http://api.example.com/\r\nX: y'], /no spaces/],
      ['select meta.web_request($1, $2)', ['http://api.example.com/', 'TRACE'], /method is one of/],
      ['select meta.web_request($1, p_headers => $2)', ['http://api.example.com/', '{"X-A": "1\\r\\nInjected: yes"}'], /without line breaks/],
      ['select meta.web_request($1, p_headers => $2)', ['http://api.example.com/', '{"Bad Name": "1"}'], /not a valid header name/],
      ['select meta.web_request($1, p_headers => $2)', ['http://api.example.com/', '{"Host": "evil.example.com"}'], /set by the server/],
      ['select meta.web_request($1, p_headers => $2)', ['http://api.example.com/', '{"X-N": 1}'], /is a string/],
      ['select meta.web_request($1, p_headers => $2)', ['http://api.example.com/', '["x"]'], /JSON object/],
      ['select meta.web_request($1, p_body => $2)', ['http://api.example.com/', 'x'.repeat(1_000_001)], /larger than 1 MB/],
      ['select meta.web_request($1, p_timeout_s => 3600)', ['http://api.example.com/'], /1 to 60 seconds/],
      // another application's credential is not found from this one
      ['select meta.web_request($1, p_credential => $2)', ['http://api.example.com/', 'SEC5_TOKEN'], /web credential SEC5_TOKEN does not exist/],
      ['select meta.web_request_source($1)', ['NO_SUCH_SOURCE'], /does not exist in this application/],
      ['select meta.web_request_source($1, $2)', ['CRM_CONTACTS', '{"a": 1}'], /JSON object of strings/],
    ];
    for (const [sql, params, re] of bad) await fails(appId, sql, params, re);
    // no application: refused
    await assert.rejects(runtime.query(`select meta.web_request('https://api.example.com/')`), /no current application/);
    // the queue limit
    await fails(other, `select meta.web_request('https://api.example.com/q') from generate_series(1, 101)`, [], /100 requests waiting/, null);
    await owner.query('delete from meta.web_request_log where app_id = $1', [other]);
  });

  test('the server makes it with the allow-list, the address checks and the credential URL limits', async () => {
    const wr = await import('../src/webrequests.ts');
    const at = (url: string, more: Record<string, unknown> = {}) =>
      wr.execute(other, { id: '0', source: null, params: null, url, method: 'GET', headers: {}, body: null, credential: null, timeout_s: 5, ...more });
    // 127.0.0.1 is allowed but private (PGAPEX_REST_PRIVATE_HOSTS unset): refused before connecting
    let r = await at(`${mockBase}/x`);
    assert.equal(r.status, 'error');
    assert.match(r.message!, /private, loopback or link-local/);
    r = await at('http://169.254.169.254/latest/meta-data/');
    assert.match(r.message!, /allow-list/);
    r = await at('http://evil.example.org/');
    assert.match(r.message!, /allow-list/);
    assert.equal(hits.length, 0);
    // a credential that is valid for one URL only is not sent elsewhere
    await owner.query(`update meta.web_credential set valid_for = '{https://api.example.com/only}' where app_id = $1 and name = 'SEC5_TOKEN'`, [other]);
    r = await at('https://api.example.com/other', { credential: 'SEC5_TOKEN' });
    assert.match(r.message!, /not valid for this URL/);
    assert.ok(!JSON.stringify(r).includes('other-app-s3cret'));
    // a header that smuggles a line break (edited in the table by the owner) is dropped, not sent
    process.env.PGAPEX_REST_PRIVATE_HOSTS = '127.0.0.1';
    try {
      r = await at(`${mockBase}/h`, { headers: { 'x-ok': 'fine', 'x-bad': 'a\r\nInjected: 1' } });
      assert.equal(r.status, 'ok');
      assert.equal(hits.at(-1)!.headers['x-ok'], 'fine');
      assert.equal(hits.at(-1)!.headers['injected'], undefined);
      assert.equal(hits.at(-1)!.headers['x-bad'], undefined);
    } finally {
      delete process.env.PGAPEX_REST_PRIVATE_HOSTS;
    }
  });

  test('meta.parse_data refuses what it can not parse safely and stays within its limits', async () => {
    await assert.rejects(runtime.query(`select * from meta.parse_data('\\x504b0304'::bytea)`), /Excel/);
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>', 'UTF8'))`), /DTD or entity/);
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to('a', 'UTF8'), p_delimiter => '"')`), /delimiter is one character/);
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to('a', 'UTF8'), p_format => 'pdf')`), /format is auto/);
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to('[1, 2]', 'UTF8'))`), /must be an object/);
    // values are data: a quote or SQL in a cell is just text
    const r = (await runtime.query(`select cols, data from meta.parse_data(convert_to($1, 'UTF8'))`, [`"x'); drop table meta.app; --",b\n"<script>",2\n`])).rows;
    assert.deepEqual(r[0].cols, ['<script>', '2']);
    assert.deepEqual(Object.keys(r[0].data), ['b', 'x_drop_table_meta_app']);
    // the row limit is capped
    await assert.rejects(runtime.query(`select count(*) from meta.parse_data(convert_to(repeat(E'1\\n', 3), 'UTF8'), p_headers => false, p_max_rows => 2)`), /at most 2/);
  });
});

describe('sprint 33 item 6: Theme Roller style variants and template options', () => {
  const styleTag = (body: string) => /<style nonce="[^"]+" id="pgapex-css">([\s\S]*?)<\/style>/.exec(body)?.[1] ?? '';

  test('stored style values and names cannot inject CSS or HTML', async () => {
    const before = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    const evil = [
      { name: 'Evil', accent: 'red;}body{display:none', header: '#123456', font: 'serif;}*{color:red', radius: '0;}x{', font_size: '99px' },
      { name: '</style><script>alert(1)</script>', accent: '#654321' },
      { name: 'Fine', accent: '#0a0b0c', font: 'mono' },
    ];
    await owner.query(`update meta.app set theme = $2 where id = $1`, [appId, JSON.stringify({ styles: evil, style: 'Evil', style_choice: true })]);
    try {
      const king = await as('king');
      let body = (await king.get('/a/hr/1')).body;
      let css = styleTag(body);
      assert.doesNotMatch(css, /display:none|color:red|x\{|99px|#123456/, 'an invalid style is skipped entirely');
      assert.doesNotMatch(body, /<script>alert\(1\)/);
      assert.doesNotMatch(body, /value="&lt;\/style&gt;/, 'an invalid name is not offered');
      // a forged choice of the invalid style is refused; a valid one works
      await king.post('/a/hr/account/style', { __csrf: king.lastCsrf,  style: '</style><script>alert(1)</script>', next: '/a/hr/1' });
      css = styleTag((await king.get('/a/hr/1')).body);
      assert.doesNotMatch(css, /#654321/);
      await king.post('/a/hr/account/style', { __csrf: king.lastCsrf,  style: 'Fine', next: '/a/hr/1' });
      body = (await king.get('/a/hr/1')).body;
      assert.match(styleTag(body), /--accent:#0a0b0c/);
      assert.match(styleTag(body), /--font:ui-monospace/);
    } finally {
      await owner.query(`update meta.app set theme = $2 where id = $1`, [appId, JSON.stringify(before)]);
      await owner.query('delete from meta.account_style where app_id = $1', [appId]);
    }
  });

  test('the style switch needs the CSRF token, stays in the app and only picks the app\'s own styles', async () => {
    const before = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    await owner.query(`update meta.app set theme = theme || $2::jsonb where id = $1`, [appId, JSON.stringify({ styles: [{ name: 'Own', accent: '#0a0b0c' }], style_choice: true })]);
    const other = (await owner.one(`insert into meta.app (alias, name, authentication, theme) values ('sec6-other', 'Other', 'none', $1) returning id`,
      [JSON.stringify({ styles: [{ name: 'Foreign', accent: '#fe0000' }], style_choice: true })])).id;
    try {
      const king = await as('king');
      await king.get('/a/hr/1');
      const forged = await king.post('/a/hr/account/style', { __csrf: 'forged', style: 'Own', next: '/a/hr/1' });
      assert.equal(forged.statusCode, 303);
      assert.doesNotMatch(styleTag((await king.get('/a/hr/1')).body), /#0a0b0c/, 'forged post ignored');
      const away = await king.post('/a/hr/account/style', { __csrf: king.lastCsrf,  style: 'Own', next: 'https://evil.example/' });
      assert.equal(away.headers.location, '/a/hr/1', 'no open redirect');
      assert.match(styleTag((await king.get('/a/hr/1')).body), /#0a0b0c/);
      await king.post('/a/hr/account/style', { __csrf: king.lastCsrf,  style: 'Foreign', next: '/a/hr/1' });
      const css = styleTag((await king.get('/a/hr/1')).body);
      assert.doesNotMatch(css, /#fe0000/, 'another app\'s style can not be chosen');
      assert.match(css, /#0a0b0c/);
      // the account table refuses a malformed name even from the runtime connection
      await assert.rejects(runtime.query(`insert into meta.account_style (account_id, app_id, style) select id, $1, '}<x' from meta.account where username = 'king'
                                          on conflict (account_id, app_id) do update set style = excluded.style`, [appId]), /check constraint/);
      // the runtime can not read or change the apps' definitions through it
      await assert.rejects(runtime.query(`update meta.app set theme = '{}' where id = $1`, [appId]), /permission denied/);
    } finally {
      await owner.query(`update meta.app set theme = $2 where id = $1`, [appId, JSON.stringify(before)]);
      await owner.query('delete from meta.account_style where app_id = $1', [appId]);
      await owner.query('delete from meta.app where id = $1', [other]);
    }
  });

  test('the Theme Roller pages need a developer and the CSRF token; values are checked', async () => {
    const anon = new FileBrowser(app);
    assert.equal((await anon.get(`/builder/apps/${appId}/theme`)).statusCode, 302);
    assert.equal((await anon.post(`/builder/apps/${appId}/theme/styles`, { __csrf: 'x', name: 'X' })).statusCode, 302);
    const dev = new FileBrowser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get(`/builder/apps/${appId}/theme`);
    const before = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
    try {
      assert.equal((await dev.post(`/builder/apps/${appId}/theme/styles`, { __csrf: 'forged', name: 'X' })).statusCode, 403);
      assert.equal((await dev.post(`/builder/apps/${appId}/theme/settings`, { __csrf: 'forged', style_choice: 'true' })).statusCode, 403);
      for (const bad of <Record<string, string>[]>[
        { name: '<script>' }, { name: 'x;}' }, { name: 'A', accent: 'red', accent_own: 'true' }, { name: 'A', font: 'Comic Sans' },
        { name: 'A', font_size: '100px' }, { name: 'A', radius: '__proto__' },
      ])
        await dev.submit(`/builder/apps/${appId}/theme/styles`, bad);
      const theme = (await owner.one('select theme from meta.app where id = $1', [appId])).theme;
      assert.deepEqual(theme.styles ?? [], before.styles ?? [], 'nothing invalid saved');
      assert.equal((await dev.get('/builder/apps/999999999/theme')).statusCode, 404);
      assert.equal((await dev.get('/builder/apps/x/theme')).statusCode, 404);
    } finally {
      await owner.query(`update meta.app set theme = $2 where id = $1`, [appId, JSON.stringify(before)]);
    }
  });

  test('template options: the database checks the shape, the page keeps only the fixed list', async () => {
    const r = await owner.one(`select r.id, r.template_options from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 1 order by r.seq limit 1`, [appId]);
    await assert.rejects(owner.query(`update meta.region set template_options = '{"x\\" onclick=alert(1)"}' where id = $1`, [r.id]), /check constraint/);
    await assert.rejects(owner.query(`update meta.region set template_options = $2 where id = $1`, [r.id, Array.from({ length: 13 }, (_, i) => `a${i}`)]), /check constraint/);
    await owner.query(`update meta.region set template_options = '{to-accent,btn-hot,t-header}' where id = $1`, [r.id]);
    try {
      const body = (await (await as('king')).get('/a/hr/1')).body;
      const cls = new RegExp(`<section class="([^"]*)" id="R${r.id}"`).exec(body)?.[1] ?? '';
      assert.match(cls, / to-accent/);
      assert.doesNotMatch(cls, /btn-hot|t-header/, 'well-formed but unlisted classes are ignored');
    } finally {
      await owner.query(`update meta.region set template_options = $2 where id = $1`, [r.id, r.template_options]);
    }
  });
});

describe('sprint 34 working copies', () => {
  const MAIN = 'wc-sec';
  let mainId: number;
  let dev: FileBrowser;
  before(async () => {
    await owner.query('delete from meta.app where alias like $1', [`${MAIN}%`]);
    mainId = (await owner.one(`select meta.import_app(meta.export_app('hr'), $1) as id`, [MAIN])).id;
    dev = new FileBrowser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  });
  after(async () => {
    await owner.query('delete from meta.app where alias like $1', [`${MAIN}%`]);
  });

  test('the pages need a developer and the CSRF token', async () => {
    const anon = new FileBrowser(app);
    assert.equal((await anon.get(`/builder/apps/${mainId}/working-copies`)).statusCode, 302);
    assert.equal((await anon.post('/builder/working-copies', { __csrf: 'x', main_app_id: String(mainId), name: 'anon' })).statusCode, 302);
    await dev.get(`/builder/apps/${mainId}/working-copies`);
    assert.equal((await dev.post('/builder/working-copies', { __csrf: 'forged', main_app_id: String(mainId), name: 'forged' })).statusCode, 403);
    assert.equal(await owner.one(`select 1 from meta.working_copy where main_app_id = $1`, [mainId]), undefined);
    for (const name of ['<b>x</b>', '../up', 'a'.repeat(41), '-lead']) await dev.submit('/builder/working-copies', { main_app_id: String(mainId), name });
    assert.equal(await owner.one(`select 1 from meta.working_copy where main_app_id = $1`, [mainId]), undefined, 'bad names refused');
    assert.equal((await dev.get('/builder/apps/x/working-copies')).statusCode, 404);
    assert.equal((await dev.submit(`/builder/apps/${mainId}/merge`, { state: 'x', direction: 'merge' })).statusCode, 404, 'only a copy merges');
  });

  test('merging respects locks and the comparison shown; differences are escaped; the copy table is closed to the runtime', async () => {
    await dev.get(`/builder/apps/${mainId}/working-copies`);
    await dev.submit('/builder/working-copies', { main_app_id: String(mainId), name: 'sec' });
    const copyId = (await owner.one(`select app_id from meta.working_copy where main_app_id = $1`, [mainId])).app_id;
    const lov = (id: number) => owner.one(`select query from meta.lov where app_id = $1 and name = 'JOBS'`, [id]);
    await owner.query(`update meta.lov set query = 'select ''</pre><script>x()</script>'' as d, 1 as r' where app_id = $1 and name = 'JOBS'`, [copyId]);
    const page = await dev.get(`/builder/apps/${copyId}/compare?c=${encodeURIComponent('shared/lovs/jobs')}`);
    assert.doesNotMatch(page.body, /<script>x\(\)/, 'differences are escaped');
    assert.equal((await dev.get(`/builder/apps/${copyId}/compare?c=${encodeURIComponent('../../etc/passwd')}`)).statusCode, 200, 'unknown components are only looked up');
    const state = /name="state" value="([0-9a-f]+)"/.exec(page.body)![1];
    const mainBefore = (await lov(mainId)).query;

    // another developer's page or application lock on the main application stops the merge
    await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 0, 'someone-else')`, [mainId]);
    try {
      await dev.submit(`/builder/apps/${copyId}/merge`, { state, direction: 'merge' });
      assert.equal((await lov(mainId)).query, mainBefore, 'locked: nothing merged');
    } finally {
      await owner.query(`delete from meta.builder_lock where app_id = $1`, [mainId]);
    }
    // a forged or stale fingerprint, a bad direction, a missing CSRF token
    await dev.submit(`/builder/apps/${copyId}/merge`, { state: 'f'.repeat(32), direction: 'merge' });
    assert.equal(await dev.submit(`/builder/apps/${copyId}/merge`, { state, direction: 'sideways' }).then((r) => r.statusCode), 400);
    assert.equal((await dev.post(`/builder/apps/${copyId}/merge`, { __csrf: 'forged', state, direction: 'merge' })).statusCode, 403);
    assert.equal((await lov(mainId)).query, mainBefore, 'still nothing merged');
    await dev.get(`/builder/apps/${copyId}/compare`);
    await dev.submit(`/builder/apps/${copyId}/merge`, { state, direction: 'merge' });
    assert.match((await lov(mainId)).query, /<script>x\(\)/, 'the real merge goes through');

    await assert.rejects(runtime.query('select * from meta.working_copy'), /permission denied/);
    // deleting needs a copy: the main application can not be deleted this way
    await dev.submit(`/builder/apps/${mainId}/working-copy/delete`, {});
    assert.ok(await owner.one('select 1 from meta.app where id = $1', [mainId]));
  });
});

describe('sprint 34 application types and subscriptions', () => {
  const P = 'sub-sec';
  let lib: number, sub: number;
  let dev: FileBrowser;
  const blank = async (alias: string, type = 'standard') =>
    (await owner.one(`insert into meta.app (alias, name, app_type) values ($1, $2, $3) returning id`, [alias, `App ${alias}`, type])).id as number;
  const lov = async (id: number) => (await owner.one(`select query from meta.lov where app_id = $1 and name = 'SECRET_LOV'`, [id]))?.query;
  before(async () => {
    await owner.query('delete from meta.app where alias like $1', [`${P}%`]);
    lib = await blank(`${P}-lib`, 'library');
    sub = await blank(`${P}-sub`);
    await owner.query(`insert into meta.lov (app_id, name, query) values ($1, 'SECRET_LOV', 'select 1 as d, 1 as r')`, [lib]);
    dev = new FileBrowser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  });
  after(async () => {
    await owner.query('delete from meta.app where alias like $1', [`${P}%`]);
  });

  test('the pages need a developer and the CSRF token; only offered components can be subscribed to', async () => {
    const anon = new FileBrowser(app);
    assert.equal((await anon.get(`/builder/apps/${sub}/subscriptions`)).statusCode, 302);
    assert.equal((await anon.post(`/builder/apps/${sub}/subscriptions`, { __csrf: 'x', component: `${lib}|lov|SECRET_LOV` })).statusCode, 302);
    await dev.get(`/builder/apps/${sub}/subscriptions`);
    assert.equal((await dev.post(`/builder/apps/${sub}/subscriptions`, { __csrf: 'forged', component: `${lib}|lov|SECRET_LOV` })).statusCode, 403);
    assert.equal(await lov(sub), undefined);
    // a standard application, an unknown kind or a table name in the kind are refused
    const std = await blank(`${P}-std`);
    await owner.query(`insert into meta.lov (app_id, name, query) values ($1, 'SECRET_LOV', 'select 2 as d, 2 as r')`, [std]);
    for (const component of [`${std}|lov|SECRET_LOV`, `${lib}|page|1`, `${lib}|__proto__|x`, `${lib}|lov;drop table meta.app|x`, `${lib}|account|admin`, 'garbage'])
      await dev.submit(`/builder/apps/${sub}/subscriptions`, { component });
    assert.equal(await lov(sub), undefined, 'nothing copied');
    assert.equal((await owner.one('select count(*)::int as n from meta.subscription where app_id = $1', [sub])).n, 0);
    // the subscriber's application lock (another developer) refuses subscribing
    await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 0, 'someone-else')`, [sub]);
    try {
      await dev.submit(`/builder/apps/${sub}/subscriptions`, { component: `${lib}|lov|SECRET_LOV` });
      assert.equal(await lov(sub), undefined, 'locked');
    } finally {
      await owner.query('delete from meta.builder_lock where app_id = $1', [sub]);
    }
  });

  test('publishing skips applications locked by another developer; the subscription table is closed to the runtime', async () => {
    await dev.get(`/builder/apps/${sub}/subscriptions`);
    await dev.submit(`/builder/apps/${sub}/subscriptions`, { component: `${lib}|lov|SECRET_LOV` });
    assert.equal(await lov(sub), 'select 1 as d, 1 as r');
    await owner.query(`update meta.lov set query = 'select 3 as d, 3 as r' where app_id = $1 and name = 'SECRET_LOV'`, [lib]);
    await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 0, 'someone-else')`, [sub]);
    try {
      await dev.get(`/builder/apps/${lib}/subscriptions`);
      await dev.submit(`/builder/apps/${lib}/subscriptions/publish`, { kind: 'lov', name: 'SECRET_LOV' });
      assert.equal(await lov(sub), 'select 1 as d, 1 as r', 'the locked subscriber is not changed');
    } finally {
      await owner.query('delete from meta.builder_lock where app_id = $1', [sub]);
    }
    await dev.submit(`/builder/apps/${lib}/subscriptions/publish`, { kind: 'lov', name: 'SECRET_LOV' });
    assert.equal(await lov(sub), 'select 3 as d, 3 as r');
    await assert.rejects(runtime.query('select * from meta.subscription'), /permission denied/);
    await assert.rejects(owner.query(`update meta.app set app_type = 'evil' where id = $1`, [sub]), /check constraint/);
    // a bad referrer never becomes the redirect
    dev.headers.referer = `https://evil.example/builder/apps/${lib}/shared?c=lov-1`;
    try {
      const res = await dev.request('POST', `/builder/apps/${sub}/subscriptions/refresh`, { __csrf: dev.lastCsrf });
      assert.equal(res.headers.location, `/builder/apps/${sub}/subscriptions`);
      dev.headers.referer = `http://localhost/builder/apps/${sub}/shared?c=lov-12`;
      assert.equal((await dev.request('POST', `/builder/apps/${sub}/subscriptions/refresh`, { __csrf: dev.lastCsrf })).headers.location, `/builder/apps/${sub}/shared?c=lov-12`);
    } finally {
      delete dev.headers.referer;
    }
  });
});

describe('sprint 35 appwizard', () => {
  const ALIASES = ['sec35-aw', 'sec35-aw-t'];
  const SRC = 'sec35_aw_src';
  const DEV = 'sec35_aw_dev';
  const DEV_PW = 'Sec35-aw-developer!';
  const cleanup = async () => {
    for (const alias of ALIASES) {
      const schema = alias.replace(/-/g, '_');
      await owner.query('delete from meta.app where alias = $1', [alias]);
      await owner.query(`drop schema if exists ${schema} cascade`);
      if ((await owner.query('select 1 from pg_roles where rolname = $1', [`app_${schema}`])).rowCount) {
        await owner.query(`drop owned by app_${schema}`);
        await owner.query(`drop role app_${schema}`);
      }
    }
    await owner.query(`drop schema if exists ${SRC} cascade`);
    await owner.query('delete from meta.developer where username = $1', [DEV]);
  };
  const builder = async (user = 'admin', password = 'admin', start = '/builder/create/paste') => {
    const b = new FileBrowser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: user, password })).statusCode, 303);
    await b.get(start);
    return b;
  };
  const PASTE = { title: 'Sec paste', data: 'Name,"<script>alert(1)</script>"\nAnn,<b>x</b>\n', headers: 'true' };
  before(async () => {
    await cleanup();
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
    await owner.query(`create schema ${SRC}`);
    await owner.query(`create table ${SRC}.thing (id int primary key, name text)`);
  });
  after(cleanup);

  test('pasted data and existing tables need a builder login and the CSRF token', async () => {
    const king = new FileBrowser(app);
    await king.login('king');
    for (const b of [new FileBrowser(app), king]) {
      assert.equal((await b.get('/builder/create/paste')).statusCode, 302);
      assert.equal((await b.get(`/builder/create/tables?schema=${SRC}`)).statusCode, 302);
      assert.equal((await b.post('/builder/create/paste', PASTE)).statusCode, 302);
      assert.equal((await b.post('/builder/create/tables', { schema: SRC, t_0: 'thing', alias: 'sec35-aw-t', name: 'x', authentication: 'none' })).statusCode, 302);
    }
    const dev = await builder();
    for (const token of [undefined, 'wrong']) {
      const form: Record<string, string> = token ? { __csrf: token } : {};
      assert.equal((await dev.post('/builder/create/paste', { ...form, ...PASTE })).statusCode, 403);
      assert.equal((await dev.post('/builder/create/tables', { ...form, schema: SRC, t_0: 'thing', alias: 'sec35-aw-t', name: 'x', authentication: 'none' })).statusCode, 403);
    }
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'sec35-aw-t'`)).rowCount, 0);
  });

  test("pasted data is a temporary file of the builder session; its text is escaped", async () => {
    const admin = await builder();
    const res = await admin.submit('/builder/create/paste', PASTE);
    assert.equal(res.statusCode, 303);
    const url = res.headers.location as string;
    const own = await admin.get(url);
    assert.equal(own.statusCode, 200);
    assert.doesNotMatch(own.body, /<script>alert\(1\)<\/script>|<b>x<\/b>/);
    const other = await builder(DEV, DEV_PW);
    const get = await other.get(url);
    assert.equal(get.statusCode, 302);
    assert.equal(get.headers.location, '/builder/create/file');
    const big = await admin.submit('/builder/create/paste', { ...PASTE, data: 'x'.repeat(4.5 * 1024 * 1024) });
    assert.equal(big.statusCode, 422);
    assert.match(big.body, /At most 4 MB of text can be pasted/);
  });

  test('existing tables: pgapex, system and unknown schemas are refused; only the schema\'s own tables count', async () => {
    const dev = await builder('admin', 'admin', '/builder/create/tables');
    const base = { alias: 'sec35-aw-t', name: 'Sec tables', authentication: 'none' };
    for (const schema of ['meta', 'pg_catalog', 'information_schema', 'pg_toast', 'no_such_schema', "x'; drop table meta.app; --"]) {
      const res = await dev.submit('/builder/create/tables', { ...base, schema, t_0: 'app', t_1: 'pg_class' });
      assert.equal(res.statusCode, 422, schema);
      assert.match(res.body, /Choose one of the schemas in the list/);
    }
    for (const t of ['app', 'meta.app', '../thing', 'thing"; drop table meta.app; --', 'pg_class'])
      assert.match((await dev.submit('/builder/create/tables', { ...base, schema: SRC, t_0: t })).body, /Choose at least one table or view/, t);
    assert.equal((await owner.query(`select 1 from meta.app where alias = 'sec35-aw-t'`)).rowCount, 0);
    assert.equal((await owner.one(`select to_regclass('meta.app') is not null as ok`)).ok, true);
    // the app's role gets the schema it was built on, not pgapex's tables
    const ok = await dev.submit('/builder/create/tables', { ...base, schema: SRC, t_0: 'thing' });
    assert.equal(ok.statusCode, 200);
    const priv = await owner.one(`select has_table_privilege('app_sec35_aw_t', '${SRC}.thing', 'select') as t, has_table_privilege('app_sec35_aw_t', 'meta.account', 'select') as m`);
    assert.deepEqual(priv, { t: true, m: false });
  });

  test('several sheets: sheet names are escaped; table, column, key and foreign key fields never become SQL', async () => {
    const { workbook } = await import('./xlsxbook.ts');
    const book = workbook([
      { name: '<img src=x onerror=alert(1)>', rows: [['ID', 'Name'], [1, 'A'], [2, 'B']] },
      { name: 'Items', rows: [['ID', 'Name', 'Img src x onerror alert 1 ID'], [1, 'x', 1]] },
    ]);
    const dev = await builder('admin', 'admin', '/builder/create/file');
    const up = await dev.upload('/builder/create/file', { headers: 'true' }, { file: { name: 'sec.xlsx', type: 'application/octet-stream', data: book } });
    assert.equal(up.statusCode, 303);
    const url = up.headers.location as string;
    const page = await dev.get(url);
    assert.doesNotMatch(page.body, /<img src=x/);
    assert.match(page.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    const base: Record<string, string> = {
      h: '1', name: 'Sec aw', alias: 'sec35-aw', schema: '', authentication: 'none',
      s0_on: 'true', s0_table: 'img', s0_key: '0', s0_name_0: 'id', s0_type_0: 'integer', s0_name_1: 'name', s0_type_1: 'text',
      s1_on: 'true', s1_table: 'items', s1_key: '0', s1_name_0: 'id', s1_type_0: 'integer', s1_name_1: 'name', s1_type_1: 'text', s1_name_2: 'other', s1_type_2: 'integer',
    };
    for (const [form, error] of [
      [{ s0_table: 'img; drop table meta.app; --' }, /the table name must be lower-case/],
      [{ s0_table: 'meta.app' }, /the table name must be lower-case/],
      [{ s1_name_1: 'name text); drop table meta.app; --' }, /is not a valid column name/],
      [{ s1_type_1: 'int); drop table meta.app; --' }, /unknown column type/],
      [{ schema: 'meta' }, /can&#39;t be the parsing schema/],
      [{ schema: 'pg_catalog' }, /can&#39;t be the parsing schema/],
    ] as [Record<string, string>, RegExp][]) {
      const res = await dev.submit(url, { ...base, ...form });
      assert.equal(res.statusCode, 422, JSON.stringify(form));
      assert.match(res.body, error);
    }
    assert.equal((await owner.one(`select to_regclass('meta.app') is not null as ok`)).ok, true);
    // a key or foreign key that wasn't proposed is ignored: no constraint to anything else
    const res = await dev.submit(url, { ...base, s0_key: '0 or 1=1', s0_name_0: 'img_no', fk_1_2: '0', fk_1_1: "0); drop table meta.app; --", fk_0_1: '1', fkp_1_2: '0' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 1500));
    const fks = (await owner.query(`select conrelid::regclass::text as t from pg_constraint where contype = 'f' and connamespace = 'sec35_aw'::regnamespace`)).rows;
    assert.deepEqual(fks, [], 'img has no file key (s0_key was not a column index), so nothing can refer to it');
    assert.equal((await owner.one(`select attidentity from pg_attribute where attrelid = 'sec35_aw.img'::regclass and attname = 'id'`)).attidentity, 'd');
    assert.equal((await owner.one(`select count(*)::int as n from sec35_aw.img`)).n, 2);
  });
});

describe('sprint 35 reporter', () => {
  let rid: number; // the Data Reporter region on HR page 36
  let pageId: number;
  let reportRegion: number; // the interactive report on HR page 2
  const P = () => `dr${rid}_`;
  const user = async (name: string) => {
    const b = new FileBrowser(app);
    await b.login(name);
    await b.get('/a/hr/36');
    return b;
  };
  const params = (extra: [string, string][] = []) => new URLSearchParams([[`${P()}src`, 'employees'], ...extra.map(([k, v]): [string, string] => [`${P()}${k}`, v])]).toString();
  const count = async (name: string) => (await owner.one(`select count(*)::int as n from meta.data_report where region_id = $1 and name = $2`, [rid, name])).n as number;
  let config: unknown;
  before(async () => {
    const r = await owner.one(`select r.id, r.page_id, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 36 and r.type = 'data_reporter'`, [appId]);
    rid = r.id;
    pageId = r.page_id;
    config = r.config;
    reportRegion = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId])).id;
  });
  after(async () => {
    await owner.query(`delete from meta.data_report where region_id = $1 and name like 'sec-%'`, [rid]);
    await owner.query(`update meta.region set config = $2, authz = null where id = $1`, [rid, JSON.stringify(config)]);
  });

  test('saving and deleting need the CSRF token, a signed-in user and the visible Data Reporter region of that page', async () => {
    const king = await user('king');
    assert.equal((await king.post(`/a/hr/36/reporter/${rid}/save`, { __csrf: 'forged', params: params(), name: 'sec-a' })).statusCode, 403);
    const anon = new FileBrowser(app);
    assert.ok([302, 303, 403].includes((await anon.post(`/a/hr/36/reporter/${rid}/save`, { __csrf: '', params: params(), name: 'sec-a' })).statusCode));
    assert.equal((await king.submit(`/a/hr/36/reporter/999999/save`, { params: params(), name: 'sec-a' })).statusCode, 403, 'unknown region');
    assert.equal((await king.submit(`/a/hr/36/reporter/${reportRegion}/save`, { params: params(), name: 'sec-a' })).statusCode, 403, 'not a Data Reporter region');
    assert.equal((await king.submit(`/a/hr/2/reporter/${rid}/save`, { params: params(), name: 'sec-a' })).statusCode, 403, 'a region of another page');
    await owner.query(`update meta.region set authz = 'ADMIN' where id = $1`, [rid]);
    try {
      const blake = await user('blake');
      assert.equal((await blake.submit(`/a/hr/36/reporter/${rid}/save`, { params: params(), name: 'sec-a' })).statusCode, 403, 'a region the user may not see');
    } finally {
      await owner.query(`update meta.region set authz = null where id = $1`, [rid]);
    }
    assert.equal(await count('sec-a'), 0);
    // and unknown sources are refused
    assert.equal((await king.submit(`/a/hr/36/reporter/${rid}/save`, { params: `${P()}src=secret`, name: 'sec-a' })).statusCode, 403);
    assert.equal(await count('sec-a'), 0);
  });

  test('a forged definition keeps only offered columns, whitelisted operators and functions', async () => {
    const king = await user('king');
    await king.submit(`/a/hr/36/reporter/${rid}/save`, {
      name: 'sec-forged',
      params: params([['col', 'ename'], ['col', 'username'], ['col', 'photo'], ['col', 'ename") from pg_authid --'], ['fc', 'username'], ['fo', 'eq'], ['fv', 'x'],
        ['fc', 'job'], ['fo', 'eq; drop table hr.emp'], ['fv', 'x'], ['g', 'username'], ['af', 'pg_sleep'], ['ac', 'sal'], ['af', 'sum'], ['ac', 'ename'], ['sc', 'username'], ['sd', 'desc'], ['ch', 'gantt']]),
    });
    const d = (await owner.one(`select definition from meta.data_report where region_id = $1 and name = 'sec-forged'`, [rid])).definition;
    assert.deepEqual(d, { source: 'employees', columns: ['ename'], filters: [], group: [], aggregates: [], sort: [], chart: null });
    // the same in the URL: not-offered columns never show
    const page = (await king.get(`/a/hr/36?${params([['col', 'username'], ['col', 'ename'], ['g', 'username'], ['af', 'count'], ['ac', 'username']])}`)).body;
    assert.doesNotMatch(page, /king<\/td>|data-label="Username"/);
  });

  test('filter values are literals and user text is escaped', async () => {
    const king = await user('king');
    const page = (await king.get(`/a/hr/36?${params([['fc', 'ename'], ['fo', 'eq'], ['fv', `x' or '1'='1`], ['col', 'ename']])}`)).body;
    assert.match(page, /No data found/);
    const xss = (await king.get(`/a/hr/36?${params([['fc', 'ename'], ['fo', 'contains'], ['fv', '"><script>alert(1)</script>']])}`)).body;
    assert.doesNotMatch(xss, /<script>alert\(1\)/);
    await king.submit(`/a/hr/36/reporter/${rid}/save`, { params: params(), name: 'sec-<img src=x onerror=alert(1)>', description: '<b>x</b>' });
    const home = (await king.get('/a/hr/36')).body;
    assert.doesNotMatch(home, /<img src=x|<b>x<\/b>/);
    assert.match(home, /sec-&lt;img/);
  });

  test('other users\' reports: private ones stay hidden, no one else may change or delete them', async () => {
    const king = await user('king');
    await king.submit(`/a/hr/36/reporter/${rid}/save`, { params: params(), name: 'sec-private' });
    const id = (await owner.one(`select id from meta.data_report where region_id = $1 and name = 'sec-private'`, [rid])).id;
    const blake = await user('blake');
    assert.match((await blake.get(`/a/hr/36?${P()}open=${id}`)).body, /That report is not available\./);
    await blake.submit(`/a/hr/36/reporter/${rid}/save`, { params: params([['col', 'sal']]), name: 'sec-stolen', rep: String(id), shared: 'true' });
    await blake.submit(`/a/hr/36/reporter/${rid}/delete`, { rep: String(id) });
    const row = await owner.one('select name, shared, definition from meta.data_report where id = $1', [id]);
    assert.deepEqual([row.name, row.shared, row.definition.columns], ['sec-private', false, []]);
    assert.equal(await count('sec-stolen'), 0);
    await owner.query(`update meta.data_report set shared = true where id = $1`, [id]);
    assert.match((await blake.get(`/a/hr/36?${P()}open=${id}`)).body, /sec-private/, 'shared: visible');
  });

  test('sharing follows the region\'s settings', async () => {
    await owner.query(`update meta.region set config = config || '{"share_authz": "ADMIN"}' where id = $1`, [rid]);
    const blake = await user('blake');
    assert.doesNotMatch((await blake.get(`/a/hr/36?${params()}`)).body, /name="shared"/);
    await blake.submit(`/a/hr/36/reporter/${rid}/save`, { params: params(), name: 'sec-share-b', shared: 'true' });
    const king = await user('king');
    assert.match((await king.get(`/a/hr/36?${params()}`)).body, /name="shared"/);
    await king.submit(`/a/hr/36/reporter/${rid}/save`, { params: params(), name: 'sec-share-k', shared: 'true' });
    await owner.query(`update meta.region set config = (config - 'share_authz') || '{"sharing": false}' where id = $1`, [rid]);
    await king.get('/a/hr/36');
    await king.submit(`/a/hr/36/reporter/${rid}/save`, { params: params(), name: 'sec-share-off', shared: 'true' });
    const shared = Object.fromEntries((await owner.query(`select name, shared from meta.data_report where region_id = $1 and name like 'sec-share-%'`, [rid])).rows.map((r) => [r.name, r.shared]));
    assert.deepEqual(shared, { 'sec-share-b': false, 'sec-share-k': true, 'sec-share-off': false });
    await owner.query(`update meta.region set config = config - 'sharing' where id = $1`, [rid]);
  });

  test('reports run as the application\'s role with row level security; pgapex\'s own tables are never a source', async () => {
    const scott = await user('scott');
    const body = (await scott.get(`/a/hr/36?${new URLSearchParams([[`${P()}src`, 'leave'], [`${P()}col`, 'empno']])}`)).body;
    const empno = (await owner.one(`select empno from hr.emp where username = 'scott'`)).empno;
    const total = (await owner.one('select count(*)::int as n from hr.leave_request')).n;
    const shown = [...body.matchAll(/data-label="Employee no\.">(\d+)</g)].map((m) => Number(m[1]));
    assert.ok(shown.includes(empno), 'scott sees his own leave requests');
    assert.ok(shown.length < total, 'but not everyone\'s');
    const allen = await user('allen');
    await owner.query(`update meta.region set config = $2 where id = $1`, [rid, JSON.stringify({ sources: [{ id: 'acc', schema: 'meta', table: 'account', columns: [{ name: 'username' }, { name: 'password_hash' }] }] })]);
    try {
      const page = (await allen.get(`/a/hr/36?${P()}src=acc`)).body;
      assert.match(page, /No data sources are set up/);
      assert.doesNotMatch(page, /\$2[aby]\$/);
    } finally {
      await owner.query(`update meta.region set config = $2 where id = $1`, [rid, JSON.stringify(config)]);
    }
  });

  test('applications reach the reports only through the view and functions', async () => {
    await assert.rejects(runtime.query('select * from meta.data_report'), /permission denied/);
    await assert.rejects(runtime.query(`insert into meta.data_report (app_id, region_id, username, name, definition) values (${appId}, ${rid}, 'x', 'x', '{}')`), /permission denied/);
    assert.equal((await runtime.query('select * from meta.data_reports')).rowCount, 0, 'no application context: nothing');
    await assert.rejects(runtime.query(`select meta.save_data_report(${rid}, null, 'x', null, '{}'::jsonb, true)`), /sign in|unknown/);
    assert.equal((await runtime.query(`select meta.delete_data_report(1) as d`)).rows[0].d, false);
  });

  test('the builder settings need a developer and the CSRF token, and refuse pgapex\'s own tables', async () => {
    const anon = new FileBrowser(app);
    assert.equal((await anon.post(`/builder/pages/${pageId}/region/${rid}/reporter`, { __csrf: 'x', new_object: '1' })).statusCode, 302);
    const dev = new FileBrowser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get(`/builder/pages/${pageId}?c=region-${rid}`);
    assert.equal((await dev.post(`/builder/pages/${pageId}/region/${rid}/reporter`, { __csrf: 'forged', new_object: '1' })).statusCode, 403);
    assert.equal((await dev.submit(`/builder/pages/${pageId}/region/${reportRegion}/reporter`, {})).statusCode, 404, 'not a Data Reporter region');
    const account = (await owner.one(`select 'meta.account'::regclass::oid::int as oid`)).oid;
    try {
      await dev.submit(`/builder/pages/${pageId}/region/${rid}/reporter`, { new_object: String(account), new_id: 'accounts' });
      const cfg = (await owner.one('select config from meta.region where id = $1', [rid])).config;
      assert.ok(!(cfg.sources ?? []).some((s: any) => s.schema === 'meta'));
    } finally {
      await owner.query(`update meta.region set config = $2 where id = $1`, [rid, JSON.stringify(config)]);
    }
  });
});

describe('sprint 35 sampledata', () => {
  const S = 'sec_sd';
  let dev: FileBrowser;
  before(async () => {
    await owner.query(`drop schema if exists ${S} cascade; create schema ${S};
      create table ${S}.item (id int generated by default as identity primary key, "odd col" text, label text not null);
      create table ${S}.slow (id int);
      create function ${S}.sleepy() returns trigger language plpgsql as $$ begin perform pg_sleep(0.3); return new; end $$;
      create trigger slow_ins before insert on ${S}.slow for each row execute function ${S}.sleepy();`);
    dev = new FileBrowser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  });
  after(async () => {
    await owner.query(`drop schema if exists ${S} cascade`);
    await owner.query(`delete from meta.data_generator where schema_name = $1`, [S]);
  });
  const base = (extra: Record<string, string> = {}) => ({ schema: S, t: 'item', rows_0: '3', c_0_0: 'id', g_0_0: 'skip', c_0_1: 'odd col', g_0_1: 'word', c_0_2: 'label', g_0_2: 'word', action: 'insert', ...extra });
  const items = async () => (await owner.one(`select count(*)::int as n from ${S}.item`)).n;

  test('the pages need a developer session and the CSRF token', async () => {
    const anon = new FileBrowser(app);
    assert.equal((await anon.get('/builder/sql/sample-data')).statusCode, 302);
    assert.equal((await anon.get(`/builder/sql/sample-data?schema=${S}&t=item`)).statusCode, 302);
    assert.equal((await anon.post('/builder/sql/sample-data', { __csrf: 'x', ...base() })).statusCode, 302);
    await dev.get('/builder/sql/sample-data');
    assert.equal((await dev.post('/builder/sql/sample-data', { __csrf: 'forged', ...base() })).statusCode, 403);
    assert.equal((await dev.post('/builder/sql/sample-data', { __csrf: 'forged', ...base({ action: 'save', name: 'forged' }) })).statusCode, 403);
    assert.equal(await items(), 0);
    const id = (await owner.one(`insert into meta.data_generator (name, schema_name) values ('sec gen', $1) returning id`, [S])).id;
    assert.equal((await anon.post(`/builder/sql/sample-data/${id}/delete`, { __csrf: 'x' })).statusCode, 302);
    assert.equal((await dev.post(`/builder/sql/sample-data/${id}/delete`, { __csrf: 'forged' })).statusCode, 403);
    assert.ok(await owner.one('select 1 from meta.data_generator where id = $1', [id]));
    assert.equal((await dev.get('/builder/sql/sample-data/1x')).statusCode, 404);
  });

  test('meta, pg_* and information_schema are refused; table and column names never reach SQL as text', async () => {
    await dev.get('/builder/sql/sample-data');
    const before = (await owner.one('select count(*)::int as n from meta.app')).n;
    for (const schema of ['meta', 'pg_catalog', 'information_schema', 'pg_toast']) {
      const step = await dev.get(`/builder/sql/sample-data?schema=${schema}&t=app`);
      assert.doesNotMatch(step.body, /name="rows_0"/, schema);
      const res = await dev.submit('/builder/sql/sample-data', { schema, t: 'app', rows_0: '2', c_0_0: 'alias', g_0_0: 'word', c_0_1: 'name', g_0_1: 'word', action: 'insert' });
      assert.equal(res.statusCode, 422, schema);
      assert.match(res.body, /not meta, information_schema or pg_\*/);
      const save = await dev.submit('/builder/sql/sample-data', { schema, t: 'app', rows_0: '2', action: 'save', name: `sec ${schema}` });
      assert.equal(save.statusCode, 422);
    }
    assert.equal((await owner.one('select count(*)::int as n from meta.app')).n, before);
    await assert.rejects(owner.query(`insert into meta.data_generator (name, schema_name) values ('bad', 'meta')`), /check constraint/);
    await assert.rejects(owner.query(`insert into meta.data_generator (name, schema_name) values ('bad', 'pg_catalog')`), /check constraint/);
    // a table name or a column name with SQL in it is only a name to look up
    const evil = await dev.submit('/builder/sql/sample-data', base({ t: `item"; drop table ${S}.item; --` }));
    assert.equal(evil.statusCode, 422);
    assert.match(evil.body, /no such table/);
    const col = await dev.submit('/builder/sql/sample-data', base({ c_0_1: `label") values ('x'); drop table ${S}.item; --`, g_0_1: 'word' }));
    assert.equal(col.statusCode, 200, 'unknown columns are ignored');
    assert.equal(await items(), 3);
  });

  test('values are bound: quotes, SQL and markup are stored as typed and shown escaped', async () => {
    await dev.get('/builder/sql/sample-data');
    const value = `x'); drop table ${S}.item; -- <script>alert(1)</script>`;
    const res = await dev.submit('/builder/sql/sample-data', base({ g_0_1: 'fixed', o_0_1: value, g_0_2: 'list', o_0_2: `a'b, "c"` }));
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /<script>alert\(1\)/);
    assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal((await owner.one(`select count(*)::int as n from ${S}.item where "odd col" = $1`, [value])).n, 3);
    // the SQL download quotes every value as a literal and every identifier
    const sql = await dev.submit('/builder/sql/sample-data', base({ g_0_1: 'fixed', o_0_1: value, action: 'sql', name: `x*/ drop table x; /*\nselect 1` }));
    assert.match(sql.body, /insert into "sec_sd"\."item" \("odd col", "label"\) values/);
    assert.match(sql.body, /'x''\); drop table sec_sd\.item; -- <script>alert\(1\)<\/script>'/);
    assert.match(String(sql.headers['content-disposition']), /^attachment; filename="[\w-]+\.sql"$/);
    assert.match(sql.body.split('\n')[0], /^-- x\*\/ drop table x; \/\*/, 'the name stays on the comment line');
    assert.equal(sql.body.split('\n')[1], 'begin;');
  });

  test('a run has a statement timeout and fails as a whole; the generator table is closed to the runtime', async () => {
    const old = process.env.SAMPLE_DATA_STATEMENT_TIMEOUT;
    const itemsBefore = await items();
    process.env.SAMPLE_DATA_STATEMENT_TIMEOUT = '100ms';
    try {
      await dev.get('/builder/sql/sample-data');
      const res = await dev.submit('/builder/sql/sample-data', { schema: S, t: ['item', 'slow'], rows_0: '2', c_0_0: 'id', g_0_0: 'skip', c_0_1: 'odd col', g_0_1: 'word', c_0_2: 'label', g_0_2: 'word', rows_1: '3', c_1_0: 'id', g_1_0: 'integer', o_1_0: '1..9', action: 'insert' });
      assert.equal(res.statusCode, 422);
      assert.match(res.body, /statement timeout/);
    } finally {
      if (old === undefined) delete process.env.SAMPLE_DATA_STATEMENT_TIMEOUT;
      else process.env.SAMPLE_DATA_STATEMENT_TIMEOUT = old;
    }
    assert.equal((await owner.one(`select count(*)::int as n from ${S}.slow`)).n, 0);
    assert.equal(await items(), itemsBefore, 'the rows of the first table are rolled back too');
    await assert.rejects(runtime.query('select * from meta.data_generator'), /permission denied/);
    // the row limit
    const big = await dev.submit('/builder/sql/sample-data', base({ rows_0: '100001' }));
    assert.equal(big.statusCode, 422);
    assert.match(big.body, /At most 100,000 rows/);
  });
});

describe('sprint 36 ai foundation', () => {
  const env = { ...process.env };
  const SVC = 'SEC_AI';
  const KEY = 'sk-ant-sec36-secret-key-value';
  const DEV = 'sec36_dev';
  const DEV_PW = 'Sec36-dev-password!';
  let mock: Awaited<ReturnType<typeof import('./ai-mock.ts').startAiMock>>;
  let admin: Browser;
  let plain: Browser;
  let svcId = 0;
  let other = 0;
  let role = '';
  before(async () => {
    process.env.PGAPEX_SECRET_KEY = 'security-test-secret-key-0123456789abcdef';
    mock = await (await import('./ai-mock.ts')).startAiMock();
    await owner.query(`delete from meta.ai_service where name like 'SEC_AI%'`);
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false) on conflict do nothing`, [DEV, DEV_PW]);
    admin = new Browser();
    await admin.get('/builder/login');
    await admin.post('/builder/login', { __csrf: admin.lastCsrf, username: 'admin', password: 'admin' });
    plain = new Browser();
    await plain.get('/builder/login');
    await plain.post('/builder/login', { __csrf: plain.lastCsrf, username: DEV, password: DEV_PW });
    role = (await owner.one(`select db_role from meta.app where id = $1`, [appId])).db_role;
    other = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ('sec36-other', 'Other', 'none', $1) returning id`, [role])).id;
  });
  after(async () => {
    await owner.query(`delete from meta.ai_service where name like 'SEC_AI%'`);
    await owner.query('delete from meta.app where id = $1', [other]);
    await owner.query('delete from meta.developer where username = $1', [DEV]);
    await mock.close();
    for (const k of ['PGAPEX_SECRET_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  });

  test('AI services are for administrators: anonymous users sign in, developers get 403, forged CSRF tokens 403', async () => {
    const anon = new Browser();
    assert.equal((await anon.get('/builder/ai')).statusCode, 302);
    assert.equal((await anon.post('/builder/ai', { __csrf: 'x', name: 'SEC_AI_ANON', provider: 'anthropic', model: 'm' })).statusCode, 302);
    const page = await plain.get('/builder/ai');
    assert.equal(page.statusCode, 403);
    assert.doesNotMatch((await plain.get('/builder/utilities')).body, /href="\/builder\/ai"/);
    await plain.get('/builder');
    assert.equal((await plain.post('/builder/ai', { __csrf: plain.lastCsrf, name: 'SEC_AI_DEV', provider: 'anthropic', model: 'm', base_url: 'http://evil.example' })).statusCode, 403);
    assert.equal((await owner.one(`select count(*)::int as n from meta.ai_service where name = 'SEC_AI_DEV'`)).n, 0);
    await admin.get('/builder/ai');
    assert.equal((await admin.post('/builder/ai', { __csrf: 'forged', name: 'SEC_AI_FORGED', provider: 'anthropic', model: 'm' })).statusCode, 403);
    assert.equal((await owner.one(`select count(*)::int as n from meta.ai_service where name = 'SEC_AI_FORGED'`)).n, 0);
    // the administrator adds the service used below
    await admin.get('/builder/ai');
    const res = await admin.post('/builder/ai', { __csrf: admin.lastCsrf, name: SVC, provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium',
      max_tokens: '1000', timeout_s: '30', base_url: `${mock.base}/claude`, api_key: KEY, enabled: 'true', refusal_fallback: 'true', description: '<img src=x onerror=alert(1)>' });
    assert.equal(res.statusCode, 303);
    svcId = (await owner.one('select id from meta.ai_service where name = $1', [SVC])).id;
    for (const [url, form] of [[`/builder/ai/${svcId}`, { model: 'x', base_url: 'http://evil.example' }], [`/builder/ai/${svcId}/apps`, { allow: String(appId) }],
      [`/builder/ai/${svcId}/test`, { prompt: 'hi' }], [`/builder/ai/${svcId}/delete`, {}]] as const) {
      assert.equal((await plain.get(`/builder/ai/${svcId}`)).statusCode, 403);
      assert.equal((await plain.post(url, { __csrf: plain.lastCsrf, ...form })).statusCode, 403, url);
      assert.equal((await admin.post(url, { __csrf: 'forged', ...form })).statusCode, 403, url);
    }
    const row = await owner.one('select model, base_url from meta.ai_service where id = $1', [svcId]);
    assert.deepEqual(row, { model: 'claude-opus-5-5', base_url: `${mock.base}/claude` });
    assert.equal((await owner.one('select count(*)::int as n from meta.app_ai_service where service_id = $1', [svcId])).n, 0);
    assert.equal(mock.seen.length, 0, 'no test request was made');
  });

  test('the API key is stored encrypted, never shown, logged, exported or readable by applications', async () => {
    const enc = (await owner.one('select api_key_enc from meta.ai_service where id = $1', [svcId])).api_key_enc;
    assert.match(enc, /^v1:/);
    assert.ok(!enc.includes(KEY));
    const page = (await admin.get(`/builder/ai/${svcId}`)).body;
    const list = (await admin.get('/builder/ai')).body;
    for (const body of [page, list]) {
      assert.ok(!body.includes(KEY) && !body.includes(enc.slice(3, 30)), 'neither the key nor its ciphertext reaches the page');
      assert.doesNotMatch(body, /<img src=x/);
    }
    assert.match(page, /stored \(encrypted\)|A key is stored/);
    // saving without a key keeps it; the field never carries a value
    assert.doesNotMatch(page, /name="api_key"[^>]*value="[^"]/);
    await admin.post(`/builder/ai/${svcId}`, { __csrf: admin.lastCsrf, provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', max_tokens: '1000', timeout_s: '30', base_url: `${mock.base}/claude`, enabled: 'true', refusal_fallback: 'true', api_key: '' });
    assert.equal((await owner.one('select api_key_enc from meta.ai_service where id = $1', [svcId])).api_key_enc, enc);
    // applications can't read services, access, usage or requests
    for (const t of ['ai_service', 'app_ai_service', 'ai_usage', 'ai_request'])
      await assert.rejects(runtime.query(`select * from meta.${t}`), /permission denied/, t);
    await assert.rejects(runtime.tx(async (c) => {
      await c.query(`set local role ${role}`);
      await c.query('select api_key_enc from meta.ai_service');
    }), /permission denied/);
    // an export of an application that uses the service names neither the key nor the service row
    await admin.get(`/builder/ai/${svcId}`);
    await admin.post(`/builder/ai/${svcId}/apps`, { __csrf: admin.lastCsrf, allow: String(appId) });
    const doc = JSON.stringify((await owner.one(`select meta.export_app('hr') as d`)).d);
    assert.ok(!doc.includes(enc) && !doc.includes(KEY));
    assert.doesNotMatch(doc, /SEC_AI/);
  });

  test('settings are checked: base URL scheme, model name, limits; base URL only from the administrator page', async () => {
    await admin.get(`/builder/ai/${svcId}`);
    for (const [field, value] of [['base_url', 'javascript:alert(1)'], ['base_url', 'file:///etc/passwd'], ['model', 'claude"; drop table x'], ['max_tokens', '999999'], ['timeout_s', '1']]) {
      await admin.post(`/builder/ai/${svcId}`, { __csrf: admin.lastCsrf, provider: 'anthropic', model: 'claude-opus-5-5', max_tokens: '1000', timeout_s: '30', base_url: `${mock.base}/claude`, enabled: 'true', [field]: value });
      const row = await owner.one('select model, base_url, max_tokens, timeout_s from meta.ai_service where id = $1', [svcId]);
      assert.deepEqual(row, { model: 'claude-opus-5-5', base_url: `${mock.base}/claude`, max_tokens: 1000, timeout_s: 30 }, `${field}=${value}`);
    }
    await assert.rejects(owner.query(`update meta.ai_service set base_url = 'ftp://x' where id = $1`, [svcId]), /check constraint/);
    await assert.rejects(owner.query(`insert into meta.ai_service (name, provider, model) values ('sec_ai_lower', 'anthropic', 'm')`), /check constraint/);
    await assert.rejects(owner.query(`insert into meta.ai_service (name, provider, model) values ('SEC_AI_P', 'evil', 'm')`), /check constraint/);
    await admin.get(`/builder/ai/${svcId}`);
    for (const v of ['-1', '1.5', 'abc'])
      await admin.post(`/builder/ai/${svcId}/apps`, { __csrf: admin.lastCsrf, allow: String(appId), [`req_${appId}`]: v });
    assert.equal((await owner.one('select max_requests from meta.app_ai_service where app_id = $1 and service_id = $2', [appId, svcId])).max_requests, null);
  });

  test('the builder test shows the model\'s answer escaped and logs no prompt or answer', async () => {
    mock.mode = 'text';
    mock.answer = '<script>alert(1)</script> answer';
    await admin.get(`/builder/ai/${svcId}`);
    assert.equal((await admin.post(`/builder/ai/${svcId}/test`, { __csrf: admin.lastCsrf, prompt: 'Say <b>hi</b>' })).statusCode, 303);
    const body = (await admin.get(`/builder/ai/${svcId}`)).body;
    assert.doesNotMatch(body, /<script>alert\(1\)<\/script> answer/);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt; answer/);
    assert.equal(mock.seen.at(-1)!.headers['x-api-key'], KEY);
    const u = await owner.one(`select * from meta.ai_usage where service_id = $1 order by id desc limit 1`, [svcId]);
    assert.equal(u.source, 'builder');
    assert.doesNotMatch(JSON.stringify(u), /hi|script|answer|sk-ant/);
  });

  test('SQL requests are confined to the calling application and its own transaction', async () => {
    const asApp = <T>(app: number, fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>) =>
      runtime.tx(async (c) => {
        await c.query(`select set_config('pgapex.app_id', $1, true)`, [String(app)]);
        await c.query(`set local role ${role}`);
        return fn(async (sql, params = []) => (await c.query(sql, params)).rows);
      });
    // the other application is not allowed: it can't queue, and meta.ai_available says so
    assert.equal((await asApp(other, (q) => q('select meta.ai_available($1) as ok', [SVC])))[0].ok, false);
    assert.equal((await asApp(appId, (q) => q('select meta.ai_available($1) as ok', [SVC])))[0].ok, true);
    await assert.rejects(asApp(other, (q) => q(`select meta.ai_generate($1, 'x')`, [SVC])), /may not use it/);
    const id = (await asApp(appId, (q) => q(`select meta.ai_generate($1, 'secret prompt') as id`, [SVC])))[0].id;
    try {
      assert.equal((await asApp(other, (q) => q('select meta.ai_result($1) as r', [id])))[0].r, null, 'another application sees nothing');
      // a later transaction can neither take nor complete it
      const taken = await asApp(appId, async (q) => {
        await q(`select set_config('pgapex.ai_pending', '1', true)`);
        return q('select * from meta.ai_request_take(10)');
      });
      assert.equal(taken.length, 0);
      await asApp(appId, (q) => q(`select meta.ai_request_done($1, 'ok', 'forged', null)`, [id]));
      assert.equal((await owner.one('select status, response from meta.ai_request where id = $1', [id])).response, null);
      // size limits and the queue limit
      await assert.rejects(asApp(appId, (q) => q(`select meta.ai_generate($1, repeat('x', 200001))`, [SVC])), /1 to 200000 characters/);
      await assert.rejects(asApp(appId, (q) => q(`select meta.ai_generate($1, '')`, [SVC])), /1 to 200000 characters/);
      await assert.rejects(asApp(appId, async (q) => {
        for (let i = 0; i < 21; i++) await q(`select meta.ai_generate($1, 'x')`, [SVC]);
      }), /20 AI requests waiting/);
    } finally {
      await owner.query('delete from meta.ai_request where app_id = $1', [appId]);
    }
  });

  test('a dynamic action runs only a Generate text with AI process of its page, with that process\'s authorization', async () => {
    const pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 936, 'AI sec', false) returning id`, [other])).id;
    try {
      await owner.query(`insert into meta.app_ai_service (app_id, service_id) values ($1, $2)`, [other, svcId]);
      await owner.query(`insert into meta.authz_scheme (app_id, name, type, value, error_message) values ($1, 'NOBODY', 'sql', 'false', 'No.')`, [other]);
      const region = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 10, 'R', 'static', '') returning id`, [pageId])).id;
      await owner.query(`insert into meta.item (page_id, region_id, seq, name, type) values ($1, $2, 1, 'P936_TEXT', 'text'), ($1, $2, 2, 'P936_OUT', 'text')`, [pageId, region]);
      const conf = JSON.stringify({ service: SVC, prompt: '&P936_TEXT.', output_item: 'P936_OUT' });
      await owner.query(`insert into meta.process (page_id, seq, name, type, point, config, authz) values ($1, 1, 'Locked', 'ai_generate', 'submit', $2, 'NOBODY'), ($1, 2, 'Sql', 'sql', 'submit', '{}', null)`, [pageId, conf]);
      await owner.query(`update meta.process set code = 'select 1' where page_id = $1 and name = 'Sql'`, [pageId]);
      const das = (await owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, code) values
        ($1, 1, 'locked', 'click', 'X', 'ai_generate', 'Locked'), ($1, 2, 'not ai', 'click', 'X', 'ai_generate', 'Sql') returning id`, [pageId])).rows.map((r) => r.id);
      const b = new Browser();
      await b.get(`/a/sec36-other/936`);
      const before = mock.seen.length;
      assert.equal((await b.post(`/a/sec36-other/936/da/${das[0]}`, { __csrf: b.lastCsrf, P936_TEXT: 'x' })).statusCode, 403);
      const res = await b.post(`/a/sec36-other/936/da/${das[1]}`, { __csrf: b.lastCsrf, P936_TEXT: 'x' });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /no \\"Generate text with AI\\" process named/);
      assert.equal(mock.seen.length, before, 'no AI call');
    } finally {
      await owner.query('delete from meta.page where id = $1', [pageId]);
      await owner.query('delete from meta.app_ai_service where app_id = $1', [other]);
    }
  });
});

describe('sprint 36 ai assistant', () => {
  const env = { ...process.env };
  const SVC = 'HR_ASSISTANT';
  let mock: Awaited<ReturnType<typeof import('./ai-script-mock.ts').startScriptMock>>;
  let svcId = 0;
  let chat = 0;
  let report = 0;
  let pageId = 0;
  const calls = () => mock.seen.length;
  before(async () => {
    process.env.PGAPEX_SECRET_KEY = 'security-test-secret-key-0123456789abcdef';
    const { encryptSecret } = await import('../src/secrets.ts');
    mock = await (await import('./ai-script-mock.ts')).startScriptMock();
    await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
    svcId = (await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc) values ($1, 'anthropic', 'claude-opus-5-5', $2, $3) returning id`,
      [SVC, `${mock.base}/claude`, encryptSecret('sk-ant-sec-assistant')])).id;
    await owner.query(`insert into meta.app_ai_service (app_id, service_id) values ($1, $2)`, [appId, svcId]);
    const regions = (await owner.query(`select r.id, r.type, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 38`, [appId])).rows;
    chat = regions.find((r) => r.type === 'ai_assistant').id;
    report = regions.find((r) => r.type === 'report').id;
    pageId = regions[0].page_id;
  });
  after(async () => {
    await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
    await owner.query(`update meta.page set requires_auth = true where id = $1`, [pageId]);
    await mock.close();
    if (env.PGAPEX_SECRET_KEY === undefined) delete process.env.PGAPEX_SECRET_KEY;
    else process.env.PGAPEX_SECRET_KEY = env.PGAPEX_SECRET_KEY;
  });

  test('forged CSRF tokens are refused before any AI call', async () => {
    const b = await as('scott');
    await b.get('/a/hr/38');
    const before = calls();
    for (const url of [`/a/hr/38/assistant/${chat}/send`, `/a/hr/38/assistant/${chat}/clear`, `/a/hr/38/report/${report}/ask`])
      assert.equal((await b.post(url, { __csrf: 'forged', message: 'hi', question: 'hi' })).statusCode, 403, url);
    assert.equal(calls(), before);
  });

  test('a region the user can\'t see, of another page or of another type is refused', async () => {
    const b = await as('scott');
    await b.get('/a/hr/38');
    const before = calls();
    // the assistant's condition: meta.ai_available(...) is false while the service is off
    await owner.query('update meta.ai_service set enabled = false where id = $1', [svcId]);
    try {
      assert.equal((await b.post(`/a/hr/38/assistant/${chat}/send`, { __csrf: b.lastCsrf, message: 'hi' })).statusCode, 403);
    } finally {
      await owner.query('update meta.ai_service set enabled = true where id = $1', [svcId]);
    }
    assert.equal((await b.post(`/a/hr/37/assistant/${chat}/send`, { __csrf: b.lastCsrf, message: 'hi' })).statusCode, 403, 'not on that page');
    assert.equal((await b.post(`/a/hr/38/assistant/${report}/send`, { __csrf: b.lastCsrf, message: 'hi' })).statusCode, 403, 'not an assistant');
    assert.equal((await b.post(`/a/hr/38/report/${chat}/ask`, { __csrf: b.lastCsrf, question: 'hi' })).statusCode, 403, 'not a report');
    assert.equal(calls(), before);
  });

  test('signed-out users on a public page: no chat and no question box, posts refused', async () => {
    await owner.query(`update meta.page set requires_auth = false where id = $1`, [pageId]);
    try {
      const b = new Browser();
      const page = (await b.get('/a/hr/38')).body;
      assert.match(page, /Sign in to use the assistant/);
      assert.doesNotMatch(page, /name="message"/);
      assert.doesNotMatch(page, /class="ai-filter"/);
      const before = calls();
      assert.equal((await b.post(`/a/hr/38/assistant/${chat}/send`, { __csrf: b.lastCsrf, message: 'hi' })).statusCode, 403);
      assert.equal((await b.post(`/a/hr/38/report/${report}/ask`, { __csrf: b.lastCsrf, question: 'hi' })).statusCode, 403);
      assert.equal(calls(), before);
    } finally {
      await owner.query(`update meta.page set requires_auth = true where id = $1`, [pageId]);
    }
  });

  test('conversations: per session, not readable by applications, the model can\'t set APP_USER', async () => {
    const scott = await as('scott');
    await scott.get('/a/hr/38');
    mock.script = [{ tools: [{ name: 'my_leave', input: { STATUS: null, APP_USER: 'king' } }] }, { text: 'Secret answer for scott.' }];
    await scott.post(`/a/hr/38/assistant/${chat}/send`, { __csrf: scott.lastCsrf, message: 'my leave' });
    const result = mock.seen.at(-1)!.body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /Unknown argument "APP_USER"/);
    const blake = await as('blake');
    assert.doesNotMatch((await blake.get('/a/hr/38')).body, /Secret answer for scott/);
    await assert.rejects(runtime.query('select * from meta.ai_conversation'), /permission denied/);
    await assert.rejects(runtime.tx(async (c) => {
      await c.query(`set local role hr_app`);
      await c.query('select * from meta.ai_conversation');
    }), /permission denied/);
  });

  test('report questions: hidden columns are not offered; values stay literals', async () => {
    const r = await owner.one('select config from meta.region where id = $1', [report]);
    await owner.query(`update meta.region set config = config || '{"hidden": ["sal"]}' where id = $1`, [report]);
    try {
      const b = await as('scott');
      await b.get('/a/hr/38');
      mock.script = [{ text: JSON.stringify({ filters: [{ column: 'sal', operator: 'gt', value: '0' }, { column: 'ename', operator: 'eq', value: "x' or '1'='1" }], search: '', sort_column: '', sort_descending: false }) }];
      const res = await b.post(`/a/hr/38/report/${report}/ask`, { __csrf: b.lastCsrf, question: 'everyone' });
      const schema = mock.seen.at(-1)!.body.output_config.format.schema;
      assert.ok(!schema.properties.filters.items.properties.column.enum.includes('sal'), 'a hidden column is not offered');
      const loc = new URL(res.headers.location as string, 'http://x');
      assert.deepEqual(loc.searchParams.getAll(`r${report}_f`), ["ename|eq|x' or '1'='1"]);
      const page = (await b.get(`${loc.pathname}${loc.search}`)).body;
      assert.doesNotMatch(page, /alert-error/);
      assert.doesNotMatch(page, />SCOTT</, 'the quote is part of the value: no rows match');
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [report, JSON.stringify(r.config)]);
    }
  });

  test('builder settings: developers only, with CSRF; only an assistant region', async () => {
    const anon = new Browser();
    assert.equal((await anon.post(`/builder/pages/${pageId}/region/${chat}/assistant`, { __csrf: 'x', service: 'X' })).statusCode, 302);
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get('/builder');
    assert.equal((await dev.post(`/builder/pages/${pageId}/region/${chat}/assistant`, { __csrf: 'forged', service: 'X' })).statusCode, 403);
    assert.equal((await dev.post(`/builder/pages/${pageId}/region/${report}/assistant`, { __csrf: dev.lastCsrf, service: 'X' })).statusCode, 404);
    assert.equal((await dev.post(`/builder/pages/${pageId}/region/${chat}/ai-filter`, { __csrf: dev.lastCsrf, service: 'X' })).statusCode, 404);
    assert.equal((await owner.one('select config->>\'service\' as s from meta.region where id = $1', [chat])).s, SVC);
  });
});

describe('sprint 36 app builder ai', () => {
  const env = { ...process.env };
  const SVC = 'SEC_AI3';
  const DEV = 'sec36b_dev';
  const DEV_PW = 'Sec36b-dev-password!';
  let mock: Awaited<ReturnType<typeof import('./ai-script-mock.ts').startScriptMock>>;
  let admin: Browser;
  let dev: Browser;
  const signIn = async (user: string, pw: string) => {
    const b = new Browser();
    await b.get('/builder/login');
    await b.post('/builder/login', { __csrf: b.lastCsrf, username: user, password: pw });
    await b.get('/builder');
    return b;
  };
  before(async () => {
    process.env.PGAPEX_SECRET_KEY = 'security-test-secret-key-0123456789abcdef';
    const { encryptSecret } = await import('../src/secrets.ts');
    mock = await (await import('./ai-script-mock.ts')).startScriptMock();
    await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
    const id = (await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc) values ($1, 'anthropic', 'claude-opus-5-5', $2, $3) returning id`,
      [SVC, `${mock.base}/claude`, encryptSecret('sk-ant-sec-builder')])).id;
    await owner.query('update meta.builder_ai set service_id = $1', [id]);
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false) on conflict do nothing`, [DEV, DEV_PW]);
    admin = await signIn('admin', 'admin');
    dev = await signIn(DEV, DEV_PW);
  });
  after(async () => {
    await owner.query('update meta.builder_ai set service_id = null');
    await owner.query(`delete from meta.ai_service where name = $1`, [SVC]);
    await owner.query('delete from meta.developer where username = $1', [DEV]);
    await mock.close();
    if (env.PGAPEX_SECRET_KEY === undefined) delete process.env.PGAPEX_SECRET_KEY;
    else process.env.PGAPEX_SECRET_KEY = env.PGAPEX_SECRET_KEY;
  });

  test('builder AI pages need a developer session and CSRF; the service is chosen by administrators only', async () => {
    const anon = new Browser();
    for (const url of ['/builder/sql/ai', '/builder/sql/ai/describe', `/builder/apps/${appId}/ai-pages`]) assert.equal((await anon.get(url)).statusCode, 302, url);
    const before = mock.seen.length;
    for (const url of ['/builder/sql/ai/sql', '/builder/sql/ai/explain', '/builder/sql/ai/describe/draft', `/builder/apps/${appId}/ai-pages`])
      assert.equal((await dev.post(url, { __csrf: 'forged', schema: 'hr', table: 'dept', question: 'x', sql: 'x', description: 'x' })).statusCode, 403, url);
    assert.equal(mock.seen.length, before, 'no AI call');
    assert.equal((await dev.post('/builder/sql/ai/service', { __csrf: dev.lastCsrf, service: '' })).statusCode, 403);
    assert.ok((await owner.one('select service_id from meta.builder_ai')).service_id, 'unchanged');
    assert.doesNotMatch((await dev.get('/builder/sql/ai')).body, /name="service"/);
    assert.match((await admin.get('/builder/sql/ai')).body, /name="service"/);
  });

  test('model output is escaped and never run; the model sees no rows', async () => {
    mock.script = [{ text: JSON.stringify({ sql: "drop table hr.emp cascade; select '</textarea><script>alert(1)</script>'", explanation: '<script>alert(2)</script>' }) }];
    const res = await dev.post('/builder/sql/ai/sql', { __csrf: dev.lastCsrf, schema: 'hr', question: 'x' });
    assert.doesNotMatch(res.body, /<script>alert/);
    assert.match(res.body, /&lt;\/textarea&gt;&lt;script&gt;alert\(1\)/);
    assert.equal((await owner.one(`select to_regclass('hr.emp') is not null as ok`)).ok, true, 'nothing ran');
    assert.doesNotMatch(JSON.stringify(mock.seen.at(-1)!.body), /KING|BLAKE|ACCOUNTING/);
    mock.script = [{ text: JSON.stringify({ pages: [{ kind: 'grid', table: 'hr.emp', page: 1, form_page: null, label: '<b>x</b>', reason: '<script>alert(3)</script>' }] }) }];
    const pages = await dev.post(`/builder/apps/${appId}/ai-pages`, { __csrf: dev.lastCsrf, description: 'x' });
    assert.doesNotMatch(pages.body, /<script>alert|<b>x<\/b>/);
    assert.equal((await owner.one(`select count(*)::int as n from meta.page where app_id = $1 and name = '<b>x</b>'`, [appId])).n, 0, 'proposals create nothing by themselves');
  });

  test('describe tables: only existing tables outside pgapex and the system schemas; notes are plain text in comments', async () => {
    assert.equal((await dev.post('/builder/sql/ai/describe', { __csrf: dev.lastCsrf, schema: 'meta', table: 'developer', 'note:': 'x' })).statusCode, 404);
    assert.equal((await dev.post('/builder/sql/ai/describe', { __csrf: dev.lastCsrf, schema: 'hr', table: 'no_such_table', 'note:': 'x' })).statusCode, 404);
    assert.equal((await dev.post('/builder/sql/ai/describe', { __csrf: dev.lastCsrf, schema: 'hr', table: 'dept', 'note:': "x'; drop table hr.dept; --", comments: 'true' })).statusCode, 303);
    assert.equal((await owner.one(`select obj_description('hr.dept'::regclass, 'pg_class') as d`)).d, "x'; drop table hr.dept; --");
    await dev.post('/builder/sql/ai/describe', { __csrf: dev.lastCsrf, schema: 'hr', table: 'dept', 'note:': '', comments: 'true' });
    assert.equal((await owner.one(`select obj_description('hr.dept'::regclass, 'pg_class') as d`)).d, null);
    await assert.rejects(runtime.query('select * from meta.ai_table_note'), /permission denied/);
    await assert.rejects(runtime.query('select * from meta.builder_ai'), /permission denied/);
  });
});

describe('sprint 36 blueprints', () => {
  const ALIAS = 'sec36-bp';
  const DEV = 'sec36c_dev';
  const DEV_PW = 'Sec36c-dev-password!';
  let dev: Browser;
  const spec = (over: Record<string, unknown> = {}) => JSON.stringify({
    name: 'Sec blueprint', alias: ALIAS, schema: 'sec36_bp', authentication: 'none',
    tables: [{ name: 'item', columns: [{ name: 'title', type: 'text', values: ["a'); drop table hr.emp; --"] }] }],
    sample_data: [{ table: 'item', columns: ['title'], rows: [["a'); drop table hr.emp; --"]] }],
    ...over,
  });
  const cleanup = async () => {
    await owner.query(`delete from meta.app where alias like 'sec36-bp%'`);
    await owner.query(`delete from meta.blueprint where spec->>'alias' like 'sec36-bp%'`);
    await owner.query('drop schema if exists sec36_bp cascade');
    if ((await owner.query(`select 1 from pg_roles where rolname = 'app_sec36_bp'`)).rowCount) {
      await owner.query('drop owned by app_sec36_bp');
      await owner.query('drop role app_sec36_bp');
    }
  };
  before(async () => {
    await cleanup();
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false) on conflict do nothing`, [DEV, DEV_PW]);
    dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: DEV, password: DEV_PW });
    await dev.get('/builder');
  });
  after(async () => {
    await cleanup();
    await owner.query('delete from meta.developer where username = $1', [DEV]);
  });

  test('blueprint pages need a developer session and CSRF', async () => {
    const anon = new Browser();
    assert.equal((await anon.get('/builder/blueprints')).statusCode, 302);
    for (const url of ['/builder/blueprints/save', '/builder/blueprints/review', '/builder/blueprints/create', '/builder/blueprints/draft'])
      assert.equal((await dev.post(url, { __csrf: 'forged', name: 'x', spec: spec() })).statusCode, 403, url);
    assert.equal((await owner.one(`select count(*)::int as n from meta.blueprint where spec->>'alias' = $1`, [ALIAS])).n, 0);
  });

  test('only a reviewed blueprint is created, by the developer who reviewed it; values stay literals; names are checked', async () => {
    const review = await dev.post('/builder/blueprints/review', { __csrf: dev.lastCsrf, name: 'x', spec: spec() });
    const sig = /name="sig" value="([^"]+)"/.exec(review.body)![1];
    // another developer's session can't reuse the signature
    const other = new Browser();
    await other.get('/builder/login');
    await other.post('/builder/login', { __csrf: other.lastCsrf, username: 'admin', password: 'admin' });
    await other.get('/builder');
    assert.equal((await other.post('/builder/blueprints/create', { __csrf: other.lastCsrf, name: 'x', spec: spec(), sig })).statusCode, 403);
    assert.equal((await dev.post('/builder/blueprints/create', { __csrf: dev.lastCsrf, name: 'x', spec: spec({ schema: 'hr' }), sig })).statusCode, 403, 'a changed blueprint');
    assert.equal((await dev.post('/builder/blueprints/create', { __csrf: dev.lastCsrf, name: 'x', spec: spec(), sig })).statusCode, 303);
    assert.deepEqual((await owner.query('select title from sec36_bp.item')).rows, [{ title: "a'); drop table hr.emp; --" }]);
    assert.equal((await owner.one(`select to_regclass('hr.emp') is not null as ok`)).ok, true);
    for (const bad of [{ schema: 'meta' }, { schema: 'pg_temp' }, { schema: 'public' }, { tables: [{ name: 'x"; drop table hr.emp; --', columns: [{ name: 'a' }] }] }, { tables: [{ name: 'x', columns: [{ name: 'a', type: 'text; drop table hr.emp' }] }] }]) {
      const res = await dev.post('/builder/blueprints/review', { __csrf: dev.lastCsrf, name: 'x', spec: spec({ alias: 'sec36-bp-bad', ...bad }) });
      assert.match(res.body, /can't be created yet/, JSON.stringify(bad));
      assert.doesNotMatch(res.body, /name="sig"/);
    }
  });

  test('blueprints are not readable by applications', async () => {
    await assert.rejects(runtime.query('select * from meta.blueprint'), /permission denied/);
  });
});

describe('sprint 37 workspaces', () => {
  const DEV = 'sec37_ws_dev';
  const DEV_PW = 'Sec37-ws-dev-password!';
  const WS = 'Sec37 <b>ws</b>';
  let dev: Browser;
  let adm: Browser;
  let wsId: number;
  let hr: number;
  const cleanup = async () => {
    await owner.query('delete from meta.workspace_app where workspace_id in (select id from meta.workspace where name = $1)', [WS]);
    await owner.query('delete from meta.workspace where name = $1', [WS]);
    await owner.query('delete from meta.developer where username = $1', [DEV]);
  };
  before(async () => {
    await cleanup();
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
    wsId = (await owner.one(`insert into meta.workspace (name) values ($1) returning id`, [WS])).id;
    // the developer works in the new workspace only
    await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
    await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [wsId, DEV]);
    hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: DEV, password: DEV_PW });
    adm = new Browser();
    await adm.get('/builder/login');
    await adm.post('/builder/login', { __csrf: adm.lastCsrf, username: 'admin', password: 'admin' });
  });
  after(cleanup);

  test('applications of other workspaces are not found, for every builder route under /apps and /pages', async () => {
    const page = (await owner.one('select id from meta.page where app_id = $1 order by page_no limit 1', [hr])).id;
    const region = (await owner.one('select id from meta.region where page_id = $1 limit 1', [page]))?.id ?? 1;
    for (const url of [`/builder/apps/${hr}`, `/builder/apps/${hr}/export`, `/builder/apps/${hr}/shared`, `/builder/apps/${hr}/search?q=emp`, `/builder/apps/${hr}/debug`, `/builder/pages/${page}`])
      assert.equal((await dev.get(url)).statusCode, 404, url);
    await dev.get('/builder');
    for (const url of [`/builder/apps/${hr}/settings`, `/builder/apps/${hr}/delete`, `/builder/pages/${page}/c/region/${region}`, `/builder/pages/${page}/delete`, `/builder/apps/${hr}/lock`])
      assert.equal((await dev.post(url, { __csrf: dev.lastCsrf, name: 'pwned', title: 'pwned', page_no: '0' })).statusCode, 404, url);
    assert.notEqual((await owner.one('select name from meta.app where id = $1', [hr])).name, 'pwned');
    assert.ok(!(await owner.one('select 1 as ok from meta.builder_lock where app_id = $1 and locked_by = $2', [hr, DEV])));
    // working copies and boilerplates of another workspace by id
    assert.equal((await dev.post('/builder/working-copies', { __csrf: dev.lastCsrf, main_app_id: String(hr), name: 'sec37' })).statusCode, 404);
    assert.ok(!(await owner.one(`select 1 as ok from meta.app where alias = 'hr-sec37'`)));
    // the code editor's completions and checks for another workspace's application
    assert.equal((await dev.get(`/builder/code/completions?app=${hr}`)).statusCode, 404);
    assert.equal((await dev.get(`/builder/code/completions?page=${page}`)).statusCode, 404);
    assert.equal((await dev.post('/builder/code/check', { __csrf: dev.lastCsrf, shape: 'select', sql: 'select 1', app: String(hr) })).statusCode, 404);
  });

  test('workspace pages: administrators only, CSRF, own workspaces only, names escaped', async () => {
    for (const url of ['/builder/workspaces', `/builder/workspaces/${wsId}`]) assert.equal((await dev.get(url)).statusCode, 403, url);
    for (const url of ['/builder/workspaces', `/builder/workspaces/${wsId}`, `/builder/workspaces/${wsId}/members`, `/builder/workspaces/${wsId}/move`, `/builder/workspaces/${wsId}/delete`])
      assert.equal((await dev.post(url, { __csrf: dev.lastCsrf, name: 'x', member: DEV, app: String(hr), to: String(wsId) })).statusCode, 403, url);
    assert.equal(await (await owner.one('select meta.app_workspace($1) as ws', [hr])).ws, 1);
    // switching: CSRF, and only to one's own workspaces
    assert.equal((await dev.post('/builder/workspace', { __csrf: 'forged', workspace: String(wsId) })).statusCode, 403);
    assert.equal((await dev.post('/builder/workspace', { __csrf: dev.lastCsrf, workspace: '1' })).statusCode, 404);
    // the name is escaped wherever it shows
    for (const b of [adm, dev]) {
      const body = (b === adm ? await adm.get('/builder/workspaces') : await dev.get('/builder')).body;
      assert.ok(!body.includes('<b>ws</b>'), 'raw name');
      assert.ok(body.includes('Sec37 &lt;b&gt;ws&lt;/b&gt;'));
    }
  });

  test('workspace tables are closed to the runtime', async () => {
    for (const t of ['workspace', 'workspace_member', 'workspace_app']) await assert.rejects(runtime.query(`select * from meta.${t}`), /permission denied/, t);
  });
});

describe('sprint 37 drawers', () => {
  test('dialog shapes sent to the browser come from fixed lists only', async () => {
    const { dialogShapes } = await import('../src/runtime/render.ts');
    const pages = [
      { page_no: 1, mode: 'modal', dialog_position: '</script><script>alert(1)</script>', dialog_size: 'large' },
      { page_no: 2, mode: 'modal', dialog_position: 'right', dialog_size: 'x" onload="' },
      { page_no: 3, mode: 'normal', dialog_position: 'left', dialog_size: 'small' },
    ];
    const out = dialogShapes({ app: { pages } } as never);
    assert.deepEqual(out, { 1: ['center', 'large'], 2: ['right', 'medium'] });
  });

  test('the Page Designer refuses dialog changes without CSRF', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const page = await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 7`);
    assert.equal((await dev.post(`/builder/pages/${page.id}`, { __csrf: 'forged', page_no: '7', name: 'x', dialog_position: 'left' })).statusCode, 403);
    assert.equal((await owner.one('select dialog_position from meta.page where id = $1', [page.id])).dialog_position, 'right');
  });
});

describe('sprint 37 built-in template components', () => {
  test('copying a built-in needs CSRF, a known static id and the application in the developer\'s workspace', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    await dev.get('/builder');
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    assert.equal((await dev.post(`/builder/apps/${hr}/template-components/copy`, { __csrf: 'forged', static_id: 'ut_badge' })).statusCode, 403);
    for (const id of ['../ut_badge', 'ut_badge"', 'contact_card', '__proto__'])
      assert.equal((await dev.post(`/builder/apps/${hr}/template-components/copy`, { __csrf: dev.lastCsrf, static_id: id })).statusCode, 404, id);
    assert.equal((await owner.one(`select count(*)::int as n from meta.template_component where app_id = $1 and static_id = 'ut_badge'`, [hr])).n, 0);
  });
});

describe('sprint 37 theme roller', () => {
  test('dark-mode colours and column options never carry anything but checked values into the page', async () => {
    const { themeCss, appStyles } = await import('../src/runtime/styles.ts');
    const { templateClasses } = await import('../src/runtime/template-options.ts');
    // a hand-edited theme: the bad base colour is dropped, the bad style is skipped
    const css = themeCss({ accent_dark: '#fff;}body{display:none' } as never, appStyles({ styles: [{ name: 'X', accent_dark: 'red}</style><script>' }] } as never)[0] ?? null);
    assert.equal(css, '');
    assert.equal(templateClasses('column', ['to-col-bold"><script>', 'to-col-mono']), ' to-col-mono');
    assert.equal(templateClasses('item', 'to-stretch'), '', 'only lists');
  });
});

describe('sprint 37 report selection across pages', () => {
  test('only the selection item of a visible report, with CSRF, signed in to that app', async () => {
    const r = await owner.one(`select r.id, r.page_id, r.config from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2 and r.type = 'report'`);
    await owner.query(`insert into meta.item (page_id, name, type) values ($1, 'P2_SEC37', 'hidden') on conflict do nothing`, [r.page_id]);
    await owner.query('update meta.region set config = config || $2 where id = $1', [r.id, JSON.stringify({ selection: { column: 'empno', item: 'P2_SEC37' } })]);
    try {
      const anon = new Browser();
      await anon.get('/a/hr/login');
      const res = await anon.post(`/a/hr/2/report/${r.id}/select`, { __csrf: anon.lastCsrf, value: '7839', checked: 'true' });
      assert.notEqual(res.statusCode, 200, 'not signed in');
      const allen = new Browser();
      await allen.get('/a/hr/login');
      await allen.post('/a/hr/login', { __csrf: allen.lastCsrf, username: 'allen', password: 'allen' });
      await allen.get('/a/hr/2');
      assert.equal((await allen.post(`/a/hr/2/report/${r.id}/select`, { __csrf: 'x', value: '7839', checked: 'true' })).statusCode, 403);
      // a region of another page, or one without a selection
      const other = await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 6 and r.type = 'report' limit 1`);
      if (other) assert.equal((await allen.post(`/a/hr/2/report/${other.id}/select`, { __csrf: allen.lastCsrf, value: '1', checked: 'true' })).statusCode, 403);
      const ok = await allen.post(`/a/hr/2/report/${r.id}/select`, { __csrf: allen.lastCsrf, value: ['7839', '<script>'], checked: 'true' });
      assert.equal(ok.statusCode, 200);
      const page = (await allen.get('/a/hr/2')).body;
      assert.ok(!page.includes('value="<script>"'));
      assert.ok(page.includes('value="&lt;script&gt;" data-sel-other'), 'the value is escaped');
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(r.config)]);
      await owner.query(`delete from meta.item where page_id = $1 and name = 'P2_SEC37'`, [r.page_id]);
    }
  });
});

describe('sprint 37 instance settings', () => {
  test('only administrators, with CSRF; values are whole numbers in range; secrets never shown', async () => {
    const anon = new Browser();
    assert.equal((await anon.get('/builder/instance')).statusCode, 302);
    const adm = new Browser();
    await adm.get('/builder/login');
    await adm.post('/builder/login', { __csrf: adm.lastCsrf, username: 'admin', password: 'admin' });
    const page = (await adm.get('/builder/instance')).body;
    for (const k of ['PGAPEX_SECRET_KEY', 'API_JWT_SECRET', 'DATABASE_URL', 'RUNTIME_DATABASE_URL']) {
      const v = process.env[k];
      if (v) assert.ok(!page.includes(v), k);
    }
    assert.equal((await adm.post('/builder/instance', { __csrf: 'forged', session_max_hours: '1' })).statusCode, 403);
    await adm.post('/builder/instance', { __csrf: adm.lastCsrf, session_max_hours: "1; drop table meta.setting" });
    assert.equal(await owner.one(`select value from meta.setting where name = 'session_max_hours'`), undefined);
  });
});

describe('sprint 38 picture cropping', () => {
  test('only listed aspect ratios reach the file input', async () => {
    const item = await owner.one(`select i.id, i.config from meta.item i join meta.page p on p.id = i.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 3 and i.name = 'P3_PHOTO'`);
    const b = new Browser();
    await b.get('/a/hr/login');
    await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'king', password: 'king' });
    try {
      assert.match((await b.get('/a/hr/3')).body, /id="P3_PHOTO"[^>]* data-crop="1:1"/);
      for (const bad of ['1:1" onload="alert(1)', '5:4', '', 'free ']) {
        await owner.query('update meta.item set config = config || $2 where id = $1', [item.id, JSON.stringify({ crop: bad })]);
        assert.doesNotMatch((await b.get('/a/hr/3')).body, /data-crop=/, JSON.stringify(bad));
      }
    } finally {
      await owner.query('update meta.item set config = $2 where id = $1', [item.id, JSON.stringify(item.config)]);
    }
  });
});

describe('sprint 38 session sharing', () => {
  test('shared sign-ins are closed to applications; only hashes are stored', async () => {
    await assert.rejects(runtime.query('select * from meta.shared_login'), /permission denied/);
    const cols = (await owner.query(`select column_name from information_schema.columns where table_schema = 'meta' and table_name = 'shared_login'`)).rows.map((r) => r.column_name);
    assert.ok(cols.includes('token_hash') && !cols.includes('token'));
    await assert.rejects(owner.query(`update meta.app set session_group = 'Bad Group' where alias = 'hr'`), /check constraint/);
  });
});

describe('sprint 39 static application files', () => {
  test('only developers change files, with CSRF; applications only read them; content is escaped in the editor', async () => {
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    const anon = new Browser();
    assert.equal((await anon.get(`/builder/apps/${hr}/static-files`)).statusCode, 302);
    assert.equal((await anon.post(`/builder/apps/${hr}/static-files/save`, { __csrf: 'x', name: 'sec39.js', content: '1' })).statusCode, 302);
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    try {
      assert.equal((await dev.post(`/builder/apps/${hr}/static-files/save`, { __csrf: 'forged', name: 'sec39.js', content: '1' })).statusCode, 403);
      assert.equal((await dev.post(`/builder/apps/${hr}/static-files/delete`, { __csrf: 'forged', name: 'hr.js' })).statusCode, 403);
      assert.equal((await dev.post(`/builder/apps/${hr}/static-files/includes`, { __csrf: 'forged', includes: '' })).statusCode, 403);
      await dev.get(`/builder/apps/${hr}/static-files?new=1`);
      await dev.post(`/builder/apps/${hr}/static-files/save`, { __csrf: dev.lastCsrf, name: 'sec39.js', content: '</textarea><script>alert(1)</script>' });
      const editor = (await dev.get(`/builder/apps/${hr}/static-files?edit=sec39.js`)).body;
      assert.ok(!editor.includes('</textarea><script>alert(1)'), 'the content is escaped');
      // the runtime role reads files but cannot change them
      await assert.rejects(runtime.query(`update meta.static_file set content = '' where app_id = $1`, [hr]), /permission denied/);
      await assert.rejects(runtime.query(`update meta.app set static_includes = '{}' where id = $1`, [hr]), /permission denied/);
      // another application's file is not served under this alias
      const other = await owner.one(`select id, alias from meta.app where alias <> 'hr' order by id limit 1`);
      if (other) assert.equal((await anon.get(`/a/${other.alias}/static/sec39.js`)).statusCode, 404);
      // an include name cannot break out of the tag (the database refuses such names; the page escapes anyway)
      await assert.rejects(owner.query(`insert into meta.static_file (app_id, name, mime, content) values ($1, 'a"><script>.js', 'text/javascript', '')`, [hr]), /check constraint/);
    } finally {
      await owner.query(`delete from meta.static_file where app_id = $1 and name = 'sec39.js'`, [hr]);
    }
  });

  test('"Execute JavaScript" never sends code to the page: only a registered function\'s name', async () => {
    const pid = (await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 2`)).id;
    await owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, action, code) values ($1, 950, 'sec39', 'load', 'execute_javascript', '"};alert(1);//')`, [pid]);
    try {
      const b = new Browser();
      await b.get('/a/hr/login');
      await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'king', password: 'king' });
      const body = (await b.get('/a/hr/2')).body;
      assert.ok(!body.includes('alert(1)'));
    } finally {
      await owner.query(`delete from meta.dynamic_action where name = 'sec39'`);
    }
  });
});

describe('sprint 39 plug-ins', () => {
  test('only developers manage plug-ins, with CSRF; applications cannot change or install them', async () => {
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    const anon = new Browser();
    assert.equal((await anon.get(`/builder/apps/${hr}/plugins`)).statusCode, 302);
    assert.equal((await anon.get(`/builder/apps/${hr}/plugins/download?name=show_more`)).statusCode, 302);
    const dev = new Browser();
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    for (const path of ['import', 'delete', 'install'])
      assert.equal((await dev.post(`/builder/apps/${hr}/plugins/${path}`, { __csrf: 'forged', name: 'show_more', plugin: '{}' })).statusCode, 403, path);
    assert.ok(await owner.one(`select 1 from meta.plugin where app_id = $1 and name = 'show_more'`, [hr]));
    await assert.rejects(runtime.query(`update meta.plugin set sql_function = 'pg_catalog.pg_terminate_backend' where app_id = $1`, [hr]), /permission denied/);
    await assert.rejects(runtime.query(`select meta.import_plugin($1, '{}'::jsonb)`, [hr]), /permission denied/);
    // a function name is an identifier, never SQL
    await assert.rejects(owner.query(`update meta.plugin set sql_function = 'x.y(1); drop table hr.emp; --' where app_id = $1 and name = 'log_event'`, [hr]), /check constraint/);
  });

  test('a page only gets plug-ins of the right type, and attribute values as escaped data', async () => {
    const pid = (await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 40`)).id;
    // a region plug-in named in a dynamic action is not a dynamic action plug-in
    await owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, action, code, config) values ($1, 950, 'sec39 plugin', 'load', 'plugin', 'show_more', '{"attributes": {"X": "</script><script>alert(1)</script>"}}')`, [pid]);
    try {
      const b = new Browser();
      await b.get('/a/hr/login');
      await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'king', password: 'king' });
      const body = (await b.get('/a/hr/40')).body;
      const das = JSON.parse(/<script type="application\/json" id="pgapex-meta">([\s\S]*?)<\/script>/.exec(body)![1]).das;
      const da = das.find((d: { plugin?: string | null; action: string }) => d.action === 'plugin' && d.plugin === null);
      assert.ok(da, 'no plug-in for a name of another type');
      assert.ok(!body.includes('<script>alert(1)'));
    } finally {
      await owner.query(`delete from meta.dynamic_action where name = 'sec39 plugin'`);
    }
  });
});

describe('sprint 39 conditional and dynamic theme styles', () => {
  test('conditions run as the application\'s role; item colours reach the CSS only as #rrggbb', async () => {
    const before = (await owner.one(`select theme from meta.app where alias = 'hr'`)).theme;
    try {
      await owner.query(`update meta.app set theme = $1 where alias = 'hr'`, [JSON.stringify({ ...before, style_choice: false, styles: [
        { name: 'Owner only', accent: '#444444', condition: '(select count(*) from meta.developer) >= 0' },
        { name: 'Injected', accent: '&AI_ENAME.', condition: 'true' },
      ] })]);
      const b = new Browser();
      await b.get('/a/hr/login');
      await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'king', password: 'king' });
      await runtime.query(`select 1`); // the runtime pool is up
      const css = /<style nonce="[^"]+" id="pgapex-css">([\s\S]*?)<\/style>/.exec((await b.get('/a/hr/1')).body)![1];
      assert.doesNotMatch(css, /#444444/, 'meta.developer is not readable by the app role: the condition fails');
      assert.doesNotMatch(css, /KING|--accent:[^#]/i, 'a name is not a colour');
    } finally {
      await owner.query(`update meta.app set theme = $1 where alias = 'hr'`, [JSON.stringify(before)]);
    }
  });
});

describe('sprint 39 zips and parsing in SQL', () => {
  test('unpacked files are reachable only through the functions; names and XML are checked', async () => {
    await assert.rejects(runtime.query('select * from meta.unpacked_file'), /permission denied/);
    await assert.rejects(runtime.query(`insert into meta.unpacked_file (digest, kind) values (sha256('x'), 'zip')`), /permission denied/);
    await assert.rejects(runtime.query(`select meta.zip_add(null, '../../etc/passwd', '\\x00')`), /relative path/);
    // no entity expansion or external entities
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to($1, 'utf8'))`,
      ['<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x><y>&e;</y></x>']), /DTD or entity/);
    // an XPath can't be smuggled in through the row selector
    await assert.rejects(runtime.query(`select * from meta.parse_data(convert_to('<x><y>1</y></x>', 'utf8'), 'x.xml', 'auto', true, null, $1)`, ['y"] | //*[local-name()="x']), /not an element name/);
  });
});

describe('sprint 39 object storage', () => {
  test('the bucket must pass the web client\'s allow-list and address checks; the secret never shows', async () => {
    const { putObject } = await import('../src/objectstore.ts');
    const { encryptSecret } = await import('../src/secrets.ts');
    const hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
    await owner.query(`delete from meta.web_credential where app_id = $1 and name = 'SEC39_S3'`, [hr]);
    await owner.query(`insert into meta.web_credential (app_id, name, type, username, scope, secret_enc) values ($1, 'SEC39_S3', 'aws_sigv4', 'AKIDSEC39', 'eu-west-1', $2)`, [hr, encryptSecret('sec39-super-secret')]);
    const saved = { allowed: process.env.PGAPEX_REST_ALLOWED_HOSTS, priv: process.env.PGAPEX_REST_PRIVATE_HOSTS };
    try {
      process.env.PGAPEX_REST_ALLOWED_HOSTS = '*';
      delete process.env.PGAPEX_REST_PRIVATE_HOSTS;
      for (const url of ['http://169.254.169.254/latest', 'http://127.0.0.1:9/bucket', 'http://10.0.0.1/bucket']) {
        const e = await putObject(hr, { url, credential: 'SEC39_S3' }, 'a.txt', Buffer.from('x'), 'text/plain').then(() => null, (x: Error) => x);
        assert.ok(e, url);
        assert.doesNotMatch(e!.message, /sec39-super-secret/);
      }
      process.env.PGAPEX_REST_ALLOWED_HOSTS = 'objects.example.com';
      const e = await putObject(hr, { url: 'https://elsewhere.example.org/b', credential: 'SEC39_S3' }, 'a.txt', Buffer.from('x'), 'text/plain').then(() => null, (x: Error) => x);
      assert.match(e!.message, /not allowed|allow/i);
      // another type of credential can't sign object storage requests, and an aws_sigv4 one can't be used for REST calls
      const e2 = await putObject(hr, { url: 'https://objects.example.com/b', credential: 'NO_SUCH' }, 'a.txt', Buffer.from('x'), 'text/plain').then(() => null, (x: Error) => x);
      assert.match(e2!.message, /does not exist/);
    } finally {
      process.env.PGAPEX_REST_ALLOWED_HOSTS = saved.allowed;
      if (saved.priv === undefined) delete process.env.PGAPEX_REST_PRIVATE_HOSTS;
      else process.env.PGAPEX_REST_PRIVATE_HOSTS = saved.priv;
      if (saved.allowed === undefined) delete process.env.PGAPEX_REST_ALLOWED_HOSTS;
      await owner.query(`delete from meta.web_credential where app_id = $1 and name = 'SEC39_S3'`, [hr]);
    }
  });
});

describe('sprint 39 map layers loaded by the browser', () => {
  const mapRegion = async () =>
    (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 41 and r.type = 'map'`, [appId])).id as number;

  test('signed out, or a map region the user may not see: no places', async () => {
    const id = await mapRegion();
    const urls = [`/a/hr/41/map/${id}/tiles/0/4/8/5.mvt`, `/a/hr/41/map/${id}/layer/1?bb=45,5,47,8`];
    for (const u of urls) {
      const res = await new Browser().get(u);
      assert.notEqual(res.statusCode, 200, u);
      assert.doesNotMatch(res.body, /Station \d/, u);
    }
    try {
      await owner.query(`update meta.region set authz = 'ADMIN' where id = $1`, [id]);
      const blake = await as('blake');
      for (const u of urls) assert.equal((await blake.get(u)).statusCode, 403, u);
      assert.equal((await (await as('king')).get(urls[0])).statusCode, 200, 'an administrator still gets the tile');
    } finally {
      await owner.query(`update meta.region set authz = null where id = $1`, [id]);
    }
  });

  test("a layer's query runs as the application's role; the area is numbers, never SQL", async () => {
    const id = await mapRegion();
    const { source } = await owner.one('select source from meta.region where id = $1', [id]);
    try {
      await owner.query('update meta.region set source = $2 where id = $1', [id, 'select 50 as lat, 5 as lng, password_hash as title from meta.account']);
      const res = await (await as('king')).get(`/a/hr/41/map/${id}/tiles/0/4/8/5.mvt`);
      assert.equal(res.statusCode, 400);
      assert.doesNotMatch(res.body, /\$2[aby]\$|argon2/);
    } finally {
      await owner.query('update meta.region set source = $2 where id = $1', [id, source]);
    }
    const king = await as('king');
    for (const bb of ["45,5,47,8) or (1=1", "45,5,47,8'; drop table hr.emp; --", '1e2,0,1,1', 'NaN,0,1,1'])
      assert.equal((await king.get(`/a/hr/41/map/${id}/layer/1?bb=${encodeURIComponent(bb)}`)).statusCode, 400, bb);
    for (const t of ['99/0/0.mvt', '4/8/5;select', '4/-1/5.mvt', '4/8/99999999999.mvt'])
      assert.equal((await king.get(`/a/hr/41/map/${id}/tiles/0/${t}`)).statusCode, 404, t);
    assert.ok((await owner.one('select count(*)::int as n from hr.emp')).n > 0);
  });
});

describe('sprint 39 query builder canvas', () => {
  test('joins, functions, positions and the table order: only catalog names and fixed functions reach the SQL; the page escapes them', async () => {
    const dev = new Browser();
    await dev.get('/builder/login');
    assert.equal((await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' })).statusCode, 303);
    const evil = `x"><script>alert(1)</script>`;
    const q = new URLSearchParams([
      ['schema', 'hr'], ['t', 'emp'], ['t', 'dept'], ['o', `dept,emp,${evil}`],
      ['j', `t1.ename=t2.dname) or (1=1`], ['j', `t1.ename=t2.${evil}`], ['ja', 't1.ename; drop table hr.emp'], ['jb', 't2.dname'],
      ['fn', 't2.sal:pg_sleep'], ['fn', `t2.sal:sum); drop table hr.emp; --`], ['fn', `${evil}:count`], ['fn', 't2.sal:sum'],
      ['p', `${evil}:1,2`], ['p', 'emp:1,2;drop'],
    ]);
    const res = await dev.get(`/builder/sql/query?${q}`);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /<script>alert|1=1|pg_sleep|drop table hr\.emp/);
    const sql = /<pre class="source"[^>]*>([\s\S]*?)<\/pre>/.exec(res.body)![1];
    assert.match(sql, /sum\(t2\.&quot;sal&quot;\) as &quot;sum_sal&quot;/, 'the order from o: dept is t1, emp t2; only the known function stays');
    assert.match(sql, /join &quot;hr&quot;\.&quot;emp&quot; t2 on t2\.&quot;deptno&quot; = t1\.&quot;deptno&quot;/, 'no valid drawn join: the foreign key');
    assert.ok((await owner.one(`select to_regclass('hr.emp') as e`)).e);
  });
});

describe('sprint 39 workflow and task tenants', () => {
  test("application SQL sets only its own session's tenant; it can't write sessions or another app's", async () => {
    const { db_role: role } = await owner.one(`select db_role from meta.app where alias = 'hr'`);
    await as('blake');
    const mine = (await owner.one(`select id from meta.session where app_id = $1 and username = 'blake' order by created_at desc limit 1`, [appId])).id;
    await as('king');
    const theirs = (await owner.one(`select id from meta.session where app_id = $1 and username = 'king' order by created_at desc limit 1`, [appId])).id;
    // as the application's role: the session table is out of reach
    await assert.rejects(
      appTx({ appId, alias: 'hr', dbRole: role, appUser: 'blake', sessionId: mine }, (c) => c.query(`update meta.session set tenant_id = 'x' where id = $1`, [theirs])),
      /permission denied/,
    );
    await appTx({ appId, alias: 'hr', dbRole: role, appUser: 'blake', sessionId: mine }, (c) => c.query(`select meta.set_tenant('blake-co')`));
    assert.equal((await owner.one('select tenant_id from meta.session where id = $1', [mine])).tenant_id, 'blake-co');
    assert.equal((await owner.one('select tenant_id from meta.session where id = $1', [theirs])).tenant_id, null, "the other session's tenant is unchanged");
    // a session of another application is not changed through this one's app id
    await appTx({ appId: appId + 100000, alias: 'x', dbRole: role, appUser: 'blake', sessionId: mine }, (c) => c.query(`select meta.set_tenant('elsewhere')`));
    assert.equal((await owner.one('select tenant_id from meta.session where id = $1', [mine])).tenant_id, 'blake-co');
    await owner.query('update meta.session set tenant_id = null where id = $1', [mine]);
  });
});

describe('sprint 39 region static ids and text files', () => {
  test('a static id is letters, digits, _ and -; on the page it is an attribute value only', async () => {
    const { id } = await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 order by r.seq limit 1`, [appId]);
    for (const bad of ['x"><script>alert(1)</script>', 'Upper', '1abc', 'a b', 'x'.repeat(51)])
      await assert.rejects(owner.query('update meta.region set static_id = $2 where id = $1', [id, bad]), /check constraint/, bad);
    try {
      await owner.query(`update meta.region set static_id = 'staff-list' where id = $1`, [id]);
      const page = (await (await as('king')).get('/a/hr/2')).body;
      assert.match(page, new RegExp(`<section class="[^"]*" id="R${id}" data-static-id="staff-list"`));
    } finally {
      await owner.query('update meta.region set static_id = null where id = $1', [id]);
    }
  });

  test('YAML files are data: anchors, tags and flow collections are refused, a __proto__ key is a key', async () => {
    const { fromText } = await import('../src/yamltext.ts');
    for (const bad of ['a: &x 1', 'a: *x', 'a: !!python/object:os.system x', 'a: {b: 1}', 'a: [1]', 'a: >\n  folded'])
      assert.throws(() => fromText(bad), /outside the subset|double quotes/, bad);
    const v = fromText('"__proto__":\n  polluted: true\n') as Record<string, unknown>;
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(Object.keys(v), ['__proto__']);
  });
});
