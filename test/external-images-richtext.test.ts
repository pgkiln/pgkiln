// Sprint 235 (MG-2, MG-5): pictures from other sites in template components and report column templates
// (their https origins join the page's CSP img-src), and the rich text display sanitizer's named character
// references and simple tables.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { cleanRichText, decodeEntities, sanitizeHtml } from '../src/richtext.ts';
import { allowImage, MAX_IMG_ORIGINS } from '../src/runtime/img-origins.ts';
import { compileTemplate, renderInstances, rowLookup } from '../src/runtime/template-components.ts';
import { builtinComponents } from '../src/runtime/builtin-components.ts';
import { clearRegionCache } from '../src/runtime/region-cache.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const added: number[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 19', [appId])).id;
});

after(async () => {
  if (added.length) await owner.query('delete from meta.region where id = any($1)', [added]);
  clearRegionCache();
  await app.close();
  await closePools();
});

const imgSrc = (csp: unknown) => /img-src ([^;]*)/.exec(String(csp))?.[1].split(' ') ?? [];

async function region(type: string, source: string, config: object) {
  const id = (await owner.one(`insert into meta.region (page_id, seq, title, type, columns, template, source, config)
    values ($1, 900 + $2, 'S235 ' || $2, $3, 12, 'standard', $4, $5) returning id`, [pageId, added.length, type, source, JSON.stringify(config)])).id;
  added.push(id);
  return id as number;
}

async function king() {
  const b = new Browser(app);
  await b.login('king');
  return b;
}

describe('MG-5: rich text display', () => {
  test('named character references show their character', () => {
    assert.equal(sanitizeHtml('<p>K&ouml;ln &ndash; it&rsquo;s &euro;&nbsp;5 &copy; &Eacute;</p>'), '<p>Köln – it’s € 5 © É</p>');
    // a name we don't know stays a reference (the browser reads it), unknown text stays text
    assert.equal(sanitizeHtml('&alefsym; &notaname; &amp;ouml; AT&T &foo'), '&alefsym; &notaname; &amp;ouml; AT&amp;T &amp;foo');
    // markup written as references stays text
    assert.equal(sanitizeHtml('&lt;b&gt;x&lt;/b&gt; &#60;i&#62;'), '&lt;b&gt;x&lt;/b&gt; &lt;i&gt;');
    assert.equal(decodeEntities('&ouml;&amp;&Ouml;'), 'ö&Ö');
    assert.equal(decodeEntities('&amp1;'), '&1;', 'the old set as before');
  });

  test('simple tables keep their structure, without attributes', () => {
    assert.equal(
      sanitizeHtml('<table class="x" border="1"><thead><tr><th style="color:red">Name</th><th>Qty</th></tr></thead><tbody><tr><td colspan="2">A</td><td>1</td></tr></tbody></table>'),
      '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>',
    );
    // cells and rows end where the next one starts, as in HTML
    assert.equal(sanitizeHtml('<table><tr><td>a<td>b<tr><td><b>c</b></table>'), '<table><tr><td>a</td><td>b</td></tr><tr><td><b>c</b></td></tr></table>');
    // parts out of place are dropped, their text kept
    assert.equal(sanitizeHtml('<td>x</td><tr>y</tr><table><p>z</p><tr><td>1</td></tr></table>'), 'xy<table>z<tr><td>1</td></tr></table>');
    // a table in a cell
    assert.equal(sanitizeHtml('<table><tr><td><table><tr><td>n</td></tr></table></td></tr></table>'), '<table><tr><td><table><tr><td>n</td></tr></table></td></tr></table>');
    assert.match(cleanRichText('<table><tr><td>only a table</td></tr></table>'), /^<table>/);
  });

  test('a display rich text item shows both on the page', async () => {
    const page43 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 43', [appId])).id;
    const item = (await owner.one(`insert into meta.item (page_id, seq, name, type, readonly_condition, default_value) values ($1, 990, 'P43_S235_RT', 'richtext', 'true', $2) returning id`,
      [page43, '<p>Gr&uuml;&szlig;e</p><table><tr><th>A</th></tr><tr><td>1</td></tr></table>'])).id;
    try {
      const body = (await (await king()).get('/a/hr/43')).body;
      assert.ok(body.includes('<div class="display-value rich-text" id="P43_S235_RT"><p>Grüße</p><table><tr><th>A</th></tr><tr><td>1</td></tr></table></div>'));
    } finally {
      await owner.query('delete from meta.item where id = $1', [item]);
    }
  });
});

