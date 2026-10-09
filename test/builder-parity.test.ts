// Sprint 31 (builder): lists, page and application locks, developer
// comments, and supporting objects. The HR example's page 31 shows its lists;
// a small app of its own covers the rest.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { safeListUrl } from '../src/runtime/lists.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;
const alias = 'parity-f31';
const ROLE = 'pgkiln_f31_parity';
const SCHEMA = 'f31_parity';
const DEV = 'dev_f31';
const DEV_PW = 'Dev-f31-password!';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.query(`create role ${ROLE} nologin`);
  await owner.query(`grant ${ROLE} to pgkiln_runtime`);
  await owner.query(`create schema ${SCHEMA}`);
  await owner.query(`grant usage, create on schema ${SCHEMA} to ${ROLE}`);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Parity', 'none', $2) returning id`, [alias, ROLE])).id;
  pageId = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false) returning id`, [appId])).id;
  await owner.query(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 2, 'Second', false), ($1, 3, 'Admins', false)`, [appId]);
  await owner.query(`update meta.page set authz = 'NOBODY' where app_id = $1 and page_no = 3`, [appId]);
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value) values ($1, 'NOBODY', 'sql', 'false')`, [appId]);
});

after(async () => {
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query(`delete from meta.app where alias = 'parity-f31-copy'`);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
  await owner.query(`drop schema if exists ${SCHEMA} cascade`);
  await owner.query(`drop owned by ${ROLE}`);
  await owner.query(`drop role if exists ${ROLE}`);
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
const as = async (user: string) => {
  const b = new Browser(app);
  assert.equal((await b.login(user)).statusCode, 303);
  return b;
};

describe('lists', () => {
  test('the HR shortcuts: templates, nesting, badges, authorization, conditions and build options', async () => {
    const allen = await as('allen');
    const page = (await allen.get('/a/hr/31')).body;
    assert.match(page, /class="list-tabs"/);
    assert.match(page, /class="list-links"/);
    assert.match(page, /list-cards/);
    assert.match(page, /class="list-badges"/);
    // a badge from an item, children under "Leave"
    const headcount = (await owner.one('select count(*)::text as n from hr.emp')).n;
    assert.match(page, new RegExp(`<span>Employees</span> <span class="badge">${headcount}</span>`));
    assert.match(page, /list-heading[^]*?Leave[^]*?href="\/a\/hr\/6"/);
    // MANAGER only; LEAVE_FORECAST is excluded
    assert.doesNotMatch(page, /Audit trail/);
    assert.doesNotMatch(page, /Leave forecast/);
    const king = await as('king');
    const kpage = (await king.get('/a/hr/31')).body;
    assert.match(kpage, /Audit trail/);
    assert.doesNotMatch(kpage, /Leave forecast/);
    // the departments list comes from SQL: one entry per department
    const depts = (await owner.one('select count(*)::int as n from hr.dept')).n;
    assert.equal((page.match(/class="list-badge"/g) ?? []).length, depts);
    // the navigation bar
    assert.match(page, /<nav class="t-navbar"[^>]*>.*href="\/a\/hr\/31"/s);
  });

  test('static entries: item links carry a checksum, URLs inside the app and other sites, current entry', async () => {
    await owner.query(`insert into meta.list (app_id, name) values ($1, 'MAIN')`, [appId]);
    await owner.query(
      `insert into meta.list_entry (app_id, list_name, seq, label, target_page, target_items, target_url, badge) values
        ($1, 'MAIN', 10, 'Home', 1, '{}', null, null),
        ($1, 'MAIN', 20, 'Second with item', 2, '{"P2_X": "a b"}', null, '7'),
        ($1, 'MAIN', 30, 'Inside', null, '{}', '2?x=1', null),
        ($1, 'MAIN', 40, 'Docs', null, '{}', 'https://example.com/docs', null),
        ($1, 'MAIN', 50, 'Admins only page', 3, '{}', null, null)`,
      [appId],
    );
    await owner.query(`insert into meta.region (page_id, title, type, config) values ($1, 'Menu', 'list', '{"list": "MAIN"}')`, [pageId]);
    const b = new Browser(app);
    const res = await b.get(`/a/${alias}/1`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /href="\/a\/parity-f31\/1" aria-current="page"/);
    assert.match(res.body, /href="\/a\/parity-f31\/2\?P2_X=a\+b&amp;cs=[0-9a-f]+"/);
    assert.match(res.body, /href="\/a\/parity-f31\/2\?x=1"/);
    assert.match(res.body, /href="https:\/\/example.com\/docs" rel="noopener noreferrer"/);
    assert.match(res.body, /<span class="badge">7<\/span>/);
    // a page the user can't open is left out
    assert.doesNotMatch(res.body, /Admins only page/);
  });

  test('a list as the navigation menu, and a missing list', async () => {
    await owner.query(`update meta.app set nav_list = 'MAIN' where id = $1`, [appId]);
    try {
      const nav = (await new Browser(app).get(`/a/${alias}/1`)).body.match(/<nav id="t-nav"[^]*?<\/nav>/)![0];
      assert.match(nav, /Second with item/);
      assert.match(nav, /Docs/);
      await owner.query(`update meta.app set nav_list = 'NO_SUCH' where id = $1`, [appId]);
      // a missing list: the navigation entries (none here)
      const fallback = (await new Browser(app).get(`/a/${alias}/1`)).body.match(/<nav id="t-nav"[^]*?<\/nav>/)![0];
      assert.doesNotMatch(fallback, /Second with item/);
    } finally {
      await owner.query(`update meta.app set nav_list = null where id = $1`, [appId]);
    }
    await owner.query(`update meta.region set config = '{"list": "NO_SUCH"}' where page_id = $1 and title = 'Menu'`, [pageId]);
    assert.match((await new Browser(app).get(`/a/${alias}/1`)).body, /The list NO_SUCH does not exist/);
    await owner.query(`update meta.region set config = '{"list": "MAIN"}' where page_id = $1 and title = 'Menu'`, [pageId]);
  });

  test('a SQL list: rows as entries with parents, unsafe URLs dropped', async () => {
    await owner.query(
      `insert into meta.list (app_id, name, type, query) values ($1, 'DYN', 'sql', $2)`,
      [appId, `select * from (values (1, null::int, 'Top', null::int, null::text, 'home'), (2, 1, 'Child', 2, null, null), (3, null, 'Bad', null, 'javascript:alert(1)', null), (4, null, 'Evil', null, '//evil.example', null)) v(id, parent_id, label, page, url, icon)`],
    );
    await owner.query(`insert into meta.region (page_id, title, type, config) values ($1, 'Dynamic', 'list', '{"list": "DYN"}')`, [pageId]);
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    const region = body.match(/<section[^>]*region-list[^]*?Dynamic[^]*?<\/section>/)![0];
    assert.match(region, /Top[^]*<ul class="list-links">[^]*Child/);
    assert.doesNotMatch(region, /javascript:/);
    assert.doesNotMatch(region, /evil/);
  });

  test('safeListUrl', () => {
    assert.deepEqual(safeListUrl('10?tab=open'), { kind: 'app', url: '10?tab=open' });
    assert.deepEqual(safeListUrl('https://example.com/x?y=1'), { kind: 'external', url: 'https://example.com/x?y=1' });
    for (const bad of ['javascript:alert(1)', '//evil', '../x', 'data:text/html,x', 'https://a b', 'http://x"onmouseover=1', '\\\\evil', 'vbscript:x'])
      assert.equal(safeListUrl(bad), null, bad);
  });

  test('the builder: lists and entries under Shared Components, the list region settings, Where used', async () => {
    const b = await builder();
    const shared = await b.get(`/builder/apps/${appId}/shared?c=list-${(await owner.one(`select id from meta.list where app_id = $1 and name = 'MAIN'`, [appId])).id}`);
    assert.equal(shared.statusCode, 200);
    assert.match(shared.body, /Add entry/);
    assert.match(shared.body, /Used in \(1\)/);
    const res = await b.submit(`/builder/apps/${appId}/shared/list_entry`, { list_name: 'MAIN', label: 'Added', seq: '60', target_page: '2', target_items: '', target_url: '' });
    assert.equal(res.statusCode, 303);
    assert.ok(await owner.one(`select 1 from meta.list_entry where app_id = $1 and label = 'Added'`, [appId]));
    // both a page and a URL: refused
    await b.get(`/builder/apps/${appId}/shared?new=list_entry`);
    await b.submit(`/builder/apps/${appId}/shared/list_entry`, { list_name: 'MAIN', label: 'Both', target_page: '2', target_url: '2' });
    assert.equal(await owner.one(`select 1 from meta.list_entry where app_id = $1 and label = 'Both'`, [appId]), undefined);
    // a parent from another list is refused by the database
    await owner.query(`insert into meta.list (app_id, name) values ($1, 'OTHER')`, [appId]);
    await assert.rejects(owner.query(`insert into meta.list_entry (app_id, list_name, label, parent_id) select $1, 'OTHER', 'x', id from meta.list_entry where app_id = $1 and label = 'Added'`, [appId]), /same list/);
    // region settings
    const region = await owner.one(`select id from meta.region where page_id = $1 and title = 'Menu'`, [pageId]);
    const designer = await b.get(`/builder/pages/${pageId}?c=region-${region.id}`);
    assert.match(designer.body, /List settings/);
    await b.submit(`/builder/pages/${pageId}/region/${region.id}/settings`, { list: 'main', template: 'cards' });
    assert.deepEqual((await owner.one('select config from meta.region where id = $1', [region.id])).config, { list: 'MAIN', template: 'cards' });
    await b.submit(`/builder/pages/${pageId}/region/${region.id}/settings`, { list: 'x; drop', template: 'evil' });
    assert.deepEqual((await owner.one('select config from meta.region where id = $1', [region.id])).config, {});
    await owner.query(`update meta.region set config = '{"list": "MAIN"}' where id = $1`, [region.id]);
  });

  test('export and import carry lists and entries with their nesting', async () => {
    const parent = (await owner.one(`select id from meta.list_entry where app_id = $1 and label = 'Home'`, [appId])).id;
    await owner.query(`insert into meta.list_entry (app_id, list_name, parent_id, label, target_page) values ($1, 'MAIN', $2, 'Nested', 2)`, [appId, parent]);
    // a parent created after its child (an entry moved under a newer one)
    const late = (await owner.one(`insert into meta.list_entry (app_id, list_name, seq, label) values ($1, 'MAIN', 90, 'Later parent') returning id`, [appId])).id;
    await owner.query(`update meta.list_entry set parent_id = $2 where app_id = $1 and label = 'Inside'`, [appId, late]);
    const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
    assert.ok(doc.lists.some((l: any) => l.name === 'DYN' && l.type === 'sql'));
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'parity-f31-copy') as id`, [JSON.stringify(doc)])).id;
    const parentOf = async (label: string) =>
      (await owner.one(`select p.label from meta.list_entry e join meta.list_entry p on p.id = e.parent_id where e.app_id = $1 and e.label = $2`, [id, label]))?.label;
    assert.equal(await parentOf('Nested'), 'Home');
    assert.equal(await parentOf('Inside'), 'Later parent');
    await owner.query(`update meta.list_entry set parent_id = null where app_id = $1 and label = 'Inside'`, [appId]);
    await owner.query(`delete from meta.list_entry where id = $1`, [late]);
    await owner.query('delete from meta.app where id = $1', [id]);
  });
});

