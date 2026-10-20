// The App Gallery's sample apps in a real browser (sprint 120, WS-8): every
// page of every sample app (examples/gallery/samples/) fits a phone, a tablet
// and a desktop without horizontal scrolling, violates no Content-Security-
// Policy and shows no error; the pages pass axe-core on a desktop; a few
// dynamic actions of Sample Dynamic Actions work; the gallery's four tabs fit
// a phone.
//   SCREENSHOTS=1 npm run test:e2e   saves them to test-results/gallery-*.png
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { dropSample, installSample, SAMPLES } from '../gallery-samples.ts';

// as in responsive.test.ts (not imported from there: that would run its tests too)
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  'tablet-portrait': { width: 768, height: 1024 },
  'tablet-landscape': { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
} as const;
const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const shots = process.env.SCREENSHOTS === '1';
if (shots) mkdirSync('test-results', { recursive: true });
let base = '';
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  for (const x of SAMPLES) {
    await dropSample(x);
    await installSample(x);
  }
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    for (const x of SAMPLES) await dropSample(x);
    await closePools();
  };
});
after(() => close());

async function context(viewport: { width: number; height: number }) {
  const c = await browser.newContext({ viewport });
  await c.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  return c;
}

async function signIn(c: BrowserContext, alias: string) {
  const page = await c.newPage();
  await page.goto(`${base}/a/${alias}/login`);
  await page.fill('#username', 'demo');
  await page.fill('#password', 'demo');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

async function check(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `test-results/gallery-${name}.png`, fullPage: true });
  assert.deepEqual(await page.evaluate(() => (window as any).__csp ?? []), [], `${name}: Content-Security-Policy`);
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= vw + 1) return null;
    let worst: { tag: string; cls: string; right: number } | null = null;
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > vw + 1 && (!worst || r.right > worst.right)) worst = { tag: el.tagName, cls: el.className?.toString?.() ?? '', right: Math.round(r.right) };
    }
    return { scrollWidth: document.documentElement.scrollWidth, vw, worst };
  });
  assert.equal(o, null, `${name} overflows: ${JSON.stringify(o)}`);
  // a region's error is exactly "alert alert-error" (the UX catalog's example alert has more classes)
  assert.equal(await page.locator('[class="alert alert-error"]').count(), 0, `${name}: no error`);
}

const pagesOf = async (alias: string) =>
  (await owner.query<{ page_no: number }>(`select p.page_no from meta.page p join meta.app a on a.id = p.app_id where a.alias = $1 order by 1`, [alias])).rows.map((r) => r.page_no);

describe('the sample apps of the App Gallery', () => {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    test(`every page fits ${vp} (${size.width}px), without CSP violations or errors`, async () => {
      const c = await context(size);
      try {
        for (const x of SAMPLES) {
          const page = await signIn(c, x.alias);
          for (const p of await pagesOf(x.alias)) {
            const res = await page.goto(`${base}/a/${x.alias}/${p}`);
            assert.equal(res?.status(), 200, `${x.alias} ${p}`);
            await check(page, `${vp}-${x.alias}-${p}`);
          }
        }
      } finally {
        await c.close();
      }
    });
  }

  test('axe-core finds no WCAG 2.1 AA violations on a desktop', async () => {
    const c = await context(VIEWPORTS.desktop);
    try {
      const found: string[] = [];
      for (const x of SAMPLES) {
        const page = await signIn(c, x.alias);
        for (const p of await pagesOf(x.alias)) {
          await page.goto(`${base}/a/${x.alias}/${p}`);
          await page.evaluate(AXE);
          const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
          for (const v of r.violations as { id: string; nodes: { html: string }[] }[]) found.push(`${x.alias} ${p} ${v.id}: ${v.nodes[0]?.html.slice(0, 160)}`);
        }
      }
      assert.deepEqual(found, []);
    } finally {
      await c.close();
    }
  });

  test('Sample Dynamic Actions: show on a condition, a value from the server, a confirmation', async () => {
    const c = await context(VIEWPORTS.desktop);
    try {
      const page = await signIn(c, 'sample-dynamic-actions');
      await page.goto(`${base}/a/sample-dynamic-actions/2`);
      const company = page.locator('[data-item="P2_COMPANY"]');
      assert.equal(await company.isVisible(), false, 'hidden for a person');
      await page.check('input[name="P2_TYPE"][value="COMPANY"]');
      await company.waitFor({ state: 'visible' });
      await page.goto(`${base}/a/sample-dynamic-actions/3`);
      await page.selectOption('#P3_PRODUCT', { label: 'Stapler' });
      await page.waitForFunction(() => (document.querySelector('#P3_PRICE') as HTMLInputElement)?.value === '12.50');
      assert.equal(await page.inputValue('#P3_TOTAL'), '12.50');
      await page.goto(`${base}/a/sample-dynamic-actions/4`);
      page.once('dialog', (d) => d.accept());
      await page.click('button[data-button="CONFIRM"]');
      await page.getByText('You said yes: this is a success message.').waitFor();
      await check(page, 'da-confirmed');
    } finally {
      await c.close();
    }
  });

  test('the gallery: four tabs fit a phone, and the search filters as you type', async () => {
    const c = await context(VIEWPORTS.phone);
    try {
      const page = await c.newPage();
      await page.goto(`${base}/builder/login`);
      await page.fill('#f_username', 'admin');
      await page.fill('#f_password', 'admin');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      for (const tab of ['samples', 'starters', 'utilities', 'custom']) {
        await page.goto(`${base}/builder/gallery?tab=${tab}`);
        await check(page, `builder-${tab}`);
      }
      await page.goto(`${base}/builder/gallery?tab=samples`);
      await page.fill('#gal-q', 'drag and drop');
      assert.equal(await page.locator('.gal-card:visible').count(), 1, 'Sample Calendar only');
      assert.match(await page.locator('.gal-card:visible h2').innerText(), /Sample Calendar/);
    } finally {
      await c.close();
    }
  });
});
