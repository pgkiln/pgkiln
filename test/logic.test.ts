// Page logic (migration 029, src/runtime/logic.ts): computations, branches,
// menu buttons and badges, the new dynamic actions and build options, in the
// runtime, the builder and export/import. HR page 22 ("Leave planner",
// examples/hr/hr_22_logic.sql) is the fixture.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let pageId: number;

const as = async (user: string) => {
  const b = new Browser(app);
  const res = await b.login(user);
  assert.equal(res.statusCode, 303, `login as ${user}`);
  return b;
};
const developer = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  return b;
};
const meta = (body: string) => JSON.parse(/<script type="application\/json" id="pgapex-meta">([\s\S]*?)<\/script>/.exec(body)![1]);
const setOption = (status: 'include' | 'exclude') => owner.query(`update meta.build_option set status = $2 where app_id = $1 and name = 'LEAVE_FORECAST'`, [appId, status]);

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 22', [appId])).id;
});
after(async () => {
  await setOption('exclude');
  await app.close();
  await closePools();
});

describe('computations', () => {
  test('before header: SQL query (when the item is empty), PL/pgSQL function body, and a query for a display item', async () => {
    const king = await as('king');
    const body = (await king.get('/a/hr/22')).body;
    assert.match(body, /<option value="7839" selected/, 'P22_EMPNO from the query');
    assert.match(body, /King \(President\)/, 'P22_NAME from the function body');
    assert.match(body, /id="P22_PENDING"[^>]*>\d+</, 'P22_PENDING from a query');
    // the condition item_null: a chosen employee is kept
    await king.submit('/a/hr/22', { P22_EMPNO: '7788', P22_DAYS: '2', __request: 'CHECK' });
    assert.match((await king.get('/a/hr/22')).body, /Scott \(Analyst\)/);
  });

  test('after submit: a SQL expression runs before the validations', async () => {
    const king = await as('king');
    await king.get('/a/hr/22');
    const res = await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '2.4', __request: 'CHECK' });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/a/hr/22');
    assert.match((await king.get('/a/hr/22')).body, /name="P22_DAYS"[^>]*value="2"/, 'rounded');
  });

  test('a failing computation shows its message; one for an unknown item is reported', async () => {
    const ids = (
      await owner.query(
        `insert into meta.computation (page_id, seq, item_name, point, type, expression) values
           ($1, 90, 'P22_NAME', 'before_header', 'sql_expression', '1/0'),
           ($1, 91, 'NO_SUCH_ITEM', 'before_header', 'static', 'x') returning id`,
        [pageId],
      )
    ).rows.map((r) => r.id);
    try {
      const body = (await (await as('king')).get('/a/hr/22')).body;
      assert.match(body, /class="alert alert-error"/);
      assert.match(body, /NO_SUCH_ITEM/);
      // after submit: the submit stops with the message (422)
      await owner.query(`update meta.computation set point = 'after_submit' where id = $1`, [ids[0]]);
      const king = await as('king');
      await king.get('/a/hr/22');
      const res = await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '3', __request: 'CHECK' });
      assert.equal(res.statusCode, 422);
    } finally {
      await owner.query('delete from meta.computation where id = any($1)', [ids]);
    }
  });

  test('static values substitute items; item copies; conditions on items and requests', async () => {
    const ids = (
      await owner.query(
        `insert into meta.computation (page_id, seq, item_name, point, type, expression, condition_type, condition_expr, condition_value) values
           ($1, 80, 'P22_NAME', 'after_submit', 'static', 'Hello &APP_USER.', 'request_in', null, 'PLAN, CHECK'),
           ($1, 81, 'P22_PENDING', 'after_submit', 'item', 'P22_DAYS', 'item_equals', 'P22_DAYS', '5'),
           ($1, 82, 'P22_PENDING', 'after_submit', 'static', 'never', 'exists', 'select 1 where false', null)
         returning id`,
        [pageId],
      )
    ).rows.map((r) => r.id);
    try {
      const king = await as('king');
      await king.get('/a/hr/22');
      await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '5', __request: 'CHECK' });
      const state = (await owner.one(`select state from meta.session where username = 'king' order by last_seen desc limit 1`)).state;
      assert.equal(state.P22_NAME, 'Hello king');
      assert.equal(state.P22_PENDING, '5');
    } finally {
      await owner.query('delete from meta.computation where id = any($1)', [ids]);
    }
  });
});

