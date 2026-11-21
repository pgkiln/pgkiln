// (sprint 247, MG-20) The picture gallery of a multiple file item in a real browser: Sample Files' folder form shows
// the folder's pictures (from a table it shares with people) as thumbnails that fit a phone and a desktop, pass axe-core,
// open the full-size picture, and remove a picture with its box on save.
//   SCREENSHOTS=1 npx tsx --test test/e2e/file-gallery-247.test.ts   saves test-results/file-gallery-*.png
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { urlChecksum } from '../../src/security.ts';
import { dropSample, installSample, SAMPLES } from '../gallery-samples.ts';

const SAMPLE = SAMPLES.find((x) => x.key === 'sample-files')!;
const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const shots = process.env.SCREENSHOTS === '1';
if (shots) mkdirSync('test-results', { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let base = '';
let appId: number;
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  await dropSample(SAMPLE);
  await installSample(SAMPLE);
  // a second picture and a non-image file for folder 1, and a long unbroken file name
  await owner.query(`insert into sample_files.picture (related_type, related_id, filename, mime_type, content) values
    ('folder', '1', 'a-very-long-picture-file-name-without-any-spaces-at-all-from-the-camera.png', 'image/png', $1),
    ('folder', '1', 'site-notes.txt', 'text/plain', 'notes')`, [PNG]);
  appId = (await owner.one(`select id from meta.app where alias = 'sample-files'`)).id;
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await dropSample(SAMPLE);
    await closePools();
  };
});
after(() => close());

async function folderForm(width: number, height: number) {
  const c = await browser.newContext({ viewport: { width, height } });
  await c.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`));
  });
  const page = await c.newPage();
  await page.goto(`${base}/a/sample-files/login`);
  await page.fill('#username', 'demo');
  await page.fill('#password', 'demo');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  const items = { P5_ID: '1' };
  await page.goto(`${base}/a/sample-files/5?${new URLSearchParams({ ...items, cs: urlChecksum(appId, 5, 'demo', items) })}`);
  return { c, page };
}

async function fits(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `test-results/file-gallery-${name}.png`, fullPage: true });
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${name}: Content-Security-Policy`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${name}: no horizontal scroll (${overflow}px)`);
}

describe('the picture gallery of a multiple file item', () => {
  for (const [name, w, h] of [['phone', 390, 844], ['desktop', 1440, 900]] as const) {
    test(`thumbnails fit the ${name} (${w}px); other files are links`, async () => {
      const { c, page } = await folderForm(w, h);
      try {
        const gallery = page.locator('.file-gallery');
        await gallery.waitFor();
        assert.equal(await page.locator('.file-gallery-thumb').count(), 2);
        assert.equal(await page.locator('.file-gallery-other').count(), 1);
        // the pictures load (served inline through the signed link) and are square tiles inside the item
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.file-gallery-thumb')].every((i) => i.complete && i.naturalWidth > 0));
        const boxes = await page.locator('.file-gallery-link').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ w: Math.round(r.width), h: Math.round(r.height), right: r.right })));
        const vw = await page.evaluate(() => document.documentElement.clientWidth);
        for (const b of boxes) {
          assert.ok(b.w > 60 && Math.abs(b.w - b.h) <= 1, `square thumbnail: ${JSON.stringify(b)}`);
          assert.ok(b.right <= vw, 'inside the page');
        }
        await fits(page, name);
      } finally {
        await c.close();
      }
    });
  }

  test('axe-core finds no WCAG 2.1 AA violations', async () => {
    const { c, page } = await folderForm(1440, 900);
    try {
      await page.evaluate(AXE);
      const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
      assert.deepEqual((r.violations as { id: string; nodes: { html: string }[] }[]).map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 160)}`), []);
    } finally {
      await c.close();
    }
  });

  test('a thumbnail opens the full-size picture; a ticked picture is removed on save', async () => {
    const { c, page } = await folderForm(390, 844);
    try {
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.file-gallery-link').first().click()]);
      await popup.waitForLoadState();
      assert.match(popup.url(), /\/file\/P5_PICTURES\?.*inline=1/);
      await popup.close();
      const tile = page.locator('.file-gallery-item', { hasText: 'site-notes.txt' });
      await tile.getByRole('checkbox').check();
      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Apply Changes' }).click()]);
      const left = (await owner.query(`select filename from sample_files.picture where related_type = 'folder' and related_id = '1' order by id`)).rows.map((r) => r.filename);
      assert.equal(left.length, 2);
      assert.ok(!left.includes('site-notes.txt'));
      assert.equal((await owner.one(`select count(*)::int as n from sample_files.picture where related_type = 'person'`)).n, 1);
    } finally {
      await c.close();
    }
  });
});
