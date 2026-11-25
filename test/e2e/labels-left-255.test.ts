// Labels beside the fields (sprint 255, HR page 76): with the region option to-labels-left the label sits to the left
// of its field, at 1280 px and on a phone; no axe violations in the region.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
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

describe('labels beside the fields (HR page 76)', () => {
  for (const width of [1280, 390])
    test(`the label is left of its select at ${width} px`, async () => {
      const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
      await page.goto(`${base}/a/hr/login`);
      await page.fill('#username', 'king');
      await page.fill('#password', 'king');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      await page.goto(`${base}/a/hr/76`);
      const label = (await page.locator('label[for="P76_EMPNO"]').boundingBox())!;
      const field = (await page.locator('#P76_EMPNO').boundingBox())!;
      assert.ok(label.x + label.width <= field.x, `label ends before the field (${label.x + label.width} / ${field.x})`);
      assert.ok(Math.abs(label.y + label.height / 2 - (field.y + field.height / 2)) < field.height, 'on the same line');
      await page.evaluate(AXE);
      const r = await page.evaluate(() => (window as any).axe.run('[data-static-id="find-employee"]', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
      assert.deepEqual(r.violations.map((v: { id: string }) => v.id), []);
      await page.context().close();
    });
});
