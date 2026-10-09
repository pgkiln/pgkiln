// Static application files and "Execute JavaScript" dynamic actions (068): the
// builder page, the public route (types, caching, refused names), the tags a
// page gets, the action's function name, export/import and the directory layout.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { parseIncludes } from '../src/builder/static-files.ts';
import { staticType } from '../src/runtime/static-files.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hr: number;
let dev: Browser;
let includes: string[] = [];
const IMP = 'hr-static-imp';
const meta = (body: string) => JSON.parse(/<script type="application\/json" id="pgkiln-meta">([\s\S]*?)<\/script>/.exec(body)![1]);

async function cleanup() {
  await owner.query(`delete from meta.app where alias = $1`, [IMP]);
  await owner.query(`delete from meta.static_file where app_id = $1 and name like 't-%'`, [hr]);
  await owner.query(`update meta.app set static_includes = array(select n from unnest(static_includes) n where n not like 't-%') where id = $1`, [hr]);
  await owner.query(`update meta.page set static_includes = array(select n from unnest(static_includes) n where n not like 't-%') where app_id = $1`, [hr]);
  await owner.query(`delete from meta.dynamic_action where name like 't-static%'`);
}

before(async () => {
  app = await buildApp({ logger: false });
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  includes = (await owner.one('select static_includes from meta.app where id = $1', [hr])).static_includes;
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
});
after(async () => {
  await cleanup();
  await owner.query('update meta.app set static_includes = $2 where id = $1', [hr, includes]);
  await app.close();
  await closePools();
});

