// Document templates: the template language, the HTML subset, the PDF and
// the download from a page (the HR sample's employee sheet).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { documentFilename, documentPdf, fillTemplate, parseHtml, TemplateError, templateProblem } from '../src/runtime/document.ts';
import { BUILT_IN } from '../src/runtime/pdf.ts';
import { Browser, pdfText } from './helpers.ts';

let app: FastifyInstance;
let appId: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await owner.query(`delete from meta.document_template where app_id = $1 and name like 'TEST_%'`, [appId]);
  await owner.query(`update meta.document_template set authz = null where app_id = $1 and name = 'EMPLOYEE_SHEET'`, [appId]);
  await app.close();
  await closePools();
});

/** The words of a PDF's text, so kerning splits don't matter. */
const words = (pdf: Buffer) => pdfText(pdf).replace(/\s+/g, ' ');

describe('template language', () => {
  test('values, paths, lists, objects, flags and escaping', () => {
    const data = {
      name: '<b>Ann & "Bob"</b>', zero: 0, list: [{ n: 'a' }, { n: 'b' }], empty: [], obj: { city: 'Delft' }, flag: true, tags: ['x', 'y'],
    };
    assert.equal(fillTemplate('{{name}}', data), '&lt;b&gt;Ann &amp; &quot;Bob&quot;&lt;/b&gt;');
    assert.equal(fillTemplate('{{#list}}[{{@index}}:{{n}}]{{/list}}', data), '[1:a][2:b]');
    assert.equal(fillTemplate('{{#empty}}x{{/empty}}{{^empty}}none{{/empty}}', data), 'none');
    assert.equal(fillTemplate('{{obj.city}} {{#obj}}{{city}}{{/obj}}', data), 'Delft Delft');
    assert.equal(fillTemplate('{{#flag}}yes{{/flag}}{{#zero}}no{{/zero}}{{^zero}}zero{{/zero}}', data), 'yeszero');
    assert.equal(fillTemplate('{{#tags}}{{.}};{{/tags}}', data), 'x;y;');
    assert.equal(fillTemplate('{{#list}}{{name}}{{/list}}', { ...data, name: 'outer' }).length > 0, true, 'outer values stay visible in a list');
    assert.equal(fillTemplate('{{missing}}|{{! comment }}|', data), '||');
  });

  test('filters', () => {
    assert.equal(fillTemplate('{{v|number:2}}', { v: '1234.5' }, { lang: 'en' }), '1,234.50');
    assert.equal(fillTemplate('{{v|number:2}}', { v: 1234.5 }, { lang: 'nl' }), '1.234,50');
    assert.equal(fillTemplate('{{v|number}}', { v: 'abc' }), 'abc');
    assert.equal(fillTemplate('{{d|date}}', { d: '2026-10-01' }, { fmt: (v) => `D:${v}` }), 'D:2026-10-01');
    assert.equal(fillTemplate('{{d|date}}', { d: '2026-10-01T12:00:00Z' }), '2026-10-01');
    assert.equal(fillTemplate('{{v|upper}} {{w|default:-}} {{w|default:n/a|upper}}', { v: 'ab', w: null }), 'AB - N/A');
  });

  test('mistakes are reported with their position', () => {
    for (const [tpl, re] of [
      ['{{#a}}x', /not closed/], ['{{#a}}x{{/b}}', /closes \{\{#a\}\}/], ['{{/a}}', /closes nothing/], ['{{a', /not closed with \}\}/],
      ['{{a|bogus}}', /Unknown filter "bogus"/], ['{{{a}}}', /Unescaped output/], ['{{&a}}', /Unescaped output/], ['{{}}', /empty tag/],
    ] as const) {
      assert.throws(() => fillTemplate(tpl, { a: 1 }), TemplateError, tpl);
      assert.match(templateProblem(tpl) ?? '', re, tpl);
    }
    assert.equal(templateProblem('<p>{{#a}}{{b|number:2}}{{/a}}</p>'), null);
  });

  test('the HTML parser is tolerant and decodes entities', () => {
    const root = parseHtml('<p>a &amp; b&nbsp;&#169;<br>c<b>d</p><table><tr><td width="30%">x</td></table><!-- skip -->');
    const p = root.children[0] as any;
    assert.equal(p.tag, 'p');
    assert.equal(p.children[0], 'a & b ©');
    assert.equal(p.children[1].tag, 'br');
    assert.equal((root.children[1] as any).children[0].children[0].attrs.width, '30%');
    assert.equal(root.children.length, 2);
  });

  test('file names are safe', () => {
    assert.equal(documentFilename('employee-7788'), 'employee-7788.pdf');
    assert.equal(documentFilename('../../etc/passwd'), 'etc_passwd.pdf');
    assert.equal(documentFilename('Rapport 2026 é.pdf'), 'Rapport_2026_é.pdf');
    assert.equal(documentFilename('///'), 'document.pdf');
  });
});

describe('PDF', () => {
  test('headings, paragraphs, lists, tables over several pages with repeated headers, page breaks', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => `<tr><td>Row ${i + 1}</td><td align="right">${i * 10}</td></tr>`).join('');
    const html = `<h1>Title</h1><p>Some <b>bold</b> and <i>italic</i> text, <a href="https://example.org">a link</a>.</p>
      <ul><li>first</li><li>second</li></ul><ol><li>one</li></ol>
      <table><thead><tr><th width="70%">Name</th><th align="right">Value</th></tr></thead>${rows}</table>
      <div class="page-break"></div><p class="muted">Last page</p><img src="logo"><img src="https://evil.example/x.png">`;
    const pdf = await documentPdf({ html, layout: BUILT_IN, title: 'T', author: 'me', footer: 'Footer text', pageLabel: (p, n) => `Page ${p} of ${n}` });
    const text = words(pdf);
    for (const w of ['Title', 'bold', 'italic', 'first', 'second', 'Row 1', 'Row 120', 'Last page', 'Footer text']) assert.match(text, new RegExp(w), w);
    const pages = Number(/Page \d+ of (\d+)/.exec(text)![1]);
    assert.ok(pages >= 3, `the table runs over pages and the page break adds one (${pages})`);
    assert.ok((text.match(/Name/g) ?? []).length >= pages - 1, 'the table header repeats on every page it runs over');
    assert.doesNotMatch(pdf.toString('latin1'), /evil\.example/, 'no remote images');
  });
});

describe('download from a page', () => {
  /** A browser on the employee form of 7788 (opened through the report's checksummed link). */
  async function onEmployee(user: string) {
    const b = new Browser(app);
    await b.login(user);
    const list = (await b.get('/a/hr/2')).body;
    const href = /href="(\/a\/hr\/3\?[^"]*P3_EMPNO=7788[^"]*)"/.exec(list)![1].replace(/&amp;/g, '&');
    return { b, form: (await b.get(href)).body };
  }

  test('the Print button downloads the employee sheet, filled with the page\'s values', async () => {
    const { b, form } = await onEmployee('king');
    assert.match(form, /<a class="btn" href="\/a\/hr\/3\?doc=EMPLOYEE_SHEET" download>Print<\/a>/);
    const res = await b.get('/a/hr/3?doc=EMPLOYEE_SHEET');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="employee-7788.pdf"');
    const text = words(res.rawPayload);
    assert.match(text, /Scott/);
    assert.match(text, /Analyst/);
    assert.match(text, /3,000\.00/);
    assert.match(text, /printed on .* by king/);
  });

  test('item values in the URL need their checksum; unknown and unauthorized templates are refused', async () => {
    const { b } = await onEmployee('king');
    assert.equal((await b.get('/a/hr/3?P3_EMPNO=7839&doc=EMPLOYEE_SHEET')).statusCode, 403, 'no checksum');
    assert.equal((await b.get('/a/hr/3?doc=NO_SUCH')).statusCode, 403);
    await owner.query(`update meta.document_template set authz = 'NO_SUCH_SCHEME' where app_id = $1 and name = 'EMPLOYEE_SHEET'`, [appId]);
    assert.equal((await b.get('/a/hr/3?doc=EMPLOYEE_SHEET')).statusCode, 403, 'authorization');
    await owner.query(`update meta.document_template set authz = null where app_id = $1 and name = 'EMPLOYEE_SHEET'`, [appId]);
  });

  test('the query runs as the app role: it cannot read what the app cannot', async () => {
    await owner.query(
      `insert into meta.document_template (app_id, name, query, template) values ($1, 'TEST_SECRET', 'select password_hash from meta.account', '{{password_hash}}')`,
      [appId],
    );
    const { b } = await onEmployee('king');
    const res = await b.get('/a/hr/3?doc=TEST_SECRET');
    assert.notEqual(res.statusCode, 200);
    assert.doesNotMatch(res.body, /\$2[aby]\$/);
  });
});

describe('builder', () => {
  test('a broken template is not saved; the preview renders as the app role', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get(`/builder/apps/${appId}/shared?new=document_template`);
    const bad = await dev.submit(`/builder/apps/${appId}/shared/document_template`, { name: 'TEST_BAD', query: 'select 1 as x', template: '{{#x}}open' });
    assert.equal(bad.statusCode, 303);
    assert.equal(await owner.one(`select 1 from meta.document_template where name = 'TEST_BAD'`), undefined);
    const t = await owner.one(`select id from meta.document_template where app_id = $1 and name = 'EMPLOYEE_SHEET'`, [appId]);
    const page = (await dev.get(`/builder/apps/${appId}/shared?c=document_template-${t.id}`)).body;
    assert.match(page, /Preview PDF/);
    assert.match(page, /P3_EMPNO=/, 'the binds of the query are offered');
    assert.match(page, /Used in \(1\)/, 'the Print button');
    const pdf = await dev.get(`/builder/apps/${appId}/documents/${t.id}/preview?binds=${encodeURIComponent('P3_EMPNO=7839')}`);
    assert.equal(pdf.statusCode, 200);
    assert.match(words(pdf.rawPayload), /King/);
    await owner.query(`insert into meta.document_template (app_id, name, query, template) values ($1, 'TEST_DENIED', 'select password_hash from meta.account', 'x')`, [appId]);
    const denied = await owner.one(`select id from meta.document_template where name = 'TEST_DENIED'`);
    const res = await dev.get(`/builder/apps/${appId}/documents/${denied.id}/preview`);
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /permission denied/);
    assert.equal((await new Browser(app).get(`/builder/apps/${appId}/documents/${t.id}/preview`)).statusCode, 302, 'developers only');
  });
});
