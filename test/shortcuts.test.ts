// Shortcuts (migration 103; APEX: Shared Components → Shortcuts): "NAME" in a
// static region's content, an item's help and a button's confirm message is
// replaced by the application's shortcut. HR page 22 is the fixture; the test's
// shortcuts, region and button change are undone afterwards.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { docToFiles, filesToDoc } from '../src/appfiles.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page22: number;
let regionId: number;
let button: { id: number; confirm: string | null };

const as = async (user: string) => {
  const b = new Browser(app);
  assert.equal((await b.login(user)).statusCode, 303, `login as ${user}`);
  return b;
};
const cleanUp = () => owner.query(`delete from meta.shortcut where app_id = $1 and name like 'SC\\_TEST\\_%'`, [appId]);

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  page22 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 22', [appId])).id;
  await cleanUp();
  regionId = (await owner.one(`insert into meta.region (page_id, seq, title, type, source) values ($1, 999, 'SC test', 'static', $2) returning id`,
    [page22, '<p id="sc-test">"SC_TEST_HTML" | "SC_TEST_TEXT" | "SC_TEST_FN" | "SC_TEST_NONE" | <span class="SC_TEST_CLASS">&APP_USER.</span></p>'])).id;
  button = (await owner.one(`select id, confirm from meta.button where page_id = $1 and action = 'submit' order by seq, id limit 1`, [page22]))!;
});
after(async () => {
  await owner.query('delete from meta.region where id = $1', [regionId]);
  await owner.query('update meta.button set confirm = $2 where id = $1', [button.id, button.confirm]);
  await cleanUp();
  await app.close();
  await closePools();
});

const testRegion = (body: string) => /<p id="sc-test">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '';

describe('shortcuts', () => {
  test('made in Shared Components (Other Components)', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    assert.match((await dev.get(`/builder/apps/${appId}/shared`)).body, /shared\?type=shortcut"/);
    await dev.get(`/builder/apps/${appId}/shared?new=shortcut`);
    const res = await dev.submit(`/builder/apps/${appId}/shared/shortcut`, { name: 'sc_test_html', type: 'html', value: '<b>Bold &APP_USER.</b>' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(await owner.one(`select type, value from meta.shortcut where app_id = $1 and name = 'SC_TEST_HTML'`, [appId]), { type: 'html', value: '<b>Bold &APP_USER.</b>' });
    assert.match((await dev.get(`/builder/apps/${appId}/shared?type=shortcut`)).body, /&quot;SC_TEST_HTML&quot; \(html\)/);
  });

  test('replaced in static content before &ITEM. substitutions: HTML as HTML, text escaped, a function body; other quoted words stay', async () => {
    await owner.query(`insert into meta.shortcut (app_id, name, type, value) values
                         ($1, 'SC_TEST_TEXT', 'text', '<script>alert(1)</script> & co'),
                         ($1, 'SC_TEST_FN', 'function_body', 'begin return ''Hello '' || upper(:APP_USER); end;')`, [appId]);
    const king = await as('king');
    const shown = testRegion((await king.get('/a/hr/22')).body);
    assert.match(shown, /^<b>Bold king<\/b> \| /i, 'HTML, with the item substituted');
    assert.match(shown, /\| &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co \|/, 'text is escaped');
    assert.doesNotMatch(shown, /<script>/);
    assert.match(shown, /\| Hello KING \|/, 'the function body');
    assert.match(shown, /\| "SC_TEST_NONE" \|/, 'no such shortcut: left alone');
    assert.match(shown, /class="SC_TEST_CLASS"/);
  });

  test('in a button\'s confirm message, as text', async () => {
    await owner.query('update meta.button set confirm = $2 where id = $1', [button.id, 'Sure? "SC_TEST_TEXT"']);
    const body = (await (await as('king')).get('/a/hr/22')).body;
    assert.match(body, /data-confirm="Sure\? &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co"/);
  });

  test('a failing function body shows its error once and leaves the text empty', async () => {
    await owner.query(`update meta.shortcut set value = E'begin\n  return 1/0;\nend;' where app_id = $1 and name = 'SC_TEST_FN'`, [appId]);
    const body = (await (await as('king')).get('/a/hr/22')).body;
    assert.match(testRegion(body), /\| {2}\|/);
    assert.match(body, /class="alert alert-error"/);
  });

  test('exported with the application and written as files; the runtime role cannot change them', async () => {
    const doc = (await owner.one('select meta.export_app($1) as d', ['hr'])).d;
    const ours = doc.shortcuts.filter((s: { name: string }) => s.name.startsWith('SC_TEST_'));
    assert.deepEqual(ours.map((s: { name: string }) => s.name), ['SC_TEST_FN', 'SC_TEST_HTML', 'SC_TEST_TEXT']);
    const files = docToFiles(doc, 'json');
    assert.ok(files.has('shared/shortcuts/sc_test_html.json'), [...files.keys()].filter((k) => k.includes('shortcut')).join(', '));
    assert.ok(files.has('shared/shortcuts/sc_test_fn.value.sql'), 'a function body as SQL');
    assert.deepEqual(filesToDoc(files).shortcuts, doc.shortcuts);
    await assert.rejects(runtime.query(`insert into meta.shortcut (app_id, name, value) values ($1, 'SC_TEST_X', 'x')`, [appId]), /permission denied/);
    await assert.rejects(runtime.query(`update meta.shortcut set value = 'x' where app_id = $1`, [appId]), /permission denied/);
  });
});
