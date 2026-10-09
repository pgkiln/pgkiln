// Takes the screenshots in docs/images/ that the README shows, from the HR
// example application (npm run example:hr first).
//   npx playwright install chromium   (once)
//   npx tsx scripts/screenshots.ts
// Starts its own server on a free port with the database from .env.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type BrowserContext } from 'playwright';
import { root } from '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';

const dir = join(root, 'docs', 'images');
mkdirSync(dir, { recursive: true });

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const browser = await chromium.launch();

async function signIn(context: BrowserContext, url: string, user: string, password: string, fields: [string, string]) {
  const page = await context.newPage();
  await page.goto(`${base}${url}`);
  await page.fill(fields[0], user);
  await page.fill(fields[1], password);
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

async function shoot(context: BrowserContext, page: Awaited<ReturnType<typeof signIn>>, path: string, name: string) {
  await page.goto(`${base}${path}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600); // charts and maps draw after load
  // a development database: no "default password" warning, no applications the tests left behind
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.alert-error')) if (el.textContent?.includes('default password')) el.remove();
    for (const el of document.querySelectorAll('tr, li, a')) if (/^E2E |E2E (shared|subscriber)/.test(el.textContent?.trim() ?? '')) el.remove();
  });
  await page.screenshot({ path: join(dir, `${name}.png`) });
  console.log(`docs/images/${name}.png  ${path}`);
}

try {
  const appRow = await owner.one(`select id from meta.app where alias = 'hr'`);
  if (!appRow) throw new Error('the HR example is not installed: npm run example:hr');
  const pageId = async (no: number) => (await owner.one(`select id from meta.page where app_id = $1 and page_no = $2`, [appRow.id, no])).id;

  const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

  // the runtime, as the HR example's president
  const run = await browser.newContext({ ...desktop, colorScheme: 'light' });
  const p = await signIn(run, '/a/hr/login', 'king', 'king', ['#username', '#password']);
  await shoot(run, p, '/a/hr/1', 'app-dashboard');
  await shoot(run, p, '/a/hr/2', 'app-interactive-report');
  await shoot(run, p, '/a/hr/21', 'app-faceted-search');
  await shoot(run, p, '/a/hr/12', 'app-calendar');
  await shoot(run, p, '/a/hr/4', 'app-cards-map');

  const dark = await browser.newContext({ ...desktop, colorScheme: 'dark' });
  const d = await signIn(dark, '/a/hr/login', 'king', 'king', ['#username', '#password']);
  await shoot(dark, d, '/a/hr/15', 'app-charts-dark');

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const m = await signIn(phone, '/a/hr/login', 'king', 'king', ['#username', '#password']);
  await shoot(phone, m, '/a/hr/1', 'app-phone');

  // the builder
  const build = await browser.newContext({ ...desktop, colorScheme: 'light' });
  const b = await signIn(build, '/builder/login', 'admin', 'admin', ['#f_username', '#f_password']);
  await shoot(build, b, '/builder', 'builder-home');
  await shoot(build, b, `/builder/apps/${appRow.id}`, 'builder-app');
  await shoot(build, b, `/builder/pages/${await pageId(3)}`, 'builder-page-designer');
  await shoot(build, b, '/builder/sql/objects?o=hr.emp', 'builder-object-browser');
} finally {
  await browser.close();
  await app.close();
  await closePools();
}