describe('branches', () => {
  test('after processing: the first matching branch, by button and condition; otherwise the page itself', async () => {
    const king = await as('king');
    await king.get('/a/hr/22');
    let res = await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '12', __request: 'CHECK' });
    assert.equal(res.headers.location, '/a/hr/12', 'more than 10 days: the calendar');
    await king.get('/a/hr/22');
    res = await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '4', __request: 'CHECK' });
    assert.equal(res.headers.location, '/a/hr/22');
    // a page with items: a signed URL the target page accepts
    await king.get('/a/hr/22');
    res = await king.submit('/a/hr/22', { P22_EMPNO: '7499', __request: 'PLAN' });
    assert.match(res.headers.location as string, /^\/a\/hr\/7\?P7_EMPNO=7499&cs=/);
    assert.equal((await king.get(res.headers.location as string)).statusCode, 200);
  });

  test('a URL branch stays inside the application and encodes item values', async () => {
    const b = await owner.one(
      `insert into meta.branch (page_id, seq, name, when_button, target_type, target_url) values ($1, 5, 'url', 'CHECK', 'url', '12?note=&P22_NAME.') returning id`,
      [pageId],
    );
    try {
      const king = await as('king');
      await king.get('/a/hr/22');
      const res = await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '3', __request: 'CHECK' });
      assert.equal(res.headers.location, `/a/hr/12?note=${encodeURIComponent('King (President)')}`);
    } finally {
      await owner.query('delete from meta.branch where id = $1', [b.id]);
    }
  });

  test('before header: redirects before the page is shown; a branch to the page itself is ignored', async () => {
    const ids = (
      await owner.query(
        `insert into meta.branch (page_id, seq, name, point, target_page, condition_type, condition_expr) values
           ($1, 1, 'self', 'before_header', 22, null, null),
           ($1, 2, 'away', 'before_header', 6, 'sql', ':APP_USER = ''scott''') returning id`,
        [pageId],
      )
    ).rows.map((r) => r.id);
    try {
      assert.equal((await (await as('king')).get('/a/hr/22')).statusCode, 200);
      const res = await (await as('scott')).get('/a/hr/22');
      assert.equal(res.statusCode, 303);
      assert.equal(res.headers.location, '/a/hr/6');
    } finally {
      await owner.query('delete from meta.branch where id = any($1)', [ids]);
    }
  });
});

describe('menu buttons and badges', () => {
  test('a menu of links and a submit request, rendered without script; the badge', async () => {
    const body = (await (await as('king')).get('/a/hr/22')).body;
    const menu = /<details class="menu btn-menu" data-button="MORE">[\s\S]*?<\/details>/.exec(body)?.[0] ?? '';
    assert.ok(menu, 'menu rendered');
    assert.match(menu, /href="\/a\/hr\/6"/);
    assert.match(menu, /href="\/a\/hr\/12"/);
    assert.match(menu, /<button type="submit" name="__request" value="RESET"/);
    assert.match(body, /value="CHECK"[^>]*>Check <span class="btn-badge">\d+<\/span>/);
  });

  test('a menu request runs processes and branches like a button', async () => {
    const king = await as('king');
    await king.get('/a/hr/22');
    const res = await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '3', __request: 'RESET' });
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.location as string, /^\/a\/hr\/22\?P22_DAYS=&cs=/);
    assert.equal((await king.get(res.headers.location as string)).statusCode, 200);
  });

  test('a badge from a query; an empty badge is not shown', async () => {
    await owner.query(`update meta.button set badge_query = 'select 42' where page_id = $1 and name = 'PLAN'`, [pageId]);
    await owner.query(`update meta.button set badge = '&P22_NOTHING.' where page_id = $1 and name = 'HIGHLIGHT'`, [pageId]);
    try {
      const body = (await (await as('king')).get('/a/hr/22')).body;
      assert.match(body, /value="PLAN"[^>]*>Plan <span class="btn-badge">42<\/span>/);
      // an unknown substitution stays as written (APEX behaviour): only empty values hide the badge
      await owner.query(`update meta.button set badge = null where page_id = $1 and name = 'HIGHLIGHT'`, [pageId]);
      assert.doesNotMatch((await (await as('king')).get('/a/hr/22')).body, /data-button="HIGHLIGHT">Highlight <span/);
    } finally {
      await owner.query(`update meta.button set badge_query = null, badge = null where page_id = $1 and name in ('PLAN', 'HIGHLIGHT')`, [pageId]);
    }
  });
});

