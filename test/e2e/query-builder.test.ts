// SQL Workshop → Query Builder in a real browser (0.31): the chosen tables
// are boxes on a canvas, the foreign key is a line between their columns,
// a table is dragged by its handle (or moved with the arrow keys) and keeps
// its place, and dragging a column's dot onto a column of another table
// joins them. On a phone the boxes stay stacked. The CSP reports nothing.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function developer(viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return { context, page };
}

describe('query builder canvas', () => {
  test('tables as boxes: the foreign key drawn, a table dragged and kept, a join drawn from column to column', async () => {
    const { context, page } = await developer({ width: 1440, height: 900 });
    await page.goto(`${base}/builder/sql/query?schema=hr&t=emp&t=dept`);
    const canvas = page.locator('.qb-canvas');
    assert.match((await canvas.getAttribute('class')) ?? '', /qb-free/);
    assert.equal(await page.locator('.qb-lines path').count(), 1, 'the foreign key emp.deptno → dept.deptno');
    const dept = page.locator('.qb-table[data-table="dept"]');
    const before = (await dept.boundingBox())!;
    // drag the dept table by its handle
    const handle = dept.locator('.qb-move');
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 150, h.y + 90, { steps: 5 });
    await page.mouse.up();
    const after = (await dept.boundingBox())!;
    assert.ok(Math.abs(after.x - before.x - 150 + h.width / 2) <= 2 && after.y > before.y + 60, `${before.x},${before.y} → ${after.x},${after.y}`);
    assert.match((await dept.locator('input[name="p"]').inputValue()) ?? '', /^dept:\d+,\d+$/);
    // the arrow keys move it too
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    assert.ok(Math.abs((await dept.boundingBox())!.x - after.x - 16) <= 1);
    const kept = await dept.locator('input[name="p"]').inputValue();
    // join emp.ename to dept.dname: drag the dot onto the column
    const dot = page.locator('.qb-col[data-ref="t1.ename"] .qb-link');
    const d = (await dot.boundingBox())!;
    const target = (await page.locator('.qb-col[data-ref="t2.dname"]').boundingBox())!;
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 30, target.y + target.height / 2, { steps: 8 });
    await Promise.all([page.waitForNavigation(), page.mouse.up()]);
    const url = decodeURIComponent(page.url());
    assert.match(url, /[?&]j=t1\.ename=t2\.dname(&|$)/);
    assert.ok(url.includes(`p=${kept}`), 'the table stays where it was put');
    assert.match((await page.locator('pre.source').textContent()) ?? '', /join "hr"\."dept" t2 on t1\."ename" = t2\."dname"/);
    assert.equal(await page.locator('.qb-lines path.qb-custom').count(), 1);
    const moved = (await page.locator('.qb-table[data-table="dept"]').boundingBox())!;
    assert.ok(Math.abs(moved.x - (after.x + 16)) <= 2, 'placed where it was left');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('on a phone the boxes stay stacked and the page does not scroll sideways', async () => {
    const { context, page } = await developer({ width: 390, height: 844 });
    await page.goto(`${base}/builder/sql/query?schema=hr&t=emp&t=dept`);
    assert.doesNotMatch((await page.locator('.qb-canvas').getAttribute('class')) ?? '', /qb-free/);
    assert.equal(await page.locator('.qb-move:visible').count(), 0);
    assert.equal(await page.locator('.qb-lines path').count(), 1, 'the join is still drawn');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await context.close();
  });
});
