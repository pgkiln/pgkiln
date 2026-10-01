// Excel downloads and report layouts (Shared Components → Report layouts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { unzipSync, strFromU8 } from 'fflate';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { parseFile } from '../src/dataload.ts';
import { excelDate, writeXlsx } from '../src/xlsx.ts';
import { imageType } from '../src/builder/layouts.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let employees: number; // report region on HR page 2

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  employees = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report'`, [appId])).id;
});

after(async () => {
  await owner.query(`delete from meta.report_layout where app_id = $1 and name like 'TEST_%'`, [appId]);
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}

async function developer() {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
}

/** The drawing operators of a pdfkit PDF (its inflated content streams). */
function pdfContent(pdf: Buffer) {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    try {
      out.push(inflateSync(pdf.subarray(start, raw.indexOf('endstream', start))).toString('latin1'));
    } catch {
      // not a compressed stream
    }
  }
  return out.join('\n');
}

/** Text drawn in a pdfkit PDF with a standard font (hex strings in TJ operators). */
const pdfText = (pdf: Buffer) =>
  pdfContent(pdf)
    .split('\n')
    .map((line) => [...line.matchAll(/<([0-9a-f]+)>/gi)].map((s) => Buffer.from(s[1], 'hex').toString('latin1')).join(''))
    .join('\n');

/** A small valid PNG (w × h, grey). */
function png(w = 4, h = 2) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 0x80)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const setPdfConfig = (pdf: unknown) =>
  owner.query(`update meta.region set config = case when $2::jsonb is null then config - 'pdf' else jsonb_set(config, '{pdf}', $2::jsonb) end where id = $1`, [
    employees,
    pdf === null ? null : JSON.stringify(pdf),
  ]);

describe('Excel download', () => {
  test('writes typed cells; text never becomes a formula', async () => {
    const buf = writeXlsx({
      name: 'A: [b]/c',
      headings: ['Text', 'Number', 'Date', 'When', 'Flag'],
      rows: [['=HYPERLINK("http://evil")\u0001 & <x>', 1250.5, { date: '1981-02-20' }, { date: '2026-09-30 14:05:00+02', time: true }, true]],
    });
    const files = unzipSync(new Uint8Array(buf));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/evil&quot;\) &amp; &lt;x&gt;<\/t><\/is><\/c>/);
    assert.doesNotMatch(sheet, /<f>/, 'no formulas');
    assert.match(sheet, /<c r="B2"><v>1250.5<\/v><\/c>/);
    assert.match(sheet, /<c r="C2" s="2"><v>29637<\/v><\/c>/, '1981-02-20 as an Excel date');
    assert.match(sheet, /<c r="E2" t="b"><v>1<\/v><\/c>/);
    assert.match(strFromU8(files['xl/workbook.xml']), /<sheet name="A   b  c"/, 'sheet name without forbidden characters');
    const back = await parseFile('x.xlsx', buf, { headers: true });
    assert.deepEqual(back.rows[0].slice(1, 4), ['1250.5', '1981-02-20', '2026-09-30 14:05:00']);
    assert.equal(excelDate('1970-01-01'), 25569);
    assert.equal(excelDate('not a date'), null);
  });

  test('the report downloads as .xlsx with the filters on screen', async () => {
    const b = await as('king');
    const page = (await b.get('/a/hr/2')).body;
    assert.match(page, new RegExp(`r${employees}_xlsx=1`), 'Actions → Download Excel');
    const res = await b.get(`/a/hr/2?r${employees}_xlsx=1&r${employees}_f=${encodeURIComponent('job|eq|ANALYST')}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(String(res.headers['content-disposition']), /filename="Employees.xlsx"/);
    const sheet = await parseFile('e.xlsx', res.rawPayload, { headers: true });
    assert.ok(sheet.headers.includes('Salary'), 'headings as on screen');
    const names = sheet.rows.map((r) => r[sheet.headers.indexOf('Name')]);
    assert.deepEqual([...names].sort(), ['FORD', 'SCOTT']);
    const xml = strFromU8(unzipSync(new Uint8Array(res.rawPayload))['xl/worksheets/sheet1.xml']);
    assert.match(xml, /<c r="[A-Z]+\d+"><v>3000<\/v><\/c>/, 'salaries are numbers');
  });

  test('follows page and region access like the report', async () => {
    const allen = await as('allen');
    const audit = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 9`, [appId])).id;
    assert.equal((await allen.get(`/a/hr/9?r${audit}_xlsx=1`)).statusCode, 403);
    assert.equal((await (await as('king')).get('/a/hr/2?r999999_xlsx=1')).statusCode, 403);
  });
});

