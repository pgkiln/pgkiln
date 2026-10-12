// Data and settings (migration 086): application settings, user preferences and items kept per
// user, dynamic translations, meta.data_export and the download process's export, display image
// and geocoded address items. HR example page 43 (examples/hr/hr_53_data_settings.sql).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { replaceApp } from '../src/cli/replace.ts';
import { Browser, formFields } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let role: string;
let geocoder: Server;
const geocoderAsked: URL[] = [];
// a 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Run SQL as the HR application does: its role, its app id, a user. */
async function asApp<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>, opts: { user?: string; role?: string | null; app?: number } = {}) {
  const c = await owner.pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', $2, true)`, [String(opts.app ?? appId), opts.user ?? 'king']);
    if (opts.role !== null) await c.query(`set local role ${opts.role ?? role}`);
    const r = await fn(async (sql, params) => (await c.query(sql, params)).rows);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const signedIn = async (user = 'king') => {
  const b = new Browser(app);
  await b.login(user);
  return b;
};

before(async () => {
  app = await buildApp({ logger: false });
  const a = await owner.one(`select id, db_role from meta.app where alias = 'hr'`);
  appId = a.id;
  role = a.db_role;
  geocoder = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    geocoderAsked.push(u);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(u.searchParams.get('q') === 'nowhere' ? [] : [
      { display_name: 'Markt 1, Delft, Nederland', lat: '52.0116', lon: '4.3571' },
      { display_name: 'not a place', lat: 'x', lon: '1' },
    ]));
  });
  await new Promise<void>((r) => geocoder.listen(0, '127.0.0.1', r));
  process.env.GEOCODER_URL = `http://127.0.0.1:${(geocoder.address() as AddressInfo).port}/search`;
  await owner.query(`delete from meta.user_preference where app_id = $1`, [appId]);
});

after(async () => {
  delete process.env.GEOCODER_URL;
  await owner.query(`update meta.app_setting set value = 'hr-support@example.com' where app_id = $1 and name = 'SUPPORT_EMAIL'`, [appId]);
  await owner.query(`update meta.app_setting set value = 'manager' where app_id = $1 and name = 'LEAVE_APPROVAL'`, [appId]);
  await owner.query(`delete from meta.user_preference where app_id = $1`, [appId]);
  await owner.query(`update hr.emp set photo = null, photo_mime = null, photo_name = null where ename = 'SCOTT'`);
  geocoder.close();
  await app.close();
  await closePools();
});

describe('application settings', () => {
  test('meta.get_app_setting and meta.set_app_setting, with their checks', async () => {
    await asApp(async (q) => {
      assert.equal((await q(`select meta.get_app_setting('support_email') as v`))[0].v, 'hr-support@example.com');
      await q(`select meta.set_app_setting('LEAVE_APPROVAL', 'hr')`);
      assert.equal((await q(`select meta.get_app_setting('LEAVE_APPROVAL') as v`))[0].v, 'hr');
    });
    const fails = (sql: string, re: RegExp) => assert.rejects(asApp((q) => q(sql)), re);
    await fails(`select meta.set_app_setting('LEAVE_APPROVAL', 'ceo')`, /LEAVE_APPROVAL is one of manager, hr/);
    await fails(`select meta.set_app_setting('SUPPORT_EMAIL', '')`, /needs a value/);
    await fails(`select meta.get_app_setting('NO_SUCH')`, /has no setting NO_SUCH/);
    // not as the application's role: refused
    await assert.rejects(asApp((q) => q(`select meta.get_app_setting('SUPPORT_EMAIL')`), { role: null }), /outside the application's own database role/);
    // the load process shows the setting on page 43
    const b = await signedIn();
    assert.match((await b.get('/a/hr/43')).body, /hr-support@example\.com/);
  });

  test('exported with the application; an import over it keeps the installed values marked keep on upgrade', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.ok(doc.app_settings.some((s: any) => s.name === 'SUPPORT_EMAIL' && s.value === 'hr-support@example.com' && s.keep_on_upgrade === true));
    assert.ok(doc.dynamic_translations.some((t: any) => t.language === 'nl' && t.source === 'SALES' && t.target === 'VERKOOP'));
    const copy = (await owner.one(`select meta.import_app($1::jsonb, 'hr_ds_copy') as id`, [JSON.stringify(doc)])).id;
    try {
      await owner.query(`update meta.app_setting set value = 'installed@example.com' where app_id = $1 and name = 'SUPPORT_EMAIL'`, [copy]);
      await owner.query(`update meta.app_setting set value = 'hr' where app_id = $1 and name = 'LEAVE_APPROVAL'`, [copy]);
      const next = structuredClone(doc);
      Object.assign(next.app_settings.find((s: any) => s.name === 'LEAVE_APPROVAL'), { keep_on_upgrade: false, value: 'manager' });
      const c = await owner.pool.connect();
      try {
        await c.query('begin');
        await replaceApp(c, next, 'hr_ds_copy', { backup: null });
        await c.query('commit');
      } finally {
        c.release();
      }
      const values = Object.fromEntries((await owner.query('select name, value from meta.app_setting where app_id = $1', [copy])).rows.map((r) => [r.name, r.value]));
      assert.equal(values.SUPPORT_EMAIL, 'installed@example.com', 'kept');
      assert.equal(values.LEAVE_APPROVAL, 'manager', 'from the file');
    } finally {
      await owner.query(`delete from meta.app where id = $1`, [copy]);
    }
  });
});

