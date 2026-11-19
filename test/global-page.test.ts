// Sprint 229 (parity AX-8): the Global Page (APEX: page 0, page type Global Page). Page 0's regions, items,
// buttons, dynamic actions, computations, validations and processes are part of every other page; page 0 is never
// opened by itself; its Authorization and Page requires sign-in decide who gets its components. The builder: Create
// page offers it, the Page Designer opens it at /builder/apps/<id>/pages/0, the Pages report, copy, delete, the
// Advisor. Exports, the one-file-per-component layout, working copies and the APEX importer carry it. HR: page 0's
// leave notice (examples/hr/hr_95_global_page.sql).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { loadPage } from '../src/metadata.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { advise } from '../src/builder/advisor.ts';
import { apexToDoc } from '../src/apeximport.ts';
import { readFileSync } from 'node:fs';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let otherId: number;
const ALIAS = 'gp229';
const OTHER = 'gp229-other';

const pageId = async (id: number, no: number) => (await owner.one<{ id: number }>('select id from meta.page where app_id = $1 and page_no = $2', [id, no]))?.id;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query('delete from meta.app where alias = any($1)', [[ALIAS, OTHER, `${ALIAS}-copy`, `${ALIAS}-apex`]]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, access_control, db_role) values ($1, 'Global page', 'app_users', 'any_user', 'hr_app') returning id`, [ALIAS])).id;
  otherId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Other', 'none', 'hr_app') returning id`, [OTHER])).id;
  await owner.query(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false), ($1, 2, 'Second', true)`, [appId]);
  await owner.query(`insert into meta.page (app_id, page_no, name, requires_auth, mode) values ($1, 3, 'Dialog', false, 'modal')`, [appId]);
  await owner.query(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 1, 'Home', false)`, [otherId]);
  const p0 = (await owner.one(`insert into meta.page (app_id, page_no, name, requires_auth) values ($1, 0, 'Global Page', false) returning id`, [appId])).id;
  const p1 = await pageId(appId, 1);
  const p2 = await pageId(appId, 2);
  await owner.query(`insert into meta.region (page_id, seq, title, type, source, position) values
      ($1, 10, 'Own region', 'static', '<p>own of page 1</p>', null),
      ($2, 10, 'Second region', 'static', '<p>own of page 2</p>', null)`, [p1, p2]);
  await owner.query(`insert into meta.region (page_id, seq, title, type, source, position, condition_type, condition_value, static_id) values
      ($1, 5, 'Banner', 'static', '<p>Hello &P0_MSG.</p>', 'banner', null, null, 'gp-banner'),
      ($1, 20, 'Late global', 'static', '<p>late global region</p>', null, null, null, 'gp-late'),
      ($1, 30, 'Not on two', 'static', '<p>never on page 2</p>', null, 'page_not_in', '2', 'gp-not-two')`, [p0]);
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type) values ($1, null, 10, 'P0_MSG', 'Message', 'hidden'), ($1, null, 20, 'P0_LOADED', 'Loaded', 'hidden')`, [p0]);
  await owner.query(`insert into meta.computation (page_id, seq, item_name, point, type, expression) values ($1, 10, 'P0_MSG', 'before_header', 'sql_expression', $$'from page ' || :APP_PAGE_ID$$)`, [p0]);
  await owner.query(`insert into meta.process (page_id, seq, name, type, point, code) values ($1, 10, 'Global load', 'sql', 'load', $$select 'yes' as p0_loaded$$)`, [p0]);
  await owner.query(`insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, message) values ($1, 10, 'Global hello', 'load', null, 'alert', 'global DA')`, [p0]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action, target_page)
      select $1, r.id, 10, 'P0_GO', 'Go home', 'redirect', 1 from meta.region r where r.page_id = $1 and r.title = 'Banner'`, [p0]);
});

