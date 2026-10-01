// Security regression tests. They run the real app (in-process, via
// fastify.inject) against the development database with the HR sample:
//   npm run setup && npm test
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { urlChecksum } from '../src/security.ts';
import { PageCss } from '../src/css.ts';

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
      `/builder/apps/${appId}/globalization`, '/builder/sql', '/builder/sql/load', '/builder/users', '/builder/users/providers']) {
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
