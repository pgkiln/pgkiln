// Sprint 183 (the owner's open questions, decided). CD-2: the application's Pages report lists the server-side
// conditions of each page's components in words. DA-13: a database role is assigned to an isolated workspace from
// Database Users.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId = 0;
const ALIAS = 's183-conds';

const admin = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
};

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.app where alias = $1', [ALIAS]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'S183 conditions', 'none') returning id`, [ALIAS]))!.id;
  const p1 = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 1, 'Orders') returning id`, [appId]))!.id;
  await owner.query(`insert into meta.page (app_id, page_no, name) values ($1, 2, 'Plain')`, [appId]);
  await owner.query(`insert into meta.region (page_id, type, title, condition_type, condition, condition_value) values ($1, 'static', 'Notes <b>x</b>', 'item_equals', 'P1_STATUS', '<i>open</i>')`, [p1]);
  await owner.query(`insert into meta.region (page_id, type, title, condition) values ($1, 'static', 'Totals', 'exists (select 1)')`, [p1]);
  await owner.query(`insert into meta.button (page_id, name, label, condition_type, condition_value) values ($1, 'SAVE', 'Save', 'request_in', 'EDIT,CREATE')`, [p1]);
  await owner.query(`insert into meta.button (page_id, name, label) values ($1, 'CANCEL', 'Cancel')`, [p1]);
});
after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await app.close();
  await closePools();
});

describe('sprint 183: conditions in words in the Pages report (CD-2)', () => {
  test('each page lists its components\' server-side conditions in words; pages without one show a dash; markup is escaped', async () => {
    const b = await admin();
    const body = (await b.get(`/builder/apps/${appId}`)).body;
    assert.match(body, /<th>Conditions<\/th>/);
    const rows = body.split('<tbody id="pages-rows">')[1].split('</tbody>')[0].split('<tr>').slice(1);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /<summary>3 conditions<\/summary>/);
    assert.match(rows[0], /Region<\/span> <b>Notes &lt;b&gt;x&lt;\/b&gt;<\/b>: When P1_STATUS is &lt;i&gt;open&lt;\/i&gt;/);
    assert.match(rows[0], /Region<\/span> <b>Totals<\/b>: /);
    assert.match(rows[0], /Button<\/span> <b>SAVE<\/b>: When the request is EDIT, CREATE/);
    assert.doesNotMatch(rows[0], /CANCEL/);
    assert.match(rows[1], /<span class="muted">—<\/span>/);
  });
});
