// Drawers and dialog sizes (065): the page's dialog position and size in the
// Page Designer, what the runtime tells the browser, exports and imports.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let hr: number;
const meta = (body: string) => JSON.parse(/<script type="application\/json" id="pgapex-meta">([\s\S]*?)<\/script>/.exec(body)![1]);

before(async () => {
  app = await buildApp({ logger: false });
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`delete from meta.app where alias = 'hr-drawer-imp'`);
});
after(async () => {
  await owner.query(`delete from meta.app where alias = 'hr-drawer-imp'`);
  await owner.query(`update meta.page set dialog_position = 'right', dialog_size = 'medium' where app_id = $1 and page_no = 7`, [hr]);
  await owner.query(`update meta.page set dialog_position = 'center', dialog_size = 'medium' where app_id = $1 and page_no in (3, 5)`, [hr]);
  await app.close();
  await closePools();
});

describe('drawers and dialog sizes', () => {
  test('pages tell the browser how their modal targets open (only the ones that are not a medium centred dialog)', async () => {
    const king = new Browser(app);
    await king.login('king');
    const dialogs = meta((await king.get('/a/hr/6')).body).dialogs;
    assert.deepEqual(dialogs['7'], ['right', 'medium'], 'the HR example\'s drawer');
    assert.equal(dialogs['3'], undefined, 'a medium centred dialog is the default');
    assert.equal(dialogs['1'], undefined, 'normal pages are not listed');
    await owner.query(`update meta.page set dialog_size = 'large' where app_id = $1 and page_no = 3`, [hr]);
    assert.deepEqual(meta((await king.get('/a/hr/6')).body).dialogs['3'], ['center', 'large']);
  });

  test('the Page Designer saves position and size; other values become the defaults', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = await owner.one(`select * from meta.page where app_id = $1 and page_no = 5`, [hr]);
    const designer = (await dev.get(`/builder/pages/${page.id}?c=page`)).body;
    assert.match(designer, /name="dialog_position"/);
    assert.match(designer, /name="dialog_size"/);
    const form = {
      page_no: '5', name: page.name, title: page.title ?? '', mode: 'modal', parent_page: page.parent_page ? String(page.parent_page) : '',
      authz: page.authz ?? '', protection: page.protection, build_option: page.build_option ?? '', ...(page.requires_auth ? { requires_auth: 'true' } : {}),
    };
    await dev.submit(`/builder/pages/${page.id}`, { ...form, dialog_position: 'bottom', dialog_size: 'small' });
    let p = await owner.one('select dialog_position, dialog_size from meta.page where id = $1', [page.id]);
    assert.deepEqual(p, { dialog_position: 'bottom', dialog_size: 'small' });
    await dev.get(`/builder/pages/${page.id}?c=page`);
    await dev.submit(`/builder/pages/${page.id}`, { ...form, dialog_position: '"><script>', dialog_size: 'huge' });
    p = await owner.one('select dialog_position, dialog_size from meta.page where id = $1', [page.id]);
    assert.deepEqual(p, { dialog_position: 'center', dialog_size: 'medium' });
    await assert.rejects(owner.query(`update meta.page set dialog_position = 'middle' where id = $1`, [page.id]), /check constraint/);
  });

  test('position and size travel with the export; an export from before 065 imports with the defaults', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const seven = doc.pages.find((x: { page_no: number }) => x.page_no === 7);
    assert.equal(seven.dialog_position, 'right');
    for (const x of doc.pages) {
      delete x.dialog_position;
      delete x.dialog_size;
    }
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr-drawer-imp') as id`, [JSON.stringify(doc)])).id;
    assert.deepEqual(
      (await owner.query('select distinct dialog_position, dialog_size from meta.page where app_id = $1', [id])).rows,
      [{ dialog_position: 'center', dialog_size: 'medium' }],
    );
  });
});
