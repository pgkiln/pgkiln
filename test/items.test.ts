// Item types of sprint 26: rich text and Markdown (sanitising), star rating,
// combobox (tags), date range, password reveal and QR code, on HR page 20.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { urlChecksum } from '../src/security.ts';
import { qrMatrix, qrSvg } from '../src/qrcode.ts';
import { cleanRichText, markdownHtml, safeHref, sanitizeHtml } from '../src/richtext.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let reviewId: string;

const link = (user: string, items: Record<string, string>) => `/a/hr/20?${new URLSearchParams({ ...items, cs: urlChecksum(appId, 20, user, items) })}`;

async function openReview(user = 'king') {
  const b = new Browser(app);
  await b.login(user);
  const page = await b.get(link(user, { P20_ID: reviewId }));
  assert.equal(page.statusCode, 200);
  return { b, page };
}

const valid = {
  __request: 'SAVE',
  P20_EMPNO: '7698',
  P20_PERIOD: ['2026-01-01', '2026-06-30'],
  P20_RATING: '4',
  P20_SKILLS: 'Sales',
  P20_SUMMARY: '<p>Fine</p>',
  P20_NOTES: 'ok',
};

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  reviewId = String(
    (await owner.one(`insert into hr.review (empno, period, rating, skills, summary, notes, created_by)
                      values (7698, '2026-01-01:2026-06-30', 3, 'Sales', '<p>x</p>', 'y', 'test') returning id`)).id,
  );
});

after(async () => {
  await owner.query(`delete from hr.review where created_by = 'test'`);
  await app.close();
  await closePools();
});

