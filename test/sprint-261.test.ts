// Sprint 261 (Jira PGKIL-12, found comparing two migrated Appsmith applications): a date-time item in the application's
// date format with a time field of its own, a file item shown as a button, read-only items as greyed fields with their
// placeholder (template option to-readonly-field), and required items checked only for some buttons (required_when).
// HR page 37 shows them (part 121).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const alias = 'ts-s261';
let pageId = 0;

/** The field wrapper of an item, as HTML. */
const fieldOf = (body: string, name: string) => {
  const at = body.indexOf(`data-item="${name}"`);
  assert.ok(at > 0, `${name} is on the page`);
  return body.slice(body.lastIndexOf('<', at), body.indexOf('data-item="', at + 12) > 0 ? body.indexOf('data-item="', at + 12) : undefined);
};

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  const appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role, date_format) values ($1, 'Sprint 261', 'none', 'hr_app', 'DD-MM-YYYY') returning id`, [alias])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth) values ($1, 1, 'Form', 'Form', false) returning id`, [appId])).id;
  const r = (await owner.one(`insert into meta.region (page_id, seq, title, type) values ($1, 10, 'Form', 'static') returning id`, [pageId])).id;
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, config, template_options, readonly_condition, required, placeholder, lov) values
    ($1, $2, 10, 'P1_WHEN', 'When', 'datetime', '{}', '{}', null, false, null, null),
    ($1, $2, 20, 'P1_FILE', 'File', 'file', '{"button": true}', '{}', null, false, null, null),
    ($1, $2, 30, 'P1_FILES', 'Files', 'file', '{"button": "Add photos", "multiple": true}', '{}', null, false, null, null),
    ($1, $2, 40, 'P1_CHOICE', 'Choice', 'select', '{"null_label": "Pick one"}', '{to-readonly-field}', 'true', false, null, 'STATIC:A,B'),
    ($1, $2, 50, 'P1_NOTE', 'Note', 'text', '{}', '{to-readonly-field}', 'true', false, 'Nothing yet', null),
    ($1, $2, 60, 'P1_PLAIN', 'Plain', 'text', '{}', '{}', 'true', false, 'Not shown', null),
    ($1, $2, 70, 'P1_NEED', 'Need', 'text', '{"required_when": ["SEND"]}', '{}', null, true, null, null)`, [pageId, r]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action) values ($1, $2, 10, 'SAVE', 'Save', 'submit'), ($1, $2, 20, 'SEND', 'Send', 'submit')`, [pageId, r]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias = $1`, [alias]);
  await app.close();
  await closePools();
});

describe('a date-time item', () => {
  test('the date in the date format with the date picker, and a time field; both post under the item\'s name', async () => {
    const b = new Browser(app);
    const html = fieldOf((await b.get(`/a/${alias}/1`)).body, 'P1_WHEN');
    assert.match(html, /<span class="datetime-field" data-datetime>/);
    assert.match(html, /<input type="text" id="P1_WHEN" name="P1_WHEN"[^>]*placeholder="DD-MM-YYYY"[^>]*data-date-mask="DD-MM-YYYY"/);
    assert.match(html, /data-date-pick="P1_WHEN"/);
    assert.match(html, /<input type="text" class="time-field" id="P1_WHEN_time" name="P1_WHEN" value=""[^>]*aria-label="When \(Time\)"/);
    assert.doesNotMatch(html, /datetime-local/);
  });

  for (const [date, time, stored] of [
    ['27-11-2026', '9:05', '2026-11-27T09:05'],
    ['27-11-2026', '1930', '2026-11-27T19:30'],
    ['2026-11-27', '07.15', '2026-11-27T07:15'],
    ['27-11-2026', '', '2026-11-27T00:00'],
    ['27-11-2026', '25:00', '27-11-2026 25:00'],
    ['', '', ''],
  ] as const) {
    test(`posted "${date}" and "${time}" is ${stored ? `"${stored}"` : 'empty'}; shown again in the format`, async () => {
      const b = new Browser(app);
      await b.get(`/a/${alias}/1`);
      await b.submit(`/a/${alias}/1`, { P1_WHEN: [date, time], P1_NEED: '', __request: 'SAVE' });
      const html = fieldOf((await b.get(`/a/${alias}/1`)).body, 'P1_WHEN');
      const [d, t] = [...html.matchAll(/<input type="text"[^>]*name="P1_WHEN" value="([^"]*)"/g)].map((m) => m[1]);
      if (stored === '2026-11-27T09:05') assert.deepEqual([d, t], ['27-11-2026', '09:05']);
      if (!stored) assert.deepEqual([d, t], ['', '']);
      if (stored === '27-11-2026 25:00') assert.deepEqual([d, t], ['27-11-2026', '25:00'], 'what can\'t be read is kept as typed');
      const s = await owner.one(`select coalesce(state ->> 'P1_WHEN', '') as v from meta.session where state ? 'P1_NEED' order by last_seen desc limit 1`);
      assert.equal(s.v, stored);
    });
  }
});

describe('a file item as a button', () => {
  test('{"button": true}: the input with a label button and "No file"; a text of its own; translated', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(fieldOf(body, 'P1_FILE'), /<span class="file-button"><input type="file" id="P1_FILE" name="P1_FILE"[^>]*><label for="P1_FILE" class="btn">[\s\S]*?Choose a file<\/label><span class="file-button-names" aria-live="polite">No file<\/span><\/span>/);
    assert.match(fieldOf(body, 'P1_FILES'), /<input type="file" id="P1_FILES" name="P1_FILES" multiple[^>]*>[\s\S]*?Add photos<\/label>/);
    const { builtinTexts } = await import('../src/i18n.ts');
    assert.equal(builtinTexts('nl')?.['file.choose'], 'Bestand kiezen');
    assert.equal(builtinTexts('de')?.['file.choose_many'], 'Dateien wählen');
  });

  test('without "button" the file input is as before; the label text is escaped', async () => {
    await owner.query(`update meta.item set config = '{"button": "<b>x</b>"}' where page_id = $1 and name = 'P1_FILE'`, [pageId]);
    try {
      const html = fieldOf((await new Browser(app).get(`/a/${alias}/1`)).body, 'P1_FILE');
      assert.match(html, /&lt;b&gt;x&lt;\/b&gt;<\/label>/);
      await owner.query(`update meta.item set config = '{}' where page_id = $1 and name = 'P1_FILE'`, [pageId]);
      const plain = fieldOf((await new Browser(app).get(`/a/${alias}/1`)).body, 'P1_FILE');
      assert.doesNotMatch(plain, /file-button/);
      assert.match(plain, /<input type="file" id="P1_FILE"/);
    } finally {
      await owner.query(`update meta.item set config = '{"button": true}' where page_id = $1 and name = 'P1_FILE'`, [pageId]);
    }
  });
});

describe('read-only items as greyed fields', () => {
  test('to-readonly-field: the empty choice or the placeholder in the box; without it nothing is shown', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(fieldOf(body, 'P1_CHOICE'), /class="field field-select readonly[^"]*to-readonly-field"[\s\S]*<div class="display-value" id="P1_CHOICE"><span class="display-placeholder">Pick one<\/span><\/div>/);
    assert.match(fieldOf(body, 'P1_NOTE'), /<span class="display-placeholder">Nothing yet<\/span>/);
    assert.doesNotMatch(fieldOf(body, 'P1_PLAIN'), /Not shown|display-placeholder/);
  });
});

describe('required_when', () => {
  test('the * shows; Save passes without a value, Send asks for it', async () => {
    const b = new Browser(app);
    const page = (await b.get(`/a/${alias}/1`)).body;
    assert.match(fieldOf(page, 'P1_NEED'), /Need<span class="req" aria-hidden="true">\*<\/span>/);
    const saved = await b.submit(`/a/${alias}/1`, { P1_NEED: '', __request: 'SAVE' });
    assert.doesNotMatch(saved.body, /Need is required|must have a value/i);
    assert.equal(saved.statusCode, 303);
    const sent = await b.submit(`/a/${alias}/1`, { P1_NEED: '', __request: 'SEND' });
    assert.equal(sent.statusCode, 422);
    assert.match(fieldOf(sent.body, 'P1_NEED'), /has-error/);
    const ok = await b.submit(`/a/${alias}/1`, { P1_NEED: 'yes', __request: 'SEND' });
    assert.equal(ok.statusCode, 303);
  });
});