describe('user preferences', () => {
  test('meta.set_preference, get_preference and remove_preference, per user and application', async () => {
    await asApp(async (q) => {
      await q(`select meta.set_preference('theme.size', 'large')`);
      await q(`select meta.set_preference('theme.size', 'small', 'blake')`);
      assert.equal((await q(`select meta.get_preference('theme.size') as v`))[0].v, 'large');
      assert.equal((await q(`select meta.get_preference('theme.size', 'blake') as v`))[0].v, 'small');
      await q(`select meta.remove_preference('theme.size')`);
      assert.equal((await q(`select meta.get_preference('theme.size') as v`))[0].v, null);
    });
    await assert.rejects(asApp((q) => q(`select meta.set_preference('x', 'y')`), { user: 'nobody' }), /no signed-in user/);
    await assert.rejects(asApp((q) => q(`select meta.set_preference('bad name', 'y')`)), /a name of letters/);
    assert.equal(await asApp(async (q) => (await q(`select meta.get_preference('x') as v`))[0].v, { user: 'nobody' }), null);
  });

  test('items with {"persist": "user"} keep their value across sessions', async () => {
    let b = await signedIn();
    await b.get('/a/hr/43');
    // a plain submit (submit on change) saves it
    const res = await b.submit('/a/hr/43', { ...formFields((await b.get('/a/hr/43')).body), P43_DEPTNO: '20' });
    assert.equal(res.statusCode, 303);
    assert.equal(await asApp(async (q) => (await q(`select meta.get_preference('P43_DEPTNO') as v`))[0].v), '20');
    // a new session of the same user starts with it; another user doesn't
    b = await signedIn();
    assert.equal(formFields((await b.get('/a/hr/43')).body).P43_DEPTNO, '20');
    const other = await signedIn('blake');
    assert.equal(formFields((await other.get('/a/hr/43')).body).P43_DEPTNO, '');
  });
});

describe('dynamic translations', () => {
  test('meta.lang: the session language, then its base language, else the text', async () => {
    await asApp(async (q) => {
      assert.equal((await q(`select meta.lang('SALES', 'nl') as v`))[0].v, 'VERKOOP');
      assert.equal((await q(`select meta.lang('SALES', 'nl-BE') as v`))[0].v, 'VERKOOP');
      assert.equal((await q(`select meta.lang('SALES', 'fr') as v`))[0].v, 'SALES');
      assert.equal((await q(`select meta.lang(null) as v`))[0].v, null);
    });
    const b = await signedIn();
    const page = (await b.get('/a/hr/43?lang=nl')).body;
    assert.match(page, />VERKOOP</, 'the list of values in Dutch');
    await b.get('/a/hr/43?lang=en');
  });
});

