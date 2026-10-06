// Accessibility audit with axe-core (WCAG 2.1 A and AA rules it can check
// automatically): every page of the HR example (light and dark, Standard and
// Iris), its sign-in and account pages, a dialog and a drawer, and the
// builder's main pages. No violations allowed; the message names each rule,
// the pages and an example element.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

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
after(async () => close());

type Found = Map<string, { help: string; pages: string[]; example: string }>;

/** Run axe on the page (or a frame's document) and collect the violations under `name`. */
async function audit(page: Page, name: string, found: Found) {
  await page.evaluate(AXE);
  const r = await page.evaluate((tags) => (window as any).axe.run(document, { runOnly: { type: 'tag', values: tags } }), TAGS);
  for (const v of r.violations as { id: string; help: string; nodes: { html: string }[] }[]) {
    const e = found.get(v.id) ?? { help: v.help, pages: [], example: v.nodes[0]?.html.slice(0, 200) ?? '' };
    e.pages.push(name);
    found.set(v.id, e);
  }
}

const report = (found: Found) =>
  [...found].map(([id, e]) => `${id}: ${e.help} (on ${e.pages.slice(0, 8).join(', ')}${e.pages.length > 8 ? ', …' : ''}) e.g. ${e.example}`).join('\n');

async function signIn(page: Page, url: string, user: string, password: string, userField = '#username', passField = '#password') {
  await page.goto(`${base}${url}`);
  await page.fill(userField, user);
  await page.fill(passField, password);
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
}

describe('accessibility (axe-core)', () => {
  for (const scheme of ['light', 'dark'] as const)
    test(`application pages, ${scheme}`, async () => {
      const found: Found = new Map();
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme })).newPage();
      try {
        await page.goto(`${base}/a/hr/login`);
        await audit(page, 'login', found);
        await signIn(page, '/a/hr/login', 'king', 'king');
        const pages = (await owner.query(`select p.page_no from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.mode = 'normal' order by 1`)).rows;
        for (const { page_no: p } of pages) {
          await page.goto(`${base}/a/hr/${p}`);
          await audit(page, `page ${p}`, found);
        }
        await page.goto(`${base}/a/hr/account`);
        await audit(page, 'account', found);
        // a modal page on its own, and the drawer as it opens
        await page.goto(`${base}/a/hr/7`);
        await audit(page, 'page 7', found);
      } finally {
        await page.context().close();
      }
      assert.equal(found.size, 0, report(found));
    });

  test('application pages with the Iris base style (light and dark)', async () => {
    const found: Found = new Map();
    await owner.query(`update meta.app set theme = theme || '{"base": "iris"}' where alias = 'hr'`);
    try {
      for (const scheme of ['light', 'dark'] as const) {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme })).newPage();
        try {
          await signIn(page, '/a/hr/login', 'king', 'king');
          for (const p of [1, 2, 3, 8, 21, 39]) {
            await page.goto(`${base}/a/hr/${p}`);
            await audit(page, `iris ${scheme} page ${p}`, found);
          }
        } finally {
          await page.context().close();
        }
      }
    } finally {
      await owner.query(`update meta.app set theme = theme - 'base' where alias = 'hr'`);
    }
    assert.equal(found.size, 0, report(found));
  });

  test('builder pages', async () => {
    const found: Found = new Map();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    try {
      await page.goto(`${base}/builder/login`);
      await audit(page, 'builder login', found);
      await signIn(page, '/builder/login', 'admin', 'admin', '#f_username', '#f_password');
      const app = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
      const pid = (await owner.one('select id from meta.page where app_id = $1 and page_no = 3', [app])).id;
      const urls = [
        '/builder', '/builder/create', '/builder/import', '/builder/dashboard', '/builder/utilities', '/builder/workspaces', '/builder/instance',
        `/builder/apps/${app}`, `/builder/apps/${app}/shared`, `/builder/apps/${app}/settings`, `/builder/apps/${app}/theme`,
        `/builder/apps/${app}/search?q=emp`, `/builder/apps/${app}/advisor`, `/builder/apps/${app}/static-files`, `/builder/apps/${app}/static-files?edit=hr.js`, `/builder/pages/${pid}`, `/builder/pages/${pid}?c=page`,
        '/builder/sql', '/builder/sql/scripts', '/builder/sql/objects', '/builder/users', '/builder/developers', '/builder/ai',
      ];
      for (const u of urls) {
        await page.goto(`${base}${u}`);
        await audit(page, u, found);
      }
    } finally {
      await page.context().close();
    }
    assert.equal(found.size, 0, report(found));
  });
});
