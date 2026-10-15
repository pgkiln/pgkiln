// Component settings and component groups (migration 105; APEX: Shared Components →
// Component Settings, Component Groups). Settings: an application's defaults of its
// built-in component types (HR is the fixture, its settings are restored). Groups: a
// library application's set of components another application subscribes to at once.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { componentSetting, componentSettingsFrom } from '../src/runtime/component-settings.ts';
import { lovMax, popupPageSize, ratingMax } from '../src/runtime/items.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let dev: Browser;
let hrId: number;
let saved: unknown;
let lib: number, user: number;
const P = 'cg-t';

before(async () => {
  app = await buildApp({ logger: false });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  saved = (await owner.one('select component_settings from meta.app where id = $1', [hrId])).component_settings;
  await owner.query(`delete from meta.app where alias like $1`, [`${P}%`]);
  lib = (await owner.one(`insert into meta.app (alias, name, app_type) values ($1, 'CG library', 'library') returning id`, [`${P}-lib`])).id;
  user = (await owner.one(`insert into meta.app (alias, name) values ($1, 'CG user') returning id`, [`${P}-user`])).id;
  await owner.query(`insert into meta.lov (app_id, name, query) values ($1, 'COLOURS', 'select ''red'' as d, 1 as r')`, [lib]);
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value, error_message) values ($1, 'MANAGERS', 'role', 'manager', 'Managers only.')`, [lib]);
});
after(async () => {
  await owner.query('update meta.app set component_settings = $2 where id = $1', [hrId, JSON.stringify(saved)]);
  await owner.query(`delete from meta.app where alias like $1`, [`${P}%`]);
  await app.close();
  await closePools();
});

describe('component settings', () => {
  test('bounded values; a component\'s own setting wins', () => {
    assert.equal(componentSetting({}, 'report_rows'), 15);
    assert.equal(componentSetting({ report_rows: 40 }, 'report_rows'), 40);
    assert.equal(componentSetting({ report_rows: 1e9 } as never, 'report_rows'), 15, 'out of bounds: the default');
    assert.equal(componentSetting({ grid_rows: 'x' } as never, 'grid_rows'), 25);
    const item = (config: Record<string, unknown>) => ({ config }) as never;
    assert.equal(lovMax(item({}), { lov_max_rows: 200 }), 200);
    assert.equal(lovMax(item({ max_rows: 10 }), { lov_max_rows: 200 }), 10);
    assert.equal(lovMax(item({})), 5000);
    assert.equal(ratingMax(item({}), { rating_max: 7 }), 7);
    assert.equal(ratingMax(item({ max: 4 }), { rating_max: 7 }), 4);
    assert.equal(popupPageSize(item({}), undefined, { popup_lov_rows: 50 }), 50);
    assert.equal(popupPageSize(item({}), 500, { popup_lov_rows: 50 }), 100, 'at most 100');
    assert.deepEqual(componentSettingsFrom({ report_rows: '30', grid_rows: '', rating_max: '2', lov_max_rows: '1.5' }), {
      settings: { report_rows: 30 },
      problems: ['Lists of values, Maximum rows: a whole number from 1 to 50,000.', 'Star ratings, Stars: a whole number from 3 to 10.'],
    });
  });

  test('set in Shared Components (User Interface); reports and star ratings follow them', async () => {
    assert.match((await dev.get(`/builder/apps/${hrId}/shared`)).body, /component-settings">[^<]*(<[^>]*>[^<]*)*Component Settings/);
    const page = (await dev.get(`/builder/apps/${hrId}/component-settings`)).body;
    assert.match(page, /name="report_rows"/);
    assert.equal((await dev.submit(`/builder/apps/${hrId}/component-settings`, { report_rows: '0' })).statusCode, 303);
    assert.match((await dev.get(`/builder/apps/${hrId}/component-settings`)).body, /Reports, Rows per page: a whole number from 1 to 1,000/);
    assert.deepEqual((await owner.one('select component_settings from meta.app where id = $1', [hrId])).component_settings, saved, 'nothing saved');
    assert.equal((await dev.submit(`/builder/apps/${hrId}/component-settings`, { report_rows: '5', rating_max: '7' })).statusCode, 303);
    assert.deepEqual((await owner.one('select component_settings from meta.app where id = $1', [hrId])).component_settings, { report_rows: 5, rating_max: 7 });

    const king = new Browser(app);
    assert.equal((await king.login('king')).statusCode, 303);
    const employees = (await king.get('/a/hr/2')).body;
    const total = Number((await owner.one('select count(*)::int as n from hr.emp')).n);
    assert.match(employees, new RegExp(`1–5 of ${total}`), 'the report shows 5 rows a page');
    // P20_RATING sets its own maximum (5): without it, the application's
    const ratingItem = await owner.one(`select i.id, i.config from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1 and i.name = 'P20_RATING'`, [hrId]);
    await owner.query(`update meta.item set config = config - 'max' where id = $1`, [ratingItem.id]);
    const rating = await (async () => {
      try {
        return (await king.get('/a/hr/20')).body;
      } finally {
        await owner.query('update meta.item set config = $2 where id = $1', [ratingItem.id, JSON.stringify(ratingItem.config)]);
      }
    })();
    assert.equal([...rating.matchAll(/name="P20_RATING" value="\d+"/g)].length, 7, 'seven stars');
  });
});

describe('component groups', () => {
  test('made in the library application: members are checked against its components', async () => {
    await dev.get(`/builder/apps/${lib}/shared?new=component_group`);
    const bad = await dev.submit(`/builder/apps/${lib}/shared/component_group`, { name: 'Lookups', members: 'lov:colours, page:1, lov:NOPE' });
    assert.notEqual(bad.statusCode, 500);
    assert.equal((await owner.one('select count(*)::int as n from meta.component_group where app_id = $1', [lib])).n, 0, 'refused');
    const ok = await dev.submit(`/builder/apps/${lib}/shared/component_group`, { name: 'Lookups', description: 'Shared lookups', members: 'lov:colours, authz_scheme:MANAGERS' });
    assert.equal(ok.statusCode, 303);
    assert.deepEqual((await owner.one('select members from meta.component_group where app_id = $1 and name = $2', [lib, 'Lookups'])).members, ['lov:COLOURS', 'authz_scheme:MANAGERS'], 'the names as the application has them');
    assert.match((await dev.get(`/builder/apps/${lib}/shared?type=component_group`)).body, /Lookups \(2\)/);
  });

  test('another application subscribes to the whole group; a member the library dropped is skipped', async () => {
    assert.match((await dev.get(`/builder/apps/${user}/subscriptions`)).body, new RegExp(`<option value="${lib}\\|Lookups">CG library: Lookups \\(2\\)</option>`));
    await owner.query(`update meta.component_group set members = members || '{lov:GONE}' where app_id = $1`, [lib]);
    const res = await dev.submit(`/builder/apps/${user}/subscriptions/group`, { group: `${lib}|Lookups` });
    assert.equal(res.statusCode, 303);
    assert.match((await dev.get(`/builder/apps/${user}/subscriptions`)).body, /Subscribed to Lookups: 2 components copied; skipped lov:GONE/);
    const subs = (await owner.query('select kind, name, master_app_id from meta.subscription where app_id = $1 order by kind', [user])).rows;
    assert.deepEqual(subs, [{ kind: 'authz_scheme', name: 'MANAGERS', master_app_id: lib }, { kind: 'lov', name: 'COLOURS', master_app_id: lib }]);
    assert.ok(await owner.one(`select 1 from meta.lov where app_id = $1 and name = 'COLOURS'`, [user]), 'copied');
    // a group of a standard application (or a forged one) is refused
    const std = (await owner.one(`insert into meta.app (alias, name) values ($1, 'CG standard') returning id`, [`${P}-std`])).id;
    await owner.query(`insert into meta.component_group (app_id, name, members) values ($1, 'Mine', '{}')`, [std]);
    await dev.submit(`/builder/apps/${user}/subscriptions/group`, { group: `${std}|Mine` });
    assert.match((await dev.get(`/builder/apps/${user}/subscriptions`)).body, /Choose a component group/);
  });

  test('exported with the application and written as files', async () => {
    const doc = (await owner.one('select meta.export_app($1) as d', [`${P}-lib`])).d;
    assert.deepEqual(doc.component_groups, [{ name: 'Lookups', description: 'Shared lookups', members: ['lov:COLOURS', 'authz_scheme:MANAGERS', 'lov:GONE'] }]);
    const files = docToFiles(doc, 'json');
    assert.ok(files.has('shared/component-groups/lookups.json'));
    assert.deepEqual(filesToDoc(files).component_groups, doc.component_groups);
  });
});