after(async () => {
  await owner.query('delete from meta.app where alias = any($1)', [[ALIAS, OTHER, `${ALIAS}-copy`, `${ALIAS}-apex`]]);
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};

describe('sprint 229 AX-8: the Global Page at run time', () => {
  test('loadPage merges page 0 into every page, in sequence order, marked global_page', async () => {
    const p1 = (await loadPage(appId, 1))!;
    assert.deepEqual(p1.regions.map((r) => r.title), ['Banner', 'Own region', 'Late global', 'Not on two']);
    assert.ok(p1.regions.filter((r) => r.title !== 'Own region').every((r) => r.global_page));
    assert.ok(!p1.regions.find((r) => r.title === 'Own region')!.global_page);
    assert.deepEqual(p1.items.map((i) => i.name).sort(), ['P0_LOADED', 'P0_MSG']);
    assert.equal(p1.processes.length, 1);
    assert.equal(p1.computations.length, 1);
    assert.equal(p1.dynamic_actions.length, 1);
    assert.deepEqual(p1.global, { page_id: await pageId(appId, 0), authz: null, requires_auth: false });
    // page 0 itself is not merged into itself
    const p0 = (await loadPage(appId, 0))!;
    assert.equal(p0.global, undefined);
    assert.equal(p0.regions.length, 3);
  });

  test('every page shows the Global Page: regions, computed items, load processes, dynamic actions', async () => {
    const b = new Browser(app);
    const one = await b.get(`/a/${ALIAS}/1`);
    assert.equal(one.statusCode, 200);
    assert.match(one.body, /Hello from page 1/);
    assert.match(one.body, /late global region/);
    assert.match(one.body, /never on page 2/);
    assert.match(one.body, /own of page 1/);
    assert.match(one.body, /global DA/);
    assert.match(one.body, /Go home/);
    // the banner position comes before the body; the page's own region before the later global one
    assert.ok(one.body.indexOf('Hello from page 1') < one.body.indexOf('own of page 1'));
    assert.ok(one.body.indexOf('own of page 1') < one.body.indexOf('late global region'));
    // the dialog page gets it too (APEX does): a condition page_is_not_dialog keeps a region off dialogs
    const dialog = await b.get(`/a/${ALIAS}/3`);
    assert.equal(dialog.statusCode, 200);
    assert.match(dialog.body, /Hello from page 3/);
  });

  test('a load process of page 0 sets its item on every page', async () => {
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    const state = await owner.one<{ s: Record<string, string> }>(
      `select state as s from meta.session where app_id = $1 order by created_at desc limit 1`, [appId]);
    assert.equal(state?.s.P0_LOADED, 'yes');
  });

  test('a server-side condition on :APP_PAGE_ID or the page keeps a global region off a page', async () => {
    const b = new Browser(app);
    await b.login('scott', 'scott', ALIAS);
    const two = await b.get(`/a/${ALIAS}/2`);
    assert.equal(two.statusCode, 200);
    assert.match(two.body, /Hello from page 2/);
    assert.match(two.body, /own of page 2/);
    assert.doesNotMatch(two.body, /never on page 2/);
  });

  test('page 0 is never opened by itself, by number or by alias', async () => {
    const b = new Browser(app);
    assert.equal((await b.get(`/a/${ALIAS}/0`)).statusCode, 404);
    const alias = (await owner.one<{ alias: string }>('select alias from meta.page where app_id = $1 and page_no = 0', [appId]))!.alias;
    assert.equal((await b.get(`/a/${ALIAS}/${alias}`)).statusCode, 404);
  });

  test('Page requires sign-in on page 0: its components only for signed-in users', async () => {
    await owner.query('update meta.page set requires_auth = true where app_id = $1 and page_no = 0', [appId]);
    try {
      const anon = new Browser(app);
      const pub = await anon.get(`/a/${ALIAS}/1`);
      assert.equal(pub.statusCode, 200, 'page 1 stays public');
      assert.match(pub.body, /own of page 1/);
      assert.doesNotMatch(pub.body, /Hello from|late global region|global DA|Go home/);
      const user = new Browser(app);
      await user.login('scott', 'scott', ALIAS);
      assert.match((await user.get(`/a/${ALIAS}/1`)).body, /Hello from page 1/);
    } finally {
      await owner.query('update meta.page set requires_auth = false where app_id = $1 and page_no = 0', [appId]);
    }
  });

  test('the Authorization of page 0 decides for whom its components are added', async () => {
    await owner.query(`insert into meta.authz_scheme (app_id, name, type, value) values ($1, 'GP_ADMIN', 'role', 'admin') on conflict do nothing`, [appId]);
    await owner.query(`update meta.page set authz = 'GP_ADMIN' where app_id = $1 and page_no = 0`, [appId]);
    try {
      const b = new Browser(app);
      const res = await b.get(`/a/${ALIAS}/1`);
      assert.equal(res.statusCode, 200, 'the page itself is not refused');
      assert.doesNotMatch(res.body, /Hello from|late global region/);
      assert.match(res.body, /own of page 1/);
    } finally {
      await owner.query('update meta.page set authz = null where app_id = $1 and page_no = 0', [appId]);
    }
  });

  test('a page item or button of the same name wins over the Global Page\'s; clearing a page keeps P0 items', async () => {
    const p1 = (await pageId(appId, 1))!;
    const p0 = (await pageId(appId, 0))!;
    await owner.query(`insert into meta.button (page_id, seq, name, label, action, target_page) values ($1, 10, 'P0_GO', 'Own go', 'redirect', 2)`, [p1]);
    try {
      const page = (await loadPage(appId, 1))!;
      assert.deepEqual(page.buttons.filter((x) => x.name === 'P0_GO').map((x) => x.label), ['Own go']);
      assert.equal((await loadPage(appId, 2))!.buttons.find((x) => x.name === 'P0_GO')!.label, 'Go home');
    } finally {
      await owner.query(`delete from meta.button where page_id = $1 and name = 'P0_GO'`, [p1]);
    }
    assert.ok(p0);
    const b = new Browser(app);
    await b.get(`/a/${ALIAS}/1`);
    const res = await b.get(`/a/${ALIAS}/1?clear=1`);
    assert.match(res.body, /Hello from page 1/);
  });

  test('a build option that excludes page 0 leaves its components out', async () => {
    await owner.query(`insert into meta.build_option (app_id, name, status) values ($1, 'GP_OFF', 'exclude') on conflict do nothing`, [appId]);
    await owner.query(`update meta.page set build_option = 'GP_OFF' where app_id = $1 and page_no = 0`, [appId]);
    try {
      const page = (await loadPage(appId, 1))!;
      assert.equal(page.global, undefined);
      assert.deepEqual(page.regions.map((r) => r.title), ['Own region']);
    } finally {
      await owner.query('update meta.page set build_option = null where app_id = $1 and page_no = 0', [appId]);
    }
  });

  test('page 0 is always a normal page', async () => {
    await assert.rejects(owner.query(`update meta.page set mode = 'modal' where app_id = $1 and page_no = 0`, [appId]), /page_global_normal/);
    await assert.rejects(owner.query(`insert into meta.page (app_id, page_no, name) values ($1, -1, 'Negative')`, [appId]), /page_page_no_check/);
  });
});

describe('sprint 229 AX-8: the Global Page in the builder', () => {
  test('Create page offers Global Page while the application has none, and makes page 0', async () => {
    const b = await builder();
    const grid = await b.get(`/builder/apps/${otherId}/create-page`);
    assert.match(grid.body, /create-page\?type=global/);
    const step = await b.get(`/builder/apps/${otherId}/create-page?type=global`);
    assert.equal(step.statusCode, 200);
    assert.match(step.body, /name="page_no" value="0"/);
    const res = await b.submit(`/builder/apps/${otherId}/pages`, { page_no: '0', name: 'Global Page', mode: 'normal' });
    assert.equal(res.statusCode, 303);
    assert.ok(await pageId(otherId, 0));
    assert.doesNotMatch((await b.get(`/builder/apps/${otherId}/create-page`)).body, /create-page\?type=global/);
    // an empty page number is not 0
    await b.get(`/builder/apps/${otherId}/create-page`);
    await b.submit(`/builder/apps/${otherId}/pages`, { page_no: '', name: 'Empty', mode: 'normal' });
    assert.ok(!(await owner.one(`select 1 as ok from meta.page where app_id = $1 and name = 'Empty'`, [otherId])));
    await owner.query('delete from meta.page where app_id = $1 and page_no = 0', [otherId]);
  });

  test('the Page Designer opens page 0; Run opens the home page; the Pages report says Global Page', async () => {
    const b = await builder();
    const pd = await b.get(`/builder/apps/${appId}/pages/0`);
    assert.equal(pd.statusCode, 200);
    assert.match(pd.body, /pd-global/);
    assert.match(pd.body, new RegExp(`href="/a/${ALIAS}/1"[^>]*class|class="btn btn-sm btn-run" href="/a/${ALIAS}/1"`));
    assert.doesNotMatch(pd.body, new RegExp(`href="/a/${ALIAS}/0"`));
    const report = await b.get(`/builder/apps/${appId}`);
    assert.match(report.body, /Global Page<\/td>/);
    assert.match(report.body, /On every page/);
  });

  test('Quick edit from the developer toolbar finds a Global Page item shown on a page', async () => {
    const b = await builder();
    const res = await b.get(`/builder/pages/${await pageId(appId, 1)}/quick?item=P0_MSG`);
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), new RegExp(`/builder/apps/${appId}/pages/0\\?c=item-\\d+`));
  });

  test('a page copied as page 0 becomes the Global Page; page 0 copied to another application stays page 0', async () => {
    const b = await builder();
    await b.get(`/builder/apps/${otherId}/copy-page?from=${appId}&page=0`);
    const res = await b.submit(`/builder/apps/${otherId}/copy-page`, { from: String(appId), page: '0', new_page: '0', name: 'Global Page' });
    assert.equal(res.statusCode, 303);
    const p0 = await pageId(otherId, 0);
    assert.ok(p0);
    assert.equal((await owner.one<{ n: number }>('select count(*)::int as n from meta.region where page_id = $1', [p0]))!.n, 3);
    assert.ok(await owner.one(`select 1 as ok from meta.item where page_id = $1 and name = 'P0_MSG'`, [p0]));
    // a second page 0 is refused
    await assert.rejects(owner.query('select meta.copy_page($1, 0, $2, 0)', [appId, otherId]), /page 0 already exists/);
    // the Global Page copied as a normal page: its items renamed
    const p9 = (await owner.one<{ id: number }>('select meta.copy_page($1, 0, $2, 9) as id', [appId, otherId]))!.id;
    assert.ok(await owner.one(`select 1 as ok from meta.item where page_id = $1 and name = 'P9_MSG'`, [p9]));
    // a modal page copied as page 0 becomes a normal page
    await owner.query('delete from meta.page where app_id = $1 and page_no = 0', [otherId]);
    await owner.query('select meta.copy_page($1, 3, $2, 0)', [appId, otherId]);
    assert.equal((await owner.one<{ mode: string }>('select mode from meta.page where app_id = $1 and page_no = 0', [otherId]))!.mode, 'normal');
    await owner.query('delete from meta.page where app_id = $1 and page_no in (0, 9)', [otherId]);
  });

  test('deleting the Global Page keeps the application lock and comments (page_no 0 is the application\'s)', async () => {
    const id = (await owner.one(`insert into meta.page (app_id, page_no, name) values ($1, 0, 'Global Page') returning id`, [otherId])).id;
    await owner.query(`insert into meta.builder_lock (app_id, page_no, locked_by) values ($1, 0, 'admin')`, [otherId]);
    try {
      const b = await builder();
      await b.get(`/builder/apps/${otherId}/pages/0`);
      const res = await b.submit(`/builder/pages/${id}/delete`, { confirm: '0' });
      assert.equal(res.statusCode, 303);
      assert.ok(!(await pageId(otherId, 0)));
      assert.ok(await owner.one('select 1 as ok from meta.builder_lock where app_id = $1 and page_no = 0', [otherId]));
    } finally {
      await owner.query('delete from meta.builder_lock where app_id = $1', [otherId]);
      await owner.query('delete from meta.page where app_id = $1 and page_no = 0', [otherId]);
    }
  });

  test('the Advisor: links to page 0, branches and items without P0_ on page 0', async () => {
    const p0 = (await pageId(appId, 0))!;
    const p1 = (await pageId(appId, 1))!;
    try {
      await owner.query(`insert into meta.item (page_id, seq, name, label, type) values ($1, 90, 'GP_ODD', 'Odd', 'hidden')`, [p0]);
      await owner.query(`insert into meta.branch (page_id, seq, name, target_type, target_page) values ($1, 10, 'Home', 'page', 1)`, [p0]);
      await owner.query(`insert into meta.button (page_id, seq, name, label, action, target_page) values ($1, 90, 'TO_ZERO', 'Zero', 'redirect', 0)`, [p1]);
      await owner.query(`insert into meta.region (page_id, seq, title, type, source, config) values ($1, 90, 'Links to zero', 'chart', 'select 1 as l, 1 as v', '{"link": {"page": 0}}')`, [p1]);
      const { findings } = await advise(appId);
      const text = findings.map((f) => f.message).join('\n');
      assert.match(text, /Item GP_ODD is on the Global Page/);
      assert.match(text, /branch of the Global Page never runs/);
      assert.match(text, /The link goes to page 0, the Global Page/);
      assert.match(text, /The target is page 0, the Global Page/);
    } finally {
      await owner.query(`delete from meta.item where page_id = $1 and name = 'GP_ODD'`, [p0]);
      await owner.query('delete from meta.branch where page_id = $1', [p0]);
      await owner.query(`delete from meta.button where page_id = $1 and name = 'TO_ZERO'`, [p1]);
      await owner.query(`delete from meta.region where page_id = $1 and title = 'Links to zero'`, [p1]);
    }
  });
});

