// The builder in more languages in a real browser (sprint 121, WS-7): Deutsch on the sign-in page gives a German
// builder; the status bar's language menu switches (and opens inside a phone's screen); no page scrolls sideways
// at 390 px and nothing violates the Content-Security-Policy.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { builderMessages } from '../../src/builder/i18n.ts';

const DEV = 'e2e_i18n';
const PW = 'E2e-i18n-password-1!';
const de = builderMessages('de');
const fr = builderMessages('fr');
let base = '';
let browser: Browser;
let close: () => Promise<void>;

before(async () => {
  await owner.query('delete from meta.developer where username = $1', [DEV]);
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), true)`, [DEV, PW]);
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    await app.close();
    await owner.query('delete from meta.session where app_id is null and username = $1', [DEV]);
    await owner.query('delete from meta.developer where username = $1', [DEV]);
    await closePools();
  };
});
after(() => close());

async function phone() {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  return { c, page: await c.newPage() };
}
const fits = async (page: Page, what: string) => {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  const wide = scroll <= inner + 1 ? [] : await page.evaluate(() => (() => { const out: string[] = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const r = document.createRange(); r.selectNodeContents(n); if (r.getBoundingClientRect().right > window.innerWidth + 1) out.push(`${n.parentElement?.className}: ${(n.textContent ?? '').trim().slice(0, 40)}`); } return out.slice(0, 6); })());
  assert.ok(scroll <= inner + 1, `${what}: no sideways scrolling at 390 px (${scroll} > ${inner}): ${wide.join(' | ')}`);
  assert.deepEqual(await page.evaluate(() => (window as any).__csp), [], `${what}: Content-Security-Policy`);
};

describe('builder language in a browser', () => {
  test('Deutsch on the sign-in page, then the footer menu to Français', async () => {
    const { c, page } = await phone();
    await page.goto(`${base}/builder/login`);
    await fits(page, 'sign-in');
    await Promise.all([page.waitForNavigation(), page.click('.signin-langs a[lang="de"]')]);
    assert.equal(await page.getAttribute('html', 'lang'), 'de');
    assert.equal((await page.locator('.signin-form h2').innerText()).trim(), de['signin.welcome']);
    await fits(page, 'sign-in (Deutsch)');
    await page.fill('#f_username', DEV);
    await page.fill('#f_password', PW);
    await Promise.all([page.waitForNavigation(), page.click('.signin-submit')]);
    assert.equal(await page.getAttribute('html', 'lang'), 'de');
    await page.goto(`${base}/builder/apps`);
    assert.ok(((await page.locator('.ab-tiles').textContent()) ?? '').includes(de['ab.tile.import_text']));
    await fits(page, 'App Builder (Deutsch)');
    // the other translated screens fit a phone in German too (long compound words)
    const hr = (await owner.one<{ id: number; page_no: number }>(`select a.id, min(p.page_no) as page_no from meta.app a join meta.page p on p.app_id = a.id where a.alias = 'hr' group by a.id`))!;
    for (const url of ['/builder/home', `/builder/apps/${hr.id}`, `/builder/apps/${hr.id}/pages/${hr.page_no}`]) {
      await page.goto(`${base}${url}`);
      assert.equal(await page.getAttribute('html', 'lang'), 'de');
      await fits(page, `${url} (Deutsch)`);
    }
    await page.goto(`${base}/builder/sql`);
    assert.ok((await page.locator('.sw-tabs').innerText()).includes(de['sql.tool.objects']));
    await fits(page, 'SQL Workshop (Deutsch)');

    // the status bar's language menu: opens within the screen, switches to French
    await page.click('.ide-lang > summary');
    const panel = page.locator('.ide-lang .menu-panel');
    await panel.waitFor({ state: 'visible' });
    const box = (await panel.boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, `the menu inside the screen: ${JSON.stringify(box)}`);
    await Promise.all([page.waitForNavigation(), page.click('.ide-lang-form button[value="fr"]')]);
    assert.equal(new URL(page.url()).pathname, '/builder/sql', 'back on the same page');
    assert.equal(await page.getAttribute('html', 'lang'), 'fr');
    assert.ok((await page.locator('.sw-tabs').innerText()).includes(fr['sql.tool.objects']));
    await fits(page, 'SQL Workshop (Français)');
    assert.equal((await owner.one<{ language: string }>('select language from meta.developer where username = $1', [DEV]))?.language, 'fr');
    await c.close();
  });
});