describe('page locks, the application lock and comments', () => {
  test('a locked page refuses other developers\' changes; comments still work; only the owner or an administrator unlocks', async () => {
    const dev = await builder(DEV, DEV_PW);
    const admin = await builder();
    // the developer locks page 1
    await dev.get(`/builder/pages/${pageId}`);
    assert.equal((await dev.submit(`/builder/apps/${appId}/lock`, { page_no: '1', note: 'reworking' })).statusCode, 303);
    assert.equal((await owner.one('select locked_by from meta.builder_lock where app_id = $1 and page_no = 1', [appId])).locked_by, DEV);
    // the owner keeps editing
    await dev.get(`/builder/pages/${pageId}`);
    assert.equal((await dev.submit(`/builder/pages/${pageId}/c/region`, { title: 'By owner', type: 'static', columns: '12', template: 'standard', config: '' })).statusCode, 303);
    assert.ok(await owner.one(`select 1 from meta.region where page_id = $1 and title = 'By owner'`, [pageId]));
    // another developer sees the lock and is refused
    const page = await admin.get(`/builder/pages/${pageId}`);
    assert.match(page.body, /Page 1 is locked by dev_f31/);
    const refused = await admin.submit(`/builder/pages/${pageId}/c/region`, { title: 'By admin', type: 'static', columns: '12', template: 'standard', config: '' });
    assert.equal(refused.statusCode, 303);
    assert.equal(await owner.one(`select 1 from meta.region where page_id = $1 and title = 'By admin'`, [pageId]), undefined);
    const json = await app.inject({ method: 'POST', url: `/builder/pages/${pageId}/layout/span`, headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; '), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, payload: `__csrf=${admin.lastCsrf}&id=1&delta=1` });
    assert.equal(json.statusCode, 423);
    // a comment is fine
    await admin.get(`/builder/pages/${pageId}`);
    assert.equal((await admin.submit(`/builder/apps/${appId}/comments`, { page_no: '1', body: 'Please also fix the title' })).statusCode, 303);
    assert.match((await dev.get(`/builder/pages/${pageId}`)).body, /Please also fix the title/);
    // the administrator breaks the lock (logged)
    await admin.get(`/builder/pages/${pageId}`);
    assert.equal((await admin.submit(`/builder/apps/${appId}/unlock`, { page_no: '1' })).statusCode, 303);
    assert.equal(await owner.one('select 1 from meta.builder_lock where app_id = $1', [appId]), undefined);
    assert.ok(await owner.one(`select 1 from meta.activity_log where app_id = $1 and event = 'lock_broken' and username = 'admin'`, [appId]));
    // the application lock
    await admin.get(`/builder/apps/${appId}`);
    await admin.submit(`/builder/apps/${appId}/lock`, { page_no: '0' });
    await dev.get(`/builder/apps/${appId}`);
    assert.match((await dev.get(`/builder/apps/${appId}`)).body, /The application is locked by admin/);
    await dev.submit(`/builder/apps/${appId}/shared/list`, { name: 'BLOCKED', type: 'static' });
    assert.equal(await owner.one(`select 1 from meta.list where app_id = $1 and name = 'BLOCKED'`, [appId]), undefined);
    await dev.get(`/builder/pages/${pageId}`);
    await dev.submit(`/builder/pages/${pageId}/c/region`, { title: 'Blocked', type: 'static', columns: '12', template: 'standard', config: '' });
    assert.equal(await owner.one(`select 1 from meta.region where page_id = $1 and title = 'Blocked'`, [pageId]), undefined);
    // the developer can't unlock it
    await dev.get(`/builder/apps/${appId}`);
    assert.equal((await dev.submit(`/builder/apps/${appId}/unlock`, { page_no: '0' })).statusCode, 403);
    await admin.get(`/builder/apps/${appId}`);
    await admin.submit(`/builder/apps/${appId}/unlock`, { page_no: '0' });
    assert.equal(await owner.one('select 1 from meta.builder_lock where app_id = $1', [appId]), undefined);
    await owner.query(`delete from meta.region where page_id = $1 and title = 'By owner'`, [pageId]);
  });

  test('comments: only the author or an administrator deletes one; a renamed page keeps them', async () => {
    const dev = await builder(DEV, DEV_PW);
    const c = await owner.one(`select id from meta.dev_comment where app_id = $1 and body = 'Please also fix the title'`, [appId]);
    await dev.get(`/builder/apps/${appId}`);
    assert.equal((await dev.submit(`/builder/apps/${appId}/comments/${c.id}/delete`, {})).statusCode, 403);
    await dev.submit(`/builder/apps/${appId}/comments`, { page_no: '0', body: 'App-level note' });
    assert.match((await dev.get(`/builder/apps/${appId}`)).body, /App-level note/);
    const mine = await owner.one(`select id from meta.dev_comment where app_id = $1 and body = 'App-level note'`, [appId]);
    assert.equal((await dev.submit(`/builder/apps/${appId}/comments/${mine.id}/delete`, {})).statusCode, 303);
    assert.equal(await owner.one('select 1 from meta.dev_comment where id = $1', [mine.id]), undefined);
    // page number 1 → 9 and back: the comment follows
    const admin = await builder();
    await admin.get(`/builder/pages/${pageId}?c=page`);
    const page = { name: 'Home', mode: 'normal', protection: 'checksum' };
    await admin.submit(`/builder/pages/${pageId}`, { ...page, page_no: '9' });
    assert.equal((await owner.one('select page_no from meta.dev_comment where id = $1', [c.id])).page_no, 9);
    await admin.submit(`/builder/pages/${pageId}`, { ...page, page_no: '1', requires_auth: '' });
    assert.equal((await owner.one('select page_no from meta.dev_comment where id = $1', [c.id])).page_no, 1);
  });

  test('developers: only administrators add, remove or promote developers', async () => {
    const dev = await builder(DEV, DEV_PW);
    const page = await dev.get('/builder/developers');
    assert.match(page.body, /Only administrators add and remove developers/);
    assert.equal((await dev.submit('/builder/developers', { username: 'sneaky_f31', password: 'Sneaky-f31-pass!' })).statusCode, 403);
    assert.equal((await dev.submit('/builder/developers/admin', { username: DEV, is_admin: 'true' })).statusCode, 403);
    assert.equal((await dev.submit('/builder/developers/delete', { username: 'admin' })).statusCode, 403);
    assert.equal((await owner.one('select is_admin from meta.developer where username = $1', [DEV])).is_admin, false);
    assert.ok(await owner.one(`select 1 from meta.developer where username = 'admin'`));
  });
});

describe('supporting objects', () => {
  test('scripts travel with the export, are not run on import, and run as the app\'s role when chosen', async () => {
    await owner.query(
      `insert into meta.supporting_script (app_id, name, kind, seq, script) values
        ($1, 'Tables', 'install', 10, $2),
        ($1, 'Seed', 'install', 20, $3),
        ($1, 'Drop', 'deinstall', 10, $4)`,
      [appId,
       `create table ${SCHEMA}.thing (id int primary key, name text);\n-- a comment\ncreate function ${SCHEMA}.twice(x int) returns int language plpgsql as $$ begin return x * 2; end $$;`,
       `insert into ${SCHEMA}.thing values (1, 'one'), (2, 'two');\nselect current_user as who, ${SCHEMA}.twice(21) as answer;`,
       `drop table ${SCHEMA}.thing; drop function ${SCHEMA}.twice(int);`],
    );
    const doc = (await owner.one('select meta.export_app($1) as d', [alias])).d;
    assert.equal(doc.supporting_scripts.length, 3);
    // import in the builder: nothing runs, the developer is sent to the review page
    const b = await builder();
    await b.get('/builder/import');
    const imp = await b.submit('/builder/import', { doc: JSON.stringify(doc), alias: 'parity-f31-copy' });
    assert.equal(imp.statusCode, 303);
    assert.match(String(imp.headers.location), /\/supporting-objects\?imported=1$/);
    assert.equal((await owner.one(`select to_regclass('${SCHEMA}.thing') as t`)).t, null, 'not run on import');
    const review = await b.get(String(imp.headers.location));
    assert.match(review.body, /were <b>not<\/b> run/);
    assert.match(review.body, /Run the install scripts/);
    await owner.query(`delete from meta.app where alias = 'parity-f31-copy'`);
    // run: as the app's role, results per statement
    await b.get(`/builder/apps/${appId}/supporting-objects`);
    const run = await b.submit(`/builder/apps/${appId}/supporting-objects/run`, { kind: 'install' });
    assert.equal(run.statusCode, 200);
    assert.match(run.body, /The install scripts ran: 4 statement\(s\), committed/);
    assert.match(run.body, new RegExp(`<td>${ROLE}</td><td>42</td>`));
    assert.equal((await owner.one(`select count(*)::int as n from ${SCHEMA}.thing`)).n, 2);
    assert.equal((await owner.one(`select tableowner from pg_tables where schemaname = $1 and tablename = 'thing'`, [SCHEMA])).tableowner, ROLE);
    assert.ok(await owner.one(`select 1 from meta.activity_log where app_id = $1 and event = 'supporting_objects' and detail like '%install ran%'`, [appId]));
    // a failure undoes the whole run
    await owner.query(`insert into meta.supporting_script (app_id, name, kind, script) values ($1, 'Broken', 'upgrade', $2)`, [appId, `insert into ${SCHEMA}.thing values (3, 'three'); select 1/0;`]);
    const failed = await b.submit(`/builder/apps/${appId}/supporting-objects/run`, { kind: 'upgrade' });
    assert.match(failed.body, /The upgrade scripts failed: everything they did was undone/);
    assert.match(failed.body, /division by zero/);
    assert.equal((await owner.one(`select count(*)::int as n from ${SCHEMA}.thing`)).n, 2);
    // deinstall
    await b.submit(`/builder/apps/${appId}/supporting-objects/run`, { kind: 'deinstall' });
    assert.equal((await owner.one(`select to_regclass('${SCHEMA}.thing') as t`)).t, null);
    assert.equal((await b.submit(`/builder/apps/${appId}/supporting-objects/run`, { kind: 'drop everything' })).statusCode, 400);
  });
});