describe('data export', () => {
  test('meta.data_export: CSV, JSON, XML and HTML from a query, with the caller\'s privileges', async () => {
    const out = await asApp(async (q) => {
      const one = async (fmt: string, opts = '{}') =>
        (await q(`select convert_from(meta.data_export($1, $2, $3::jsonb), 'UTF8') as f`, [
          `select empno, ename, '=1+1' as formula, 'a,b' as comma from hr.emp where ename in ('KING', 'BLAKE') order by ename;`, fmt, opts]))[0].f as string;
      return { csv: await one('csv'), semi: await one('csv', '{"separator": ";", "bom": false, "header": false}'), json: await one('json'), xml: await one('xml'), html: await one('html', '{"title": "Staff <list>"}') };
    });
    assert.ok(out.csv.startsWith('﻿empno,ename,formula,comma\r\n'));
    assert.match(out.csv, /\r\n\d+,BLAKE,'=1\+1,"a,b"\r\n/, 'formulas are neutralised, separators quoted');
    assert.match(out.semi, /^\d+;BLAKE;'=1\+1;a,b\r\n/);
    assert.deepEqual(JSON.parse(out.json).map((r: any) => r.ename), ['BLAKE', 'KING']);
    assert.match(out.xml, /<ename>KING<\/ename>/);
    assert.match(out.html, /<title>Staff &lt;list&gt;<\/title>[\s\S]*<th>ename<\/th>[\s\S]*<td>KING<\/td>/);
    // with no rows: the header only
    assert.equal(await asApp(async (q) => (await q(`select convert_from(meta.data_export('select 1 as a where false', 'csv', '{"bom": false}'), 'UTF8') as f`))[0].f), 'a\r\n');
    await assert.rejects(asApp((q) => q(`select meta.data_export('select 1', 'docx')`)), /the format is csv, json, xml or html/);
    // as the application's role: no access to pgkiln's own tables through it
    await assert.rejects(asApp((q) => q(`select meta.data_export('select * from meta.account', 'csv')`)), /permission denied/);
  });

  test('the download process with {"export": …} sends the rows as Excel or CSV', async () => {
    const b = await signedIn();
    const fields = formFields((await b.get('/a/hr/43')).body);
    let res = await b.submit('/a/hr/43', { ...fields, P43_DEPTNO: '10', __request: 'EXPORT_XLSX' });
    assert.equal(res.statusCode, 200, res.body.slice(0, 300));
    assert.match(String(res.headers['content-type']), /spreadsheetml/);
    assert.match(String(res.headers['content-disposition']), /filename="employees\.xlsx"/);
    assert.equal(res.rawPayload.subarray(0, 2).toString(), 'PK');
    res = await b.submit('/a/hr/43', { ...formFields((await b.get('/a/hr/43')).body), P43_DEPTNO: '10', __request: 'EXPORT_CSV' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /^﻿empno,name,job,hiredate,salary,department\r\n/);
    assert.match(res.body, /,King,President,.*,ACCOUNTING\r\n/);
    assert.doesNotMatch(res.body, /Blake/, 'only department 10');
  });
});

describe('display image and geocoded address items', () => {
  test('an image from a query, served as the application with a sandbox', async () => {
    await owner.query(`update hr.emp set photo = $1, photo_mime = 'image/png', photo_name = 'scott.png' where ename = 'SCOTT'`, [PNG]);
    const scott = (await owner.one(`select empno from hr.emp where ename = 'SCOTT'`)).empno;
    const b = await signedIn();
    await b.get('/a/hr/43');
    await b.submit('/a/hr/43', { ...formFields((await b.get('/a/hr/43')).body), P43_DEPTNO: '20', P43_EMPNO: String(scott) });
    const page = (await b.get('/a/hr/43')).body;
    const src = /<img src="(\/a\/hr\/43\/image\/P43_PHOTO\?v=[\w-]+)" alt="Photo of the employee" width="160"/.exec(page);
    assert.ok(src, 'the picture');
    const img = await b.get(src[1].replace(/&amp;/g, '&'));
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.match(String(img.headers['content-security-policy']), /sandbox/);
    assert.deepEqual(img.rawPayload, PNG);
    // nobody chosen: no picture
    await b.submit('/a/hr/43', { ...formFields(page), P43_EMPNO: '' });
    assert.equal((await b.get('/a/hr/43/image/P43_PHOTO')).statusCode, 404);
    // not an image item
    assert.equal((await b.get('/a/hr/43/image/P43_DEPTNO')).statusCode, 404);
  });

  test('an image from a URL: https origins join the page\'s img-src, other schemes show nothing', async () => {
    const page = (await owner.one(`select p.id from meta.page p where p.app_id = $1 and p.page_no = 43`, [appId])).id;
    const ids = (await owner.query(`insert into meta.item (page_id, seq, name, type, default_value) values
      ($1, 990, 'P43_T_URL', 'image', 'https://images.example.com/logo.png'), ($1, 991, 'P43_T_JS', 'image', 'javascript:alert(1)') returning id`, [page])).rows;
    try {
      const b = await signedIn();
      const res = await b.get('/a/hr/43');
      assert.match(res.body, /<img src="https:\/\/images\.example\.com\/logo\.png"/);
      assert.doesNotMatch(res.body, /javascript:alert/);
      assert.match(String(res.headers['content-security-policy']), /img-src 'self' data:[^;]* https:\/\/images\.example\.com;/);
    } finally {
      await owner.query('delete from meta.item where id = any($1)', [ids.map((r) => r.id)]);
    }
  });

  test('an address item asks the geocoder; the places come back as JSON', async () => {
    const b = await signedIn();
    const page = (await b.get('/a/hr/43')).body;
    assert.match(page, /data-geocode="P43_ADDRESS" data-url="\/a\/hr\/43\/geocode\/P43_ADDRESS" data-coords="P43_LOCATION"/);
    const post = (form: Record<string, string>) => b.post('/a/hr/43/geocode/P43_ADDRESS', form);
    let res = await post({ __csrf: b.lastCsrf, q: 'Markt 1 Delft' });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(JSON.parse(res.body).places, [{ label: 'Markt 1, Delft, Nederland', lat: 52.0116, lon: 4.3571 }]);
    const asked = geocoderAsked.at(-1)!;
    assert.equal(asked.searchParams.get('q'), 'Markt 1 Delft');
    assert.equal(asked.searchParams.get('format'), 'jsonv2');
    // at most one question a second per session
    assert.equal((await post({ __csrf: b.lastCsrf, q: 'Markt 2 Delft' })).statusCode, 429);
    await new Promise((r) => setTimeout(r, 1100));
    res = await post({ __csrf: b.lastCsrf, q: 'nowhere' });
    assert.deepEqual(JSON.parse(res.body).places, []);
    assert.equal((await post({ __csrf: 'forged', q: 'Markt 1 Delft' })).statusCode, 403);
    assert.equal((await b.post('/a/hr/43/geocode/P43_DEPTNO', { __csrf: b.lastCsrf, q: 'Markt 1 Delft' })).statusCode, 403, 'not an address item');
    // without a geocoder: a plain text item
    const url = process.env.GEOCODER_URL;
    delete process.env.GEOCODER_URL;
    try {
      assert.doesNotMatch((await b.get('/a/hr/43')).body, /data-geocode/);
    } finally {
      process.env.GEOCODER_URL = url;
    }
  });
});

describe('the builder', () => {
  test('Shared Components: application settings and dynamic translations, and a setting stays editable in Run only', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await b.get(`/builder/apps/${appId}/shared`)).body;
    assert.match(page, /Application settings[\s\S]*SUPPORT_EMAIL/);
    assert.match(page, /Dynamic translations[\s\S]*nl: SALES/);
    await b.get(`/builder/apps/${appId}/shared?new=app_setting`);
    let res = await b.submit(`/builder/apps/${appId}/shared/app_setting`, { name: 't_any', value: 'x', valid_values: '', keep_on_upgrade: 'true' });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select * from meta.app_setting where app_id = $1 and name = 'T_ANY'`, [appId]);
    assert.equal(row.valid_values, null, 'no valid values: any value');
    try {
      await b.get(`/builder/apps/${appId}/shared?c=app_setting-${row.id}`);
      res = await b.submit(`/builder/apps/${appId}/shared/app_setting/${row.id}`, { name: 'T_ANY', value: 'z', valid_values: 'x, y', keep_on_upgrade: 'true' });
      assert.match((await b.get(`/builder/apps/${appId}/shared?c=app_setting-${row.id}`)).body, /one of the valid values: x, y/);
      await owner.query(`update meta.app set build_status = 'run_only' where id = $1`, [appId]);
      res = await b.submit(`/builder/apps/${appId}/shared/app_setting/${row.id}`, { name: 'T_ANY', value: 'y', valid_values: 'x, y', keep_on_upgrade: 'true' });
      assert.equal((await owner.one(`select value from meta.app_setting where id = $1`, [row.id])).value, 'y', 'saved in Run only');
      res = await b.submit(`/builder/apps/${appId}/shared/app_setting`, { name: 'T_NEW', value: 'x' });
      assert.ok(!(await owner.one(`select 1 from meta.app_setting where app_id = $1 and name = 'T_NEW'`, [appId])), 'no new settings in Run only');
    } finally {
      await owner.query(`update meta.app set build_status = 'run_and_build' where id = $1`, [appId]);
      await owner.query(`delete from meta.app_setting where app_id = $1 and name like 'T\\_%'`, [appId]);
    }
  });
});