describe('dynamic actions', () => {
  test('set focus, inline error, clear errors, add class and success message reach the client', async () => {
    const das = meta((await (await as('king')).get('/a/hr/22')).body).das as any[];
    const by = (action: string) => das.find((d) => d.action === action);
    assert.equal(by('set_focus').event, 'load');
    assert.deepEqual(by('set_focus').items, ['P22_DAYS']);
    assert.equal(by('show_error').message, 'Zero days is not a leave.');
    assert.deepEqual(by('clear_errors').items, ['P22_DAYS']);
    assert.deepEqual(by('add_class').classes, ['is-highlight']);
    assert.ok(by('add_class').region);
    assert.equal(by('show_success').message, 'The form is highlighted.');
  });
});

describe('build options', () => {
  test('an excluded region is left out, its "Not" twin shown; including the option swaps them', async () => {
    let body = (await (await as('king')).get('/a/hr/22')).body;
    assert.match(body, /Planner tips/);
    assert.doesNotMatch(body, /<h2[^>]*>Forecast<\/h2>/);
    await setOption('include');
    try {
      body = (await (await as('king')).get('/a/hr/22')).body;
      assert.doesNotMatch(body, /Planner tips/);
      assert.match(body, /<h2[^>]*>Forecast<\/h2>/);
    } finally {
      await setOption('exclude');
    }
  });

  test('an excluded page is not found and leaves the navigation; an unknown option excludes', async () => {
    await owner.query(`update meta.page set build_option = 'LEAVE_FORECAST' where id = $1`, [pageId]);
    try {
      const king = await as('king');
      assert.equal((await king.get('/a/hr/22')).statusCode, 404);
      assert.doesNotMatch((await king.get('/a/hr/1')).body, /href="\/a\/hr\/22"/);
      await owner.query(`update meta.page set build_option = '!LEAVE_FORECAST' where id = $1`, [pageId]);
      assert.equal((await king.get('/a/hr/22')).statusCode, 200);
      await owner.query(`update meta.page set build_option = 'NO_SUCH_OPTION' where id = $1`, [pageId]);
      assert.equal((await king.get('/a/hr/22')).statusCode, 404);
    } finally {
      await owner.query(`update meta.page set build_option = null where id = $1`, [pageId]);
    }
  });

  test('excluded items, buttons, processes, computations and branches neither render nor run', async () => {
    await owner.query(`update meta.item set build_option = 'LEAVE_FORECAST' where page_id = $1 and name = 'P22_PENDING'`, [pageId]);
    await owner.query(`update meta.computation set build_option = 'LEAVE_FORECAST' where page_id = $1 and item_name = 'P22_DAYS'`, [pageId]);
    await owner.query(`update meta.branch set build_option = 'LEAVE_FORECAST' where page_id = $1 and seq = 10`, [pageId]);
    try {
      const king = await as('king');
      const body = (await king.get('/a/hr/22')).body;
      assert.doesNotMatch(body, /id="P22_PENDING"/);
      const res = await king.submit('/a/hr/22', { P22_EMPNO: '7839', P22_DAYS: '12', __request: 'CHECK' });
      assert.equal(res.headers.location, '/a/hr/22', 'the excluded branch is not taken');
    } finally {
      await owner.query(`update meta.item set build_option = null where page_id = $1`, [pageId]);
      await owner.query(`update meta.computation set build_option = null where page_id = $1`, [pageId]);
      await owner.query(`update meta.branch set build_option = null where page_id = $1`, [pageId]);
    }
  });
});

