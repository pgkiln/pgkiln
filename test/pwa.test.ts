// Progressive Web App on the server: manifest, service worker, icons, the
// offline page, submission ids (no double processing), signed form keys,
// location items. The browser side is in test/e2e/pwa.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { inflateSync } from 'node:zlib';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { pngSize } from '../src/builder/pwa.ts';
import { letterIcon, png } from '../src/runtime/pwa.ts';
import { Browser, formFields } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const REASON = `pwa unit ${Date.now()}`;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await owner.query(`update meta.app set pwa = true, pwa_short_name = 'HR', pwa_icon = null, pwa_offline_pages = true, pwa_offline_submit = true where id = $1`, [appId]);
  const ids = (await owner.query('select id from hr.leave_request where reason like $1', [`${REASON}%`])).rows.map((r) => String(r.id));
  await owner.query('delete from meta.task where app_id = $1 and detail_pk = any($2::text[])', [appId, ids]);
  await owner.query('delete from hr.leave_request where reason like $1', [`${REASON}%`]);
  await owner.query(`update hr.emp set work_location = null where empno = 7788`);
  await app.close();
  await closePools();
});

/** The pixels of a PNG made by png(): [width, height, RGBA of the centre pixel]. */
function decode(buf: Buffer) {
  const { width, height } = pngSize(buf)!;
  const idat = buf.subarray(buf.indexOf('IDAT') + 4, buf.indexOf('IEND') - 8);
  const raw = inflateSync(idat);
  const row = Math.floor(height / 2) * (width * 4 + 1) + 1 + Math.floor(width / 2) * 4;
  return [width, height, [...raw.subarray(row, row + 4)]];
}

describe('installable app', () => {
  test('manifest, service worker, icons and the offline page; none of it when the app is not a PWA', async () => {
    const b = new Browser(app);
    const m = JSON.parse((await b.get('/a/hr/manifest.webmanifest')).body);
    assert.equal(m.start_url, '/a/hr/1');
    assert.equal(m.scope, '/a/hr/');
    assert.equal(m.display, 'standalone');
    assert.equal(m.short_name, 'HR');
    assert.deepEqual(m.icons.map((i: any) => `${i.sizes}/${i.purpose}`), ['192x192/any', '512x512/any', '512x512/maskable']);
    const sw = await b.get('/a/hr/sw.js');
    assert.equal(sw.headers['service-worker-allowed'], '/a/hr/');
    assert.match(sw.body, /^const PGAPEX = \{"base":"\/a\/hr","offlinePages":true,"offlineSubmit":true,"version":"[a-z0-9]+"\};/);
    const icon = (await b.get('/a/hr/icon-512.png')).rawPayload;
    const [w, h, centre] = decode(icon);
    assert.deepEqual([w, h], [512, 512]);
    assert.deepEqual(centre, [255, 255, 255, 255], 'the white letter in the middle');
    assert.match((await b.get('/a/hr/offline')).body, /You&#39;re offline|You're offline/);
    const page = (await b.get('/a/hr/login')).body;
    assert.match(page, /<link rel="manifest" href="\/a\/hr\/manifest.webmanifest">/);

    await owner.query('update meta.app set pwa = false where id = $1', [appId]);
    for (const url of ['/a/hr/manifest.webmanifest', '/a/hr/sw.js', '/a/hr/icon-192.png', '/a/hr/offline']) assert.equal((await b.get(url)).statusCode, 404, url);
    assert.doesNotMatch((await b.get('/a/hr/login')).body, /rel="manifest"/);
    await owner.query('update meta.app set pwa = true where id = $1', [appId]);
  });

  test('letter tiles and PNG sizes', () => {
    assert.deepEqual(pngSize(letterIcon('HR Demo', '#0b63c5', 192)), { width: 192, height: 192 });
    assert.equal(decode(letterIcon('ünicode', '#000000', 64))[0], 64, 'accents are dropped (U)');
    assert.equal(pngSize(Buffer.from('GIF89a…')), null);
  });

  test('the builder saves the settings and only takes square PNG icons of 512 pixels or more', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    assert.match((await dev.get(`/builder/apps/${appId}/settings`)).body, /Progressive Web App/);
    const upload = async (data: Buffer, extra: Record<string, string> = {}) => {
      await dev.get(`/builder/apps/${appId}/settings`);
      await dev.upload(`/builder/apps/${appId}/pwa`, { pwa: 'true', pwa_short_name: 'HR', pwa_offline_pages: 'true', pwa_offline_submit: 'true', ...extra }, { icon: { name: 'i.png', type: 'image/png', data } });
      return (await dev.get(`/builder/apps/${appId}/settings`)).body;
    };
    assert.match(await upload(Buffer.from('not a png')), /must be a PNG/);
    assert.match(await upload(png(256, 256, new Uint8Array(256 * 256 * 4))), /at least 512 × 512 pixels \(this one is 256 × 256\)/);
    assert.match(await upload(png(600, 512, new Uint8Array(600 * 512 * 4))), /must be square/);
    const good = png(512, 512, new Uint8Array(512 * 512 * 4).fill(200));
    assert.match(await upload(good), /settings saved/);
    assert.deepEqual((await new Browser(app).get('/a/hr/icon-192.png')).rawPayload, good, 'the uploaded icon is served');
    const m = JSON.parse((await new Browser(app).get('/a/hr/manifest.webmanifest')).body);
    assert.ok(!m.icons.some((i: any) => i.purpose === 'maskable'), 'an uploaded icon is not declared maskable');
  });
});

