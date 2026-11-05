// Sprint 158 (CD-5; APEX 26.2 page items): Image Upload (a file item for pictures), Text Field with autocomplete (a
// one-value combobox), Percent Graph (a 0–100 bar) and Display Map (a map tile with a pin), both display only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { presetItem } from '../src/metadata.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'items-s158';
const ROLE = 'pgkiln_s158_items';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Items', 'none', $2) returning id`, [alias, ROLE])).id;
  const p = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 1, 'Main', 'static', 'main') returning id`, [p])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, type, lov, config) values
    ($1, $2, 1, 'P1_PCT', 'percent_graph', null, '{}'),
    ($1, $2, 2, 'P1_LOC', 'hidden', null, '{}'),
    ($1, $2, 3, 'P1_MAP', 'display_map', null, '{"coordinates_item": "P1_LOC", "zoom": 15}'),
    ($1, $2, 4, 'P1_AC', 'autocomplete', 'STATIC:Clerk;CLERK,Analyst;ANALYST', '{}'),
    ($1, $2, 5, 'P1_IMG', 'image_upload', null, '{"crop": "1:1"}'),
    ($1, $2, 6, 'P1_BAD', 'percent_graph', null, '{}')`, [p, r]);
  await owner.query(`insert into meta.computation (page_id, seq, item_name, point, type, expression) values
    ($1, 1, 'P1_PCT', 'before_header', 'static', '142'), ($1, 2, 'P1_LOC', 'before_header', 'static', '52.37302,4.89259'),
    ($1, 3, 'P1_BAD', 'before_header', 'static', 'lots')`, [p]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label) values ($1, $2, 1, 'SAVE', 'Save')`, [p, r]);
});
after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await owner.query(`drop role if exists ${ROLE}`);
  await app.close();
  await closePools();
});

describe('item types (CD-5)', () => {
  test('presets: Image Upload is a file item for pictures, autocomplete a one-value combobox', () => {
    const img = presetItem({ name: 'P1_IMG', type: 'image_upload', config: { crop: '1:1' } } as any);
    assert.equal(img.type, 'file');
    assert.deepEqual([img.config.accept, img.config.crop, img.config.max_px], ['image/*', '1:1', 1600]);
    const ac = presetItem({ name: 'P1_AC', type: 'autocomplete', config: { multiple: true } } as any);
    assert.deepEqual([ac.type, ac.config.multiple], ['combobox', false]);
  });

  test('the page: a bar for the percentage (capped at 100), a map tile with its pin, suggestions, a picture upload', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(body, /<progress max="100" value="100" aria-label="[^"]*">100%<\/progress>/);
    assert.match(body, /id="P1_BAD"> </, 'not a number: shown empty');
    // zoom 15 tile of 52.37302,4.89259 (Amsterdam): x = 16829, y = 10768
    assert.match(body, /<img src="[^"]*\/15\/16829\/10768\.png" alt="[^"]*52\.37302,4\.89259"/);
    assert.match(body, /class="display-map-pin x[A-Za-z0-9]+"/);
    assert.match(body, /name="P1_AC"[^>]*list="P1_AC_list"/);
    assert.doesNotMatch(body, /data-tags="P1_AC"/, 'one value, not tags');
    assert.match(body, /<option value="ANALYST">Analyst<\/option>/);
    assert.match(body, /type="file"[^>]*name="P1_IMG"|name="P1_IMG"[^>]*type="file"/);
    assert.match(body, /accept="image\/\*"/);
    assert.doesNotMatch(body, /name="P1_PCT"|name="P1_MAP"/, 'display only: nothing to post');
  });

  test('the database knows the types', async () => {
    await assert.rejects(owner.query(`insert into meta.item (page_id, name, type) select page_id, 'P1_X', 'percent_bar' from meta.item where name = 'P1_PCT' limit 1`), /item_type_check/);
  });
});
