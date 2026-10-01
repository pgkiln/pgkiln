// File upload items: upload into a bytea column, validation errors keep the
// upload, size and type limits, signed downloads, removal, and temporary
// files that belong to one session only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { urlChecksum } from '../src/security.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const EMP = '7934'; // MILLER
// the smallest valid PNG (1x1 transparent pixel)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MILLER = { P3_ENAME: 'MILLER', P3_JOB: 'CLERK', P3_DEPTNO: '10', P3_MGR: '7782', P3_HIREDATE: '1982-01-23', P3_SAL: '1300', P3_ACTIVE: 'true' };

const link = (user: string, items: Record<string, string>) => `/a/hr/3?${new URLSearchParams({ ...items, cs: urlChecksum(appId, 3, user, items) })}`;

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}

/** Open MILLER in the employee form. */
async function openForm(user = 'king') {
  const b = await as(user);
  const page = await b.get(link(user, { P3_EMPNO: EMP }));
  assert.equal(page.statusCode, 200);
  return { b, page };
}

const downloadLink = (body: string) => /href="(\/a\/hr\/3\/file\/P3_PHOTO\?[^"]+)"/.exec(body)?.[1]?.replace(/&amp;/g, '&');

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await owner.query(`update hr.emp set photo = null, photo_name = null, photo_mime = null where empno = ${EMP}`);
  await owner.query(`delete from meta.temp_file where filename in ('mine.txt', 'foreign.png')`);
  await app.close();
  await closePools();
});

