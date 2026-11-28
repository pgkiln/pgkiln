// Sprint 263 (found comparing the migrated Appsmith applications a fifth time): an item's help text as a tooltip of a ?
// after its label ({"help_icon": true}, Appsmith's label tooltip). HR page 3 shows it (part 123).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'ts-s263';

const fieldOf = (body: string, name: string) => {
  const at = body.indexOf(`data-item="${name}"`);
  assert.ok(at > 0, `${name} is on the page`);
  const next = body.indexOf('data-item="', at + 12);
  return body.slice(body.lastIndexOf('<', at), next > 0 ? next : undefined);
};

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Sprint 263', 'none', 'hr_app') returning id`, [alias])).id;
  const page = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth) values ($1, 1, 'Form', 'Form', false) returning id`, [appId])).id;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type) values ($1, 10, 'Form', 'static') returning id`, [page])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, config, help, required, lov) values
    ($1, $2, 10, 'P1_TIP', 'Tip', 'text', '{"help_icon": true}', 'Say <b>why</b>', true, null),
    ($1, $2, 20, 'P1_PLAIN', 'Plain', 'text', '{}', 'Under the field', false, null),
    ($1, $2, 30, 'P1_GROUP', 'Group', 'checkbox_group', '{"help_icon": true}', 'Tick what applies', false, 'STATIC:A,B'),
    ($1, $2, 40, 'P1_NOHELP', 'No help', 'text', '{"help_icon": true}', null, false, null)`, [page, r]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await app.close();
  await closePools();
});

test('help_icon: a ? in the label, the help a tooltip the field is described by; escaped', async () => {
  const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
  const tip = fieldOf(body, 'P1_TIP');
  assert.match(tip, /<label class="label" for="P1_TIP">Tip<span class="req" aria-hidden="true">\*<\/span><span class="help-tip" aria-hidden="true"><svg/);
  assert.match(tip, /<input [^>]*aria-describedby="P1_TIP_help"/);
  assert.match(tip, /<small class="help help-tip-text" id="P1_TIP_help" role="tooltip">Say &lt;b&gt;why&lt;\/b&gt;<\/small>/);
  assert.match(fieldOf(body, 'P1_GROUP'), /<legend class="label">Group<span class="help-tip" aria-hidden="true">[\s\S]*class="help help-tip-text" id="P1_GROUP_help" role="tooltip">Tick what applies/);
});

test('without help_icon the help is under the field; without help no ?', async () => {
  const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
  assert.match(fieldOf(body, 'P1_PLAIN'), /<small class="help" id="P1_PLAIN_help">Under the field<\/small>/);
  assert.doesNotMatch(fieldOf(body, 'P1_PLAIN'), /help-tip/);
  assert.doesNotMatch(fieldOf(body, 'P1_NOHELP'), /help-tip/);
});