describe('builder', () => {
  test('the page designer lists computations and branches, and creates them', async () => {
    const dev = await developer();
    const body = (await dev.get(`/builder/pages/${pageId}`)).body;
    assert.match(body, /After submit \(computations\)/);
    assert.match(body, /After processing \(branches\)/);
    assert.match(body, /Long leave: see the calendar/);
    assert.match(body, /P22_NAME/);
    assert.match((await dev.get(`/builder/pages/${pageId}?new=computation`)).body, /name="expression"/);
    await owner.query(`delete from meta.branch where name = 'Test branch'`);
    const res = await dev.submit(`/builder/pages/${pageId}/c/branch`, {
      name: 'Test branch', point: 'after_processing', seq: '99', target_type: 'page', target_page: '6', target_items: '', condition_type: 'request_in', condition_value: 'PLAN',
    });
    assert.equal(res.statusCode, 303);
    const row = await owner.one(`select * from meta.branch where page_id = $1 and name = 'Test branch'`, [pageId]);
    assert.equal(row.condition_value, 'PLAN');
    assert.deepEqual(row.target_items, {});
    await owner.query('delete from meta.branch where id = $1', [row.id]);
  });

  test('build options in Shared Components, with where used; a missing option is flagged', async () => {
    const dev = await developer();
    const opt = await owner.one(`select id from meta.build_option where app_id = $1 and name = 'LEAVE_FORECAST'`, [appId]);
    const body = (await dev.get(`/builder/apps/${appId}/shared?c=build_option-${opt.id}`)).body;
    assert.match(body, /Used in \(2\)/);
    const region = await owner.one(`select id from meta.region where page_id = $1 and title = 'Forecast'`, [pageId]);
    assert.match((await dev.get(`/builder/pages/${pageId}?c=region-${region.id}`)).body, /<option value="LEAVE_FORECAST" selected>LEAVE_FORECAST \(exclude\)<\/option>/);
    const advisor = (await dev.get(`/builder/apps/${appId}/advisor`)).body;
    assert.doesNotMatch(advisor, /Build option LEAVE_FORECAST doesn&#39;t exist|Build option LEAVE_FORECAST doesn't exist/);
  });

  test('a menu button saves an empty menu as none and refuses a non-array', async () => {
    const dev = await developer();
    const b = await owner.one(`select * from meta.button where page_id = $1 and name = 'PLAN'`, [pageId]);
    const form = { name: 'PLAN', label: 'Plan', action: 'submit', seq: String(b.seq), region_id: String(b.region_id), menu: '', target_items: '' };
    await dev.get(`/builder/pages/${pageId}?c=button-${b.id}`);
    assert.equal((await dev.submit(`/builder/pages/${pageId}/c/button/${b.id}`, form)).statusCode, 303);
    assert.equal((await owner.one('select menu from meta.button where id = $1', [b.id])).menu, null);
    await dev.submit(`/builder/pages/${pageId}/c/button/${b.id}`, { ...form, menu: '{"label": "x"}' });
    assert.equal((await owner.one('select menu from meta.button where id = $1', [b.id])).menu, null, 'not saved');
  });
});

describe('export and import', () => {
  test('build options, computations, branches, menus and badges travel', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.ok(doc.build_options.some((o: any) => o.name === 'LEAVE_FORECAST' && o.status === 'exclude'));
    const page = doc.pages.find((p: any) => p.page_no === 22);
    assert.equal(page.computations.length, 4);
    assert.equal(page.branches.length, 3);
    assert.ok(page.regions.some((r: any) => r.build_option === 'LEAVE_FORECAST'));
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr-logic-copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const copy = (await owner.one(`select meta.export_app('hr-logic-copy') as d`)).d;
      const p2 = copy.pages.find((p: any) => p.page_no === 22);
      assert.deepEqual(p2.computations, page.computations);
      assert.deepEqual(p2.branches, page.branches);
      assert.deepEqual(copy.build_options, doc.build_options);
      assert.deepEqual(p2.buttons.find((b: any) => b.name === 'MORE').menu, page.buttons.find((b: any) => b.name === 'MORE').menu);
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });

  test('an export from before 029 (no menu, no sections) still imports', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    delete doc.build_options;
    for (const p of doc.pages) {
      delete p.computations;
      delete p.branches;
      for (const k of ['regions', 'items', 'buttons', 'dynamic_actions', 'validations', 'processes'])
        for (const r of p[k]) {
          delete r.build_option;
          delete r.menu;
          delete r.badge;
          delete r.badge_query;
          delete r.css_classes;
        }
    }
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr-logic-old') as id`, [JSON.stringify(doc)])).id;
    await owner.query('delete from meta.app where id = $1', [id]);
  });
});
