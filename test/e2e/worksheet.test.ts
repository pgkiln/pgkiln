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
    assert.equal(await page.locator('.ws-tabs [role=tab][aria-selected=true]').textContent(), 'Query Result');
    // the statement that ran is selected again
    assert.deepEqual(await page.evaluate(() => { const t = document.querySelector<HTMLTextAreaElement>('textarea[name=sql]')!; return t.value.slice(t.selectionStart, t.selectionEnd); }), "select 'second' as which");

    await setEditor(page, sql, 0);
    await Promise.all([page.waitForNavigation(), page.keyboard.press('F5')]);
    assert.equal(await page.locator('.ws-tabs [role=tab][aria-selected=true]').textContent(), 'Script Output');
    assert.match(await page.locator('#ws-pane-output').textContent() ?? '', /SELECT 2[\s\S]*SELECT 1/);
    await page.locator('[role=tab]', { hasText: 'SQL History' }).click();
    assert.ok(await page.locator('#ws-pane-history').isVisible());
    assert.ok(!(await page.locator('#ws-pane-output').isVisible()));
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('.ws-tabs [role=tab][aria-selected=true]').textContent(), 'Autotrace');
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

  test('(sprint 92) sort a column, a value in a dialog, Autotrace as a tree, history search and run again', async () => {
    const { context, page } = await builder();
    await owner.query(`delete from meta.sql_history where username = 'admin'`);
    await page.goto(`${base}/builder/sql/worksheet?schema=${S}`);
    const sql = `select id, name, json_build_object('n', name) as j from ${S}.dept order by id`;
    await setEditor(page, sql, 3);
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+Enter')]);
    const firstName = () => page.locator('[data-ws-grid] tbody tr').first().locator('td').nth(2).textContent();
    assert.equal(await firstName(), 'Sales');
    await page.locator('[data-ws-sort="1"]').click();
    assert.equal(await firstName(), 'Research', 'ascending by name');
    assert.equal(await page.locator('th[aria-sort=ascending]').count(), 1);
    await page.locator('[data-ws-sort="1"]').click();
    assert.equal(await firstName(), 'Sales', 'descending');
    await page.locator('[data-ws-grid] tbody tr').first().locator('td').nth(3).click();
    assert.ok(await page.locator('#ws-cell').isVisible());
    assert.match(await page.locator('#ws-cell pre').textContent() ?? '', /\{\n {2}"n": "Sales"\n\}/);
    await page.keyboard.press('Escape');
    assert.ok(!(await page.locator('#ws-cell').isVisible()));

    await setEditor(page, `select * from ${S}.dept where id = 1`, 0);
    await Promise.all([page.waitForNavigation(), page.keyboard.press('F6')]);
    assert.equal(await page.locator('.ws-tabs [role=tab][aria-selected=true]').textContent(), 'Autotrace');
    assert.ok(await page.locator('#ws-pane-autotrace .ws-plan-op').first().isVisible());
    assert.ok(!(await page.locator('#ws-pane-autotrace .ws-plan-text pre').isVisible()), 'the text plan is folded');

    await page.locator('[role=tab]', { hasText: 'SQL History' }).click();
    await page.fill('[data-ws-hist-q]', 'json_build_object');
    assert.equal(await page.locator('.ws-history li:not([hidden])').count(), 1);
    await setEditor(page, '', 0);
    await Promise.all([page.waitForNavigation(), page.locator('.ws-history li:not([hidden]) [data-ws-run]').click()]);
    assert.equal(await page.locator('.ws-tabs [role=tab][aria-selected=true]').textContent(), 'Query Result');
    assert.equal(await page.locator('[data-ws-grid] tbody tr').count(), 2);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('(sprint 93) worksheets as tabs that survive a reload; Ctrl+S saves as a script; Files', async () => {
    await owner.query(`delete from meta.sql_script where name = 'e2e93 script'`);
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/worksheet`);
    const tabs = () => page.locator('.ws-wtabs [role=tab]').allTextContents();
    await setEditor(page, 'select 1', 8);
    assert.deepEqual(await tabs(), ['Untitled 1*']);
    await page.locator('.ws-wtab-new').click();
    assert.equal(await page.locator('textarea[name=sql]').inputValue(), '');
    await page.locator('textarea[name=sql]').fill('select 2');
    await page.reload();
    assert.deepEqual(await tabs(), ['Untitled 1*', 'Untitled 2*']);
    assert.equal(await page.locator('textarea[name=sql]').inputValue(), 'select 2', 'the active tab came back');
    await page.locator('.ws-wtabs [role=tab]', { hasText: 'Untitled 1' }).click();
    assert.equal(await page.locator('textarea[name=sql]').inputValue(), 'select 1');
    // Ctrl+S on an unsaved worksheet asks for a name; Enter saves
    await page.locator('textarea[name=sql]').focus();
    await page.keyboard.press('Control+s');
    assert.ok(await page.locator('#ws-name').isVisible());
    await page.fill('#ws-name', 'e2e93 script');
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
    assert.deepEqual(await tabs(), ['e2e93 script', 'Untitled 2*']);
    assert.equal(await page.locator('.ws-file-name').textContent(), 'e2e93 script');
    await page.locator('[data-ws-navtab=files]').click();
    assert.ok(await page.locator('#ws-files a', { hasText: 'e2e93 script' }).isVisible());
    await page.locator('textarea[name=sql]').press('End');
    await page.keyboard.type(' + 1');
    assert.equal(await page.locator('.ws-file-name').textContent(), 'e2e93 script*');
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+s')]);
    assert.equal((await owner.one(`select content from meta.sql_script where name = 'e2e93 script'`))!.content, 'select 1 + 1');
    assert.equal(await page.locator('.ws-file-name').textContent(), 'e2e93 script');
    await owner.query(`delete from meta.sql_script where name = 'e2e93 script'`);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('(sprint 93) a bind variable asks for its value; Format, find and replace, comment lines', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/worksheet`);
    await setEditor(page, 'select :n * 2 as d', 0);
    await Promise.all([page.waitForNavigation(), page.keyboard.press('Control+Enter')]);
    assert.ok(await page.locator('#ws-binds').isVisible());
    await page.fill('input[name=bind_N]', '21');
    await Promise.all([page.waitForNavigation(), page.locator('#ws-binds button[value=statement]').click()]);
    assert.equal(await page.locator('[data-ws-grid] td:not(.ws-rownum)').textContent(), '42');

    await setEditor(page, 'SELECT a,b FROM t', 0);
    await page.keyboard.press('Control+F7');
    await page.waitForFunction(() => (document.querySelector('textarea[name=sql]') as HTMLTextAreaElement).value.includes('\n'));
    assert.equal(await page.locator('textarea[name=sql]').inputValue(), 'select a,\n       b\nfrom t');
    await page.keyboard.press('Control+h');
    await page.fill('[data-ws-find-q]', 'from t');
    await page.fill('[data-ws-find-r]', 'from u');
    await page.locator('[data-ws-find-all]').click();
    assert.match(await page.locator('textarea[name=sql]').inputValue(), /from u$/);
    assert.equal(await page.locator('[data-ws-find-msg]').textContent(), '1 replaced.');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.locator('.ws-findbar').isVisible()));
    await page.evaluate(() => (document.querySelector('textarea[name=sql]') as HTMLTextAreaElement).setSelectionRange(0, 0));
    await page.keyboard.press('Control+/');
    assert.match(await page.locator('textarea[name=sql]').inputValue(), /^-- select a,\n {7}b/);
    await page.keyboard.press('Control+/');
    assert.match(await page.locator('textarea[name=sql]').inputValue(), /^select a,/);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('(sprint 94) right-click an object for its menu; Open shows it in a panel whose tabs load there', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/worksheet?schema=${S}`);
    const dept = page.locator('.ws-obj', { has: page.locator('summary', { hasText: /^dept$/ }) });
    await dept.locator('summary').first().click({ button: 'right' });
    assert.ok(await dept.locator('.obj-menu[open] a', { hasText: 'Quick DDL to the worksheet' }).isVisible());
    await dept.locator('.obj-menu [data-obj-open]').click();
    await page.locator('.obj-slide[open] .obj-panel').waitFor();
    assert.match(await page.locator('#obj-slide-title').textContent() ?? '', /Tables: ws91e2e\.dept/);
    await page.locator('.obj-slide a', { hasText: 'Data' }).click();
    await page.locator('.obj-slide td', { hasText: 'Research' }).waitFor();
    assert.match(page.url(), /\/builder\/sql\/worksheet/, 'the page stayed');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.locator('.obj-slide').isVisible()));
    // Quick DDL opens a new worksheet tab with the DDL
    await dept.locator('summary').first().click({ button: 'right' });
    await Promise.all([page.waitForNavigation(), dept.locator('.obj-menu a', { hasText: 'Quick DDL to the worksheet' }).click()]);
    assert.match(await page.locator('textarea[name=sql]').inputValue(), /^-- DDL of ws91e2e\.dept\n/);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('(sprint 95) Table Properties: tabs, add and move a column, preview, apply', async () => {
    await owner.query(`drop table if exists ${S}.e2e95`);
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql/objects/table?schema=${S}`);
    assert.equal(await page.locator('[data-te-section]:not([hidden])').count(), 1, 'one section at a time');
    await page.fill('#te-name', 'e2e95');
    const rows = page.locator('[data-te-grid=col] tbody tr:not([hidden])');
    assert.equal(await rows.count(), 1, 'one empty row to start');
    await rows.nth(0).locator('input[name$=".name"]').fill('title');
    await rows.nth(0).locator('input[name$=".type"]').fill('text');
    await page.locator('[data-te-add=col]').click();
    await rows.nth(1).locator('input[name$=".name"]').fill('id');
    await rows.nth(1).locator('input[name$=".type"]').fill('bigint');
    await rows.nth(1).locator('input[name$=".pk"]').check();
    await rows.nth(1).locator('[data-te-up]').click();
    assert.equal(await rows.nth(0).locator('input[name$=".name"]').inputValue(), 'id', 'moved up');
    await page.locator('[data-te-show=checks]').click();
    await page.locator('[data-te-grid=ck] input[name$=".name"]').first().fill('e2e95_title_ck');
    await page.locator('[data-te-grid=ck] input[name$=".expr"]').first().fill('length(title) > 0');
    await Promise.all([page.waitForNavigation(), page.locator('button[value=preview]').click()]);
    assert.equal(await page.locator('[data-te-show=ddl]').getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('.te-ddl').textContent() ?? '', /create table ws91e2e\.e2e95 \(\n {2}id bigint,\n {2}title text,\n {2}primary key \(id\),\n {2}constraint e2e95_title_ck check \(length\(title\) > 0\)\n\);/);
    await Promise.all([page.waitForNavigation(), page.locator('button[value=apply]').click()]);
    assert.match(await page.locator('h1').textContent() ?? '', /Table ws91e2e\.e2e95/);
    assert.ok(await owner.one(`select to_regclass('${S}.e2e95') as t`));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `no page overflow (${overflow}px)`);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });
});
