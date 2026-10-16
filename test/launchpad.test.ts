// Sprint 96 (Database Actions DA-15): the SQL Workshop's Launchpad (pins, tool groups) and the builder's search
// (Ctrl+K): tools, applications, pages and database objects by name, JSON or a page of results.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'lp96';
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S}; create table ${S}.lp96_orders (id int); create function ${S}.lp96_total() returns int language sql as 'select 1'`);
  await owner.query(`delete from meta.builder_pin where username = 'admin'`);
});
after(async () => {
  await owner.query(`drop schema if exists ${S} cascade`);
  await owner.query(`delete from meta.builder_pin where username = 'admin'`);
  await app.close();
  await closePools();
});
const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};

describe('the Launchpad', () => {
  test('tools in three groups with a line each; the More menu under the same headings', async () => {
    const b = await builder();
    const home = (await b.get('/builder/sql')).body;
    for (const g of ['Development', 'Administration', 'Monitoring']) assert.match(home, new RegExp(`<section class="lp-group" id="lp-${g.toLowerCase()}" data-lp-group="${g.toLowerCase()}" aria-label="${g}">`));
    assert.match(home, /<a href="\/builder\/sql\/worksheet">.*?<strong>SQL Worksheet<\/strong><small class="muted">Run statements and scripts/s);
    assert.match(home, /<a href="\/builder\/sql\/utilities\/monitor">/, 'administrators see the database monitor');
    assert.match(home, /Pinned &amp; recently visited/);
    assert.match(home, /<span class="small muted">Monitoring<\/span><a href="\/builder\/sql\/utilities\/about">/);
  });

  test('pin and unpin a tool, an object and a worksheet; only builder pages; at most 24', async () => {
    const b = await builder();
    await b.get('/builder/sql');
    assert.equal((await b.submit('/builder/pins', { href: '/builder/sql/quick', label: 'Quick SQL', icon: 'bolt', pin: '1', back: '/builder/sql' })).statusCode, 303);
    let home = (await b.get('/builder/sql')).body;
    assert.match(home, /<ul class="lp-chips"><li><a href="\/builder\/sql\/quick">.*?<span>Quick SQL<\/span><\/a>/s);
    assert.match(home, /Pinned Quick SQL to the SQL Workshop home/);
    // the Object Browser pins its object
    const ob = (await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.lp96_orders`)).body;
    assert.match(ob, /<div class="ob-pin"><form method="post" action="\/builder\/pins"/);
    await b.submit('/builder/pins', { href: `/builder/sql/objects?schema=${S}&k=table&o=${S}.lp96_orders`, label: 'lp96_orders', icon: 'table', pin: '1' });
    assert.match((await b.get(`/builder/sql/objects?schema=${S}&k=table&o=${S}.lp96_orders`)).body, /class="pin-btn is-pinned"/);
    await b.submit('/builder/pins', { href: '/builder/sql/quick', label: 'Quick SQL', pin: '0' });
    home = (await b.get('/builder/sql')).body;
    assert.doesNotMatch(home, /<ul class="lp-chips"><li><a href="\/builder\/sql\/quick">/);
    assert.match(home, /<span>lp96_orders<\/span>/);
    for (const href of ['https://evil.example/x', '//evil.example', '/a/hr/1', 'javascript:alert(1)', '/builder/x"><script>'])
      assert.equal((await b.submit('/builder/pins', { href, label: 'x', pin: '1' })).statusCode, 400, href);
    for (let k = 0; k < 30; k++) await b.submit('/builder/pins', { href: `/builder/sql/x${k}`, label: `x${k}`, pin: '1' });
    assert.equal(Number((await owner.one(`select count(*) as n from meta.builder_pin where username = 'admin'`))!.n), 24);
    await owner.query(`delete from meta.builder_pin where username = 'admin'`);
  });
});

describe('the builder\'s search', () => {
  test('tools, applications, pages and database objects; JSON for the dialog', async () => {
    const b = await builder();
    const r = (await b.get('/builder/palette?format=json&q=lp96')).json() as { results: { kind: string; label: string; href: string }[] };
    assert.deepEqual(r.results.map((x) => [x.kind, x.label]), [['Table', 'lp96_orders'], ['Function', 'lp96_total()']]);
    assert.equal(r.results[0].href, `/builder/sql/objects?schema=${S}&k=table&o=${S}.lp96_orders`);
    const hr = (await b.get('/builder/palette?format=json&q=employees')).json() as { results: { kind: string; href: string }[] };
    assert.ok(hr.results.some((x) => x.kind === 'Page' && /^\/builder\/apps\/\d+\/pages\/\d+$/.test(x.href)), 'HR pages');
    const tools = (await b.get('/builder/palette?format=json&q=worksheet')).json() as { results: { kind: string; label: string }[] };
    assert.equal(tools.results[0].label, 'SQL Worksheet');
    const app = (await b.get('/builder/palette?format=json&q=hr%20demo')).json() as { results: { kind: string }[] };
    assert.ok(app.results.some((x) => x.kind === 'Application'));
    // a LIKE pattern is text
    assert.deepEqual(((await b.get('/builder/palette?format=json&q=%25')).json() as { results: unknown[] }).results.filter((x: any) => x.kind === 'Table'), []);
  });

  test('a page of results without JavaScript; the header has the field on every builder page', async () => {
    const b = await builder();
    const page = (await b.get('/builder/palette?q=lp96_orders')).body;
    assert.match(page, /<ul class="pal-results"><li><a href="\/builder\/sql\/objects\?schema=lp96&amp;k=table&amp;o=lp96\.lp96_orders">/);
    assert.match((await b.get('/builder')).body, /<form method="get" action="\/builder\/palette" class="ide-search" role="search" data-palette>/);
    assert.match((await b.get('/builder/palette?q=zzzz_nothing')).body, /Nothing found for “zzzz_nothing”/);
    const anon = new Browser(app);
    assert.equal((await anon.get('/builder/palette?format=json&q=hr')).headers.location, '/builder/login');
  });
});
