// Plug-ins with their own code (069): plug-in files and their checks, the
// builder page (import, download, install SQL, remove), the four plug-in
// types at runtime, export/import, the directory layout, `pgapex plugin
// build|install`, and the examples (sources, built files and HR part 47 agree).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { root } from '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { exportPlugin } from '../src/builder/plugins.ts';
import { parsePluginDocument, pluginFromSources } from '../src/runtime/plugins.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hr: number;
let dev: Browser;
const IMP = 'hr-plugin-imp';
const EXAMPLES = ['char-counter', 'show-more', 'copy-value', 'log-event'];
const meta = (body: string) => JSON.parse(/<script type="application\/json" id="pgapex-meta">([\s\S]*?)<\/script>/.exec(body)![1]);
const example = (n: string) => JSON.parse(readFileSync(join(root, 'examples/plugins', `${n}.plugin.json`), 'utf8'));
const built = (n: string) => pluginFromSources((f) => (existsSync(join(root, 'examples/plugins', n, f)) ? readFileSync(join(root, 'examples/plugins', n, f)) : undefined));

const tiny = (over: Record<string, unknown> = {}) => ({
  format: 'pgapex-plugin/2', type: 'dynamic_action', name: 't_tiny', label: 'Tiny', version: '1.0',
  attributes: [{ name: 'WORD', default: 'hi &APP_USER.' }],
  files: [{ name: 't-tiny.js', content: Buffer.from("pgapex.plugins.register('t_tiny', () => {});\n").toString('base64') }],
  ...over,
});

async function cleanup() {
  await owner.query(`delete from meta.app where alias = $1`, [IMP]);
  await owner.query(`delete from meta.plugin where app_id = $1 and name like 't\\_%'`, [hr]);
  await owner.query(`delete from meta.static_file where app_id = $1 and name like 't-%'`, [hr]);
  await owner.query(`delete from meta.template_component where app_id = $1 and static_id like 't\\_%'`, [hr]);
  await owner.query(`delete from meta.dynamic_action where name like 't-plugin%'`);
  await owner.query(`delete from meta.region where title like 't-plugin%'`);
}

