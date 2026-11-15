// (sprint 206, AX-5) The Page Designer's Create and Utilities menus work on the page that is open:
//   Create → Copy this page (Create page as copy with this page chosen) and Issue for this page (Team Development's
//   new issue with the application and page filled in); Utilities → History of this page (the change history
//   filtered to it), View as text, Page checksum and Export this page (src/builder/page-utilities.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { pageChecksums, shortSum } from '../src/history.ts';
import { pageFiles } from '../src/builder/page-utilities.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let appId: number;
const PAGE_NO = 9206;
const COPY_NO = 9207;

const cleanup = async () => {
  await owner.query('delete from meta.page where app_id = $1 and page_no = any($2)', [appId, [PAGE_NO, COPY_NO]]);
  await owner.query(`delete from meta.team_issue where title like 'AX-5 %'`);
};

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  const pid = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, $2, 'Ax5 source') returning id`, [appId, PAGE_NO])).id;
  await owner.query(`insert into meta.region (page_id, title, type, source) values ($1, 'Ax5 list', 'report', 'select 1 as n')`, [pid]);
  await owner.query(`insert into meta.item (page_id, name, type, label) values ($1, 'P${PAGE_NO}_ID', 'hidden', 'Id')`, [pid]);
});

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

/** The menu of the designer's toolbar whose summary has this title. */
const menu = (page: string, title: string) => {
  const start = page.indexOf(`<summary class="tb-btn" title="${title}"`);
  assert.ok(start > 0, `menu ${title}`);
  return page.slice(start, page.indexOf('</details>', start));
};

describe('sprint 206 AX-5 the Page Designer\'s menus on the open page', () => {
  test('Create has Copy this page and Issue for this page; Utilities has History, View as text, Page checksum and Export', async () => {
    const page = (await dev.get(`/builder/apps/${appId}/pages/3`)).body;
    const create = menu(page, 'Create');
    assert.match(create, new RegExp(`href="/builder/apps/${appId}/copy-page\\?from=${appId}&amp;page=3">.*Copy this page</a>`));
    assert.match(create, new RegExp(`href="/builder/team/issues/new\\?app=${appId}&amp;page=3">.*Issue for this page</a>`));
    const util = menu(page, 'Utilities');
    assert.match(util, new RegExp(`href="/builder/apps/${appId}/utilities/history\\?page=3">.*History of this page</a>`));
    assert.match(util, new RegExp(`href="/builder/apps/${appId}/pages/3/text">.*View as text</a>`));
    assert.match(util, new RegExp(`href="/builder/apps/${appId}/pages/3/text#checksum">.*Page checksum</a>`));
    assert.match(util, new RegExp(`href="/builder/apps/${appId}/pages/3/export">.*Export this page</a>`));
    // the application's entries stay
    assert.match(util, /Export application/);
    assert.match(create, /Page…/);
  });

  test('the menus are in the builder\'s language', async () => {
    const nl = new Browser(app);
    await nl.get('/builder/login');
    await nl.submit('/builder/login', { username: 'admin', password: 'admin' });
    await nl.get('/builder');
    await nl.submit('/builder/language', { language: 'nl' });
    try {
      const page = (await nl.get(`/builder/apps/${appId}/pages/3`)).body;
      assert.match(page, /Deze pagina kopiëren/);
      assert.match(page, /Geschiedenis van deze pagina/);
      assert.match((await nl.get(`/builder/apps/${appId}/pages/3/text`)).body, /Pagina 3: .* als tekst/);
    } finally {
      await nl.get('/builder');
      await nl.submit('/builder/language', { language: 'en' });
    }
  });

  test('Copy this page opens the copy form with this page chosen; copying it is recorded in the page\'s history', async () => {
    const form = await dev.get(`/builder/apps/${appId}/copy-page?from=${appId}&page=${PAGE_NO}`);
    assert.equal(form.statusCode, 200);
    assert.match(form.body, new RegExp(`name="page" value="${PAGE_NO}"`));
    assert.match(form.body, /name="new_page"/);
    assert.match(form.body, /value="Ax5 source"/);
    const res = await dev.submit(`/builder/apps/${appId}/copy-page`, { from: String(appId), page: String(PAGE_NO), new_page: String(COPY_NO), name: 'Ax5 copy' });
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const copy = await owner.one('select id from meta.page where app_id = $1 and page_no = $2', [appId, COPY_NO]);
    assert.ok(copy, 'the copy');
    assert.equal((await owner.one<{ n: number }>('select count(*)::int as n from meta.region where page_id = $1', [copy.id]))!.n, 1);
    // History of this page: the change history filtered to the page
    const hist = (await dev.get(`/builder/apps/${appId}/utilities/history?page=${COPY_NO}`)).body;
    assert.match(hist, new RegExp(`id="f_page" name="page" type="number" value="${COPY_NO}"`));
    assert.match(hist, new RegExp(`Page ${COPY_NO}`));
    assert.doesNotMatch(hist, new RegExp(`Page ${PAGE_NO}\\b`), 'only this page\'s changes');
  });

  test('Issue for this page opens a new issue with the application and page filled in', async () => {
    const form = (await dev.get(`/builder/team/issues/new?app=${appId}&page=3`)).body;
    assert.match(form, new RegExp(`<option value="${appId}" selected>`));
    assert.match(form, /id="f_page" name="page"[^>]*value="3"/);
    const res = await dev.submit('/builder/team/issues', { title: 'AX-5 issue of page 3', body: '', app: String(appId), page: '3' });
    assert.equal(res.statusCode, 303);
    const i = await owner.one(`select app_id, page_no from meta.team_issue where title = 'AX-5 issue of page 3'`);
    assert.deepEqual([i.app_id, i.page_no], [appId, 3]);
  });

  test('View as text: the page\'s files of the text layout, read-only, and its checksum as on Utilities', async () => {
    const res = await dev.get(`/builder/apps/${appId}/pages/${PAGE_NO}/text`);
    assert.equal(res.statusCode, 200);
    const doc = (await owner.one('select meta.export_app($1) as d', ['hr'])).d;
    const files = pageFiles(doc, PAGE_NO);
    assert.ok(files.size >= 3, 'page, region and item');
    for (const path of files.keys()) assert.match(res.body, new RegExp(`<code>${path.replace(/[.]/g, '\\.')}</code>`));
    assert.match(res.body, /select 1 as n/);
    assert.match(res.body, new RegExp(`P${PAGE_NO}_ID`, 'i'));
    const main = res.body.slice(res.body.indexOf('<main'), res.body.indexOf('</main>'));
    assert.doesNotMatch(main, /<textarea|<form method="post"/, 'nothing to change here');
    const sum = pageChecksums(doc).get(PAGE_NO)!;
    assert.match(res.body, new RegExp(`id="checksum"[\\s\\S]*<code>${sum}</code>`));
    const util = (await dev.get(`/builder/apps/${appId}/utilities`)).body;
    assert.match(util, new RegExp(shortSum(sum)), 'the same checksum as the application\'s Utilities');
  });

  test('Export this page: a zip with the page\'s folder, the same files as the application\'s text export', async () => {
    const res = await dev.get(`/builder/apps/${appId}/pages/${PAGE_NO}/export`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(String(res.headers['content-disposition']), new RegExp(`attachment; filename="hr-page-${PAGE_NO}\\.pgkiln\\.zip"`));
    const doc = (await owner.one('select meta.export_app($1) as d', ['hr'])).d;
    assert.equal(res.headers['x-pgkiln-checksum'], pageChecksums(doc).get(PAGE_NO));
    const zip = unzipSync(new Uint8Array(res.rawPayload));
    const all = docToFiles(doc, 'text');
    const names = Object.keys(zip);
    assert.ok(names.length >= 3);
    for (const n of names) {
      assert.match(n, new RegExp(`^hr/pages/${PAGE_NO}-ax5-source/`));
      assert.equal(strFromU8(zip[n]), all.get(n.slice('hr/'.length))!.toString('utf8'), n);
    }
    // the folder in place of the page's folder of the application's text export imports: a changed name comes in
    const changed = new Map([...all].filter(([p]) => !p.startsWith(`pages/${PAGE_NO}-`)));
    for (const n of names) changed.set(n.slice('hr/'.length), Buffer.from(strFromU8(zip[n]).replace(/Ax5 source/g, 'Ax5 renamed')));
    const back = filesToDoc(changed);
    assert.equal(back.pages.find((p: any) => p.page_no === PAGE_NO)?.name, 'Ax5 renamed');
    assert.equal(back.pages.length, doc.pages.length);
    // logged like an application's export, as its own event
    assert.ok(await owner.one(`select 1 as ok from meta.activity_log where app_id = $1 and event = 'page_export' and detail = $2`, [appId, String(PAGE_NO)]));
  });

  test('an unknown page is not found', async () => {
    for (const url of [`/builder/apps/${appId}/pages/987654/text`, `/builder/apps/${appId}/pages/987654/export`, `/builder/apps/987654/pages/3/export`, `/builder/apps/${appId}/pages/x/text`])
      assert.equal((await dev.get(url)).statusCode, 404, url);
  });
});
