// Push notifications in a real browser (migration 074): the switch on My
// account, and the service worker showing a pushed message (delivered
// through the DevTools protocol, as a push service would).
//
// Chromium's headless shell has no notifications (always "denied"), so this
// file runs the full Chromium in its headless mode. Its contexts are
// incognito, where Chrome has no Push API: subscribing fails there, and the
// test checks that the page says so. The server side of subscribing and
// sending is in test/push.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let appId: number;
let close: () => Promise<void>;
const env = { ...process.env };

before(async () => {
  process.env.PGKILN_SECRET_KEY ??= 'push-e2e-secret-key-0123456789abcdefghij';
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query('update meta.app set pwa = true, pwa_push = true where id = $1', [appId]);
  browser = await chromium.launch({ channel: 'chromium' });
  close = async () => {
    await browser.close();
    await app.close();
    await closePools();
  };
});

after(async () => {
  await owner.query('update meta.app set pwa_push = false where id = $1', [appId]);
  await owner.query('delete from meta.push_subscription where app_id = $1', [appId]);
  await owner.query('delete from meta.push_key where app_id = $1', [appId]);
  process.env = env;
  await close();
});

async function signedIn(context: BrowserContext, user = 'scott') {
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', user);
  await page.fill('#password', user);
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return page;
}

/** The notifications the app's service worker shows with a tag (polled: they appear asynchronously). */
async function notifications(page: Page, tag: string) {
  for (let i = 0; i < 50; i++) {
    const list = await page.evaluate(async (tag) => {
      const shown = await (await navigator.serviceWorker.ready).getNotifications({ tag });
      return shown.map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, url: String(n.data && n.data.url) }));
    }, tag);
    if (list.length) return list;
    await page.waitForTimeout(100);
  }
  throw new Error(`no notification with tag ${tag}`);
}

async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

describe('push notifications', () => {
  for (const width of [390, 768, 1024, 1440])
    test(`My account → Notifications at ${width}px: the switch, no horizontal scroll`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.grantPermissions(['notifications'], { origin: base });
      const page = await signedIn(context);
      await page.goto(`${base}/a/hr/account`);
      const section = page.locator('[data-push-section]');
      await section.waitFor();
      await page.locator('[data-push-toggle]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-push-toggle]').textContent(), 'Turn on notifications');
      assert.equal(await page.locator('[data-push-status]').textContent(), 'Notifications are off for this device.');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
      await context.close();
    });

  test('blocked notifications: the page says how to allow them', async () => {
    const context = await browser.newContext();
    const page = await signedIn(context);
    await page.goto(`${base}/a/hr/account`);
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'denied', origin: base, browserContextId: targetInfo.browserContextId });
    await page.reload();
    await page.waitForFunction(() => /blocks notifications/.test(document.querySelector('[data-push-status]')?.textContent ?? ''));
    assert.ok(await page.locator('[data-push-toggle]').isHidden());
    await context.close();
  });

  test('the service worker shows a pushed notification with its title, text and app icon', async () => {
    const context = await browser.newContext();
    await context.grantPermissions(['notifications'], { origin: base });
    const page = await signedIn(context);
    await controlled(page);
    const cdp = await context.newCDPSession(page);
    const registration = new Promise<string>((resolve) =>
      cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string }[] }) => {
        const r = e.registrations.find((x) => x.scopeURL === `${base}/a/hr/`);
        if (r) resolve(r.registrationId);
      }),
    );
    await cdp.send('ServiceWorker.enable');
    const registrationId = await registration;
    const data = JSON.stringify({ title: 'Leave request', body: 'Blake asks for 3 days', url: '/a/hr/6', tag: 'leave-1' });
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: `${base}/`, registrationId, data });
    const [n] = await notifications(page, 'leave-1');
    assert.equal(n.title, 'Leave request');
    assert.equal(n.body, 'Blake asks for 3 days');
    assert.equal(n.tag, 'leave-1');
    assert.match(n.icon, /\/a\/hr\/icon-192\.png$/);
    assert.equal(n.url, `${base}/a/hr/6`);

    // a link outside the app is not followed: the notification opens the app instead
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: `${base}/`, registrationId, data: JSON.stringify({ title: 'Elsewhere', url: 'https://evil.example.com/', tag: 'x' }) });
    const [other] = await notifications(page, 'x');
    assert.equal(other.url, `${base}/a/hr/`);
    await context.close();
  });

  test('turning notifications on asks the browser; when it refuses, the page says why', async () => {
    const context = await browser.newContext();
    await context.grantPermissions(['notifications'], { origin: base });
    const page = await signedIn(context);
    await page.goto(`${base}/a/hr/account`);
    await page.locator('[data-push-toggle]').waitFor({ state: 'visible' });
    await page.locator('[data-push-toggle]').click();
    // incognito Chromium refuses the subscription: its message replaces "off", the button stays usable
    await page.waitForFunction(() => !/are off/.test(document.querySelector('[data-push-status]')?.textContent ?? ''));
    assert.ok(await page.locator('[data-push-toggle]').isEnabled());
    assert.equal(await owner.one('select count(*)::int as n from meta.push_subscription where app_id = $1', [appId]).then((r) => r.n), 0);
    await context.close();
  });
});
