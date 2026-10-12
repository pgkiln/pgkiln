// Region templates in a real browser (sprint 57, HR page 44): hero, title
// bar, buttons container, inline dialog and drawer, the carousel style of
// the display selector and the wizard progress list; no CSP or axe-core
// violations; without JavaScript a link to #R<id> shows an inline region.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
let base = '';
let browser: Browser;
let close: () => Promise<void>;
const R: Record<string, number> = {};

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  for (const r of (await owner.query(`select r.id, r.title from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                       where a.alias = 'hr' and p.page_no = 44`)).rows) R[r.title] = r.id;
  close = async () => {
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function open(javaScriptEnabled = true) {
  const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/44`);
  return page;
}
const axe = async (page: Page) => {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.map((v: { id: string; nodes: { html: string }[] }) => `${v.id}: ${v.nodes[0]?.html.slice(0, 160)}`);
};

describe('region templates (HR page 44)', () => {
  test('hero, title bar, wizard progress; an inline dialog and drawer open and close', async () => {
    const page = await open();
    assert.equal(await page.locator(`#R${R['Welcome to HR']}.region-hero h2`).innerText(), 'Welcome to HR');
    assert.equal(await page.locator(`#R${R['Onboarding steps']} .wizard-step[aria-current="step"]`).innerText().then((t) => t.replace(/\s+/g, ' ').trim()), '1 Personal details');
    const dialog = page.locator(`dialog#R${R['Leave policy']}`);
    assert.equal(await dialog.isVisible(), false);
    assert.deepEqual(await axe(page), []);
    if (process.env.TPL_SHOT) await page.screenshot({ path: process.env.TPL_SHOT, fullPage: true });
    await page.click('button:has-text("Leave policy")');
    assert.equal(await dialog.isVisible(), true);
    assert.deepEqual(await axe(page), [], 'with the dialog open');
    await dialog.locator('[data-region-close]').click();
    assert.equal(await dialog.isVisible(), false);
    const drawer = page.locator(`dialog#R${R.Help}`);
    await page.click('button:has-text("Help")');
    assert.equal(await drawer.isVisible(), true);
    const box = (await drawer.boundingBox())!;
    assert.ok(box.x + box.width >= 1270, 'docked to the right edge');
    await page.keyboard.press('Escape');
    assert.equal(await drawer.isVisible(), false);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await page.context().close();
  });

  test('the carousel: one region at a time, Next and the dots', async () => {
    const page = await open();
    const shown = () => page.evaluate((ids: number[]) => ids.filter((id) => !document.getElementById(`R${id}`)!.classList.contains('rds-hidden')), [R['New colleagues'], R.Anniversaries, R['Open positions']]);
    assert.deepEqual(await shown(), [R['New colleagues']]);
    await page.click('.rds-carousel .rds-next');
    assert.deepEqual(await shown(), [R.Anniversaries]);
    await page.click('.rds-carousel .rds-prev');
    await page.click('.rds-carousel .rds-prev');
    assert.deepEqual(await shown(), [R['Open positions']], 'Previous wraps around');
    assert.equal(await page.locator('.rds-carousel .rds-tab[aria-selected="true"]').count(), 1);
    await page.context().close();
  });

  test('without JavaScript: every region shows except the inline ones, and #R<id> opens one', async () => {
    const page = await open(false);
    assert.equal(await page.locator(`#R${R.Anniversaries}`).isVisible(), true);
    assert.equal(await page.locator(`dialog#R${R['Leave policy']}`).isVisible(), false);
    await page.goto(`${base}/a/hr/44#R${R['Leave policy']}`);
    assert.equal(await page.locator(`dialog#R${R['Leave policy']}`).isVisible(), true);
    await page.context().close();
  });
});