describe('file upload items', () => {
  test('the employee form posts multipart and has a photo field', async () => {
    const { page } = await openForm();
    assert.match(page.body, /enctype="multipart\/form-data"/);
    assert.match(page.body, /<input type="file" id="P3_PHOTO" name="P3_PHOTO" accept="image\/png,image\/jpeg,image\/webp"/);
  });

  test('an upload is saved into the row with its name and type; the audit trail leaves the bytes out', async () => {
    const { b } = await openForm();
    const res = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER }, { P3_PHOTO: { name: 'miller.png', type: 'image/png', data: PNG } });
    assert.equal(res.statusCode, 303, res.body.slice(0, 500));
    const row = await owner.one(`select photo, photo_name, photo_mime from hr.emp where empno = ${EMP}`);
    assert.deepEqual(row.photo, PNG);
    assert.equal(row.photo_name, 'miller.png');
    assert.equal(row.photo_mime, 'image/png');
    const audit = await owner.one(`select new_values from hr.audit_log where table_name = 'emp' and row_pk = '${EMP}' order by id desc limit 1`);
    assert.equal(audit.new_values.photo_name, 'miller.png');
    assert.ok(!('photo' in audit.new_values), 'no image in the audit trail');
    const left = await owner.one(`select count(*)::int as n from meta.temp_file where filename = 'miller.png'`);
    assert.equal(left.n, 0, 'the temporary file is removed once saved');
  });

  test('saving without a new file keeps the stored file', async () => {
    const { b } = await openForm();
    assert.equal((await b.submit('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_SAL: '1301' })).statusCode, 303);
    const row = await owner.one(`select photo_name, sal from hr.emp where empno = ${EMP}`);
    assert.equal(row.photo_name, 'miller.png');
    assert.equal(Number(row.sal), 1301);
    await owner.query(`update hr.emp set sal = 1300 where empno = ${EMP}`);
  });

  test('the form shows the file with a signed download link and an image preview', async () => {
    const { b, page } = await openForm();
    assert.match(page.body, /miller\.png/);
    assert.match(page.body, /<img class="file-preview" src="\/a\/hr\/3\/file\/P3_PHOTO\?/);
    const url = downloadLink(page.body)!;
    const dl = await b.get(url);
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.headers['content-type'], 'application/octet-stream');
    assert.match(String(dl.headers['content-disposition']), /^attachment; filename="miller.png"/);
    assert.match(String(dl.headers['content-security-policy']), /sandbox/);
    assert.deepEqual(dl.rawPayload, PNG);
    const inline = await b.get(`${url}&inline=1`);
    assert.equal(inline.headers['content-type'], 'image/png');
    assert.match(String(inline.headers['content-disposition']), /^inline/);
  });

  test('download links are bound to the user, the key and page access', async () => {
    const { page } = await openForm();
    const url = downloadLink(page.body)!;
    const blake = await as('blake');
    assert.equal((await blake.get(url)).statusCode, 403, "king's link does not work for blake");
    const tampered = url.replace(`k=${EMP}`, 'k=7839');
    const king = await as('king');
    assert.equal((await king.get(tampered)).statusCode, 403, 'another record needs another checksum');
    // allen may not open the employee form, even with a link signed for him
    const allen = await as('allen');
    const own = `/a/hr/3/file/P3_PHOTO?${new URLSearchParams({ k: EMP, cs: urlChecksum(appId, 3, 'allen', { __FILE: 'P3_PHOTO', __KEY: EMP }) })}`;
    assert.equal((await allen.get(own)).statusCode, 403);
  });

  test('too large files and disallowed types are refused', async () => {
    const { b } = await openForm();
    const big = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER }, { P3_PHOTO: { name: 'big.png', type: 'image/png', data: Buffer.alloc(2 * 1024 * 1024 + 1) } });
    assert.equal(big.statusCode, 422);
    assert.match(big.body, /larger than 2 MB/);
    const html = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER }, { P3_PHOTO: { name: 'x.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') } });
    assert.equal(html.statusCode, 422);
    assert.match(html.body, /type of file is not allowed/);
    assert.equal((await owner.one(`select photo_name from hr.emp where empno = ${EMP}`)).photo_name, 'miller.png');
  });

  test('after a validation error the upload is kept until the next save', async () => {
    const { b } = await openForm();
    const bad = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_ENAME: '' }, { P3_PHOTO: { name: 'second.png', type: 'image/png', data: PNG } });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /second\.png/);
    assert.match(bad.body, /saved when you save/);
    assert.equal((await b.submit('/a/hr/3', { __request: 'SAVE', ...MILLER })).statusCode, 303);
    assert.equal((await owner.one(`select photo_name from hr.emp where empno = ${EMP}`)).photo_name, 'second.png');
  });

  test('a stored file can be removed', async () => {
    const { b } = await openForm();
    assert.equal((await b.submit('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_PHOTO__REMOVE: 'true' })).statusCode, 303);
    const row = await owner.one(`select photo, photo_name, photo_mime from hr.emp where empno = ${EMP}`);
    assert.deepEqual(row, { photo: null, photo_name: null, photo_mime: null });
  });

  test('a posted text value cannot set a file item', async () => {
    const { b } = await openForm();
    const other = (await owner.one(`insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content)
      select id, 'P3_PHOTO', 'foreign.png', 'image/png', 1, '\\x00' from meta.session where username = 'blake' order by created_at desc limit 1 returning id`))?.id;
    assert.ok(other);
    assert.equal((await b.submit('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_PHOTO: other })).statusCode, 303);
    assert.equal((await owner.one(`select photo_name from hr.emp where empno = ${EMP}`)).photo_name, null);
  });

  test("meta.temp_files shows only the current session's files", async () => {
    const [s1, s2] = (await owner.query(`select id from meta.session order by created_at desc limit 2`)).rows.map((r) => r.id);
    await owner.query(`insert into meta.temp_file (session_id, item_name, filename, mime_type, size, content) values ($1, 'X', 'mine.txt', 'text/plain', 1, '\\x41')`, [s1]);
    const seen = await runtime.tx(async (c) => {
      await c.query(`select set_config('pgapex.session_id', $1, true)`, [s2]);
      await c.query('set local role hr_app');
      return (await c.query(`select filename from meta.temp_files where filename = 'mine.txt'`)).rows;
    });
    assert.equal(seen.length, 0);
    const denied = await runtime
      .tx(async (c) => {
        await c.query('set local role hr_app');
        return c.query('select * from meta.temp_file');
      })
      .then(() => false, () => true);
    assert.ok(denied, 'the table itself is not readable by application roles');
  });
});

describe('several files per upload item', () => {
  const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
  const pdf = (name: string) => ({ name, type: 'application/pdf', data: PDF });
  const docs = async () => (await owner.query(`select id, filename, mime_type from hr.emp_document where empno = ${EMP} order by id`)).rows;
  const docLinks = (body: string) => [...body.matchAll(/href="(\/a\/hr\/3\/file\/P3_DOCUMENTS\?[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  after(async () => {
    await owner.query(`delete from hr.emp_document where empno = ${EMP}`);
  });

  test('the item is an <input type="file" multiple>', async () => {
    const { page } = await openForm();
    assert.match(page.body, /<input type="file" id="P3_DOCUMENTS" name="P3_DOCUMENTS" accept="[^"]+" multiple/);
    assert.match(page.body, /up to 5/);
  });

  test('every chosen file becomes a row of the child table; the temporary files are removed', async () => {
    const { b } = await openForm();
    const res = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER }, { P3_DOCUMENTS: [pdf('contract.pdf'), { name: 'id.png', type: 'image/png', data: PNG }] });
    assert.equal(res.statusCode, 303, res.body.slice(0, 500));
    assert.deepEqual((await docs()).map((d) => [d.filename, d.mime_type]), [['contract.pdf', 'application/pdf'], ['id.png', 'image/png']]);
    assert.equal((await owner.one(`select count(*)::int as n from meta.temp_file where filename in ('contract.pdf', 'id.png')`)).n, 0);
  });

  test('more files are added to the stored ones; the form lists them with signed links', async () => {
    const { b } = await openForm();
    assert.equal((await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER }, { P3_DOCUMENTS: [pdf('diploma.pdf')] })).statusCode, 303);
    assert.equal((await docs()).length, 3);
    const page = await b.get(link('king', { P3_EMPNO: EMP }));
    assert.equal(docLinks(page.body).length, 3);
    assert.match(page.body, /<img class="file-thumb" src="\/a\/hr\/3\/file\/P3_DOCUMENTS\?/);
    const dl = await b.get(docLinks(page.body)[0]);
    assert.equal(dl.statusCode, 200);
    assert.match(String(dl.headers['content-disposition']), /^attachment; filename="contract.pdf"/);
    assert.deepEqual(dl.rawPayload, PDF);
  });

  test('after a validation error the new files stay pending; a ticked pending file is dropped', async () => {
    const { b } = await openForm();
    const bad = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_ENAME: '' }, { P3_DOCUMENTS: [pdf('a.pdf'), pdf('b.pdf')] });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /a\.pdf/);
    assert.match(bad.body, /b\.pdf/);
    const pendingB = /name="P3_DOCUMENTS__REMOVE" value="(temp:[0-9a-f-]+)"[^>]*>[^<]*<\/label>\s*<\/li>\s*<\/ul>/.exec(bad.body)?.[1];
    assert.ok(pendingB, 'the last pending file has a remove box');
    assert.equal((await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_DOCUMENTS__REMOVE: pendingB }, {})).statusCode, 303);
    const names = (await docs()).map((d) => d.filename);
    assert.ok(names.includes('a.pdf') && !names.includes('b.pdf'), names.join());
  });

  test('ticked stored files are removed, only from this record', async () => {
    const other = (await owner.one(`insert into hr.emp_document (empno, filename, mime_type, content) values (7839, 'king.pdf', 'application/pdf', '\\x00') returning id`)).id;
    try {
      const { b } = await openForm();
      const [first] = await docs();
      assert.equal((await b.submit('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_DOCUMENTS__REMOVE: [String(first.id), String(other)] })).statusCode, 303);
      assert.ok(!(await docs()).some((d) => d.id === first.id), 'removed');
      assert.equal((await owner.one(`select count(*)::int as n from hr.emp_document where id = $1`, [other])).n, 1, "another employee's file stays");
    } finally {
      await owner.query('delete from hr.emp_document where id = $1', [other]);
    }
  });

  test('max_files, size and type are checked for every file; nothing is kept from a refused upload', async () => {
    const { b } = await openForm();
    const before = (await docs()).length;
    const many = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER }, { P3_DOCUMENTS: ['1', '2', '3', '4', '5'].map((n) => pdf(`${n}.pdf`)) });
    assert.equal(many.statusCode, 422);
    assert.match(many.body, /At most 5 files/);
    const wrong = await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER }, { P3_DOCUMENTS: [pdf('ok.pdf'), { name: 'x.html', type: 'text/html', data: Buffer.from('<script>') }] });
    assert.equal(wrong.statusCode, 422);
    assert.match(wrong.body, /type of file is not allowed/);
    assert.doesNotMatch(wrong.body, /ok\.pdf/, 'all or none');
    assert.equal((await docs()).length, before);
  });

  test('download links are bound to the user and the file; row level security applies', async () => {
    const { page } = await openForm();
    const url = docLinks(page.body)[0];
    assert.equal((await (await as('blake')).get(url)).statusCode, 403, "king's link does not work for blake");
    const king = await as('king');
    const key = new URL(url, 'http://x').searchParams.get('k')!;
    assert.equal((await king.get(url.replace(`k=${key}`, `k=${Number(key) + 1}`))).statusCode, 403);
    // jones (manager of research) may open the form, but MILLER (accounting) is not in his team
    const jones = await as('jones');
    const own = `/a/hr/3/file/P3_DOCUMENTS?${new URLSearchParams({ k: key, cs: urlChecksum(appId, 3, 'jones', { __FILE: 'P3_DOCUMENTS', __KEY: key }) })}`;
    assert.equal((await jones.get(own)).statusCode, 404, 'hidden by row level security');
  });

  test('deleting the employee deletes the documents', async () => {
    const empno = (await owner.one(`insert into hr.emp (ename, job, deptno, hiredate, sal) values ('TEMP', 'CLERK', 10, current_date, 1000) returning empno`)).empno;
    try {
      const b = await as('king');
      await b.get(link('king', { P3_EMPNO: String(empno) }));
      assert.equal((await b.upload('/a/hr/3', { __request: 'SAVE', ...MILLER, P3_ENAME: 'TEMP' }, { P3_DOCUMENTS: [pdf('temp.pdf')] })).statusCode, 303);
      assert.equal((await owner.one('select count(*)::int as n from hr.emp_document where empno = $1', [empno])).n, 1);
      assert.equal((await b.submit('/a/hr/3', { __request: 'DELETE' })).statusCode, 303);
      assert.equal((await owner.one('select count(*)::int as n from hr.emp_document where empno = $1', [empno])).n, 0);
    } finally {
      await owner.query('delete from hr.emp where empno = $1', [empno]);
    }
  });
});
