// Large tables (sprint 27): row-range pagination and maximum row counts,
// row limits on cards, charts, dynamic content and lists of values, lazy
// regions, region caching and streamed downloads. HR example page 25 reads
// 200,000 generated rows (examples/hr/hr_25_large_tables.sql).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { clearRegionCache } from '../src/runtime/region-cache.ts';
import { mergeReportSettings } from '../src/builder/report-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
let pageId: number;
const regions: Record<string, number> = {};

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
  pageId = (await owner.query(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 25`)).rows[0].id;
  for (const r of (await owner.query('select id, title from meta.region where page_id = $1', [pageId])).rows) regions[r.title] = r.id;
});

after(async () => {
  clearRegionCache();
  await app.close();
  await closePools();
});

const sectionOf = (page: string, id: number) => {
  const start = page.indexOf(`id="R${id}"`);
  return page.slice(start, page.indexOf('</section>', start));
};

describe('pagination of large tables', () => {
  test('row ranges: no total, Next from one extra row, Previous; the last page has no Next', async () => {
    const id = regions['All readings'];
    const page = sectionOf((await king.get('/a/hr/25')).body, id);
    assert.match(page, /Rows 1–25/);
    assert.doesNotMatch(page, /1–25 of/);
    assert.match(page, new RegExp(`r${id}_p=2"[^>]*>Next`));
    const p2 = sectionOf((await king.get(`/a/hr/25?r${id}_p=2`)).body, id);
    assert.match(p2, /Rows 26–50/);
    assert.match(p2, /Previous/);
    const last = sectionOf((await king.get(`/a/hr/25?r${id}_p=8000`)).body, id);
    assert.match(last, /Rows 199976–200000/);
    assert.doesNotMatch(last, />Next/);
    // a maximum that is a whole number of pages: no Next on the last one
    await owner.query(`update meta.region set config = config || '{"max_rows": 50}' where id = $1`, [id]);
    try {
      const capped = sectionOf((await king.get(`/a/hr/25?r${id}_p=2`)).body, id);
      assert.match(capped, /Rows 26–50/);
      assert.doesNotMatch(capped, />Next/);
    } finally {
      await owner.query(`update meta.region set config = config - 'max_rows' where id = $1`, [id]);
    }
  });

  test('a maximum row count caps the total and the pages', async () => {
    const id = regions['Readings of sensor A'];
    const page = sectionOf((await king.get(`/a/hr/25?r${id}_load=1`)).body, id);
    assert.match(page, /1–10 of more than 5000/);
    const beyond = sectionOf((await king.get(`/a/hr/25?r${id}_load=1&r${id}_p=900`)).body, id);
    assert.match(beyond, /4991–5000 of more than 5000/, 'a page past the maximum shows the last one');
    assert.doesNotMatch(beyond, />Next/);
    const csv = await king.get(`/a/hr/25?r${id}_csv=1`);
    assert.equal(csv.body.trim().split('\r\n').length, 5001, 'the download stops at the maximum too');
  });
});

describe('row limits', () => {
  test('cards stop at max_rows and say so', async () => {
    const page = sectionOf((await king.get('/a/hr/25')).body, regions['Latest readings']);
    assert.equal(page.match(/class="card"/g)?.length, 6);
    assert.match(page, /Showing the first 6 rows\./);
  });

  test('charts and dynamic content have a default limit; lists of values too', async () => {
    const chart = (await owner.query(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 90, 'Many bars', 'chart', 'select g::text, g from generate_series(1, 1500) g', '{"kind": "bar"}') returning id`, [pageId])).rows[0].id;
    const dyn = (await owner.query(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 91, 'Many rows', 'dynamic', $$select '<i>x</i>' from generate_series(1, 1500)$$, '{"max_rows": 7}') returning id`, [pageId])).rows[0].id;
    const item = (await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, lov, config) values ($1, $2, 1, 'P25_PICK', 'Pick', 'select', 'select g::text, g from generate_series(1, 6000) g', '{}') returning id`, [pageId, null])).rows[0].id;
    try {
      const body = (await king.get('/a/hr/25')).body;
      assert.match(sectionOf(body, chart), /Showing the first 1000 rows\./);
      assert.equal(sectionOf(body, dyn).match(/<i>x<\/i>/g)?.length, 7);
      assert.equal(body.match(/<option value="\d+"/g)?.length, 5000, 'lists of values: 5000 by default');
      await owner.query(`update meta.item set config = '{"max_rows": 40}' where id = $1`, [item]);
      assert.equal((await king.get('/a/hr/25')).body.match(/<option value="\d+"/g)?.length, 40);
    } finally {
      await owner.query('delete from meta.item where id = $1', [item]);
      await owner.query('delete from meta.region where id = any($1)', [[chart, dyn]]);
    }
  });
});

describe('lazy regions', () => {
  test('a placeholder with a link (no JavaScript), the region from the region endpoint', async () => {
    const id = regions['Readings of sensor A'];
    const page = (await king.get(`/a/hr/25?r${regions['All readings']}_p=3`)).body;
    const section = sectionOf(page, id);
    assert.match(section, /class="region-lazy" data-lazy="\/a\/hr\/25\/region\/\d+\?r\d+_p=3"/);
    assert.match(section, new RegExp(`href="/a/hr/25\\?r\\d+_p=3&amp;r${id}_load=1#R${id}"`));
    assert.doesNotMatch(section, /<table/);
    const res = await king.get(`/a/hr/25/region/${id}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    const json = JSON.parse(res.body);
    assert.match(json.html, new RegExp(`^<section class="region region-report[^"]*" id="R${id}"`));
    assert.match(json.html, /<table/);
    assert.match(json.detached, /<form id="rs\d+"/, 'the search form comes along');
  });
});

