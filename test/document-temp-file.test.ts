// (sprint 245, MG-18 + MG-26) Document templates: meta.document_temp_file draws a template's PDF into a temporary file
// of the session when the process ends, so the next process can keep it (HR's "Keep a copy" on the employee form);
// the renderer's inline content (images in table cells and paragraphs, <br>, headings in cells); the Advisor's
// warning about query columns named like a built-in.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { advise } from '../src/builder/advisor.ts';
import { documentPdf, shadowedBuiltIns } from '../src/runtime/document.ts';
import { BUILT_IN } from '../src/runtime/pdf.ts';
import { Browser, pdfText } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page3: number;
const made: { processes: number[]; buttons: number[]; sessions: string[] } = { processes: [], buttons: [], sessions: [] };

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  page3 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 3', [appId])).id;
});

after(async () => {
  for (const id of made.processes) await owner.query('delete from meta.process where id = $1', [id]);
  for (const id of made.buttons) await owner.query('delete from meta.button where id = $1', [id]);
  for (const id of made.sessions) await owner.query('delete from meta.session where id = $1', [id]);
  await owner.query(`delete from hr.emp_document where filename like 'record-%' or filename like 't245%'`);
  await owner.query(`delete from meta.document_template where app_id = $1 and name like 'T245_%'`, [appId]);
  await app.close();
  await closePools();
});

const words = (pdf: Buffer) => pdfText(pdf).replace(/\s+/g, ' ');

