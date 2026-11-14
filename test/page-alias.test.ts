// Sprint 193 (NX-F3): the Pages report's Type, Alias, Updated and Updated by, its filters and column chooser
// (src/builder/pages-report.ts, page-type.ts), page aliases (src/page-alias.ts, migration 170) and who changed a
// page last (meta.page_change, src/history.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { aliasFromName, pageAliasProblem, pageOfSegment, RESERVED_PAGE_ALIASES } from '../src/page-alias.ts';
import { pageType } from '../src/builder/page-type.ts';
import { chosenColumns, DEFAULT_PAGE_COLUMNS, filterPages, readFilters, sortPages, type ReportPage } from '../src/builder/pages-report.ts';
import { apexToDoc } from '../src/apeximport.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
const ALIAS = 's193-pages';
const DEV = 'dev_s193';
const DEV_PW = 'Dev-s193-password-xyz!';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias like 's193-pages%'`);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  await owner.query(`insert into meta.workspace_member (workspace_id, username) values (1, $1) on conflict do nothing`, [DEV]);
});
after(async () => {
  await owner.query(`delete from meta.app where alias like 's193-pages%'`);
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`update meta.developer set page_columns = null where username = 'admin'`);
  await app.close();
  await closePools();
});

const builder = async (user = 'admin', password = 'admin') => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: user, password })).statusCode, 303, `builder sign-in as ${user}`);
  await b.get('/builder');
  return b;
};

/** An export made before migration 170: pages without an alias (made from a fresh export, the aliases taken out). */
async function oldDoc(alias: string) {
  await owner.query('delete from meta.app where alias = $1', [alias]);
  const id = (await owner.one<{ id: number }>(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'S193 pages', 'none', 'hr_app') returning id`, [alias]))!.id;
  const page = async (no: number, name: string, regions: string[], mode = 'normal') => {
    const pid = (await owner.one<{ id: number }>('insert into meta.page (app_id, page_no, name, requires_auth, mode) values ($1, $2, $3, false, $4) returning id', [id, no, name, mode]))!.id;
    for (const [i, type] of regions.entries())
      await owner.query(`insert into meta.region (page_id, seq, type, title, source) values ($1, $2, $3, $4, $5)`, [pid, (i + 1) * 10, type, `${type} ${i}`, type === 'static' ? '<p>Hi</p>' : 'select 1 as n']);
  };
  await page(1, 'Home', ['static']);
  await page(2, 'Orders', ['report']);
  await page(3, 'Order', ['form'], 'modal');
  await page(4, 'Login', []);
  await page(5, 'Orders', ['chart', 'chart']);
  const doc = (await owner.one('select meta.export_app($1) as d', [alias]))!.d;
  await owner.query('delete from meta.app where id = $1', [id]);
  for (const p of doc.pages) delete p.alias;
  return doc;
}

