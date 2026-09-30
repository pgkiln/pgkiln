// Printing: report PDFs (Actions → Download PDF) and the print button.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await app.close();
  await closePools();
});

/** The text drawn in a PDF made by pdfkit with a standard font (hex strings in TJ operators). */
function pdfText(pdf: Buffer) {
  let text = '';
  const raw = pdf.toString('latin1');
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const s of content.matchAll(/<([0-9a-f]+)>/gi)) text += Buffer.from(s[1], 'hex').toString('latin1');
    text += '\n';
  }
  return text;
}

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