describe('forms', () => {
  async function leaveForm(user = 'king') {
    const b = new Browser(app);
    await b.login(user);
    const page = (await b.get('/a/hr/7?clear=1')).body;
    const field = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(page)?.[1] ?? '';
    const rid = /name="__pk_(\d+)"/.exec(page)![1]; // the leave form region
    return { b, page, rid, form: { __csrf: b.lastCsrf, __submit_id: field('__submit_id'), [`__pk_${rid}`]: field(`__pk_${rid}`), [`__pkcs_${rid}`]: field(`__pkcs_${rid}`) } };
  }

  test('a form sent twice with the same submission id is processed once', async () => {
    const { b, form } = await leaveForm();
    assert.match(form.__submit_id, /^[0-9a-f-]{36}$/);
    const body = { ...form, __request: 'CREATE', P7_START_DATE: '2027-09-06', P7_END_DATE: '2027-09-07', P7_REASON: `${REASON} twice` };
    assert.equal((await b.post('/a/hr/7', body)).statusCode, 303);
    assert.equal((await b.post('/a/hr/7', body)).statusCode, 303);
    assert.equal((await owner.query('select 1 from hr.leave_request where reason = $1', [`${REASON} twice`])).rows.length, 1);
    assert.match((await b.get('/a/hr/7')).body, /This form was already sent/);
  });

  test('the form\'s record travels signed with the form; a forged key is ignored', async () => {
    const { page, rid } = await leaveForm();
    assert.match(page, new RegExp(`name="__pk_${rid}" value=""`), 'a new request: no key');
    // a signed key from another page/user doesn't validate: the session's key is used
    const allen = new Browser(app);
    await allen.login('allen');
    const p = (await allen.get('/a/hr/7?clear=1')).body;
    const sid = /name="__submit_id" value="([^"]*)"/.exec(p)![1];
    const res = await allen.post('/a/hr/7', { __csrf: allen.lastCsrf, __submit_id: sid, __request: 'CREATE', [`__pk_${rid}`]: '1', [`__pkcs_${rid}`]: 'forged',
      P7_START_DATE: '2027-09-13', P7_END_DATE: '2027-09-14', P7_REASON: `${REASON} forged` });
    assert.equal(res.statusCode, 303);
    const row = await owner.one('select empno from hr.leave_request where reason = $1', [`${REASON} forged`]);
    assert.equal(row.empno, 7499, 'created as a new request of allen, not an update of request 1');
  });

  test('location items take "lat,lng" only', async () => {
    const before = await owner.one('select * from hr.emp where empno = 7788');
    try {
      const b = new Browser(app);
      await b.login('king');
      const list = (await b.get('/a/hr/2')).body;
      const href = /href="(\/a\/hr\/3\?[^"]*P3_EMPNO=7788[^"]*)"/.exec(list)![1].replace(/&amp;/g, '&');
      const form = (await b.get(href)).body;
      assert.match(form, /data-locate="P3_WORK_LOCATION"/);
      assert.match(form, /capture="environment" data-max-px="1200"/);
      const save = async (loc: string) => {
        const page = (await b.get(href)).body;
        return b.post('/a/hr/3', { ...formFields(page), __request: 'SAVE', P3_WORK_LOCATION: loc });
      };
      const bad = await save('somewhere in Delft');
      assert.equal(bad.statusCode, 422);
      assert.match(bad.body, /enter a position as latitude,longitude/);
      assert.equal((await save('52.01160, 4.35710')).statusCode, 303);
      const after = await owner.one('select * from hr.emp where empno = 7788');
      assert.equal(after.work_location, '52.01160, 4.35710');
      assert.deepEqual({ ...after, work_location: null }, { ...before, work_location: null }, 'nothing else changed');
      assert.match((await b.get(href)).body, /value="52\.01160, 4\.35710"/);
    } finally {
      await owner.query('update hr.emp set mgr = $2, username = $3, comm = $4, sal = $5, work_location = null where empno = $1', [7788, before.mgr, before.username, before.comm, before.sal]);
    }
  });
});
