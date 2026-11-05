// Sprint 160 (CD-7; APEX: Workflow Diagram region): a running instance drawn in an application page, with the
// current step marked and each reached step's history as its tooltip; only for users who may see the instance.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let regionId: number;
let appId: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const page = (await owner.one('select id from meta.page where app_id = $1 and page_no = 28', [appId])).id;
  regionId = (await owner.one(`insert into meta.region (page_id, seq, title, type, config) values ($1, 999, 'Progress', 'workflow_diagram', '{"instance_item": "P28_WORKFLOW_ID"}') returning id`, [page])).id;
});
after(async () => {
  await owner.query('delete from meta.region where id = $1', [regionId]);
  await owner.query(`delete from meta.workflow where app_id = $1 and initiator = 'king' and started_at > now() - interval '10 minutes'`, [appId]).catch(() => undefined);
  await app.close();
  await closePools();
});

const as = async (user: string) => {
  const b = new Browser(app);
  assert.equal((await b.login(user)).statusCode, 303);
  await b.get('/a/hr/28');
  return b;
};
const section = (body: string) => new RegExp(`id="R${regionId}"[\\s\\S]*?</section>`).exec(body)?.[0] ?? '';

describe('Workflow Diagram region (CD-7)', () => {
  test('the instance the user started: its steps, the current one marked, history as tooltips', async () => {
    const king = await as('king');
    await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'ONBOARD' });
    const body = (await king.get('/a/hr/28')).body;
    const id = /name="P28_WORKFLOW_ID"[^>]*value="(\d+)"|id="P28_WORKFLOW_ID">(\d+)/.exec(body);
    assert.ok(id, 'the toolkit put the new instance id in P28_WORKFLOW_ID');
    const region = section(body);
    assert.match(region, /<svg class="wf-diagram"/);
    assert.match(region, /class="wf-node [^"]*wf-(active|done|failed)/, 'a step is marked');
    assert.match(region, /aria-label="Workflow diagram; at /);
    assert.match(region, /<title>[^<]+: (step|started|task|split)/, 'a reached step has its history as a tooltip');
  });

  test('another user sees nothing of it, even with its id', async () => {
    const id = (await owner.one(`select id::text from meta.workflow where app_id = $1 and initiator = 'king' order by id desc limit 1`, [appId]))?.id;
    assert.ok(id);
    const page = (await owner.one('select id from meta.page where app_id = $1 and page_no = 28', [appId])).id;
    const comp = await owner.one(`insert into meta.computation (page_id, seq, item_name, point, type, expression) values ($1, 999, 'P28_WORKFLOW_ID', 'before_header', 'static', $2) returning id`, [page, id]);
    try {
      const body = (await (await as('allen')).get('/a/hr/28')).body;
      const region = section(body);
      assert.doesNotMatch(region, /<svg/);
    } finally {
      await owner.query('delete from meta.computation where id = $1', [comp.id]);
    }
  });
});