describe('region caching', () => {
  test('per user: the same HTML until a submit of the page; others get their own', async () => {
    clearRegionCache();
    const id = regions['Your summary'];
    const stamp = (body: string) => /rendered at ([\d:]+)/.exec(sectionOf(body, id))![1];
    const first = stamp((await king.get('/a/hr/25')).body);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(stamp((await king.get('/a/hr/25')).body), first, 'cached');
    const blake = new Browser(app);
    await blake.login('blake');
    const other = sectionOf((await blake.get('/a/hr/25')).body, id);
    assert.match(other, /Blake, the newest/);
    assert.doesNotMatch(other, /King/);
    await king.get('/a/hr/25');
    await king.submit('/a/hr/25', {});
    assert.notEqual(stamp((await king.get('/a/hr/25')).body), first, 'a submit of the page drops it');
  });

  test('a cached lazy region shows at once', async () => {
    clearRegionCache();
    const id = regions['Average per sensor'];
    assert.match(sectionOf((await king.get('/a/hr/25')).body, id), /data-lazy/);
    const json = JSON.parse((await king.get(`/a/hr/25/region/${id}`)).body);
    assert.match(json.html, /class="bar-row"/);
    const page = sectionOf((await king.get('/a/hr/25')).body, id);
    assert.doesNotMatch(page, /data-lazy/);
    assert.match(page, /class="bar-row"/);
  });
});

describe('streamed downloads', () => {
  test('CSV and Excel of 200,000 rows', async () => {
    const id = regions['All readings'];
    const csv = await king.get(`/a/hr/25?r${id}_csv=1`);
    assert.equal(csv.statusCode, 200);
    assert.equal(csv.headers['cache-control'], 'private, no-store');
    const lines = csv.body.trim().split('\r\n');
    assert.equal(lines.length, 200_001);
    assert.equal(lines[0].replace(/^\ufeff/, ''), 'Id,Sensor,Taken at,Value');
    assert.deepEqual([...csv.rawPayload.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a byte order mark for Excel');
    const xlsx = await king.get(`/a/hr/25?r${id}_xlsx=1`);
    assert.equal(xlsx.statusCode, 200);
    const files = unzipSync(new Uint8Array(xlsx.rawPayload));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    assert.match(sheet, /<row r="200001">/);
    assert.match(sheet, /<autoFilter ref="A1:D200001"\/><\/worksheet>$/);
    assert.match(strFromU8(files['xl/workbook.xml']), /\$A\$1:\$D\$200001/);
  });

  test('a failing query is still an error page, not a broken file', async () => {
    const bad = (await owner.query(`insert into meta.region (page_id, seq, title, type, source) values ($1, 92, 'Broken', 'report', 'select 1/0 as x') returning id`, [pageId])).rows[0].id;
    try {
      const res = await king.get(`/a/hr/25?r${bad}_csv=1`);
      assert.equal(res.statusCode, 500);
      assert.doesNotMatch(String(res.headers['content-type']), /csv/);
    } finally {
      await owner.query('delete from meta.region where id = $1', [bad]);
    }
  });
});

describe('builder: report settings for large tables', () => {
  test('pagination, maximum row count, lazy loading and cache', () => {
    const none = new Set<never>();
    const out = mergeReportSettings({ page_size: 25 } as any, { page_size: '25', pagination: 'range', max_rows: '20000000', lazy: 'true', cache_scope: 'session', cache_seconds: '999999', searchable: 'true', interactive: 'true', sortable: 'true', saved_reports: 'true' }, none, none, none);
    assert.equal(out.pagination, 'range');
    assert.equal(out.max_rows, 1_000_000);
    assert.equal(out.lazy, true);
    assert.deepEqual(out.cache, { scope: 'session', seconds: 86_400 });
    const off = mergeReportSettings(out, { page_size: '25', pagination: 'x', max_rows: '', cache_scope: 'everyone', searchable: 'true', interactive: 'true', sortable: 'true', saved_reports: 'true' }, none, none, none);
    assert.equal(off.pagination, undefined);
    assert.equal(off.max_rows, undefined);
    assert.equal(off.lazy, undefined);
    assert.equal(off.cache, undefined);
  });

  test('the form shows the fields', async () => {
    const owner2 = new Browser(app);
    await owner2.get('/builder/login');
    await owner2.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await owner2.get(`/builder/pages/${pageId}?c=region-${regions['All readings']}`)).body;
    assert.match(page, /name="pagination"[\s\S]*<option value="range" selected>/);
    assert.match(page, /name="cache_scope"/);
  });
});
