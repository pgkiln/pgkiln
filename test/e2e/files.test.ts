// File items in a real browser: files dropped on the field or pasted (a
// screenshot, a copied file) go into the file input and are saved like
// chosen ones; text fields keep their normal paste.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';
import { urlChecksum } from '../../src/security.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const EMP = '7934';

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  close = async () => {
    await owner.query(`delete from hr.emp_document where empno = ${EMP}`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function employeeForm() {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  const appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  const items = { P3_EMPNO: EMP };
  await page.goto(`${base}/a/hr/3?${new URLSearchParams({ ...items, cs: urlChecksum(appId, 3, 'king', items) })}`);
  return { context, page };
}

/** Files made in the page (a DataTransfer can't cross from Node). */
const inPage = (page: Page, fn: string, arg?: unknown) => page.evaluate(new Function('arg', fn) as (a: unknown) => unknown, arg);

describe('dropping and pasting files', () => {
  test('a dropped file and a pasted screenshot are added to the multiple item and saved', async () => {
    const { context, page } = await employeeForm();
    assert.equal(await page.locator('[data-item="P3_DOCUMENTS"] .file-drop .file-drop-hint').textContent(), 'Or drop files here, or paste them');
    const dropped = await inPage(page, `
      const dt = new DataTransfer();
      dt.items.add(new File(['%PDF-1.4'], 'dropped.pdf', { type: 'application/pdf' }));
      const zone = document.querySelector('[data-item="P3_DOCUMENTS"] .file-drop');
      zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const over = zone.classList.contains('dragover');
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return { over, after: zone.classList.contains('dragover'), files: [...document.getElementById('P3_DOCUMENTS').files].map((f) => f.name) };`);
    assert.deepEqual(dropped, { over: true, after: false, files: ['dropped.pdf'] });
    // paste with the file input focused: added to the dropped one
    await page.locator('#P3_DOCUMENTS').focus();
    const pasted = await inPage(page, `
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return [...document.getElementById('P3_DOCUMENTS').files].map((f) => f.name);`);
    assert.deepEqual(pasted, ['dropped.pdf', 'image.png']);
    await Promise.all([page.waitForNavigation(), page.click('button.btn[value="SAVE"]')]);
    const saved = (await owner.query(`select filename from hr.emp_document where empno = ${EMP} order by id`)).rows.map((r) => r.filename);
    assert.deepEqual(saved, ['dropped.pdf', 'image.png']);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('a single file item takes one file; pasting into a text field stays a text paste', async () => {
    const { context, page } = await employeeForm();
    const photo = await inPage(page, `
      const dt = new DataTransfer();
      dt.items.add(new File(['a'], 'a.png', { type: 'image/png' }));
      dt.items.add(new File(['b'], 'b.png', { type: 'image/png' }));
      document.querySelector('[data-item="P3_PHOTO"] .file-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return [...document.getElementById('P3_PHOTO').files].map((f) => f.name);`);
    assert.deepEqual(photo, ['a.png']);
    await page.locator('#P3_ENAME').focus();
    const untouched = await inPage(page, `
      const dt = new DataTransfer();
      dt.items.add(new File(['c'], 'c.png', { type: 'image/png' }));
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(e);
      return { prevented: e.defaultPrevented, photo: [...document.getElementById('P3_PHOTO').files].map((f) => f.name), docs: document.getElementById('P3_DOCUMENTS').files.length };`);
    assert.deepEqual(untouched, { prevented: false, photo: ['a.png'], docs: 0 });
    // a file dropped next to the drop zones doesn't open in the browser
    const stray = await inPage(page, `
      const dt = new DataTransfer();
      dt.items.add(new File(['d'], 'd.pdf', { type: 'application/pdf' }));
      const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector('h1, .page-title, body').dispatchEvent(e);
      return e.defaultPrevented;`);
    assert.equal(stray, true);
    await context.close();
  });
});
