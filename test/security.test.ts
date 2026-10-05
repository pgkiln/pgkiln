// Security regression tests. They run the real app (in-process, via
// fastify.inject) against the development database with the HR sample:
//   npm run setup && npm test
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
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
    assert.doesNotMatch(page, /href="\/a\/hr\/3/, 'no edit links for non-managers');
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
      assert.match(none, /class="bubble s1 \w+" data-tip=/);
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
