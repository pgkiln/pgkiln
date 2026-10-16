// Sprint 98 (Database Actions DA-10): the Data Modeler. A diagram "hr core" of hr.emp, hr.dept and hr.leave_request
// shows the foreign key lines emp → dept and leave_request → emp, keeps its positions, exports as SVG, and gives the
// DDL and a data dictionary of its objects. The geometry (sizes, lines, automatic layout) is tested on its own.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { autoLayout, boxSize, cleanObjects, fkPath, matchNames, placeAll, type ModelTable } from '../src/datamodel.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const S = 'dm98';
before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.sql_diagram where name like 'dm98%' or name = 'hr core'`);
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S};
    create table ${S}.a (id int primary key, note text); create table ${S}.b (id int primary key, a_id int not null references ${S}.a);
    create view ${S}.v as select id from ${S}.a; comment on table ${S}.a is 'The A things'; comment on column ${S}.a.note is 'A note'`);
});
after(async () => {
  await owner.query(`delete from meta.sql_diagram where name like 'dm98%' or name = 'hr core'`);
  await owner.query(`drop schema if exists ${S} cascade`);
  await app.close();
  await closePools();
});
const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  await b.get('/builder/sql/modeler');
  return b;
};
const idOf = (location: unknown) => /\/builder\/sql\/modeler\/(\d+)/.exec(String(location))![1];