before(async () => {
  app = await buildApp({ logger: false });
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
});
after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('plug-ins', () => {
  test('plug-in files are checked before anything is installed', () => {
    assert.equal(typeof parsePluginDocument(tiny()), 'object');
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ format: 'pgapex-plugin/1' }, /format/],
      [{ type: 'authentication' }, /type is one of/],
      [{ name: 'Bad Name' }, /Name/],
      [{ label: '' }, /Label/],
      [{ files: [{ name: 'evil.html', content: '' }] }, /not an allowed name/],
      [{ files: [{ name: '../x.js', content: '' }] }, /not an allowed name/],
      [{ files: [{ name: 'x.js', content: '<script>' }] }, /base64/],
      [{ attributes: [{ name: 'lower' }] }, /upper case/],
      [{ type: 'process' }, /schema\.function/],
      [{ type: 'process', sql_function: 'drop table x; --' }, /schema\.function/],
      [{ sql_function: 'a.b' }, /Only process plug-ins/],
      [{ template_component: { static_id: 't_x', name: 'X', template: '<b>x</b>' } }, /Only region plug-ins/],
      [{ type: 'region', template_component: { static_id: 't_x', name: 'X', template: '<script>alert(1)</script>' } }, /Template component: .*script/i],
      [{ type: 'region', template_component: { static_id: 't_x', name: 'X', template: '<a onclick="x()">x</a>' } }, /Template component/],
    ];
    for (const [over, re] of bad) {
      const r = parsePluginDocument(tiny(over));
      assert.equal(typeof r, 'string', JSON.stringify(over));
      assert.match(r as string, re, JSON.stringify(over));
    }
  });

  test('the examples: sources, built files and HR part 47 agree', async () => {
    for (const n of EXAMPLES) {
      assert.deepEqual(built(n), example(n), `examples/plugins/${n}.plugin.json is built from examples/plugins/${n}/ (pgapex plugin build)`);
      const doc = example(n);
      const installed = await exportPlugin(hr, doc.name);
      assert.ok(installed, `${doc.name} is installed by examples/hr/hr_47_plugins.sql`);
      const noNulls = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (v === null ? undefined : v)));
      assert.deepEqual(noNulls(installed), noNulls(doc));
    }
  });

  test('the builder imports, shows, downloads and removes plug-ins', async () => {
    let page = await dev.get(`/builder/apps/${hr}/plugins`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Show more list/);
    await dev.submit(`/builder/apps/${hr}/plugins/import`, { plugin: JSON.stringify(tiny()) });
    const row = await owner.one(`select * from meta.plugin where app_id = $1 and name = 't_tiny'`, [hr]);
    assert.deepEqual([row.type, row.files], ['dynamic_action', ['t-tiny.js']]);
    assert.equal((await owner.one(`select convert_from(content, 'utf8') as c from meta.static_file where app_id = $1 and name = 't-tiny.js'`, [hr])).c, "pgapex.plugins.register('t_tiny', () => {});\n");
    // again without "replace": refused, nothing changed
    await dev.get(`/builder/apps/${hr}/plugins`);
    await dev.submit(`/builder/apps/${hr}/plugins/import`, { plugin: JSON.stringify(tiny({ label: 'Changed' })) });
    page = await dev.get(`/builder/apps/${hr}/plugins`);
    assert.match(page.body, /A plug-in named t_tiny exists/);
    assert.equal((await owner.one(`select label from meta.plugin where app_id = $1 and name = 't_tiny'`, [hr])).label, 'Tiny');
    await dev.submit(`/builder/apps/${hr}/plugins/import`, { plugin: JSON.stringify(tiny({ label: 'Changed' })), replace: 'true' });
    assert.equal((await owner.one(`select label from meta.plugin where app_id = $1 and name = 't_tiny'`, [hr])).label, 'Changed');
    // a file upload works the same way
    const up = await dev.upload(`/builder/apps/${hr}/plugins/import`, { replace: 'true' }, { file: { name: 'tiny.plugin.json', type: 'application/json', data: Buffer.from(JSON.stringify(tiny({ version: '2.0', label: 'Changed' }))) } });
    assert.equal(up.statusCode, 303);
    assert.equal((await owner.one(`select version from meta.plugin where app_id = $1 and name = 't_tiny'`, [hr])).version, '2.0');
    // not JSON, or a bad file
    await dev.get(`/builder/apps/${hr}/plugins`);
    await dev.submit(`/builder/apps/${hr}/plugins/import`, { plugin: '{nope' });
    assert.match((await dev.get(`/builder/apps/${hr}/plugins`)).body, /not valid JSON/);

    page = await dev.get(`/builder/apps/${hr}/plugins?p=t_tiny`);
    assert.match(page.body, /Changed \(Dynamic action plug-in\)/);
    const dl = await dev.get(`/builder/apps/${hr}/plugins/download?name=t_tiny`);
    assert.match(String(dl.headers['content-disposition']), /t_tiny\.plugin\.json/);
    assert.deepEqual(JSON.parse(dl.body).files, tiny().files);
    assert.equal((await dev.get(`/builder/apps/${hr}/plugins/download?name=nope`)).statusCode, 404);

    await dev.get(`/builder/apps/${hr}/plugins?p=t_tiny`);
    await dev.submit(`/builder/apps/${hr}/plugins/delete`, { name: 't_tiny' });
    assert.equal((await owner.query(`select 1 from meta.plugin where app_id = $1 and name = 't_tiny'`, [hr])).rowCount, 0);
    assert.equal((await owner.query(`select 1 from meta.static_file where app_id = $1 and name = 't-tiny.js'`, [hr])).rowCount, 1, 'its files stay');
  });

  test('install SQL runs only on request, as the application\'s role, in one transaction', async () => {
    const made = async () => (await owner.one(`select count(*)::int as n from pgapex_plugins.event_log where event = 't_install'`)).n;
    await owner.query('select meta.import_plugin($1, $2::jsonb, true)', [hr, JSON.stringify(tiny({ name: 't_installer', install_sql: "insert into pgapex_plugins.event_log (event) values ('t_install');\nselect 1/0;" }))]);
    assert.equal(await made(), 0, 'nothing ran on import');
    const page = await dev.get(`/builder/apps/${hr}/plugins?p=t_installer`);
    assert.match(page.body, /insert into pgapex_plugins\.event_log/);
    const run = await dev.submit(`/builder/apps/${hr}/plugins/install`, { name: 't_installer' });
    assert.match(run.body, /division by zero/);
    assert.equal(await made(), 0, 'rolled back');
    // as hr_app: it may not create a schema of its own
    await owner.query(`update meta.plugin set install_sql = 'create schema t_plugin_schema' where app_id = $1 and name = 't_installer'`, [hr]);
    await dev.get(`/builder/apps/${hr}/plugins?p=t_installer`);
    assert.match((await dev.submit(`/builder/apps/${hr}/plugins/install`, { name: 't_installer' })).body, /permission denied/);
  });

  test('regions, items and dynamic actions hand the plug-in its attributes; the page loads its files', async () => {
    const king = new Browser(app);
    await king.login('king');
    const body = (await king.get('/a/hr/40')).body;
    assert.match(body, /<div class="plugin-region" data-plugin="show_more" data-plugin-attrs="\{&quot;VISIBLE&quot;:&quot;4&quot;,&quot;BUTTON&quot;:&quot;Show everyone&quot;\}">/);
    assert.ok((body.match(/class="show-more-item"/g) ?? []).length >= 10, 'the template renders each row');
    assert.match(body, /data-item="P40_NOTE"[^>]* data-plugin="char_counter" data-plugin-attrs="\{&quot;MAX&quot;:&quot;140&quot;\}"/);
    assert.match(body, /<input type="text" id="P40_NOTE" name="P40_NOTE"/, 'a text field without JavaScript');
    const da = meta(body).das.find((d: { action: string }) => d.action === 'plugin');
    assert.deepEqual([da.plugin, da.attributes], ['copy_value', { MESSAGE: 'Note copied.' }]);
    for (const f of ['char-counter.js', 'char-counter.css', 'copy-value.js', 'show-more.js']) assert.match(body, new RegExp(`/a/hr/static/${f.replace('.', '\\.')}\\?v=\\d+`), f);
    assert.doesNotMatch((await king.get('/a/hr/1')).body, /show-more\.js/, 'other pages do not load the plug-ins\' files');
    // a missing plug-in: a message, not an error page
    const rid = (await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 40 and r.type = 'plugin'`, [hr]));
    await owner.query(`insert into meta.region (page_id, seq, title, type, config) values ($1, 99, 't-plugin gone', 'plugin', '{"plugin": "nope"}')`, [rid.page_id]);
    const gone = await king.get('/a/hr/40');
    assert.equal(gone.statusCode, 200);
    assert.match(gone.body, /The plug-in &quot;nope&quot; does not exist|The plug-in "nope" does not exist/);
    // an attribute value with &ITEM. and markup is data, escaped in the attribute
    await owner.query(`update meta.region set config = jsonb_set(config, '{attributes,BUTTON}', '"<b>&APP_USER.</b>"') where id = $1`, [rid.id]);
    try {
      const b2 = (await king.get('/a/hr/40')).body;
      assert.match(b2, /&quot;BUTTON&quot;:&quot;&lt;b&gt;KING&lt;\/b&gt;&quot;/i);
    } finally {
      await owner.query(`update meta.region set config = jsonb_set(config, '{attributes,BUTTON}', '"Show everyone"') where id = $1`, [rid.id]);
    }
  });

  test('a process plug-in runs its function as the application\'s role with the attribute values', async () => {
    const king = new Browser(app);
    await king.login('king');
    await king.get('/a/hr/40');
    const before = (await owner.one(`select count(*)::int as n from pgapex_plugins.event_log`)).n;
    const res = await king.post('/a/hr/40', { __csrf: king.lastCsrf, P40_NOTE: 'plug-in test note', __request: 'LOG' });
    assert.equal(res.statusCode, 303);
    assert.match((await king.get('/a/hr/40')).body, /Note logged\./);
    const last = await owner.one(`select app_user, event, detail from pgapex_plugins.event_log order by id desc limit 1`);
    assert.deepEqual(last, { app_user: 'king', event: 'hr_note', detail: 'plug-in test note' });
    assert.equal((await owner.one(`select count(*)::int as n from pgapex_plugins.event_log`)).n, before + 1);
  });

  test('plug-ins travel with the export; the directory layout keeps install SQL in its own file', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const log = doc.plugins.find((p: { name: string }) => p.name === 'log_event');
    assert.equal(log.sql_function, 'pgapex_plugins.log_event');
    const da = doc.pages.find((p: { page_no: number }) => p.page_no === 40).dynamic_actions[0];
    assert.deepEqual(da.config, { attributes: { MESSAGE: 'Note copied.' } });
    const files = docToFiles(doc);
    assert.ok(files.has('shared/plugins/log_event.json'));
    assert.match(files.get('shared/plugins/log_event.install_sql.sql')!.toString(), /create table if not exists pgapex_plugins\.event_log/);
    const back = filesToDoc(files);
    assert.deepEqual(back.plugins.find((p: { name: string }) => p.name === 'log_event'), log);
    const id = (await owner.one(`select meta.import_app($1::jsonb, $2) as id`, [JSON.stringify(back), IMP])).id;
    assert.deepEqual((await owner.query(`select name from meta.plugin where app_id = $1 and name not like 't\\_%' order by name`, [id])).rows.map((r) => r.name),
      ['char_counter', 'copy_value', 'log_event', 'show_more']);
    // an export from before 069
    const old = { ...doc };
    delete old.plugins;
    await owner.query(`delete from meta.app where alias = $1`, [IMP]);
    const id2 = (await owner.one(`select meta.import_app($1::jsonb, $2) as id`, [JSON.stringify(old), IMP])).id;
    assert.equal((await owner.one('select count(*)::int as n from meta.plugin where app_id = $1', [id2])).n, 0);
  });

  test('pgapex plugin build and install', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pgapex-plugin-'));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'bin/pgapex.js'), ...args], { cwd: tmp, encoding: 'utf8' });
      let r = run('plugin', 'build', join(root, 'examples/plugins/show-more'));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'show_more.plugin.json'), 'utf8')), example('show-more'));
      r = run('plugin', 'install', join(root, 'examples/plugins/copy-value.plugin.json'), '--app', 'hr');
      assert.equal(r.status, 3, 'exists: refused without --replace');
      assert.match(r.stderr, /exists/);
      r = run('plugin', 'install', join(root, 'examples/plugins/copy-value'), '--app', 'hr', '--replace');
      assert.equal(r.status, 0, r.stderr);
      r = run('plugin', 'install', join(root, 'examples/plugins/copy-value'));
      assert.equal(r.status, 2, 'install needs --app');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