describe('MG-2: pictures from other sites', () => {
  test('allowImage: https origins only, normalised, at most MAX_IMG_ORIGINS', () => {
    const set = new Set<string>();
    assert.equal(allowImage(set, ' https://Img.Example.com:443/a.png?x=1 '), 'https://img.example.com/a.png?x=1');
    assert.equal(allowImage(set, 'https://cdn.example.com:8443/b.png'), 'https://cdn.example.com:8443/b.png');
    for (const bad of ['http://img.example.com/a.png', '//img.example.com/a.png', 'https://u:p@img.example.com/a.png', 'javascript:alert(1)',
      'data:image/png;base64,AAAA', 'https://[::1]/a.png', '/static/a.png'])
      assert.equal(allowImage(set, bad), null, bad);
    assert.deepEqual([...set], ['https://img.example.com', 'https://cdn.example.com:8443']);
    for (let n = 0; set.size < MAX_IMG_ORIGINS; n++) allowImage(set, `https://h${n}.example.com/x.png`);
    assert.equal(allowImage(set, 'https://one-too-many.example.com/x.png'), null);
    assert.equal(allowImage(set, 'https://img.example.com/c.png'), 'https://img.example.com/c.png', 'an origin already allowed');
  });

  test('a rendered <img src> adds its origin; links and other schemes do not', () => {
    const set = new Set<string>();
    const c = compileTemplate('<img src="#IMAGE#" alt=""><a href="#HREF#">x</a>');
    const row = (image: string) => rowLookup(null, new Map(), new Map([['IMAGE', image], ['HREF', 'https://link.example.com/']]));
    const out = renderInstances(c, [row('https://a.example.com/p.png?x=1&y=2'), row('javascript:alert(1)'), row('http://b.example.com/p.png')], row(''), false, undefined, set);
    assert.deepEqual([...set], ['https://a.example.com']);
    assert.match(out, /<img src="https:\/\/a\.example\.com\/p\.png\?x=1&amp;y=2" alt="">/);
    assert.doesNotMatch(out, /javascript:/);
  });

  test('template component regions (built-in Avatar, Media list, Content row): the CSP allows the pictures\' origins', async () => {
    const builtin = new Map(builtinComponents());
    assert.ok(builtin.has('ut_avatar') && builtin.has('ut_media_list') && builtin.has('ut_content_row'));
    await region('template_component', `select 'Ann' as name, 'https://avatars.example.com/ann.png' as image`, { component: 'ut_avatar', attributes: { NAME: '#name#', IMAGE: '#image#' } });
    await region('template_component', `select 'Doc' as title, 'https://media.example.org/d.jpg' as image`, { component: 'ut_media_list', display: 'multiple', attributes: { TITLE: '#title#', IMAGE: '#image#' } });
    await region('template_component', `select 'Row' as title, 'https://rows.example.net/r.webp' as image`, { component: 'ut_content_row', display: 'multiple', attributes: { TITLE: '#title#', IMAGE: '#image#' } });
    const res = await (await king()).get('/a/hr/19');
    assert.equal(res.statusCode, 200);
    for (const o of ['https://avatars.example.com', 'https://media.example.org', 'https://rows.example.net']) {
      assert.ok(imgSrc(res.headers['content-security-policy']).includes(o), o);
      assert.ok(res.body.includes(`src="${o}/`), o);
    }
  });

  test('a report column template: the CSP allows each row\'s picture origin; plain columns add none', async () => {
    await region('report', `select n, 'https://col' || n || '.example.com/p.png' as photo, 'https://text.example.com/not-a-picture' as site
      from generate_series(1, 2) n`, { column_templates: { photo: { component: 'ut_avatar', attributes: { NAME: '#n#', IMAGE: '#photo#' } } } });
    await region('classic_report', `select 'https://classic.example.com/c.png' as photo`, { column_templates: { photo: { component: 'ut_avatar', attributes: { NAME: 'x', IMAGE: '#photo#' } } } });
    const csp = imgSrc((await (await king()).get('/a/hr/19')).headers['content-security-policy']);
    for (const o of ['https://col1.example.com', 'https://col2.example.com', 'https://classic.example.com']) assert.ok(csp.includes(o), o);
    assert.ok(!csp.includes('https://text.example.com'));
  });

  test('a cached region keeps its pictures\' origins; a lazy region names them', async () => {
    clearRegionCache();
    const cached = await region('template_component', `select 'https://cached.example.com/a.png' as image`, { component: 'ut_avatar', attributes: { NAME: 'c', IMAGE: '#image#' }, cache: { scope: 'all', seconds: 300 } });
    const b = await king();
    for (let n = 0; n < 2; n++) assert.ok(imgSrc((await b.get('/a/hr/19')).headers['content-security-policy']).includes('https://cached.example.com'), `request ${n + 1}`);
    await owner.query(`update meta.region set config = config - 'cache' || '{"lazy": true}' where id = $1`, [cached]);
    const page = await b.get('/a/hr/19');
    assert.ok(!imgSrc(page.headers['content-security-policy']).includes('https://cached.example.com'), 'not rendered yet');
    const json = JSON.parse((await b.get(`/a/hr/19/region/${cached}`)).body);
    assert.deepEqual(json.img, ['https://cached.example.com']);
    // with the region in the page (the "Show" link), the page's CSP allows it, and the page names its origins for app.js
    const shown = await b.get(`/a/hr/19?r${cached}_load=1`);
    assert.ok(imgSrc(shown.headers['content-security-policy']).includes('https://cached.example.com'));
    assert.match(shown.body, /"img":\[[^\]]*"https:\/\/cached\.example\.com"/);
  });
});
