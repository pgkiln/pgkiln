// Icons (src/icons.ts, public/icons.svg) and the builder's icon picker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { icon, iconParts, ICONS, isIcon, lucideNames, LUCIDE_VERSION, searchIcons } from '../src/icons.ts';
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
    // (0.31) another icon is in the "any icon" field, shown in the summary
    const other = iconPicker('f', 'icon', 'Icon', 'car-front lg').toString();
    assert.match(other, /<input id="f_custom" name="icon__custom" value="car-front lg"/);
    assert.match(other, /<summary[^>]*><svg class="icon icon-lg"[^>]*><use href="\/static\/icon\/car-front\.svg\?v=[\d.]+#i">/);
    assert.match(other, /data-icon-search="\/builder\/icons\/search"/);
  });

  test('(0.31) Lucide icons, Font APEX names and modifiers', () => {
    assert.ok(lucideNames().size > 1500, `${lucideNames().size} Lucide icons`);
    // pgkiln's own icon wins for a name both have; Lucide fills in the rest
    assert.deepEqual(iconParts('users'), { name: 'users', set: 'pgapex', classes: [] });
    assert.deepEqual(iconParts('car-front'), { name: 'car-front', set: 'lucide', classes: [] });
    assert.deepEqual(iconParts('fa fa-car-front fa-lg fa-spin'), { name: 'car-front', set: 'lucide', classes: ['icon-lg', 'icon-spin'] });
    assert.deepEqual(iconParts('truck flip-h success nonsense'), { name: 'truck', set: 'pgapex', classes: ['icon-flip-h', 'icon-success'] });
    assert.deepEqual(iconParts('lg users'), { name: 'users', set: 'pgapex', classes: ['icon-lg'] }, 'modifiers before the name too');
    for (const bad of ['no-such-icon', 'lg spin', '../etc/passwd', 'x"><script>', '', null]) assert.equal(isIcon(bad), false, String(bad));
    assert.equal(
      icon('fa-car-front 2x').toString(),
      `<svg class="icon icon-2x" aria-hidden="true" focusable="false"><use href="/static/icon/car-front.svg?v=${LUCIDE_VERSION}#i"></use></svg>`,
    );
    // search: the exact name first, then names that start with it, then the rest and search words
    const r = searchIcons('car');
    assert.equal(r[0], 'car');
    assert.ok(r.indexOf('car-front') < r.findIndex((n) => !n.startsWith('car')), 'prefix matches before others');
    assert.ok(searchIcons('vehicle').includes('car'), 'by search word');
    assert.deepEqual(searchIcons('x'), [], 'at least two characters');
    assert.ok(searchIcons('car', 5).length <= 5);
  });

  test('(0.31) a Lucide icon is served as a one-symbol sprite, cached for good; anything else is 404', async () => {
    const res = await app.inject({ url: `/static/icon/car-front.svg?v=${LUCIDE_VERSION}` });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^image\/svg\+xml/);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(res.body, /^<!-- Lucide [\d.]+, ISC License, https:\/\/lucide\.dev\/license -->\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"><symbol id="i" viewBox="0 0 24 24"><path /);
    assert.doesNotMatch(res.body, /class="lucide|stroke-width/, 'the .icon CSS draws it, like pgkiln\'s own');
    for (const bad of ['nope.svg', 'car-front.png', '..%2F..%2Fpackage.json', 'CAR.svg', '%2e%2e.svg'])
      assert.equal((await app.inject({ url: `/static/icon/${bad}` })).statusCode, 404, bad);
  });

  test('(0.31) the builder: icon search for developers only; "any icon" is checked and wins over the grid', async () => {
    const anon = await app.inject({ url: '/builder/icons/search?q=car' });
    assert.notEqual(anon.statusCode, 200);
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const found = JSON.parse((await dev.get('/builder/icons/search?q=car')).body);
    assert.equal(found.icons[0], 'car');
    assert.equal(found.version, LUCIDE_VERSION);
    const row = await owner.one('select * from meta.nav_entry where id = $1', [entry.id]);
    const editor = `/builder/apps/${hr}/shared?c=nav_entry-${entry.id}`;
    await dev.get(editor);
    const form = (custom: string): Record<string, string> => ({ label: row.label, seq: String(row.seq), target_page: String(row.target_page ?? ''), icon: 'trophy', icon__custom: custom });
    assert.equal((await dev.submit(`/builder/apps/${hr}/shared/nav_entry/${entry.id}`, form('fa-car-front   lg'))).statusCode, 303);
    assert.equal((await owner.one('select icon from meta.nav_entry where id = $1', [entry.id])).icon, 'fa-car-front lg');
    await dev.get(editor);
    const bad = await dev.submit(`/builder/apps/${hr}/shared/nav_entry/${entry.id}`, form('no-such-icon'));
    const shown = bad.headers.location ? (await dev.get(String(bad.headers.location))).body : bad.body;
    assert.match(shown, /there is no icon &quot;no-such-icon&quot;|there is no icon "no-such-icon"/);
    assert.equal((await owner.one('select icon from meta.nav_entry where id = $1', [entry.id])).icon, 'fa-car-front lg', 'unchanged');
    const king = new Browser(app);
    await king.login('king');
    assert.match((await king.get('/a/hr/1')).body, new RegExp(`<svg class="[^"]*icon-lg"[^>]*><use href="/static/icon/car-front\\.svg\\?v=${LUCIDE_VERSION.replace(/\./g, '\\.')}#i">`));
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
