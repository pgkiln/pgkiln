// Sprint 117 (WS-10, APEX 26.2): the Pillar Light / Pillar Dark navigation appearances in a
// browser: WCAG contrast (axe) in light and dark mode with the Standard and Iris base styles,
// the subtle colour utilities, the current page told apart from its parent menu entry, Arabic
// (right to left) on a desktop and a phone, phones at 390 px and the Theme Roller's preview.
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
let saved: { theme: unknown; languages: string[] };

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  saved = (await owner.one(`select theme, languages from meta.app where alias = 'hr'`))!;
  close = async () => {
    await owner.query(`update meta.app set theme = $1, languages = $2 where alias = 'hr'`, [JSON.stringify(saved.theme), saved.languages]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

const setTheme = (extra: object) => owner.query(`update meta.app set theme = $1 where alias = 'hr'`, [JSON.stringify({ ...(saved.theme as object), ...extra })]);

async function signedIn(width: number, scheme: 'light' | 'dark' = 'light') {
  const page = await (await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })).newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

const SUBTLE = [...Array.from({ length: 15 }, (_, i) => String(i + 1)), 'success', 'danger', 'warning', 'info', 'neutral'];

/** axe on the page, with a sample of every subtle colour utility added to <main> */
async function audit(page: Page, name: string, found: Map<string, string>) {
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], .region-lazy'), null, { timeout: 10000 }).catch(() => {});
  await page.evaluate((list) => {
    const box = document.createElement('p');
    for (const c of list) {
      const s = document.createElement('span');
      s.className = `u-color-${c}-subtle`;
      s.textContent = `Subtle ${c} `;
      box.append(s);
    }
    document.getElementById('main')?.prepend(box);
  }, SUBTLE);
  await page.evaluate(AXE);
  const r = await page.evaluate((tags) => (window as any).axe.run(document, { runOnly: { type: 'tag', values: tags } }), TAGS);
  for (const v of r.violations as { id: string; nodes: { html: string }[] }[]) found.set(`${v.id} (${name})`, v.nodes[0]?.html.slice(0, 200) ?? '');
}