describe('static application files', () => {
  test('names and types: scripts, styles, images and fonts; never HTML or paths', () => {
    assert.equal(staticType('app.js'), 'text/javascript');
    assert.equal(staticType('Theme.CSS'), 'text/css');
    assert.equal(staticType('logo.svg'), 'image/svg+xml');
    assert.equal(staticType('font.woff2'), 'font/woff2');
    for (const bad of ['index.html', 'page.htm', 'x.xhtml', '../app.js', 'a/b.js', '.hidden.js', 'noext', 'run.exe', 'a..js', 'x.php'])
      assert.equal(staticType(bad), null, bad);
    assert.deepEqual(parseIncludes('a.js, b.css,a.js  logo.png index.html c.mjs'), ['a.js', 'b.css', 'c.mjs']);
  });

  test('the builder uploads, writes, renames and deletes files', async () => {
    let page = await dev.get(`/builder/apps/${hr}/static-files`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Static application files/);
    const res = await dev.upload(`/builder/apps/${hr}/static-files/upload`, {}, {
      file: [
        { name: 't-lib.js', type: 'text/javascript', data: Buffer.from('window.tLib = 1;\n') },
        { name: 't-page.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') },
        { name: 't-pic.png', type: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') },
      ],
    });
    assert.equal(res.statusCode, 303);
    const names = (await owner.query(`select name, mime from meta.static_file where app_id = $1 and name like 't-%' order by name`, [hr])).rows;
    assert.deepEqual(names, [{ name: 't-lib.js', mime: 'text/javascript' }, { name: 't-pic.png', mime: 'image/png' }], 'the HTML file is refused');
    page = await dev.get(`/builder/apps/${hr}/static-files`);
    assert.match(page.body, /t-page\.html: not an allowed name or type/);

    await dev.get(`/builder/apps/${hr}/static-files?new=1`);
    await dev.submit(`/builder/apps/${hr}/static-files/save`, { name: 't-app.js', content: "pgkiln.actions.register('tHello', () => {});\r\n" });
    assert.equal((await owner.one(`select convert_from(content, 'utf8') as c from meta.static_file where app_id = $1 and name = 't-app.js'`, [hr])).c,
      "pgkiln.actions.register('tHello', () => {});\n");
    page = await dev.get(`/builder/apps/${hr}/static-files?edit=t-app.js`);
    assert.match(page.body, /pgkiln\.actions\.register\(&#39;tHello&#39;|pgkiln\.actions\.register\('tHello'/);
    // rename: the lists that load it follow
    await owner.query(`update meta.app set static_includes = static_includes || '{t-app.js}' where id = $1`, [hr]);
    await dev.submit(`/builder/apps/${hr}/static-files/save`, { original: 't-app.js', name: 't-main.js', content: 'window.tMain = 1;' });
    assert.ok((await owner.one('select static_includes from meta.app where id = $1', [hr])).static_includes.includes('t-main.js'));
    // a binary file is not edited as text; an HTML name is refused on save too
    await dev.get(`/builder/apps/${hr}/static-files?new=1`);
    await dev.submit(`/builder/apps/${hr}/static-files/save`, { name: 't-x.html', content: '<b>' });
    assert.equal((await owner.query(`select 1 from meta.static_file where app_id = $1 and name = 't-x.html'`, [hr])).rowCount, 0);
    await dev.get(`/builder/apps/${hr}/static-files`);
    await dev.submit(`/builder/apps/${hr}/static-files/delete`, { name: 't-pic.png' });
    assert.equal((await owner.query(`select 1 from meta.static_file where app_id = $1 and name = 't-pic.png'`, [hr])).rowCount, 0);
    // the database refuses what the forms refuse
    await assert.rejects(owner.query(`insert into meta.static_file (app_id, name, mime, content) values ($1, 't-evil.html', 'text/html', '')`, [hr]), /check constraint/);
    await assert.rejects(owner.query(`insert into meta.static_file (app_id, name, mime, content) values ($1, '../t.js', 'text/javascript', '')`, [hr]), /check constraint/);
  });

  test('the runtime serves files with their type, a validator and long caching for versioned links', async () => {
    const anon = new Browser(app);
    const res = await anon.get('/a/hr/static/t-lib.js');
    assert.equal(res.statusCode, 200, 'public, like APEX static files');
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.body, 'window.tLib = 1;\n');
    const again = await app.inject({ url: '/a/hr/static/t-lib.js', headers: { 'if-none-match': String(res.headers.etag) } });
    assert.equal(again.statusCode, 304);
    assert.match(String((await anon.get('/a/hr/static/t-lib.js?v=1')).headers['cache-control']), /immutable/);
    for (const url of ['/a/hr/static/nope.js', '/a/hr/static/t-page.html', '/a/nope/static/t-lib.js', '/a/hr/static/..%2Fapp.js'])
      assert.equal((await anon.get(url)).statusCode, 404, url);
    // an SVG opened on its own runs no script
    await owner.query(`insert into meta.static_file (app_id, name, mime, content) values ($1, 't-img.svg', 'image/svg+xml', convert_to('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'))`, [hr]);
    const svg = await anon.get('/a/hr/static/t-img.svg');
    assert.match(String(svg.headers['content-security-policy']), /default-src 'none'.*sandbox/);
  });

  test('pages load the application\'s files and their own, in order, without inline code', async () => {
    await owner.query(`insert into meta.static_file (app_id, name, mime, content) values ($1, 't-style.css', 'text/css', convert_to('.t{}', 'utf8'))`, [hr]);
    await dev.get(`/builder/apps/${hr}/static-files`);
    await dev.submit(`/builder/apps/${hr}/static-files/includes`, { includes: 't-lib.js, t-main.js, t-style.css, t-missing.js, index.html' });
    assert.deepEqual((await owner.one('select static_includes from meta.app where id = $1', [hr])).static_includes, ['t-lib.js', 't-main.js', 't-style.css', 't-missing.js']);
    await owner.query(`update meta.page set static_includes = '{t-lib.js,t-page.js}' where app_id = $1 and page_no = 2`, [hr]);
    await owner.query(`insert into meta.static_file (app_id, name, mime, content) values ($1, 't-page.js', 'text/javascript', convert_to('1', 'utf8'))`, [hr]);
    const king = new Browser(app);
    await king.login('king');
    const body = (await king.get('/a/hr/2')).body;
    const tags = [...body.matchAll(/<(?:script src|link rel="stylesheet" href)="(\/a\/hr\/static\/[^"?]+)\?v=\d+"/g)].map((m) => m[1]);
    assert.deepEqual(tags, ['/a/hr/static/t-lib.js', '/a/hr/static/t-main.js', '/a/hr/static/t-style.css', '/a/hr/static/t-page.js'],
      'the app\'s files in order, a missing one left out, then the page\'s (no duplicates)');
    assert.match(body, /<script src="\/a\/hr\/static\/t-lib\.js\?v=\d+" defer><\/script>/);
    const other = (await king.get('/a/hr/1')).body;
    assert.doesNotMatch(other, /t-page\.js/, 'page files only on their page');
    assert.match(other, /t-main\.js/);
  });

  test('the page designer saves the page\'s files', async () => {
    const page = await owner.one(`select * from meta.page where app_id = $1 and page_no = 2`, [hr]);
    const designer = (await dev.get(`/builder/pages/${page.id}?c=page`)).body;
    assert.match(designer, /name="static_includes" type="text" value="t-lib.js, t-page.js"/);
    await dev.submit(`/builder/pages/${page.id}`, {
      page_no: '2', name: page.name, title: page.title ?? '', mode: page.mode, parent_page: page.parent_page ? String(page.parent_page) : '',
      authz: page.authz ?? '', protection: page.protection, build_option: page.build_option ?? '', ...(page.requires_auth ? { requires_auth: 'true' } : {}),
      dialog_position: page.dialog_position, dialog_size: page.dialog_size, static_includes: 't-page.js t-style.css evil.html',
    });
    assert.deepEqual((await owner.one('select static_includes from meta.page where id = $1', [page.id])).static_includes, ['t-page.js', 't-style.css']);
  });

  test('"Execute JavaScript" sends the function\'s name only, never code', async () => {
    const pid = (await owner.one(`select id from meta.page where app_id = $1 and page_no = 2`, [hr])).id;
    await owner.query(
      `insert into meta.dynamic_action (page_id, seq, name, event, action, code) values
         ($1, 900, 't-static ok', 'load', 'execute_javascript', ' tHello '),
         ($1, 901, 't-static bad', 'load', 'execute_javascript', 'alert(1)')`, [pid]);
    const king = new Browser(app);
    await king.login('king');
    const das = meta((await king.get('/a/hr/2')).body).das.filter((d: { action: string }) => d.action === 'execute_javascript');
    assert.deepEqual(das.map((d: { fn: string | null }) => d.fn), ['tHello', null]);
    // the builder refuses code where a name belongs
    const form = await dev.get(`/builder/pages/${pid}?new=dynamic_action`);
    assert.match(form.body, /execute_javascript/);
  });

  test('files travel with the export, the directory layout writes them as themselves, and import brings them back', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const lib = doc.static_files.find((f: { name: string }) => f.name === 't-lib.js');
    assert.deepEqual(Object.keys(lib).sort(), ['content', 'mime', 'name']);
    assert.ok(doc.app.static_includes.includes('t-main.js'));
    const files = docToFiles(doc);
    assert.equal(files.get('static/t-lib.js')!.toString(), 'window.tLib = 1;\n');
    assert.ok(files.has('static/files.json'));
    assert.ok(![...files.keys()].some((k) => k.startsWith('extra/static')));
    const back = filesToDoc(files);
    assert.deepEqual(back.static_files.find((f: { name: string }) => f.name === 't-lib.js'), lib);

    const id = (await owner.one(`select meta.import_app($1::jsonb, $2) as id`, [JSON.stringify(back), IMP])).id;
    const copy = await owner.one(`select convert_from(content, 'utf8') as c, mime from meta.static_file where app_id = $1 and name = 't-lib.js'`, [id]);
    assert.deepEqual(copy, { c: 'window.tLib = 1;\n', mime: 'text/javascript' });
    assert.ok((await owner.one('select static_includes from meta.app where id = $1', [id])).static_includes.includes('t-lib.js'));
    // an export from before 068 imports with empty lists
    const old = { ...doc, app: { ...doc.app }, pages: doc.pages.map((p: Record<string, unknown>) => ({ ...p, static_includes: undefined })) };
    delete old.static_files;
    delete old.app.static_includes;
    await owner.query(`delete from meta.app where alias = $1`, [IMP]);
    const id2 = (await owner.one(`select meta.import_app($1::jsonb, $2) as id`, [JSON.stringify(old), IMP])).id;
    assert.deepEqual((await owner.one('select static_includes from meta.app where id = $1', [id2])).static_includes, []);
    assert.equal((await owner.one('select count(*)::int as n from meta.static_file where app_id = $1', [id2])).n, 0);
  });
});