/** The text pieces of a PDF with their position (x, y from the bottom) and the images drawn (x, y, width). */
function layoutOf(pdf: Buffer) {
  const texts: { text: string; x: number; y: number }[] = [];
  const images: { x: number; y: number; w: number }[] = [];
  const raw = pdf.toString('latin1');
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start, raw.indexOf('endstream', start))).toString('latin1');
    } catch {
      continue;
    }
    let x = 0;
    let y = 0;
    let cm: number[] = [];
    for (const line of content.split('\n')) {
      const tm = /^1 0 0 1 ([\d.-]+) ([\d.-]+) Tm$/.exec(line);
      if (tm) [x, y] = [Number(tm[1]), Number(tm[2])];
      const c = /^([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm$/.exec(line);
      if (c) cm = c.slice(1).map(Number);
      if (/TJ$/.test(line)) texts.push({ text: [...line.matchAll(/<([0-9a-f]+)>/gi)].map((s) => Buffer.from(s[1], 'hex').toString('latin1')).join(''), x, y });
      if (/^\/I\d+ Do$/.test(line)) images.push({ x: cm[2], y: cm[3], w: cm[0] });
    }
  }
  return { texts, images };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const draw = (html: string) => documentPdf({ html, layout: { ...BUILT_IN }, title: 't', author: 'a', footer: 'f', pageLabel: () => 'p' });
const MM = 72 / 25.4;

describe('the renderer: inline content', () => {
  test('<br> breaks the line in a paragraph and in a table cell; <br><br> leaves an empty line', async () => {
    const { texts } = layoutOf(await draw('<p>alpha <b>bold</b><br>beta<br><br>gamma</p><table><tr><td>one<br>two</td><td>x</td></tr></table>'));
    const at = (t: string) => texts.find((x) => x.text === t)!;
    assert.equal(at('alpha ').y, at('bold').y, 'styled runs stay on one line');
    assert.ok(at('beta').y < at('alpha ').y, 'beta on the next line');
    assert.ok(at('alpha ').y - at('beta').y < (at('beta').y - at('gamma').y) * 0.75, 'an empty line between beta and gamma');
    assert.equal(at('beta').x, at('alpha ').x);
    const two = texts.find((x) => x.text.replace(/\s/g, '') === 'two' || x.text === 'tw')!;
    assert.ok(two.y < at('one').y, 'two under one in the cell');
    assert.equal(two.x, at('one').x);
    assert.equal(at('x').y, at('one').y, 'the next cell starts at the top of the row');
  });

  test('an image in a table cell: its width in mm or % of the cell, beside the text of the next cell; the row grows', async () => {
    const pdf = await draw(`<table class="plain"><tr><td width="40mm"><img src="${PNG}" width="30mm"></td><td align="right">Title<br>sub</td></tr></table><p>after</p>`);
    const { texts, images } = layoutOf(pdf);
    assert.equal(images.length, 1);
    assert.ok(Math.abs(images[0].w - 30 * MM) < 0.01, 'width 30 mm');
    const title = texts.find((t) => t.text === 'Title')!;
    assert.ok(title.x > images[0].x + images[0].w, 'the title is beside the image');
    const after = texts.find((t) => t.text === 'after')!;
    // the image (y from the top in its matrix) ends above "after": the row is as high as the image
    const imageBottomFromTop = images[0].y;
    assert.ok(841.89 - after.y > imageBottomFromTop, 'the text after the table is below the image');

    const pct = layoutOf(await draw(`<table><tr><td width="50%"><img src="${PNG}" width="50%"><img src="${PNG}" width="10mm"><img src="${PNG}" width="10mm"></td><td>x</td></tr></table>`)).images;
    assert.equal(pct.length, 3);
    const usable = 595.28 - 2 * BUILT_IN.margin_mm * MM;
    assert.ok(Math.abs(pct[0].w - ((usable / 2 - 6) / 2)) < 0.5, '50% of the cell (less its padding)');
    assert.equal(pct[1].y, pct[2].y, 'two small images next to each other');
    assert.ok(pct[2].x > pct[1].x + pct[1].w);
  });

  test('an image in a paragraph, a heading in a cell, an image that is no PNG/JPEG left out', async () => {
    const { texts, images } = layoutOf(await draw(`<p>before<img src="${PNG}" width="20mm">after</p><table class="plain"><tr><td><h2>Big</h2>small<img src="data:image/gif;base64,R0lGOD"></td></tr></table>`));
    assert.equal(images.length, 1);
    const before = texts.find((t) => t.text === 'before')!;
    const after = texts.find((t) => t.text === 'after')!;
    assert.ok(after.y < before.y - 20 * MM + 1, 'the text after the image is below it');
    const big = texts.find((t) => t.text === 'Big')!;
    const small = texts.find((t) => t.text === 'small')!;
    assert.ok(small.y < big.y, 'what follows a heading in a cell is on the next line');
    assert.match(words(await draw('<table><tr><td><h2>Big</h2></td></tr></table>')), /Big/);
  });
});

describe('the template check: columns named like a built-in', () => {
  test('shadowedBuiltIns names exactly the built-ins', () => {
    assert.deepEqual(shadowedBuiltIns(['empno', 'app_user', 'today']), [], 'tags are case-sensitive: app_user is no APP_USER');
    const w = shadowedBuiltIns(['rows', 'APP_USER', 'NOW', 'x']);
    assert.equal(w.length, 3);
    assert.match(w[0], /column "rows": \{\{rows\}\} is the list of all rows/);
    assert.match(w[1], /column "APP_USER": \{\{APP_USER\}\} is that column/);
  });

  test('the Advisor warns about a document template whose query has such a column', async () => {
    await owner.query(`insert into meta.document_template (app_id, name, query, template) values ($1, 'T245_SHADOW', $2, '{{rows}}')`,
      [appId, `select 1 as "rows", 'x' as "TODAY", 2 as empno from hr.emp where empno = :P3_EMPNO::int`]);
    const { findings } = await advise(appId);
    const mine = findings.filter((f) => f.entry?.label?.includes('T245_SHADOW') || f.message.includes('"TODAY"'));
    assert.ok(mine.some((f) => f.severity === 'warning' && /column "rows"/.test(f.message)), JSON.stringify(mine));
    assert.ok(mine.some((f) => f.severity === 'warning' && /column "TODAY"/.test(f.message)));
    assert.ok(!findings.some((f) => /column "rows"/.test(f.message) && /EMPLOYEE_SHEET/.test(f.entry?.label ?? '')), 'HR\'s own templates are fine');
  });
});

const SCOTT = { P3_ENAME: 'SCOTT', P3_JOB: 'ANALYST', P3_DEPTNO: '20', P3_MGR: '7566', P3_HIREDATE: '1987-04-19', P3_SAL: '3000.00', P3_ACTIVE: 'true', P3_USERNAME: 'scott' };

/** Signed in, on the employee form of 7788 (through the report's checksummed link), then press `button`. */
async function press(button: string, user = 'king') {
  const b = new Browser(app);
  await b.login(user);
  const list = (await b.get('/a/hr/2')).body;
  const href = /href="(\/a\/hr\/3\?[^"]*P3_EMPNO=7788[^"]*)"/.exec(list)![1].replace(/&amp;/g, '&');
  const form = await b.get(href);
  return { res: await b.submit('/a/hr/3', { __request: button, ...SCOTT }), form: form.body };
}

/** A submit button on the employee form and processes it runs, in order. */
async function processesOn3(name: string, codes: string[]) {
  made.buttons.push((await owner.one(
    `insert into meta.button (page_id, region_id, seq, name, label, action)
     select $1, r.id, 900 + (select count(*) from meta.button where page_id = $1), $2, $2, 'submit' from meta.region r where r.page_id = $1 and r.type = 'form' returning id`,
    [page3, name])).id);
  for (const [i, code] of codes.entries())
    made.processes.push((await owner.one(
      `insert into meta.process (page_id, seq, name, type, point, when_button, code) values ($1, $2, $3, 'sql', 'submit', $4, $5) returning id`,
      [page3, 900 + i, `${name} ${i}`, name, code])).id);
}

describe('meta.document_temp_file', () => {
  test('HR\'s "Keep a copy": the PDF of EMPLOYEE_RECORD is drawn into a temporary file and kept in hr.emp_document', async () => {
    const { res, form } = await press('KEEP_RECORD');
    assert.match(form, /Keep a copy/, 'king (admin) has the button');
    assert.equal(res.statusCode, 303, res.body);
    const d = await owner.one(`select * from hr.emp_document where empno = 7788 and filename like 'record-7788-%' order by id desc limit 1`);
    assert.ok(d, 'kept');
    assert.match(d.filename, /^record-7788-\d{8}-\d{4}\.pdf$/, 'the file name from SQL, with .pdf');
    assert.equal(d.mime_type, 'application/pdf');
    assert.equal(d.content.subarray(0, 5).toString('latin1'), '%PDF-');
    const text = words(d.content);
    assert.match(text, /Employee record/);
    assert.match(text, /Scott/);
    assert.match(text, /by king/);
    assert.match(text, /Jones/, 'the manager');
    // the logo beside the title: an image drawn in the first cell
    assert.ok(layoutOf(d.content).images.length >= 1, 'the logo');
    // the temporary file of the session holds the same PDF
    const t = await owner.one(`select size, filename, mime_type from meta.temp_file where filename = $1`, [d.filename]);
    assert.equal(t.size, d.content.length);
  });

  test('without a file name: the template\'s; the file is a PDF only from the next process on; the items win', async () => {
    await processesOn3('T245_TWO', [
      `select meta.document_temp_file('employee_record', jsonb_build_object('p3_empno', 7839)) as p3_record_file`,
      `insert into hr.emp_document (empno, filename, mime_type, content)
       select 7839, 't245-' || t.filename, t.mime_type, t.content from meta.temp_files t where t.id = :P3_RECORD_FILE::uuid and t.size > 0`,
    ]);
    const { res } = await press('T245_TWO');
    assert.equal(res.statusCode, 303, res.body);
    const d = await owner.one(`select * from hr.emp_document where filename like 't245-%' order by id desc limit 1`);
    assert.equal(d.filename, 't245-record-7839.pdf', 'the template\'s file name pattern (&P3_EMPNO. of the items over the session state)');
    assert.match(words(d.content), /King/, 'P3_EMPNO from the items for the query');
  });

  test('in the same statement it is a placeholder; a failing template rolls the submit back', async () => {
    await processesOn3('T245_SAME', [
      `do $b$
declare
  v uuid := meta.document_temp_file('EMPLOYEE_RECORD', '{"P3_EMPNO": 7788}');
begin
  insert into hr.emp_document (empno, filename, mime_type, content)
  select 7788, 't245-same-' || t.size, t.mime_type, t.content from meta.temp_files t where t.id = v;
end
$b$`,
    ]);
    // the row is inserted with the reference, not a PDF (documented: read it in the next process)
    const { res } = await press('T245_SAME');
    assert.equal(res.statusCode, 303, res.body);
    const same = await owner.one(`select content from hr.emp_document where filename = 't245-same--1'`);
    assert.match(same.content.toString('latin1'), /^pgkiln:document_pdf:/);

    await processesOn3('T245_FAIL', [`select meta.document_temp_file('EMPLOYEE_RECORD', '{"P3_EMPNO": "not a number"}') as p3_record_file`]);
    const before = Number((await owner.one('select count(*) as n from meta.temp_file')).n);
    const fail = await press('T245_FAIL');
    assert.equal(fail.res.statusCode, 422);
    assert.match(fail.res.body, /alert-error/);
    assert.ok(Number((await owner.one('select count(*) as n from meta.temp_file')).n) <= before, 'no temporary file left');
    await processesOn3('T245_NONE', [`select meta.document_temp_file('NO_SUCH_TEMPLATE') as p3_record_file`]);
    const none = await press('T245_NONE');
    assert.equal(none.res.statusCode, 422);
    assert.match(none.res.body, /has no document template NO_SUCH_TEMPLATE/);
  });

  test('outside a process the server runs, the transaction does not commit an undrawn file', async () => {
    const sid = (await owner.one(`insert into meta.session (token_hash, app_id, username, roles) values ('t245-' || gen_random_uuid(), $1, 'king', '{admin}') returning id`, [appId])).id as string;
    made.sessions.push(sid);
    const c = await owner.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'KING', true), set_config('pgkiln.session_id', $2, true)`, [String(appId), sid]);
      await c.query('set local role hr_app');
      const id = (await c.query(`select meta.document_temp_file('EMPLOYEE_RECORD', '{"P3_EMPNO": 7788}', 'x') as id`)).rows[0].id;
      assert.match(id, /^[0-9a-f-]{36}$/);
      const t = (await c.query('select size, mime_type from meta.temp_files where id = $1', [id])).rows[0];
      assert.equal(t.size, -1, 'undrawn');
      await assert.rejects(c.query('commit'), /the document was not drawn/);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
    assert.equal((await owner.query('select 1 from meta.temp_file where session_id = $1', [sid])).rowCount, 0);
  });
});
