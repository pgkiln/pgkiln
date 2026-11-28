// Sprint 262 (review of sprint 261): a date-time value in a date format with a T or a space (DD-MON-YYYY), a date-time
// that can't be read reported as an item error, a date-time mask with a quoted "T", the time field's aria attributes,
// a rating that is required only for some buttons can be cleared, and a link column with "else": "text" for users who
// may not open its page. HR page 66 shows the link column and the row menu label (part 122).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { splitDateTime } from '../src/runtime/items.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'ts-s262';

const fieldOf = (body: string, name: string) => {
  const at = body.indexOf(`data-item="${name}"`);
  assert.ok(at > 0, `${name} is on the page`);
  const next = body.indexOf('data-item="', at + 12);
  return body.slice(body.lastIndexOf('<', at), next > 0 ? next : undefined);
};
const stateOf = async (name: string) =>
  (await owner.one(`select coalesce(state ->> $1, '') as v from meta.session where state ? 'P1_STARS' order by last_seen desc limit 1`, [name])).v as string;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role, date_format) values ($1, 'Sprint 262', 'none', 'hr_app', 'DD-MM-YYYY') returning id`, [alias])).id;
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value) values ($1, 'ADMINS', 'role', 'admin')`, [appId]);
  const page = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth) values ($1, 1, 'Form', 'Form', false) returning id`, [appId])).id;
  await owner.query(`insert into meta.page (app_id, page_no, name, title, requires_auth, authz) values ($1, 2, 'Secret', 'Secret', false, 'ADMINS')`, [appId]);
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type) values ($1, 10, 'Form', 'static') returning id`, [page])).id;
  await owner.query(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 20, 'Report', 'classic_report',
    'select 7 as qty', '{"link_columns": [{"label": "#qty#", "heading": "Qty", "page": 2, "style": "button", "else": "text"}, {"label": "Gone", "page": 2}]}')`, [page]);
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, config, required) values
    ($1, $2, 10, 'P1_MON', 'Mon', 'datetime', '{"format_mask": "DD-MON-YYYY HH24:MI"}', false),
    ($1, $2, 20, 'P1_ISO', 'Iso', 'datetime', '{"format_mask": "YYYY-MM-DD\\"T\\"HH24:MI"}', true),
    ($1, $2, 30, 'P1_STARS', 'Stars', 'rating', '{"required_when": ["SEND"]}', true)`, [page, r]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 10, 'SAVE', 'Save', 'submit'), ($1, $2, 20, 'SEND', 'Send', 'submit')`, [page, r]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await app.close();
  await closePools();
});

test('splitDateTime: only a time at the end is split off', () => {
  assert.deepEqual(splitDateTime('2026-01-05T09:30'), ['2026-01-05', '09:30']);
  assert.deepEqual(splitDateTime('2026-01-05 09:30:00+01'), ['2026-01-05', '09:30:00+01']);
  assert.deepEqual(splitDateTime('05-OCT-2026 09:30'), ['05-OCT-2026', '09:30']);
  assert.deepEqual(splitDateTime('05 10 2026'), ['05 10 2026', '']);
  assert.deepEqual(splitDateTime('05-OCT-2026'), ['05-OCT-2026', '']);
  assert.deepEqual(splitDateTime(''), ['', '']);
});

describe('a date-time item', () => {
  test('one value in DD-MON-YYYY (a dynamic action, an Ajax call) is read; shown again in the mask', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { P1_MON: '05-OCT-2026 09:30', P1_ISO: ['2026-10-05', '10:00'], P1_STARS: '', __request: 'SAVE' });
    assert.equal(res.statusCode, 303);
    assert.equal(await stateOf('P1_MON'), '2026-10-05T09:30');
    const html = fieldOf((await b.get(`/a/${alias}/1`)).body, 'P1_MON');
    const [d, t] = [...html.matchAll(/<input type="text"[^>]*name="P1_MON" value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual([d, t], ['05-OCT-2026', '09:30']);
  });

  test('a mask with a quoted "T": the date field takes the date part only', async () => {
    const html = fieldOf((await new Browser(app).get(`/a/${alias}/1`)).body, 'P1_ISO');
    assert.match(html, /data-date-mask="YYYY-MM-DD"/);
  });

  test('what can\'t be read is an item error, not a database error; the time field carries the item\'s aria', async () => {
    for (const value of [['31-02-2026', '09:30'], ['', '09:30'], ['05-10-2026', '9:75']]) {
      const b = new Browser(app);
      await b.get(`/a/${alias}/1`);
      const res = await b.submit(`/a/${alias}/1`, { P1_ISO: value, P1_STARS: '', __request: 'SAVE' });
      assert.equal(res.statusCode, 422, value.join(' '));
      const html = fieldOf(res.body, 'P1_ISO');
      assert.match(html, /has-error/);
      assert.match(res.body, /Iso must be a date and time/);
      assert.match(html, /<input type="text" class="time-field"[^>]*aria-invalid="true"[^>]*aria-label="Iso \(Time\)"/);
    }
  });
});

test('a rating required only for some buttons can be cleared', async () => {
  const html = fieldOf((await new Browser(app).get(`/a/${alias}/1`)).body, 'P1_STARS');
  assert.match(html, /class="rating-clear" for="P1_STARS_0"/);
});

test('a link column with "else": "text" shows its label as text to users who may not open its page', async () => {
  const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
  assert.match(body, /<td class="link-col link-col-button" data-label="Qty"><span class="link-col-text">7<\/span><\/td>/);
  assert.doesNotMatch(body, /\/a\/ts-s262\/2/);
  assert.doesNotMatch(body, />Gone</);
});