describe('sprint 229 AX-8: exports, files, working copies and the APEX importer', () => {
  test('export and import carry page 0; the file layout is pages/0000-…', async () => {
    const doc = (await owner.one<{ d: any }>('select meta.export_app($1) as d', [ALIAS]))!.d;
    const g = doc.pages.find((p: any) => p.page_no === 0);
    assert.equal(g.regions.length, 3);
    const files = docToFiles(doc, 'text');
    assert.ok([...files.keys()].some((f) => f.startsWith('pages/0000-global-page/')), [...files.keys()].filter((f) => f.startsWith('pages/')).join(', '));
    const back = filesToDoc(files);
    assert.equal(back.pages.find((p: any) => p.page_no === 0).items.length, 2);
    doc.app.alias = `${ALIAS}-copy`;
    const id = (await owner.one<{ id: number }>('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), `${ALIAS}-copy`]))!.id;
    assert.ok(await pageId(id, 0));
    const page = (await loadPage(id, 2))!;
    assert.ok(page.regions.some((r) => r.title === 'Banner' && r.global_page));
  });

  test('the MCP tool get_page reads page 0', async () => {
    const { TOOLS, LOCAL } = await import('../src/cli/mcp.ts');
    const getPage = TOOLS.find((t) => t.name === 'get_page')!;
    const out = await getPage.run({ alias: ALIAS, page: 0 }, LOCAL);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    assert.match(text, /pages\/0000-global-page\/page\.yaml/);
    assert.match(text, /P0_MSG/);
  });

  test('a working copy carries page 0 and merges a change to it', async () => {
    const { createCopy, mergeCopy, compare, fingerprint } = await import('../src/workingcopy.ts');
    const copy = await createCopy(appId, 'gp229-wc', 'admin');
    try {
      const cp0 = (await pageId(copy, 0))!;
      assert.ok(cp0);
      await owner.query(`update meta.region set source = '<p>Changed in the copy &P0_MSG.</p>' where page_id = $1 and title = 'Banner'`, [cp0]);
      const l = (await compare(copy))!;
      assert.ok(l.changes.some((ch) => ch.page === 0), l.changes.map((ch) => ch.id).join(', '));
      await mergeCopy(copy, { direction: 'merge', takeCopy: new Set(), state: fingerprint(l.changes), username: 'admin' });
      const res = await new Browser(app).get(`/a/${ALIAS}/1`);
      assert.match(res.body, /Changed in the copy from page 1/);
    } finally {
      await owner.query('delete from meta.app where id = $1', [copy]).catch(() => undefined);
      await owner.query(`update meta.region set source = '<p>Hello &P0_MSG.</p>' where page_id = $1 and title = 'Banner'`, [await pageId(appId, 0)]);
    }
  });

  test('the APEX importer maps a Global Page with its components (P0_ items)', async () => {
    const F100 = readFileSync(new URL('fixtures/apex/f100.sql', import.meta.url), 'utf8');
    const withComponents = F100.replace(`,p_page_component_map=>'14'
);
end;
/`, `,p_page_component_map=>'14'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000901)
,p_plug_name=>'Notice'
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_source=>'<p>Shop closes at &P0_CLOSING.</p>'
,p_plug_query_options=>'DERIVED_REPORT_COLUMNS'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000902)
,p_name=>'P0_CLOSING'
,p_item_sequence=>10
,p_display_as=>'NATIVE_HIDDEN'
);
end;
/`);
    assert.notEqual(withComponents, F100, 'the fixture has the global page this test extends');
    const { doc, report } = apexToDoc(withComponents, { alias: `${ALIAS}-apex`, dbRole: 'hr_app' });
    const g = doc.pages.find((p: any) => p.page_no === 0);
    assert.equal(g.regions[0].title, 'Notice');
    assert.equal(g.items[0].name, 'P0_CLOSING');
    assert.ok(report.entries.some((e) => e.kind === 'page' && e.page === 0 && e.status !== 'not_mapped'));
    const id = (await owner.one<{ id: number }>('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), `${ALIAS}-apex`]))!.id;
    assert.ok((await loadPage(id, 1))!.regions.some((r) => r.title === 'Notice' && r.global_page));
  });
});

describe('sprint 229 AX-8: HR', () => {
  test('a manager sees the leave notice of HR\'s Global Page on every page but Leave requests; Dismiss hides it', async () => {
    const hr = (await owner.one<{ id: number }>(`select id from meta.app where alias = 'hr'`))!.id;
    assert.ok(await pageId(hr, 0), 'HR has a Global Page (hr_95)');
    const pending = (await owner.one<{ n: number }>(`select count(*)::int as n from hr.leave_request where status = 'PENDING'`))!.n;
    const king = new Browser(app);
    await king.login('king');
    const home = await king.get('/a/hr/1');
    if (pending) assert.match(home.body, /leave request\(s\) wait for a decision/);
    assert.doesNotMatch((await king.get('/a/hr/6')).body, /wait for a decision/);
    // Dismiss: the dynamic action of page 0 runs from page 2 and sets P0_LEAVE_NOTICE_SEEN for the session
    await king.get('/a/hr/2');
    const da = (await owner.one<{ id: number }>(`select d.id from meta.dynamic_action d join meta.page p on p.id = d.page_id
        where p.app_id = $1 and p.page_no = 0 and d.action = 'execute_sql'`, [hr]))!.id;
    const res = await king.post(`/a/hr/2/da/${da}`, { __csrf: king.lastCsrf });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).items.P0_LEAVE_NOTICE_SEEN, 'Y');
    assert.doesNotMatch((await king.get('/a/hr/1')).body, /wait for a decision/);
    const scott = new Browser(app);
    await scott.login('scott');
    assert.doesNotMatch((await scott.get('/a/hr/1')).body, /wait for a decision/, 'not a manager');
  });
});
