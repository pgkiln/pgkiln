// Lost update detection of form regions (migration 076): the row's checksum
// travels with the page, and form_dml refuses an update or delete of a row
// someone changed meanwhile.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser, formFields } from './helpers.ts';

let app: FastifyInstance;
let formRegion: number;
let saved: Record<string, unknown>;
const EMPNO = 7844; // TURNER

before(async () => {
  app = await buildApp({ logger: false });
  formRegion = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                  where a.alias = 'hr' and p.page_no = 3 and r.type = 'form'`)).id;
  saved = await owner.one('select job, sal from hr.emp where empno = $1', [EMPNO]);
});

after(async () => {
  await owner.query('update hr.emp set job = $2, sal = $3 where empno = $1', [EMPNO, saved.job, saved.sal]);
  await owner.query(`update meta.region set config = config - 'lost_update' where id = $1`, [formRegion]);
  await app.close();
  await closePools();
});

async function openForm(b: Browser) {
  const list = (await b.get('/a/hr/2')).body;
  const href = new RegExp(`href="(/a/hr/3\\?[^"]*P3_EMPNO=${EMPNO}[^"]*)"`).exec(list)![1].replace(/&amp;/g, '&');
  return (await b.get(href)).body;
}

describe('forms: lost update detection', () => {
  test('the page carries the checksum of the row it shows', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = await openForm(b);
    const rv = new RegExp(`name="__rv_${formRegion}" value="([0-9a-f]{32})"`).exec(page);
    assert.ok(rv, 'a row version for the form region');
    // a new record (no key) has none
    const fresh = new Browser(app);
    await fresh.login('king');
    const blank = (await fresh.get('/a/hr/3')).body;
    assert.doesNotMatch(blank, /name="__rv_/);
  });

  test('a save of an unchanged row goes through; a row changed meanwhile is refused', async () => {
    const b = new Browser(app);
    await b.login('king');
    let page = await openForm(b);
    let res = await b.post('/a/hr/3', { ...formFields(page), __request: 'SAVE', P3_SAL: '1600' });
    assert.equal(res.statusCode, 303, 'unchanged row: saved');
    assert.equal(Number((await owner.one('select sal from hr.emp where empno = $1', [EMPNO])).sal), 1600);

    page = await openForm(b);
    // someone else changes the job after the page was shown
    await owner.query(`update hr.emp set job = 'ANALYST' where empno = $1`, [EMPNO]);
    res = await b.post('/a/hr/3', { ...formFields(page), __request: 'SAVE', P3_SAL: '1700' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Someone else changed this record after you opened it/);
    const row = await owner.one('select job, sal from hr.emp where empno = $1', [EMPNO]);
    assert.equal(row.job, 'ANALYST', 'the other change is kept');
    assert.equal(Number(row.sal), 1600, 'the stale save was not written');
    // the page shown again still carries the old version: saving again is refused too
    res = await b.post('/a/hr/3', { ...formFields(res.body), __request: 'SAVE', P3_SAL: '1700' });
    assert.equal(res.statusCode, 422);
    // after a reload the current row can be saved
    page = await openForm(b);
    assert.match(page, /ANALYST/);
    res = await b.post('/a/hr/3', { ...formFields(page), __request: 'SAVE', P3_SAL: '1700' });
    assert.equal(res.statusCode, 303);
  });

  test('a delete of a row changed meanwhile is refused', async () => {
    const b = new Browser(app);
    await b.login('king');
    const page = await openForm(b);
    await owner.query(`update hr.emp set sal = sal + 1 where empno = $1`, [EMPNO]);
    const res = await b.post('/a/hr/3', { ...formFields(page), __request: 'DELETE' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Someone else changed this record/);
    assert.equal((await owner.one('select count(*)::int as n from hr.emp where empno = $1', [EMPNO])).n, 1);
  });

  test('{"lost_update": false} on the form region saves over the other change', async () => {
    await owner.query(`update meta.region set config = coalesce(config, '{}') || '{"lost_update": false}' where id = $1`, [formRegion]);
    try {
      const b = new Browser(app);
      await b.login('king');
      const page = await openForm(b);
      assert.doesNotMatch(page, /name="__rv_/);
      await owner.query(`update hr.emp set job = 'CLERK' where empno = $1`, [EMPNO]);
      const res = await b.post('/a/hr/3', { ...formFields(page), __request: 'SAVE', P3_SAL: '1800' });
      assert.equal(res.statusCode, 303);
    } finally {
      await owner.query(`update meta.region set config = config - 'lost_update' where id = $1`, [formRegion]);
    }
  });

  test('meta.row_version does not depend on the time zone or date style of the session', async () => {
    const c = await owner.pool.connect();
    try {
      const v = async (tz: string, ds: string) => {
        await c.query(`set timezone = '${tz}'`);
        await c.query(`set datestyle = '${ds}'`);
        return (await c.query(`select meta.row_version('hr.emp', 'empno', $1, array['ename', 'hiredate', 'sal'])`, [String(EMPNO)])).rows[0].row_version;
      };
      const a = await v('UTC', 'ISO, YMD');
      assert.match(a, /^[0-9a-f]{32}$/);
      assert.equal(await v('Pacific/Auckland', 'German, DMY'), a);
      assert.equal(await v('America/Los_Angeles', 'SQL, MDY'), a);
      // a missing row gives NULL; a column that doesn't exist is an error
      assert.equal((await c.query(`select meta.row_version('hr.emp', 'empno', '-1', array['ename'])`)).rows[0].row_version, null);
      await assert.rejects(c.query(`select meta.row_version('hr.emp', 'nope', '1', array['ename'])`), /does not exist/);
    } finally {
      await c.query('reset timezone; reset datestyle');
      c.release();
    }
  });
});
