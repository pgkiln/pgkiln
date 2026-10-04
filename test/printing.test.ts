// Printing: report PDFs (Actions → Download PDF) and the print button.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools } from '../src/db.ts';
import { Browser, pdfText } from './helpers.ts';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}

const pdfLink = (body: string) => /href="([^"]*r\d+_pdf=1[^"]*)"/.exec(body)?.[1]?.replace(/&amp;/g, '&');

describe('report PDF', () => {
  test('the Actions menu offers Download PDF and Print', async () => {
    const page = (await (await as('king')).get('/a/hr/2')).body;
    assert.ok(pdfLink(page));
    assert.match(page, /data-print/);
  });

  test('the PDF has the report with its filters, headings and page numbers', async () => {
    const b = await as('king');
    const link = pdfLink((await b.get('/a/hr/2')).body)!;
    const id = /r(\d+)_pdf/.exec(link)![1];
    const res = await b.get(`${link}&r${id}_f=${encodeURIComponent('job|eq|ANALYST')}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.match(String(res.headers['content-disposition']), /attachment; filename="Employees.pdf"/);
    assert.equal(res.rawPayload.subarray(0, 5).toString(), '%PDF-');
    const text = pdfText(res.rawPayload);
    for (const s of ['Employees', 'Job = ANALYST', 'SCOTT', 'FORD', 'Salary', 'Page 1 of 1']) assert.ok(text.includes(s), `contains ${s}`);
    assert.ok(!text.includes('SMITH'), 'filtered rows are left out');
    assert.match(res.rawPayload.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/, 'portrait');
  });

  test('wide reports are printed landscape, in the user language', async () => {
    const b = await as('king');
    const link = pdfLink((await b.get('/a/hr/9?lang=nl')).body)!;
    const res = await b.get(link);
    assert.equal(res.statusCode, 200);
    const raw = res.rawPayload.toString('latin1');
    assert.match(raw, /\/MediaBox \[0 0 841\.89 595\.28\]/);
    assert.doesNotMatch(raw, /\/MediaBox \[0 0 595\.28 841\.89\]/, 'no portrait pages');
    assert.match(pdfText(res.rawPayload), /Pagina 1 van \d+/);
  });

  test('PDFs follow page and region access like the report', async () => {
    const king = await as('king');
    const link = pdfLink((await king.get('/a/hr/9')).body)!;
    const allen = await as('allen');
    assert.equal((await allen.get(link)).statusCode, 403, 'the audit page is for admins');
    assert.equal((await king.get('/a/hr/2?r999999_pdf=1')).statusCode, 403, 'unknown region');
  });
});

// Sprint 30: report PDFs read their rows from a cursor in batches
describe('large report PDFs', () => {
  test('rows come in batches; the row limit is noted after the table', async () => {
    const { owner } = await import('../src/db.ts');
    const id = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 25 and r.title = 'All readings'`)).id;
    await owner.query(`update meta.region set config = config || '{"max_rows": 1200}' where id = $1`, [id]);
    try {
      const res = await (await as('king')).get(`/a/hr/25?r${id}_pdf=1`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.rawPayload.subarray(0, 5).toString(), '%PDF-');
      const text = pdfText(res.rawPayload);
      assert.ok(text.includes('Only the first 1200 rows are included'), 'the note');
      assert.ok(text.includes('Sensor A') && text.includes('Page 1 of'));
      // a whole number of batches and no more rows: no note
      await owner.query(`update meta.region set config = config - 'max_rows' || '{"pagination": "range"}', source = 'select id, sensor from hr.reading where id <= 1000 order by id' where id = $1`, [id]);
      const all = pdfText((await (await as('king')).get(`/a/hr/25?r${id}_pdf=1`)).rawPayload);
      assert.ok(!all.includes('Only the first'));
      assert.ok(all.includes('1000'));
    } finally {
      await owner.query(`update meta.region set config = config - 'max_rows', source = 'select id, sensor, taken_at, value from hr.reading order by id' where id = $1`, [id]);
    }
  });
});