describe('page alias rules (src/page-alias.ts)', () => {
  test('the shape: lower case a-z, digits and single hyphens, at most 64, not only digits, not reserved', () => {
    for (const ok of ['employees', 'leave-requests', 'p2', 'a', 'x'.repeat(64), 'login-page', '2024-report']) assert.equal(pageAliasProblem(ok), null, ok);
    assert.equal(pageAliasProblem(''), 'length');
    assert.equal(pageAliasProblem('x'.repeat(65)), 'length');
    for (const bad of ['Employees', 'a b', 'a--b', '-a', 'a-', 'a_b', 'é', 'a/b', '..', "a'b", 'a%20b']) assert.equal(pageAliasProblem(bad), 'format', bad);
    assert.equal(pageAliasProblem('42'), 'numeric');
    for (const r of RESERVED_PAGE_ALIASES) assert.equal(pageAliasProblem(r), 'reserved', r);
  });

  test('from a name: lower case, accents dropped, other characters a hyphen', () => {
    assert.equal(aliasFromName('Leave requests'), 'leave-requests');
    assert.equal(aliasFromName('Café Ünïcode!'), 'cafe-unicode');
    assert.equal(aliasFromName('  Contacts (REST) '), 'contacts-rest');
    assert.equal(aliasFromName('従業員'), '');
  });

  test('the database makes the same aliases and keeps the same reserved list', async () => {
    for (const name of ['Leave requests', 'Café Ünïcode!', '  Contacts (REST) ', 'Salaries (masked)', 'A&B / C'])
      assert.equal((await owner.one<{ s: string }>('select meta.page_alias_slug($1) as s', [name]))!.s, aliasFromName(name), name);
    for (const r of RESERVED_PAGE_ALIASES) assert.equal((await owner.one('select meta.page_alias_reserved($1) as r', [r]))!.r, true, r);
    const reserved = (await owner.one<{ src: string }>(`select prosrc as src from pg_proc where proname = 'page_alias_reserved'`))!.src;
    assert.deepEqual([...reserved.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort(), [...RESERVED_PAGE_ALIASES].sort());
  });

  test('every path segment the runtime registers under /a/:alias/ is reserved', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk('src');
    const segments = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/['`]\/a\/:alias\/([a-zA-Z0-9_.-]+)/g)) segments.add(m[1]);
    assert.ok(segments.has('login') && segments.has('rest'), 'the scan finds the routes');
    for (const s of segments) {
      if (s.includes('.')) continue; // sw.js, manifest.webmanifest, icon-192.png: an alias has no dot
      assert.ok(RESERVED_PAGE_ALIASES.includes(s), `/a/:alias/${s} is a runtime route: reserve it in src/page-alias.ts and migration 170's meta.page_alias_reserved`);
    }
  });

  test("an APEX export's page aliases come along (ORDERS → orders); one pgkiln can't use is left out", () => {
    const { doc } = apexToDoc(readFileSync('test/fixtures/apex/f100.sql', 'utf8'));
    const pages = (doc.pages ?? []) as { page_no: number; alias?: string }[];
    assert.ok(pages.length >= 2);
    assert.ok(pages.some((p) => p.alias === 'orders'));
    for (const p of pages) assert.ok(p.alias === undefined || pageAliasProblem(p.alias) === null, String(p.alias));
  });

  test("a URL segment: a number, or the alias of one of the application's pages", () => {
    const pages = [{ page_no: 2, alias: 'employees' }, { page_no: 7, alias: 'leave-request' }];
    assert.equal(pageOfSegment('2', pages), 2);
    assert.equal(pageOfSegment('99', pages), 99, 'a number is a number (the page may not exist)');
    assert.equal(pageOfSegment('employees', pages), 2);
    assert.equal(pageOfSegment('leave-request', pages), 7);
    for (const no of ['Employees', 'employees ', "employees' or 1=1", 'other', '', 'x'.repeat(65), '1e1']) assert.equal(pageOfSegment(no, pages), undefined, no);
  });
});

describe('page type (src/builder/page-type.ts)', () => {
  const r = (...types: string[]) => types.map((type, i) => ({ type, seq: (i + 1) * 10, id: i + 1 }));
  test('the main region decides; facets, login, dashboard and blank have their own rule', () => {
    assert.equal(pageType([]), 'blank');
    assert.equal(pageType(r('report')), 'report');
    assert.equal(pageType(r('breadcrumb', 'static', 'help_text', 'classic_report')), 'classic_report');
    assert.equal(pageType(r('form')), 'form');
    assert.equal(pageType(r('grid', 'grid')), 'grid');
    assert.equal(pageType(r('facets', 'report')), 'facets');
    assert.equal(pageType(r('display_selector', 'smart_filters', 'report', 'facets')), 'facets');
    assert.equal(pageType(r('smart_filters', 'report')), 'smart_filters');
    assert.equal(pageType(r('facets')), 'facets');
    assert.equal(pageType(r('static', 'login')), 'login');
    assert.equal(pageType(r('static', 'cards', 'chart', 'chart', 'report')), 'dashboard');
    assert.equal(pageType(r('chart', 'chart', 'chart')), 'dashboard');
    assert.equal(pageType(r('calendar', 'form', 'chart', 'chart')), 'calendar', 'a calendar first is a calendar page');
    assert.equal(pageType(r('chart', 'report')), 'chart');
    assert.equal(pageType(r('static', 'static')), 'static');
    assert.equal(pageType([{ type: 'form', seq: 20, id: 1 }, { type: 'report', seq: 10, id: 2 }]), 'report', 'by sequence');
  });
});

describe('the Pages report (src/builder/pages-report.ts)', () => {
  const page = (o: Partial<ReportPage> & { page_no: number }) =>
    ({ id: o.page_no, name: `Page ${o.page_no}`, alias: `p${o.page_no}`, page_group: null, mode: 'normal', authz: null, requires_auth: true, protection: 'checksum',
       regions: 0, items: 0, das: 0, processes: 0, region_types: [], updated_at: null, updated_by: null, change_source: null, type: 'blank' as const, locked: false, ...o });

  test('the default columns leave out the counts; a choice keeps known names in their order', () => {
    assert.deepEqual(chosenColumns(null), [...DEFAULT_PAGE_COLUMNS]);
    assert.ok(!DEFAULT_PAGE_COLUMNS.some((c) => ['regions', 'items', 'das', 'processes'].includes(c)));
    assert.deepEqual(chosenColumns(['regions', 'updated', 'nope', 'alias']), ['alias', 'updated', 'regions']);
    assert.deepEqual(chosenColumns([]), []);
  });

  test('sort by Updated: newest first, never changed last; filters combine; a facet leaves out its own filter', () => {
    const pages = [
      page({ page_no: 1, updated_at: '2026-01-01 10:00:00+00', updated_by: 'ann' }),
      page({ page_no: 2, updated_at: '2026-03-01 10:00:00+00', updated_by: 'bob', mode: 'modal' }),
      page({ page_no: 3 }),
      page({ page_no: 4, updated_at: '2026-02-01 10:00:00+00', updated_by: 'ann', requires_auth: false }),
    ];
    assert.deepEqual(sortPages(pages, 'updated', String).map((p) => p.page_no), [2, 4, 1, 3]);
    assert.deepEqual(sortPages(pages, 'updated_by', String).map((p) => p.page_no), [1, 4, 2, 3]);
    assert.deepEqual(sortPages(pages, 'bogus', String).map((p) => p.page_no), [1, 2, 3, 4]);
    assert.deepEqual(filterPages(pages, readFilters({ by: 'ann' })).map((p) => p.page_no), [1, 4]);
    assert.deepEqual(filterPages(pages, readFilters({ by: '-' })).map((p) => p.page_no), [3]);
    assert.deepEqual(filterPages(pages, readFilters({ by: 'ann', authz: 'public' })).map((p) => p.page_no), [4]);
    assert.deepEqual(filterPages(pages, readFilters({ by: 'ann', authz: 'public' }), 'by').map((p) => p.page_no), [4]);
    assert.deepEqual(filterPages(pages, readFilters({ mode: 'modal', by: 'ann' }), 'by').map((p) => p.page_no), [2]);
    assert.deepEqual(filterPages(pages, readFilters({ q: 'p3' })).map((p) => p.page_no), [3], 'the search finds an alias');
  });
});

describe('aliases and Updated by in the builder and the runtime', () => {
  let appId = 0;
  const rows = (body: string) => body.split('<tbody id="pages-rows">')[1].split('</tbody>')[0].split('<tr>').slice(1);
  const pageNos = (body: string) => rows(body).map((r) => Number(/<td class="num">(\d+)<\/td>/.exec(r)![1]));

  test('an export made before 170 imports with aliases from the names (unique, never reserved); the export carries them', async () => {
    const old = await oldDoc(ALIAS);
    assert.ok(old.pages.every((p: Record<string, unknown>) => !('alias' in p)));
    appId = (await owner.one<{ id: number }>('select meta.import_app($1::jsonb) as id', [JSON.stringify(old)]))!.id;
    const aliases = (await owner.query('select page_no, alias from meta.page where app_id = $1 order by page_no', [appId])).rows.map((r) => `${r.page_no}:${r.alias}`);
    assert.deepEqual(aliases, ['1:home', '2:orders', '3:order', '4:login-page', '5:orders-2']);
    const doc = (await owner.one('select meta.export_app($1) as d', [ALIAS]))!.d;
    assert.deepEqual(doc.pages.map((p: { alias: string }) => p.alias), ['home', 'orders', 'order', 'login-page', 'orders-2']);
    assert.doesNotMatch(JSON.stringify(doc), /page_change|updated_by/, 'who changed a page is not exported');
    // a copy of the export (another alias) keeps them
    const copy = (await owner.one<{ id: number }>('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), `${ALIAS}-copy`]))!.id;
    assert.equal((await owner.one('select alias from meta.page where app_id = $1 and page_no = 5', [copy]))!.alias, 'orders-2');
  });

  test('/a/<app>/<alias> opens the page as its number does', async () => {
    const b = new Browser(app);
    const byAlias = await b.get(`/a/${ALIAS}/orders-2`);
    const byNumber = await b.get(`/a/${ALIAS}/5`);
    assert.equal(byAlias.statusCode, 200);
    assert.equal(byNumber.statusCode, 200);
    assert.match(byAlias.body, /<title>Orders/);
    assert.equal((await b.get(`/a/${ALIAS}/nope`)).statusCode, 404);
    // HR: every page has an alias from the migration
    const king = new Browser(app);
    await king.login('king');
    const hr = (await owner.one<{ n: number }>(`select count(*)::int as n from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.alias is null`))!.n;
    assert.equal(hr, 0);
    const employees = await king.get('/a/hr/employees');
    assert.equal(employees.statusCode, 200);
    assert.match(employees.body, /<title>Employees/);
  });

  test('the report: Alias, Type, Updated and Updated by; the counts behind the chooser; a change records the developer', async () => {
    const admin = await builder();
    let body = (await admin.get(`/builder/apps/${appId}?sort=page`)).body;
    assert.match(body, /<th><a href="\?sort=alias">Alias<\/a><\/th>/);
    assert.match(body, /<th><a href="\?sort=type">Type<\/a><\/th>/);
    assert.match(body, /<a href="\?sort=updated">Updated<\/a>/);
    assert.match(body, /<a href="\?sort=updated_by">Updated by<\/a>/);
    assert.doesNotMatch(body, /<th class="num">Regions<\/th>/, 'the counts are hidden by default');
    const r = rows(body);
    assert.match(r[0], /<code class="page-alias">home<\/code><\/td><td>Static Content<\/td><td class="col-low">Normal<\/td>/);
    assert.match(r[1], /<td>Interactive Report<\/td>/);
    assert.match(r[2], /<td>Form<\/td><td class="col-low">Modal dialog<\/td>/);
    assert.match(r[3], /<td>Blank<\/td>/);
    assert.match(r[4], /<td>Dashboard<\/td>/);
    assert.match(r[1], new RegExp(`href="/a/${ALIAS}/orders" target="_blank"`), 'Run opens the page by its alias');
    // nothing recorded yet (an import through SQL)
    assert.match(r[1], /<td class="nowrap"><span class="muted">—<\/span><\/td><td><span class="muted">—<\/span><\/td>/);

    // a developer changes page 3 in the Page Designer: their name, now; the others unchanged
    const dev = await builder(DEV, DEV_PW);
    const pid = (await owner.one('select id from meta.page where app_id = $1 and page_no = 3', [appId]))!.id;
    await dev.get(`/builder/apps/${appId}/pages/3`);
    assert.equal((await dev.submit(`/builder/pages/${pid}/c/region`, { title: 'Notes', type: 'static', columns: '12', template: 'standard', config: '' })).statusCode, 303);
    const changes = (await owner.query('select page_no, updated_by, source from meta.page_change where app_id = $1 order by page_no', [appId])).rows;
    assert.deepEqual(changes.map((c) => `${c.page_no}:${c.updated_by}:${c.source}`), [`3:${DEV}:builder`]);
    body = (await admin.get(`/builder/apps/${appId}?sort=updated`)).body;
    assert.deepEqual(pageNos(body).slice(0, 1), [3], 'sorted by Updated: the changed page first');
    assert.match(rows(body)[0], new RegExp(`<time datetime="[^"]+" title="[^"]+">[^<]+</time></td><td>${DEV}</td>`));
    assert.match(body, /aria-sort="descending"><a href="\?sort=updated">Updated<span class="ab-sorted" aria-hidden="true">↓<\/span>/);

    // the alias edited in the Page Designer is a change of that page too; the sort is remembered for the session
    await admin.get(`/builder/apps/${appId}/pages/2`);
    const p2 = (await owner.one('select * from meta.page where app_id = $1 and page_no = 2', [appId]))!;
    assert.equal((await admin.submit(`/builder/pages/${p2.id}`, { page_no: '2', name: 'Orders', title: '', page_alias: 'all-orders', mode: 'normal', requires_auth: 'false', protection: 'checksum' })).statusCode, 303);
    assert.equal((await owner.one('select alias from meta.page where id = $1', [p2.id]))!.alias, 'all-orders');
    body = (await admin.get(`/builder/apps/${appId}`)).body;
    assert.deepEqual(pageNos(body).slice(0, 2), [2, 3]);
    assert.match(rows(body)[0], /<td>admin <span class="muted small">\(you\)<\/span><\/td>/);
    assert.equal((await new Browser(app).get(`/a/${ALIAS}/all-orders`)).statusCode, 200);
    assert.equal((await new Browser(app).get(`/a/${ALIAS}/orders`)).statusCode, 404, 'the old alias is gone');

    // filters with counts: changed by, type
    body = (await admin.get(`/builder/apps/${appId}?by=${DEV}`)).body;
    assert.deepEqual(pageNos(body), [3]);
    assert.match(body, new RegExp(`<option value="${DEV}" selected>${DEV} \\(1\\)</option>`));
    assert.match(body, /<option value="-">Not recorded \(3\)<\/option>/);
    assert.match(body, /1 of 5 pages/);
    body = (await admin.get(`/builder/apps/${appId}?type=dashboard&sort=page`)).body;
    assert.deepEqual(pageNos(body), [5]);
    assert.match(body, /<option value="dashboard" selected>Dashboard \(1\)<\/option>/);
    assert.match((await admin.get(`/builder/apps/${appId}?type=calendar`)).body, /No page matches these filters\./);
    // a value outside the lists is no injection: escaped, no rows
    body = (await admin.get(`/builder/apps/${appId}?by=%3Cb%3Ex`)).body;
    assert.doesNotMatch(body, /<b>x/);
  });

  test('the column chooser is kept per developer', async () => {
    const admin = await builder();
    await admin.get(`/builder/apps/${appId}`);
    const res = await admin.submit('/builder/page-columns', { app: String(appId), back: '?sort=page', col: ['alias', 'regions', 'items', 'updated_by'] });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `/builder/apps/${appId}?sort=page`);
    assert.deepEqual((await owner.one(`select page_columns from meta.developer where username = 'admin'`))!.page_columns, ['alias', 'updated_by', 'regions', 'items']);
    let body = (await admin.get(`/builder/apps/${appId}`)).body;
    assert.match(body, /<th class="num">Regions<\/th><th class="num">Items<\/th>/);
    assert.doesNotMatch(body, /sort=type">Type/);
    assert.match(body, /<input type="checkbox" name="col" value="regions" checked>/);
    // another developer still has the default
    const dev = await builder(DEV, DEV_PW);
    assert.doesNotMatch((await dev.get(`/builder/apps/${appId}`)).body, /<th class="num">Regions<\/th>/);
    // the way back is the report's own query string only; reset gives the default set
    const odd = await admin.submit('/builder/page-columns', { app: String(appId), back: '//evil.example/x', reset: '1' });
    assert.equal(odd.headers.location, `/builder/apps/${appId}`);
    assert.equal((await owner.one(`select page_columns from meta.developer where username = 'admin'`))!.page_columns, null);
    // without the CSRF token: refused
    assert.equal((await admin.post('/builder/page-columns', { app: String(appId), col: 'regions' })).statusCode, 403);
    assert.equal((await owner.one(`select page_columns from meta.developer where username = 'admin'`))!.page_columns, null);
    body = (await admin.get(`/builder/apps/${appId}`)).body;
    assert.match(body, /sort=type">Type/);
  });

  test('an Import in the builder records the importing developer on every page', async () => {
    const dev = await builder(DEV, DEV_PW);
    const doc = (await owner.one('select meta.export_app($1) as d', [ALIAS]))!.d;
    await dev.get('/builder/import');
    assert.equal((await dev.submit('/builder/import', { doc: JSON.stringify(doc), alias: `${ALIAS}-imp`, check: '' })).statusCode, 303);
    const imp = (await owner.one('select id from meta.app where alias = $1', [`${ALIAS}-imp`]))!.id;
    const changes = (await owner.query('select page_no, updated_by from meta.page_change where app_id = $1 order by page_no', [imp])).rows;
    assert.deepEqual(changes.map((c) => `${c.page_no}:${c.updated_by}`), [1, 2, 3, 4, 5].map((n) => `${n}:${DEV}`));
    assert.equal((await owner.one('select alias from meta.page where app_id = $1 and page_no = 2', [imp]))!.alias, 'all-orders');
  });
});
