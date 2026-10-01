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

let app: FastifyInstance;
let appId: number;

/** A tiny cookie-keeping browser on top of fastify.inject. */
class Browser {
  cookies = new Map<string, string>();
  lastCsrf = '';
  async request(method: 'GET' | 'POST', url: string, form?: Record<string, string>) {
    const res = await app.inject({
      method,
      url,
      payload: form ? new URLSearchParams(form).toString() : undefined,
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
  post(url: string, form: Record<string, string>) {
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
