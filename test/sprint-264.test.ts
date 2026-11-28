// Sprint 264 (migration 210): a button grey until the fields it needs are filled in: the dynamic action condition
// all_not_null over every trigger item, and enable / disable / show / hide on buttons named in affected_items.
// HR page 37 shows it (part 124).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'ts-s264';
let pageId = 0;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Sprint 264', 'none', 'hr_app') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth) values ($1, 1, 'Form', 'Form', false) returning id`, [appId])).id;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type) values ($1, 10, 'Form', 'static') returning id`, [pageId])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, $2, 10, 'P1_A', 'A', 'text'), ($1, $2, 20, 'P1_B', 'B', 'text')`, [pageId, r]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 10, 'SEND', 'Send', 'submit')`, [pageId, r]);
  await owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, action, affected_items)
    values ($1, 10, 'Send once filled', 'change', 'P1_A,P1_B', 'all_not_null', 'enable', 'SEND')`, [pageId]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await app.close();
  await closePools();
});

test('all_not_null and a button as the affected item reach the page', async () => {
  const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
  const json = body.replace(/&quot;/g, '"');
  assert.match(json, /"trigger":\["P1_A","P1_B"\]/);
  assert.match(json, /"cond":\{"type":"all_not_null"/);
  assert.match(json, /"items":\["SEND"\]/);
  assert.match(body, /data-button="SEND"/);
});

test('the database takes all_not_null and still refuses an unknown condition type', async () => {
  await assert.rejects(owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, action) values ($1, 20, 'x', 'change', 'P1_A', 'all_null', 'enable')`, [pageId]), /condition_type_check/);
});
