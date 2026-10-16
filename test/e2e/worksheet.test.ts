// Sprint 91 (Database Actions DA-1, DA-2): the SQL Worksheet in a real browser. One screen with the
// navigator, editor and output tabs; Ctrl+Enter runs the statement at the cursor, F5 the script; a table
// dragged into the editor gives a SELECT; the panes resize; it fits a phone and never violates the CSP.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
const S = 'ws91e2e';

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  await owner.query(`drop schema if exists ${S} cascade; create schema ${S};
    create table ${S}.dept (id int primary key, name text not null); insert into ${S}.dept values (1, 'Sales'), (2, 'Research');
    create view ${S}.dept_names as select name from ${S}.dept`);
  close = async () => {
    await owner.query(`drop schema if exists ${S} cascade`);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(() => close());

async function builder(viewport = { width: 1440, height: 1000 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${base}/builder/login`);
  await page.fill('#f_username', 'admin');
  await page.fill('#f_password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  return { context, page };
}

const setEditor = (page: Page, text: string, caret: number) => page.evaluate(([t, c]) => {
  const ta = document.querySelector<HTMLTextAreaElement>('textarea[name=sql]')!;
  ta.value = t as string;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(c as number, c as number);
}, [text, caret] as const);

describe('SQL Worksheet', () => {
  test('one screen; Ctrl+Enter runs the statement at the cursor, F5 the script; tabs switch', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/worksheet?schema=${S}`);
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
    const nav = await box('.ws-nav');
    const editor = await box('.ws-editor');
    const output = await box('.ws-output');
    assert.ok(nav.x + nav.width <= editor.x + 1, 'the navigator is left of the editor');
    assert.ok(editor.y + editor.height <= output.y + 1, 'the output is below the editor');
    assert.ok(output.y + output.height <= 1000, 'everything fits the window');
    assert.equal(await page.locator('.ws-pane:not([hidden])').count(), 1, 'one output tab shows');

    const sql = `select name from ${S}.dept order by id;\nselect 'second' as which;`;
    await setEditor(page, sql, sql.length - 3);
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+Enter')]);
    assert.equal(await page.locator('#ws-pane-result td:not(.ws-rownum)').first().textContent(), 'second');
    assert.equal(await page.locator('[role=tab][aria-selected=true]').textContent(), 'Query Result');
    // the statement that ran is selected again
    assert.deepEqual(await page.evaluate(() => { const t = document.querySelector<HTMLTextAreaElement>('textarea[name=sql]')!; return t.value.slice(t.selectionStart, t.selectionEnd); }), "select 'second' as which");

    await setEditor(page, sql, 0);
    await Promise.all([page.waitForNavigation(), page.keyboard.press('F5')]);
    assert.equal(await page.locator('[role=tab][aria-selected=true]').textContent(), 'Script Output');
    assert.match(await page.locator('#ws-pane-output').textContent() ?? '', /SELECT 2[\s\S]*SELECT 1/);
    await page.locator('[role=tab]', { hasText: 'SQL History' }).click();
    assert.ok(await page.locator('#ws-pane-history').isVisible());
    assert.ok(!(await page.locator('#ws-pane-output').isVisible()));
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('[role=tab][aria-selected=true]').textContent(), 'Autotrace');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('the navigator: another type without a reload, search, columns, a table dragged in gives a SELECT', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/worksheet?schema=${S}`);
    await setEditor(page, '', 0);
    await page.selectOption('#ws-type', 'view');
    await page.locator('#ws-nav-body', { hasText: 'dept_names' }).waitFor();
    assert.equal(await page.locator('#ws-nav-body .ws-obj', { hasText: /^dept$/ }).count(), 0);
    await page.selectOption('#ws-type', 'all');
    await page.locator('.ws-obj summary', { hasText: 'dept_names' }).waitFor();
    await page.fill('#ws-filter', 'names');
    assert.equal(await page.locator('.ws-obj:not([hidden])').count(), 1);
    await page.fill('#ws-filter', '');
    const dept = page.locator('.ws-obj summary').filter({ hasText: /^dept$/ });
    await dept.click();
    assert.ok(await page.locator('.ws-obj details[open] .ws-cols', { hasText: 'name' }).isVisible());
    await dept.dragTo(page.locator('textarea[name=sql]'));
    assert.match(await page.locator('textarea[name=sql]').inputValue(), new RegExp(`select id,\\s+name\\s+from ${S}\\.dept;`));
    // the buttons insert the other statements at the cursor
    await page.locator('.ws-obj details[open] [data-ws-insert]', { hasText: 'DELETE' }).click();
    assert.match(await page.locator('textarea[name=sql]').inputValue(), new RegExp(`delete from ${S}\\.dept\\n where id = null;`));
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('panes resize with the keyboard and are remembered; the navigator hides; fullscreen and Escape', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/worksheet`);
    const width = async () => (await page.locator('.ws-nav').boundingBox())!.width;
    const before = await width();
    await page.locator('[data-ws-split=nav]').focus();
    await page.keyboard.press('Shift+ArrowRight');
    assert.ok(await width() > before + 40);
    const wider = await width();
    await page.reload();
    assert.ok(Math.abs(await width() - wider) < 2, 'remembered');
    await page.locator('[data-ws-toggle-nav]').click();
    assert.ok(!(await page.locator('.ws-nav').isVisible()));
    await page.locator('[data-ws-toggle-nav]').click();
    await page.locator('[data-ws-fullscreen]').click();
    assert.ok(!(await page.locator('.ide-rail').isVisible()));
    assert.ok(await page.locator('textarea[name=sql]').isVisible());
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('.ide-rail').isVisible());
    await context.close();
  });

  test('fits a phone and a tablet; works without JavaScript', async () => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
      const { context, page } = await builder(viewport);
      await page.goto(`${base}/builder/sql/worksheet?schema=${S}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `no horizontal page overflow at ${viewport.width}px (${overflow}px)`);
      assert.ok(await page.locator('button[value=statement]').isVisible());
      await context.close();
    }
    const plain = await browser.newContext({ javaScriptEnabled: false });
    const p = await plain.newPage();
    await p.goto(`${base}/builder/login`);
    await p.fill('#f_username', 'admin');
    await p.fill('#f_password', 'admin');
    await Promise.all([p.waitForNavigation(), p.click('button.btn-hot')]);
    await p.goto(`${base}/builder/sql/worksheet`);
    await p.fill('textarea[name=sql]', `select count(*) as n from ${S}.dept`);
    await Promise.all([p.waitForNavigation(), p.click('button[value=statement]')]);
    assert.equal(await p.locator('#ws-pane-result td:not(.ws-rownum)').textContent(), '2');
    assert.ok(await p.locator('#ws-pane-output').isVisible(), 'the panes stack without script');
    await plain.close();
  });
});