describe('Data Modeler', () => {
  test('a diagram "hr core": boxes, FK lines emp → dept and leave_request → emp, positions survive, SVG export', async () => {
    const b = await builder();
    const list = (await b.get('/builder/sql/modeler')).body;
    assert.match(list, /Create diagram/);
    assert.match(list, /aria-current="page"[^>]*>.*Data Modeler|Data Modeler/);
    const created = await b.submit('/builder/sql/modeler', { name: 'hr core', schema: 'hr', objects: 'emp, dept, leave_request' });
    assert.equal(created.statusCode, 303);
    const id = idOf(created.headers.location);
    const page = (await b.get(`/builder/sql/modeler/${id}`)).body;
    assert.match(page, /Diagram hr core created with 3 objects/);
    for (const t of ['emp', 'dept', 'leave_request']) assert.match(page, new RegExp(`class="dm-box dm-table" data-name="${t}"`));
    assert.match(page, /class="dm-fk[^"]*" data-from="emp" data-to="dept"/);
    assert.match(page, /class="dm-fk[^"]*" data-from="leave_request" data-to="emp"/);
    assert.match(page, /href="\/builder\/sql\/objects\/table\?o=hr\.emp"/, 'a box opens Table Properties');
    assert.doesNotMatch(page, /style="/);
    // the automatic layout puts parents left of their children
    const x = (t: string) => Number(new RegExp(`data-name="${t}" data-x="(\\d+)"`).exec(page)![1]);
    assert.ok(x('dept') < x('emp') && x('emp') < x('leave_request'));

    // positions are saved (JSON from the page's script) and survive a reload
    const saved = await b.submit(`/builder/sql/modeler/${id}/layout`, { format: 'json', positions: JSON.stringify([{ name: 'dept', x: 700, y: 640 }, { name: 'nope', x: 1, y: 1 }]) });
    assert.deepEqual(saved.json(), { ok: true, saved: 3 });
    const again = (await b.get(`/builder/sql/modeler/${id}`)).body;
    assert.match(again, /data-name="dept" data-x="700" data-y="640"/);
    assert.match(again, /transform="translate\(700 640\)"/);
    const row = await owner.one(`select objects from meta.sql_diagram where id = $1`, [id]);
    assert.deepEqual(row!.objects.map((o: any) => o.name).sort(), ['dept', 'emp', 'leave_request'], 'unknown names are not saved');

    const svg = await b.get(`/builder/sql/modeler/${id}/svg`);
    assert.equal(svg.statusCode, 200);
    assert.match(String(svg.headers['content-type']), /^image\/svg\+xml/);
    assert.match(String(svg.headers['content-disposition']), /attachment; filename="hr_core\.svg"/);
    assert.match(svg.body, /^<\?xml/);
    assert.match(svg.body, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg.body, /data-from="leave_request" data-to="emp"/);
    assert.doesNotMatch(svg.body, /<a |tabindex/, 'no links in the file');

    // auto layout without script
    assert.equal((await b.submit(`/builder/sql/modeler/${id}/layout`, { layout: 'auto' })).statusCode, 303);
    assert.doesNotMatch((await b.get(`/builder/sql/modeler/${id}`)).body, /data-name="dept" data-x="700"/);
  });

  test('add objects by search (* for all), remove one, rename, delete', async () => {
    const b = await builder();
    const created = await b.submit('/builder/sql/modeler', { name: 'dm98 one', schema: S, objects: '' });
    const id = idOf(created.headers.location);
    assert.match(String(created.headers.location), /#dm-add$/);
    const found = (await b.get(`/builder/sql/modeler/${id}?q=*`)).body;
    assert.match(found, /3 found/);
    assert.match(found, /value="v" checked> v <span class="tag">view<\/span>/);
    const sub = (await b.get(`/builder/sql/modeler/${id}?q=b`)).body;
    assert.match(sub, /1 found/);
    await b.submit(`/builder/sql/modeler/${id}/objects`, { t: ['a', 'b', 'v', 'missing'] });
    let page = (await b.get(`/builder/sql/modeler/${id}`)).body;
    assert.match(page, /Added 3 objects: a, b, v\./);
    assert.match(page, /data-from="b" data-to="a"/);
    assert.match(page, /class="dm-box dm-view" data-name="v"/);
    assert.match(page, /href="\/builder\/sql\/objects\?schema=dm98&amp;k=view&amp;o=dm98\.v"/);
    // a not-null foreign key is a solid line
    assert.match(page, /class="dm-fk" data-from="b"/);
    await b.submit(`/builder/sql/modeler/${id}/objects`, { remove: 'v' });
    page = (await b.get(`/builder/sql/modeler/${id}`)).body;
    assert.doesNotMatch(page, /data-name="v"/);
    assert.match(page, /v removed from the diagram/);
    // a dropped table: said so, and left out
    await owner.query(`create table ${S}.gone (id int); `);
    await b.submit(`/builder/sql/modeler/${id}/objects`, { t: 'gone' });
    await owner.query(`drop table ${S}.gone`);
    assert.match((await b.get(`/builder/sql/modeler/${id}`)).body, /Not in dm98 any more: gone/);

    await b.submit('/builder/sql/modeler', { name: 'dm98 two', schema: S });
    await b.submit(`/builder/sql/modeler/${id}/rename`, { name: 'dm98 two' });
    assert.match((await b.get(`/builder/sql/modeler/${id}`)).body, /There is already a diagram dm98 two/);
    await b.submit(`/builder/sql/modeler/${id}/rename`, { name: 'dm98 renamed' });
    assert.match((await b.get('/builder/sql/modeler')).body, /dm98 renamed/);
    assert.equal((await b.submit(`/builder/sql/modeler/${id}/delete`, {})).statusCode, 303);
    assert.equal((await b.get(`/builder/sql/modeler/${id}`)).statusCode, 404);
  });

  test('DDL of the shown objects and the data dictionary', async () => {
    const b = await builder();
    const id = idOf((await b.submit('/builder/sql/modeler', { name: 'dm98 ddl', schema: S, objects: 'b, a' })).headers.location);
    const ddl = (await b.get(`/builder/sql/modeler/${id}/ddl`)).body;
    assert.match(ddl, /create table a \(/);
    assert.match(ddl, /create table b \(/);
    assert.match(ddl, /FOREIGN KEY \(a_id\) REFERENCES a\(id\)/i);
    assert.match(ddl, /comment on table a is &#39;The A things&#39;;/);
    assert.doesNotMatch(ddl, /create view v/, 'not the objects the diagram leaves out');
    assert.match(ddl, /Open in the SQL Worksheet/);
    const file = await b.get(`/builder/sql/modeler/${id}/ddl?download=1`);
    assert.match(String(file.headers['content-disposition']), /dm98_ddl\.sql/);
    assert.match(file.body, /^-- DDL of 2 objects of schema dm98/);

    const dict = (await b.get(`/builder/sql/modeler/${id}/dictionary`)).body;
    assert.match(dict, /Data dictionary: dm98 ddl/);
    assert.match(dict, /The A things/);
    assert.match(dict, /A note/);
    assert.match(dict, /<td>Foreign key<\/td><td class="u-break"><code>FOREIGN KEY \(a_id\) REFERENCES dm98\.a\(id\)<\/code>/);
    assert.match(dict, /Referenced by/);
    const html = await b.get(`/builder/sql/modeler/${id}/dictionary?download=1`);
    assert.match(String(html.headers['content-disposition']), /dm98_ddl-dictionary\.html/);
    assert.match(html.body, /^<!doctype html>/);
  });

  test('geometry: sizes, matching, cleaning, layout, lines', () => {
    const t = (name: string, refs: string[] = [], cols = 2): ModelTable => ({
      name, kind: 'table', ref: name, comment: null,
      columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: 'integer', notNull: false, default: null, comment: null })),
      constraints: refs.map((r) => ({ name: `${name}_${r}_fk`, type: 'f' as const, cols: ['c1'], refSchema: 's', refTable: r, refCols: ['c0'], def: '' })),
    });
    assert.equal(boxSize(t('x', [], 100)).h, 30 + 40 * 20 + 6, 'at most 40 rows (39 columns and a "more" row)');
    assert.deepEqual(matchNames(['emp', 'employee', 'dept'], 'emp'), ['emp', 'employee']);
    assert.deepEqual(matchNames(['emp', 'employee', 'dept'], 'emp', { exact: true }), ['emp']);
    assert.deepEqual(matchNames(['emp', 'employee', 'dept'], 'emp*, dept'), ['emp', 'employee', 'dept']);
    assert.deepEqual(matchNames(['a.b', 'axb'], 'a.*'), ['a.b']);
    assert.deepEqual(cleanObjects([{ name: 'a', x: -5, y: 1e9 }, { name: 'a', x: 1, y: 1 }, { x: 1 }, 'z']), [{ name: 'a', x: 0, y: 20000 }]);
    const tables = [t('child', ['parent']), t('parent'), t('grandchild', ['child']), t('loop1', ['loop2']), t('loop2', ['loop1'])];
    const pos = new Map(autoLayout('s', tables).map((p) => [p.name, p]));
    assert.ok(pos.get('parent')!.x < pos.get('child')!.x && pos.get('child')!.x < pos.get('grandchild')!.x);
    assert.equal(pos.size, 5, 'a cycle doesn\'t stop the layout');
    const placed = placeAll('s', [t('p'), t('new')], [{ name: 'p', x: 10, y: 10 }]);
    assert.deepEqual(placed[0], { name: 'p', x: 10, y: 10 });
    assert.ok(placed[1].y > 10 + boxSize(t('p')).h, 'a new box goes below the placed ones');
    const a = { name: 'a', x: 0, y: 0, w: 100, h: 100 };
    const right = { name: 'b', x: 300, y: 0, w: 100, h: 100 };
    assert.equal(fkPath(a, 40, right, 15).path, 'M 100 40 H 200 V 15 H 300');
    assert.equal(fkPath(right, 40, a, 15).path, 'M 300 40 H 200 V 15 H 100');
    assert.equal(fkPath(a, 40, a, 15).path, 'M 100 40 H 118 V 15 H 100', 'a self reference loops on the right');
  });
});