describe('Pillar navigation appearances (sprint 117)', () => {
  test('WCAG contrast: Pillar Light and Pillar Dark, light and dark mode, Standard and Iris, top navigation', async () => {
    const found = new Map<string, string>();
    try {
      for (const [appearance, extra] of [['pillar_light', {}], ['pillar_dark', {}], ['pillar_dark', { base: 'iris', strip: '#e8590c' }], ['pillar_light', { base: 'iris', nav: 'top' }]] as const) {
        await setTheme({ appearance, ...extra });
        for (const scheme of ['light', 'dark'] as const) {
          const page = await signedIn(1280, scheme);
          try {
            for (const p of [1, 2, 8]) {
              await page.goto(`${base}/a/hr/${p}`);
              assert.match((await page.getAttribute('body', 'class')) ?? '', new RegExp(`nav-${appearance.replace('_', '-')}`));
              await audit(page, `${appearance} ${JSON.stringify(extra)} ${scheme} page ${p}`, found);
            }
          } finally {
            await page.context().close();
          }
        }
      }
    } finally {
      await setTheme({});
    }
    assert.equal(found.size, 0, [...found].map(([k, v]) => `${k}: ${v}`).join('\n'));
  });

  test('the subtle colour utilities pass in the base styles too', async () => {
    const found = new Map<string, string>();
    for (const scheme of ['light', 'dark'] as const) {
      const page = await signedIn(1280, scheme);
      try {
        await page.goto(`${base}/a/hr/1`);
        await audit(page, `standard ${scheme}`, found);
      } finally {
        await page.context().close();
      }
    }
    assert.equal(found.size, 0, [...found].map(([k, v]) => `${k}: ${v}`).join('\n'));
  });

  test('HR: the current page and its parent menu entry look different in every appearance', async () => {
    try {
      for (const appearance of [undefined, 'pillar_light', 'pillar_dark']) {
        await setTheme(appearance ? { appearance } : {});
        const page = await signedIn(1280);
        try {
          await page.goto(`${base}/a/hr/2`);
          const look = (sel: string) => page.$eval(sel, (el) => {
            const s = getComputedStyle(el);
            return { bg: s.backgroundColor, color: s.color, weight: Number(s.fontWeight), bar: s.borderInlineStartColor };
          });
          const current = await look('.t-nav a[aria-current="page"]');
          const parent = await look('.t-nav summary.in-trail');
          const plain = await look('.t-nav li:not(:has(.in-trail, [aria-current])) > a');
          assert.notEqual(current.bg, parent.bg, `${appearance}: the current page is filled, its parent not`);
          assert.equal(parent.bg, plain.bg, `${appearance}: the parent has no fill`);
          assert.ok(parent.weight >= 600 && plain.weight < 600, `${appearance}: the parent is bold`);
          assert.ok(current.weight >= 600);
          assert.match(await page.$eval('.t-nav summary.in-trail', (el) => el.textContent ?? ''), /Employees/);
        } finally {
          await page.context().close();
        }
      }
    } finally {
      await setTheme({});
    }
  });

  test('Arabic (right to left): the menu on the right, the drawer from the right, no sideways scrolling', async () => {
    await owner.query(`update meta.app set languages = array_append(languages, 'ar') where alias = 'hr' and not 'ar' = any(languages)`);
    try {
      for (const appearance of ['pillar_dark', 'pillar_light']) {
        await setTheme({ appearance });
        const desk = await signedIn(1280);
        try {
          await desk.goto(`${base}/a/hr/2?lang=ar`);
          assert.equal(await desk.getAttribute('html', 'dir'), 'rtl');
          const nav = (await desk.locator('#t-nav').boundingBox())!;
          const main = (await desk.locator('#main').boundingBox())!;
          assert.ok(nav.x > main.x, 'the menu is on the right');
          // the current page's bar or pill and the subtree guide sit on the right of the entries
          const guide = await desk.$eval('.t-nav details:has(> summary.in-trail) > ul', (el) => getComputedStyle(el).borderRightWidth);
          assert.equal(guide, '1px');
          assert.equal(await desk.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
        } finally {
          await desk.context().close();
        }
        const phone = await signedIn(390);
        try {
          await phone.goto(`${base}/a/hr/2?lang=ar`);
          assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'closed drawer');
          await phone.click('.t-nav-toggle');
          await phone.waitForTimeout(350);
          const box = (await phone.locator('#t-nav').boundingBox())!;
          assert.ok(Math.abs(box.x + box.width - 390) < 2, `the drawer opens from the right (${box.x}+${box.width})`);
          assert.ok(await phone.locator('.t-nav a[aria-current="page"]').isVisible());
        } finally {
          await phone.context().close();
        }
      }
    } finally {
      await setTheme({});
      await owner.query(`update meta.app set languages = $1 where alias = 'hr'`, [saved.languages]);
    }
  });

  test('phones (390 px): the header fits and the drawer shows the current page as a pill', async () => {
    await setTheme({ appearance: 'pillar_dark', base: 'iris' });
    const page = await signedIn(390);
    try {
      for (const p of [1, 2, 8]) {
        await page.goto(`${base}/a/hr/${p}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `page ${p}`);
      }
      await page.goto(`${base}/a/hr/2`);
      await page.click('.t-nav-toggle');
      await page.waitForTimeout(350);
      const box = (await page.locator('#t-nav').boundingBox())!;
      assert.ok(box.x < 2, 'the drawer opens from the left');
      const pill = await page.$eval('.t-nav a[aria-current="page"]', (el) => getComputedStyle(el).borderTopLeftRadius);
      assert.equal(pill, '999px');
    } finally {
      await page.context().close();
      await setTheme({});
    }
  });

  test('the Theme Roller offers Pillar Dark and previews it', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${base}/builder/login`);
      await page.fill('#f_username', 'admin');
      await page.fill('#f_password', 'admin');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      const app = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
      await page.goto(`${base}/builder/apps/${app}/theme`);
      const form = page.locator('form[data-tr-form]');
      await form.locator('select[name="appearance"]').selectOption('pillar_dark');
      assert.equal(await page.getAttribute('[data-tr-preview]', 'data-appearance'), 'pillar_dark');
      await form.locator('select[name="appearance"]').selectOption('default');
      assert.equal(await page.getAttribute('[data-tr-preview]', 'data-appearance'), '');
      // the application's Pillar Dark from the settings form, without a page script error
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.locator('form[action$="/theme/settings"] select[name="appearance"]').selectOption('pillar_dark');
      await Promise.all([page.waitForNavigation(), page.locator('form[action$="/theme/settings"] button.btn-hot').click()]);
      assert.equal((await owner.one(`select theme ->> 'appearance' as a from meta.app where id = $1`, [app])).a, 'pillar_dark');
      assert.equal(await page.getAttribute('[data-tr-preview]', 'data-appearance'), 'pillar_dark', 'a new style starts as the application');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await setTheme({});
    }
  });

  test('the processing indicator: a slight dim and a bar on a busy region', async () => {
    const page = await signedIn(1280);
    try {
      await page.goto(`${base}/a/hr/2`);
      await page.$eval('.region', (el) => el.setAttribute('aria-busy', 'true'));
      await page.waitForTimeout(500);
      const s = await page.$eval('.region', (el) => ({ opacity: getComputedStyle(el).opacity, bar: getComputedStyle(el, '::after').height }));
      assert.equal(s.opacity, '0.8');
      assert.equal(s.bar, '3px');
    } finally {
      await page.context().close();
    }
  });
});