describe('report layouts', () => {
  test('the default layout sets paper, orientation, texts and colors', async () => {
    await owner.query(
      `insert into meta.report_layout (app_id, name, is_default, paper, orientation, font_size, header, footer, show_filters, heading_color, stripe_color)
       values ($1, 'TEST_LETTER', true, 'LETTER', 'landscape', 10, 'Confidential for &APP_USER.' || chr(10) || 'Printed &DATE.', 'HR &APP_NAME. <b>', false, '#ffcc00', null)`,
      [appId],
    );
    try {
      const res = await (await as('king')).get(`/a/hr/2?r${employees}_pdf=1&r${employees}_f=${encodeURIComponent('job|eq|ANALYST')}`);
      assert.equal(res.statusCode, 200);
      const raw = res.rawPayload.toString('latin1');
      assert.match(raw, /\/MediaBox \[0 0 792 612\]/, 'Letter, landscape');
      const text = pdfText(res.rawPayload);
      assert.ok(text.includes('Confidential for king'), 'header with substitutions');
      assert.ok(text.includes(`Printed ${new Date().toISOString().slice(0, 10)}`));
      assert.match(text, /HR HR Demo <b>/, 'footer, as text');
      assert.ok(!text.includes('Job = ANALYST'), 'filters hidden');
      assert.match(pdfContent(res.rawPayload), /^1 0\.8 0 scn$/m, 'heading color #ffcc00');
    } finally {
      await owner.query(`delete from meta.report_layout where name = 'TEST_LETTER' and app_id = $1`, [appId]);
    }
  });

  test('a report can name its layout and choose its columns', async () => {
    await owner.query(`insert into meta.report_layout (app_id, name, is_default) values ($1, 'TEST_DEFAULT', true)`, [appId]);
    await owner.query(`insert into meta.report_layout (app_id, name, paper, orientation) values ($1, 'TEST_A3', 'A3', 'portrait')`, [appId]);
    await setPdfConfig({ layout: 'test_a3', columns: ['ename', 'JOB', 'no_such_column'], widths: { ename: 60 } });
    try {
      const res = await (await as('king')).get(`/a/hr/2?r${employees}_pdf=1`);
      assert.equal(res.statusCode, 200);
      assert.match(res.rawPayload.toString('latin1'), /\/MediaBox \[0 0 841\.89 1190\.55\]/, 'A3 portrait');
      const text = pdfText(res.rawPayload);
      assert.ok(text.includes('Name') && text.includes('Job') && text.includes('KING'));
      assert.ok(!text.includes('Salary'), 'only the chosen columns');
    } finally {
      await setPdfConfig(null);
      await owner.query(`delete from meta.report_layout where name like 'TEST_%' and app_id = $1`, [appId]);
    }
  });

  test('only one layout is the default', async () => {
    await owner.query(`insert into meta.report_layout (app_id, name, is_default) values ($1, 'TEST_ONE', true), ($1, 'TEST_TWO', false)`, [appId]);
    try {
      await owner.query(`update meta.report_layout set is_default = true where name = 'TEST_TWO' and app_id = $1`, [appId]);
      const rows = (await owner.query(`select name from meta.report_layout where app_id = $1 and is_default`, [appId])).rows;
      assert.deepEqual(rows.map((r) => r.name), ['TEST_TWO']);
    } finally {
      await owner.query(`delete from meta.report_layout where name like 'TEST_%' and app_id = $1`, [appId]);
    }
  });

  test('the builder edits layouts, stores PNG/JPEG logos only and previews them', async () => {
    const b = await developer();
    const page = await b.get(`/builder/apps/${appId}/shared?new=report_layout`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Paper size/);
    const created = await b.submit(`/builder/apps/${appId}/shared/report_layout`, {
      name: 'test_logo', paper: 'A5', orientation: 'portrait', font_size: '7.5', margin_mm: '10',
      title: '&APP_NAME. list', header: '', footer: '', show_filters: 'true',
      heading_color: '#223344', stripe_color: '', text_color: '#000000', logo_width_mm: '25',
    });
    assert.equal(created.statusCode, 303);
    const l = await owner.one(`select * from meta.report_layout where app_id = $1 and name = 'TEST_LOGO'`, [appId]);
    assert.ok(l, 'created with an upper-case name');
    assert.equal(l.stripe_color, null);
    const base = `/builder/apps/${appId}/shared/report_layout/${l.id}`;
    try {
      await b.get(`/builder/apps/${appId}/shared?c=report_layout-${l.id}`);
      // a text file with an image name and type is refused
      await b.upload(`${base}/logo`, {}, { logo: { name: 'logo.png', type: 'image/png', data: Buffer.from('<svg onload=alert(1)>') } });
      assert.equal((await owner.one('select logo from meta.report_layout where id = $1', [l.id])).logo, null);
      await b.get(`/builder/apps/${appId}/shared?c=report_layout-${l.id}`);
      const up = await b.upload(`${base}/logo`, {}, { logo: { name: 'logo.bin', type: 'application/octet-stream', data: png() } });
      assert.equal(up.statusCode, 303);
      assert.equal((await owner.one('select logo_mime from meta.report_layout where id = $1', [l.id])).logo_mime, 'image/png');
      const logo = await b.get(`${base}/logo`);
      assert.equal(logo.headers['content-type'], 'image/png');

      const preview = await b.get(`${base}/preview`);
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.headers['content-type'], 'application/pdf');
      const raw = preview.rawPayload.toString('latin1');
      assert.match(raw, /\/MediaBox \[0 0 419\.53 595\.28\]/, 'A5');
      assert.match(raw, /\/Subtype \/Image/, 'with the logo');
      assert.ok(pdfText(preview.rawPayload).includes('Globex'), 'sample rows (made up, not from an application)');

      // other people get the sign-in page, not the preview or the logo
      for (const url of [`${base}/preview`, `${base}/logo`]) {
        const anon = await new Browser(app).get(url);
        assert.equal(anon.statusCode, 302);
        assert.match(String(anon.headers.location), /\/builder\/login/);
      }
      // a layout of another application is not found through this one
      assert.equal((await b.get(`/builder/apps/${appId + 100000}/shared/report_layout/${l.id}/preview`)).statusCode, 404);
      // uploads need the CSRF token
      b.lastCsrf = 'forged';
      const forged = await b.upload(`${base}/logo`, {}, { logo: { name: 'x.png', type: 'image/png', data: png() } });
      assert.equal(forged.statusCode, 403);
    } finally {
      await owner.query('delete from meta.report_layout where id = $1', [l.id]);
    }
  });

  test('export and import carry layouts with their logo', async () => {
    await owner.query(`insert into meta.report_layout (app_id, name, paper, logo, logo_mime) values ($1, 'TEST_EXPORT', 'LEGAL', $2, 'image/png')`, [appId, png()]);
    let copy: number | undefined;
    try {
      const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
      const exported = doc.report_layouts.find((x: any) => x.name === 'TEST_EXPORT');
      assert.equal(exported.paper, 'LEGAL');
      copy = (await owner.one(`select meta.import_app($1::jsonb, 'hr_copy_layouts') as id`, [JSON.stringify(doc)])).id;
      const l = await owner.one(`select paper, logo from meta.report_layout where app_id = $1 and name = 'TEST_EXPORT'`, [copy]);
      assert.equal(l.paper, 'LEGAL');
      assert.ok(Buffer.from(l.logo).equals(png()));
    } finally {
      if (copy) await owner.query('delete from meta.app where id = $1', [copy]);
      await owner.query(`delete from meta.report_layout where name = 'TEST_EXPORT' and app_id = $1`, [appId]);
    }
  });

  test('applications can read layouts but not change them', async () => {
    await runtime.query('select name from meta.report_layout limit 1');
    for (const sql of [
      `update meta.report_layout set header = 'x'`,
      `insert into meta.report_layout (app_id, name) values (${appId}, 'TEST_X')`,
      `delete from meta.report_layout`,
    ])
      await assert.rejects(runtime.query(sql), /permission denied/, sql);
  });

  test('detects images by their bytes', () => {
    assert.equal(imageType(png()), 'image/png');
    assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
    assert.equal(imageType(Buffer.from('GIF89a....')), null);
  });
});
