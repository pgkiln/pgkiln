// Feedback (migration 084): the navigation bar link, sending feedback about a page,
// the user's own feedback with answers, the limit per hour, and the builder.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { FEEDBACK_PER_HOUR } from '../src/runtime/feedback.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const MARK = `fb-test-${Date.now()}`;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query('update meta.app set feedback = true where id = $1', [appId]);
});

after(async () => {
  await owner.query('delete from meta.feedback where app_id = $1 and body like $2', [appId, `%${MARK}%`]);
  await app.close();
  await closePools();
});

describe('feedback', () => {
  test('the navigation bar links to the page\'s feedback; feedback is stored with the page and user', async () => {
    const b = new Browser(app);
    await b.login('blake');
    const page = (await b.get('/a/hr/4')).body;
    assert.match(page, /<a href="\/a\/hr\/4\/feedback"[^>]*><svg[\s\S]*?<span>Feedback<\/span>/);
    const form = await b.get('/a/hr/4/feedback');
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /Tell the developers what you think of “Departments”/);
    const res = await b.submit('/a/hr/4/feedback', { kind: 'problem', rating: '2', body: `The <b>list</b> is slow ${MARK}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /your feedback was sent/);
    assert.match(res.body, /The &lt;b&gt;list&lt;\/b&gt; is slow/, 'escaped in the list');
    const f = await owner.one('select * from meta.feedback where app_id = $1 and body like $2', [appId, `%${MARK}%`]);
    assert.equal(f.page_no, 4);
    assert.equal(f.username, 'blake');
    assert.equal(f.kind, 'problem');
    assert.equal(f.rating, 2);
    assert.equal(f.status, 'open');
  });

  test('the user sees their own feedback with the answer, not other users\'', async () => {
    await owner.query(`update meta.feedback set status = 'done', response = $3 where app_id = $1 and body like $2`, [appId, `%${MARK}%`, `Fixed ${MARK}`]);
    const blake = new Browser(app);
    await blake.login('blake');
    const mine = (await blake.get('/a/hr/1/feedback')).body;
    assert.match(mine, new RegExp(`Answer from the developers</strong><p>Fixed ${MARK}`));
    const king = new Browser(app);
    await king.login('king');
    assert.doesNotMatch((await king.get('/a/hr/1/feedback')).body, new RegExp(MARK));
  });

  test('an empty text, a forged token and too many at once are refused; off means 404', async () => {
    const b = new Browser(app);
    await b.login('scott');
    await b.get('/a/hr/1/feedback');
    let res = await b.submit('/a/hr/1/feedback', { kind: 'comment', body: '   ' });
    assert.equal(res.statusCode, 422);
    res = await b.post('/a/hr/1/feedback', { __csrf: 'forged', kind: 'comment', body: `x ${MARK}` });
    assert.equal(res.statusCode, 403);
    for (let i = 0; i < FEEDBACK_PER_HOUR; i++) assert.equal((await b.submit('/a/hr/1/feedback', { kind: 'idea', body: `idea ${i} ${MARK}` })).statusCode, 200);
    res = await b.submit('/a/hr/1/feedback', { kind: 'idea', body: `one too many ${MARK}` });
    assert.equal(res.statusCode, 429);
    await owner.query('update meta.app set feedback = false where id = $1', [appId]);
    try {
      assert.equal((await b.get('/a/hr/1/feedback')).statusCode, 404);
      assert.doesNotMatch((await b.get('/a/hr/1')).body, /\/feedback"/);
    } finally {
      await owner.query('update meta.app set feedback = true where id = $1', [appId]);
    }
  });

  test('developers answer in the builder, also while the application is Run only', async () => {
    const f = await owner.one('select id from meta.feedback where app_id = $1 and body like $2 order by id limit 1', [appId, `%${MARK}%`]);
    await owner.query(`update meta.app set build_status = 'run_only' where id = $1`, [appId]);
    try {
      const dev = new Browser(app);
      await dev.get('/builder/login');
      await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
      const list = (await dev.get(`/builder/apps/${appId}/feedback?status=done`)).body;
      assert.match(list, new RegExp(`is slow ${MARK}`));
      await dev.submit(`/builder/apps/${appId}/feedback/${f.id}`, { status: 'in_progress', response: `Looking into it ${MARK}` });
      const row = await owner.one('select status, response, responded_by from meta.feedback where id = $1', [f.id]);
      assert.deepEqual(row, { status: 'in_progress', response: `Looking into it ${MARK}`, responded_by: 'admin' });
      // feedback of another application is not reachable through this one
      const other = (await owner.one(`insert into meta.app (alias, name) values ('fb-other', 'Other') returning id`)).id;
      try {
        await dev.submit(`/builder/apps/${other}/feedback/${f.id}`, { status: 'declined', response: 'no' });
        assert.equal((await owner.one('select status from meta.feedback where id = $1', [f.id])).status, 'in_progress');
      } finally {
        await owner.query('delete from meta.app where id = $1', [other]);
      }
    } finally {
      await owner.query(`update meta.app set build_status = 'run_and_build' where id = $1`, [appId]);
    }
  });
});
