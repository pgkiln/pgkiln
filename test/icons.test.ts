// Icons (src/icons.ts, public/icons.svg) and the builder's icon picker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { icon, ICONS } from '../src/icons.ts';
import { iconPicker } from '../src/builder/forms.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hr: number;
let entry: { id: number; icon: string | null };

before(async () => {
  app = await buildApp({ logger: false });
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  entry = (await owner.one(`select id, icon from meta.nav_entry where app_id = $1 and target_page = 1`, [hr]))!;
});
after(async () => {
  await owner.query('update meta.nav_entry set icon = $2 where id = $1', [entry.id, entry.icon]);
  await app.close();
  await closePools();
});

describe('icons', () => {
  test('every listed icon is in the sprite, every symbol is listed, once', () => {
    const svg = readFileSync(new URL('../public/icons.svg', import.meta.url), 'utf8');
    const symbols = [...svg.matchAll(/<symbol id="([^"]+)" viewBox="0 0 24 24">/g)].map((m) => m[1]);
    assert.deepEqual([...symbols].sort(), [...ICONS].sort());
    assert.equal(new Set(symbols).size, symbols.length, 'no duplicates');
    assert.ok(ICONS.length >= 130, `${ICONS.length} icons`);
    assert.doesNotMatch(svg, /<script|on[a-z]+=|href=|style=/i, 'plain shapes only');
  });

  test('unknown names draw nothing; names never reach the markup unchecked', () => {
    assert.equal(icon('trophy').toString(), '<svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#trophy"></use></svg>');
    assert.equal(icon('"><script>'), '');
    assert.equal(icon(null), '');
  });

  test('the picker: a radio per icon, the current one checked, works without script', () => {
    const markup = iconPicker('f_x_icon', 'icon', 'Icon', 'star').toString();
    assert.equal((markup.match(/type="radio" name="icon"/g) ?? []).length, ICONS.length + 1, 'every icon and none');
    assert.match(markup, /<input type="radio" name="icon" value="star" checked>/);
    assert.match(markup, /<summary[^>]*><svg class="icon"[^>]*><use href="\/static\/icons.svg#star"><\/use><\/svg><span>star<\/span><\/summary>/);
    assert.match(iconPicker('f', 'icon', 'Icon', 'gone').toString(), /value="" checked/, 'an unknown stored name shows as none');
  });

  test('a navigation entry gets a new icon in the builder and shows it in the application', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await dev.get(`/builder/apps/${hr}/shared?c=nav_entry-${entry.id}`)).body;
    assert.match(page, /class="icon-picker"/);
    const row = await owner.one('select * from meta.nav_entry where id = $1', [entry.id]);
    const form: Record<string, string> = { label: row.label, seq: String(row.seq), target_page: String(row.target_page ?? ''), icon: 'trophy' };
    const res = await dev.submit(`/builder/apps/${hr}/shared/nav_entry/${entry.id}`, form);
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select icon from meta.nav_entry where id = $1', [entry.id])).icon, 'trophy');
    const king = new Browser(app);
    await king.login('king');
    assert.match((await king.get('/a/hr/1')).body, /<use href="\/static\/icons.svg#trophy"><\/use>/);
  });
});
