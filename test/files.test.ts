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
