// The generated home page and the page footer (sprint 88, parity handoff GEN-4, migration 107): an
// application's version in the footer of its pages with "Back to top", new applications at Release 1.0,
// and a list's cards with a colour band and a round icon.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser, formFields } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const ALIAS = 'gen4-footer';

async function dropApp() {
  await owner.query('delete from meta.app where alias = $1', [ALIAS]);
  await owner.query(`drop schema if exists ${ALIAS.replace(/-/g, '_')} cascade`);
  const role = `app_${ALIAS.replace(/-/g, '_')}`;
  if ((await owner.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) {
    await owner.query(`drop owned by ${role}`);
    await owner.query(`drop role ${role}`);
  }
}

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await dropApp();
});
after(async () => {
  await owner.query('update meta.app set version = null where id = $1', [appId]);
  await owner.query(`delete from meta.translation where app_id = $1 and source = 'Release 2.1'`, [appId]);
  await dropApp();
  await app.close();
  await closePools();
});

const developer = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
};

describe('the page footer', () => {
  test('Back to top on every page; the version once the application has one, translated and escaped', async () => {
    const king = new Browser(app);
    await king.login('king');
    let page = (await king.get('/a/hr/1')).body;
    assert.match(page, /<header class="t-header" id="top">/);
    assert.match(page, /<footer class="t-footer"><a class="t-top" href="#top"><svg[^>]*>[\s\S]*?<\/svg> Back to top<\/a><\/footer><\/main>/);
    assert.doesNotMatch(page, /t-version/, 'no version: none shown');
    // the builder's Settings → Definition sets it (at most 40 characters)
    const dev = await developer();
    const settings = (await dev.get(`/builder/apps/${appId}/settings`)).body;
    assert.match(settings, /<input id="f_version" name="version" type="text" value="" placeholder="Release 1.0">/);
    const fields = formFields(settings);
    const res = await dev.submit(`/builder/apps/${appId}/settings`, { ...fields, version: `Release 2.1 <b>${'x'.repeat(60)}` });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one('select version from meta.app where id = $1', [appId])).version, `Release 2.1 <b>${'x'.repeat(25)}`);
    page = (await king.get('/a/hr/1')).body;
    assert.match(page, /<span class="t-version">Release 2\.1 &lt;b&gt;x+<\/span>/);
    // a translated version
    await owner.query(`update meta.app set version = 'Release 2.1' where id = $1`, [appId]);
    await owner.query(`insert into meta.translation (app_id, language, source, target) values ($1, 'nl', 'Release 2.1', 'Versie 2.1') on conflict do nothing`, [appId]);
    king.headers['accept-language'] = 'nl';
    const nl = (await king.get('/a/hr/1')).body;
    assert.match(nl, /<html lang="nl"/);
    assert.match(nl, /<span class="t-version">Versie 2\.1<\/span>/);
    assert.match(nl, /Naar boven<\/a>/);
  });

  test('a new application starts at Release 1.0; the version travels with the export', async () => {
    const dev = await developer();
    await dev.get('/builder/create');
    const res = await dev.submit('/builder/apps', { name: 'Gen4 footer', alias: ALIAS, authentication: 'none', features: '1', language: 'en', base: 'iris', nav: 'side' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    assert.equal((await owner.one('select version from meta.app where alias = $1', [ALIAS])).version, 'Release 1.0');
    const doc = (await owner.one(`select meta.export_app($1) as d`, [ALIAS])).d;
    assert.equal(doc.app.version, 'Release 1.0');
    const home = (await new Browser(app).get(`/a/${ALIAS}/1`)).body;
    assert.match(home, /<span class="t-version">Release 1\.0<\/span>/);
  });
});

describe('the cards of a list', () => {
  test('each card has its icon in a round badge (the colour band is CSS, in the chart palette\'s order)', async () => {
    const a = await owner.one('select id from meta.app where alias = $1', [ALIAS]);
    assert.ok(a, 'made by the test above');
    await owner.query(`insert into meta.list (app_id, name) values ($1, 'GEN4')`, [a.id]);
    await owner.query(`insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page) values ($1, 'GEN4', 10, 'Orders', 'cart', 1), ($1, 'GEN4', 20, 'Customers', 'users', 1)`, [a.id]);
    await owner.query(`insert into meta.region (page_id, seq, title, type, template, config)
                       select p.id, 30, 'Cards', 'list', 'plain', '{"list": "GEN4", "template": "cards"}' from meta.page p where p.app_id = $1 and p.page_no = 1`, [a.id]);
    const page = (await new Browser(app).get(`/a/${ALIAS}/1`)).body;
    assert.equal([...page.matchAll(/<span class="list-card-head"><span class="list-card-icon"><svg/g)].length, 2);
  });
});