describe('QR codes (server-side SVG, no dependency)', () => {
  test('matches a reference encoder module for module', () => {
    // python-qrcode 8, version 1-M, mask 2, byte mode, "pgkiln"
    const expected = ['111111100111101111111', '100000100100101000001', '101110101101101011101', '101110101010001011101', '101110101011101011101', '100000101100101000001', '111111101010101111111', '000000001011100000000', '101111100010101111100', '111111010010100101101', '110001101101010011010', '011000000000000111100', '010000111111010010000', '000000001111111100011', '111111100110101101010', '100000101101111111101', '101110101000100010010', '101110101010100110000', '101110101001010001100', '100000100000000101100', '111111101101010010010'];
    assert.deepEqual(qrMatrix('pgkiln', 'M', 2)!.map((r) => r.map((d) => (d ? 1 : 0)).join('')), expected);
  });

  test('picks the smallest version, grows with the text and the error correction, refuses too much', () => {
    const size = (t: string, e: 'L' | 'M' | 'Q' | 'H') => qrMatrix(t, e)!.length;
    assert.equal(size('x', 'M'), 21);
    assert.equal(size('x'.repeat(14), 'M'), 21); // 1-M holds 14 bytes
    assert.equal(size('x'.repeat(15), 'M'), 25);
    assert.ok(size('x'.repeat(100), 'H') > size('x'.repeat(100), 'L'));
    assert.equal(size('x'.repeat(2953), 'L'), 177); // version 40
    assert.equal(qrMatrix('x'.repeat(2954), 'L'), null);
    assert.equal(size('€'.repeat(5), 'M'), 25); // UTF-8: 15 bytes
  });

  test('the SVG has a quiet zone, an accessible name and escapes it', () => {
    const svg = qrSvg('hello', { label: 'QR "<x>" & y', px: 100 })!;
    assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29" width="100" height="100" role="img" aria-label="QR &#34;&#60;x&#62;&#34; &#38; y"/);
    assert.match(svg, /<path fill="#000" d="M4 4h1v1h-1z/);
  });
});

describe('rich text and Markdown', () => {
  test('sanitizeHtml keeps the allow-list and drops everything else', () => {
    assert.equal(sanitizeHtml('<p class="x" onclick="a()">Hi <b>there</b><script>alert(1)</script></p>'), '<p>Hi <b>there</b></p>');
    assert.equal(sanitizeHtml('<p>open <b>bold <i>it'), '<p>open <b>bold <i>it</i></b></p>');
    assert.equal(sanitizeHtml('a<svg/>b<embed src=x>c<iframe>d</iframe>e'), 'abce');
    assert.equal(sanitizeHtml('<a href="https://x.example/?a=1&amp;b=2" target="_blank">l</a>'), '<a href="https://x.example/?a=1&amp;b=2" rel="noopener noreferrer nofollow">l</a>');
    assert.equal(sanitizeHtml('5 &lt; 6 &amp; <unknown>text</unknown>'), '5 &lt; 6 &amp; text');
  });

  test('links: http(s), mailto, tel and relative only', () => {
    for (const ok of ['https://a.b', 'http://a.b', 'mailto:x@y.z', 'tel:+3112', '/a/hr/1', 'page?x=1', '#top']) assert.ok(safeHref(ok), ok);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:x', 'java\tscript:x', ' javascript:x', 'java&#x09;script:x', '&#106;avascript:x', 'data:text/html,x', 'vbscript:x', 'java​script:x'])
      assert.equal(safeHref(bad), null, bad);
  });

  test('an empty editor stores nothing', () => {
    for (const empty of ['', '<br>', '<p><br></p>', '<p> </p>', '<div>&nbsp;</div>']) assert.equal(cleanRichText(empty), '', empty);
    assert.equal(cleanRichText('<hr>'), '<hr>');
  });

  test('Markdown renders headings, lists, emphasis, code and safe links; raw HTML stays text', () => {
    const h = markdownHtml('# T\n\n**b** _i_ `c<d>`\n\n- a\n- b\n\n[x](javascript:alert(1)) [y](https://y.example)\n\n<script>alert(1)</script>');
    assert.match(h, /<h1>T<\/h1>/);
    assert.match(h, /<strong>b<\/strong> <em>i<\/em> <code>c&lt;d&gt;<\/code>/);
    assert.match(h, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
    assert.match(h, /<a href="https:\/\/y.example" rel="noopener noreferrer nofollow">y<\/a>/);
    assert.doesNotMatch(h, /href="javascript/i);
    assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('long hostile input is handled in linear time', () => {
    const t = Date.now();
    markdownHtml(' '.repeat(200_000) + 'x');
    markdownHtml('**'.repeat(100_000));
    markdownHtml('_a'.repeat(100_000));
    sanitizeHtml('<style>'.repeat(50_000));
    sanitizeHtml('<a '.repeat(50_000));
    assert.ok(Date.now() - t < 5000);
  });
});

describe('item types on page 20', () => {
  test('the form renders every new item type', async () => {
    const { page } = await openReview();
    const body = page.body;
    assert.match(body, /<fieldset class="field field-daterange[^"]*"/);
    assert.match(body, /<input type="date" id="P20_PERIOD" name="P20_PERIOD" value="2026-01-01" max="2026-06-30"/);
    assert.match(body, /<input type="date" id="P20_PERIOD_TO" name="P20_PERIOD" value="2026-06-30" min="2026-01-01"/);
    assert.match(body, /<input type="radio" id="P20_RATING_3" name="P20_RATING" value="3" checked/);
    assert.doesNotMatch(body, /id="P20_RATING_0"/, 'a required rating has no "no rating" choice');
    assert.match(body, /<input type="text" id="P20_SKILLS" name="P20_SKILLS" value="Sales" list="P20_SKILLS_list"/);
    assert.match(body, /<datalist id="P20_SKILLS_list">[\s\S]*<option value="Leadership">/);
    assert.match(body, /data-richtext="P20_SUMMARY"[\s\S]*<textarea id="P20_SUMMARY" name="P20_SUMMARY"[^>]*>&lt;p&gt;x&lt;\/p&gt;<\/textarea>/);
    assert.match(body, /data-markdown="P20_NOTES"/);
    assert.match(body, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="qr-code"[^>]*aria-label="QR code: HR review \d+: Blake, 2026-01-01 – 2026-06-30, 3\/5"/);
    assert.match(body, /<button type="button" class="btn" data-reveal="P20_PIN" aria-controls="P20_PIN" aria-pressed="false" data-hide="Hide" hidden>Show<\/button>/);
  });

  test('saving normalises tags, joins the dates, sanitises rich text and keeps Markdown as text', async () => {
    const { b } = await openReview();
    const res = await b.submit('/a/hr/20', {
      ...valid,
      P20_SKILLS: ' Sales : SQL::Sales: New skill ',
      P20_SUMMARY: '<p onclick="x()">Good <b>work</b></p><script>alert(1)</script>',
      P20_NOTES: '# Plan\r\n- a',
    });
    assert.equal(res.statusCode, 303, res.body.slice(0, 400));
    const row = await owner.one('select * from hr.review where id = $1', [reviewId]);
    assert.equal(row.period, '2026-01-01:2026-06-30');
    assert.equal(row.rating, 4);
    assert.equal(row.skills, 'Sales:SQL:New skill');
    assert.equal(row.summary, '<p>Good <b>work</b></p>');
    assert.equal(row.notes, '# Plan\n- a');
  });

  test('a date range from a dynamic action ("from:to" in one value) is accepted', async () => {
    const { b } = await openReview();
    const res = await b.submit('/a/hr/20', { ...valid, P20_PERIOD: '2026-02-01:2026-02-28' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select period from hr.review where id = $1', [reviewId])).period, '2026-02-01:2026-02-28');
  });

  test('validation: date order, real dates, both dates when required, rating range', async () => {
    const cases: [Record<string, string | string[]>, RegExp][] = [
      [{ P20_PERIOD: ['2026-06-30', '2026-01-01'] }, /Period: the start date must not be after the end date/],
      [{ P20_PERIOD: ['2026-02-30', '2026-03-01'] }, /Period: enter the dates as a valid range/],
      [{ P20_PERIOD: ['2026-01-01', ''] }, /Period is required|Period/],
      [{ P20_PERIOD: ['2026-01-01', '2026-01-02', '2026-01-03'] }, /Period: enter the dates as a valid range/],
      [{ P20_RATING: '6' }, /Rating: choose a rating from 1 to 5/],
      [{ P20_RATING: 'x' }, /Rating: choose a rating from 1 to 5/],
    ];
    for (const [change, message] of cases) {
      const { b } = await openReview();
      const res = await b.submit('/a/hr/20', { ...valid, ...change });
      assert.equal(res.statusCode, 422, JSON.stringify(change));
      assert.match(res.body, message, JSON.stringify(change));
    }
    assert.equal((await owner.one('select period from hr.review where id = $1', [reviewId])).period, '2026-02-01:2026-02-28', 'nothing saved');
  });

  test('read-only items show stars, tags, the range and formatted text', async () => {
    await owner.query(`update meta.item i set readonly_condition = 'true' from meta.page p join meta.app a on a.id = p.app_id
                        where i.page_id = p.id and a.alias = 'hr' and p.page_no = 20 and i.name in ('P20_RATING', 'P20_SKILLS', 'P20_PERIOD', 'P20_SUMMARY', 'P20_NOTES')`);
    try {
      await owner.query(`update hr.review set rating = 2, skills = 'Sales:SQL', summary = '<p>Nice <em>job</em></p>', notes = '**bold**' where id = $1`, [reviewId]);
      const { body } = (await openReview()).page;
      assert.match(body, /<div class="display-value rating-value" id="P20_RATING"><span aria-hidden="true">★★<span class="rating-off">★★★<\/span><\/span><span class="sr-only">2 of 5<\/span>/);
      assert.match(body, /<span class="tag">Sales<\/span> <span class="tag">SQL<\/span>/);
      assert.match(body, /id="P20_PERIOD">2026-02-01 – 2026-02-28</);
      assert.match(body, /<div class="display-value rich-text" id="P20_SUMMARY"><p>Nice <em>job<\/em><\/p><\/div>/);
      assert.match(body, /<div class="display-value rich-text" id="P20_NOTES"><p><strong>bold<\/strong><\/p><\/div>/);
    } finally {
      await owner.query(`update meta.item i set readonly_condition = null from meta.page p join meta.app a on a.id = p.app_id
                          where i.page_id = p.id and a.alias = 'hr' and p.page_no = 20 and i.name like 'P20_%'`);
    }
  });

  test('Dutch texts for the new items', async () => {
    const b = new Browser(app);
    await b.login('king');
    await b.get('/a/hr/1?lang=nl');
    const body = (await b.get(link('king', { P20_ID: reviewId }))).body;
    assert.match(body, /<html lang="nl"/);
    assert.match(body, /Beoordelingen/);
    assert.match(body, />Van</);
    assert.match(body, />Tot en met</);
    assert.match(body, />Tonen</);
  });
});

describe('popup LOV', () => {
  test('a select list without JavaScript; a value beyond max_rows still shows its name; the dialog pages', async () => {
    const setConfig = (config: string) =>
      owner.query(`update meta.item i set config = $2::jsonb from meta.page p where p.id = i.page_id and p.app_id = $1 and i.name = 'P26_EMPNO'`, [appId, config]);
    try {
      await setConfig('{"page_size": 5, "max_rows": 2}');
      const b = new Browser(app);
      await b.login('king');
      const page = (await b.get('/a/hr/26')).body;
      assert.match(page, /<select id="P26_EMPNO" name="P26_EMPNO" data-popup-lov="\/a\/hr\/26\/lov\/P26_EMPNO\/search"/);
      assert.equal((page.match(/<option value="\d+"/g) ?? []).length, 2 + 4, 'two employees (max_rows) and the four departments');
      const res = await b.post('/a/hr/26', { __csrf: b.lastCsrf, P26_EMPNO: '7934', P26_DEPTNO: '', __request: 'SHOW' });
      const after = (await b.get(String(res.headers.location ?? '/a/hr/26'))).body;
      assert.match(after, /<option value="7934" selected>Miller<\/option>/, 'looked up by its return value');
      assert.match(after, /<td[^>]*>Miller<\/td>/);
      const first = (await b.post('/a/hr/26/lov/P26_EMPNO/search', { __csrf: b.lastCsrf, q: '' })).json();
      assert.equal(first.rows.length, 5);
      assert.equal(first.more, true);
      assert.deepEqual(first.headings, ['Employee', 'Job', 'Department']);
      const last = (await b.post('/a/hr/26/lov/P26_EMPNO/search', { __csrf: b.lastCsrf, q: '', p: '2' })).json();
      assert.equal(last.more, false);
      assert.ok(last.rows.length >= 1);
    } finally {
      await setConfig('{"page_size": 5}');
    }
  });
});
