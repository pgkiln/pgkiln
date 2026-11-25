// A region header with long button labels on a phone (sprint 256): the buttons wrap under the title and a long label
// breaks over lines, so the page is never wider than the screen.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const LABEL = 'Download het lege werkplekinspectieformulier voor de bouwplaats';
before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  // two buttons in the header of HR page 2's report (position: create, so in the header)
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action, target_page, slot)
    select p.id, r.id, b.seq, b.name, b.label, 'redirect', 2, 'create'
      from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.type = 'report',
           (values (991, 'S256_A', 'Nieuwe werkplekinspectie'), (992, 'S256_B', $1)) as b (seq, name, label)
     where a.alias = 'hr' and p.page_no = 2`, [LABEL]);
  close = async () => {
    await owner.query(`delete from meta.button where name in ('S256_A', 'S256_B')`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

describe('long header buttons on a phone (HR page 2)', () => {
  test('the page stays as wide as the screen at 390 px', async () => {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 900 } })).newPage();
    await page.goto(`${base}/a/hr/login`);
    await page.fill('#username', 'king');
    await page.fill('#password', 'king');
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
    await page.goto(`${base}/a/hr/2`);
    const button = page.locator('.region-header .btn', { hasText: LABEL });
    assert.equal(await button.count(), 1, 'the long button is in the header');
    const box = (await button.boundingBox())!;
    assert.ok(box.x + box.width <= 390, `the button ends inside the screen (${box.x + box.width})`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal scroll');
    await page.context().close();
  });
});
