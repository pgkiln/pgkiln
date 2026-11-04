// Sprint 140 (AP-4) in a real browser, on HR page 50: the shuttle (two lists, move and order buttons, the
// keyboard) and Select One / Select Many (a search field with a list box; chips) are progressive
// enhancements of plain selects: they post what the plain form would, the cascading list of values
// reloads the shuttle, the page keeps the Content-Security-Policy and fits a phone; without JavaScript
// the same page saves the same values.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools } from '../../src/db.ts';

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
after(() => close());

async function open(o: { javaScriptEnabled?: boolean; width?: number } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: o.javaScriptEnabled ?? true, viewport: { width: o.width ?? 1280, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || 'inline'}`));
  });
  const page = await context.newPage();
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/50`);
  return page;
}
const violations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);
const chosenTeam = (page: Page) => page.locator('section:has(h2:text-is("Chosen team")) tbody td[data-label="Name"]').allTextContents();
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe('sprint 140: shuttle, select one and select many', () => {
  test('choosing with the enhanced controls saves the order and the values', async () => {
    const page = await open();
    // the plain selects are hidden behind the enhanced controls
    assert.equal(await page.locator('#P50_DEPTNO').isHidden(), true);
    assert.equal(await page.locator('#P50_MEMBERS').isHidden(), true);
    assert.equal(await page.locator('#P50_SKILLS').isHidden(), true);
    // the labels name the enhanced controls
    assert.equal(await page.locator('label[for="P50_DEPTNO_search"]').count(), 1);
    assert.equal(await page.locator('label[for="P50_MEMBERS_available"]').count(), 1);

    // Select One: type to filter, the arrow keys and Enter choose
    const dept = page.locator('#P50_DEPTNO_search');
    await dept.click();
    assert.equal(await dept.getAttribute('aria-expanded'), 'true');
    await dept.fill('sea');
    const options = page.locator('#P50_DEPTNO_search ~ [role=listbox] [role=option]');
    assert.deepEqual(await options.allTextContents(), ['RESEARCH']);
    await dept.press('Enter');
    assert.equal(await dept.inputValue(), 'RESEARCH');
    assert.equal(await page.locator('#P50_DEPTNO').inputValue(), '20');
    // the cascading list of values: the shuttle comes back with the department's employees
    const available = page.locator('#P50_MEMBERS_available');
    await page.waitForFunction(() => document.querySelectorAll('#P50_MEMBERS_available option').length === 5);
    assert.deepEqual(await available.locator('option').allTextContents(), ['ADAMS (CLERK)', 'FORD (ANALYST)', 'JONES (MANAGER)', 'SCOTT (ANALYST)', 'SMITH (CLERK)']);

    // Shuttle: Move, double-click, the keyboard (Enter), and the order buttons
    const shuttle = page.locator('[data-shuttle="P50_MEMBERS"]');
    await available.selectOption('7369'); // SMITH
    await shuttle.getByRole('button', { name: 'Move', exact: true }).click();
    await available.locator('option[value="7902"]').dblclick(); // FORD
    await available.selectOption('7566'); // JONES
    await available.press('Enter');
    const chosen = page.locator('#P50_MEMBERS_chosen');
    assert.deepEqual(await chosen.locator('option').allTextContents(), ['SMITH (CLERK)', 'FORD (ANALYST)', 'JONES (MANAGER)']);
    await chosen.selectOption('7566');
    await shuttle.getByRole('button', { name: 'Move to top' }).click();
    await chosen.selectOption('7369');
    await shuttle.getByRole('button', { name: 'Move down' }).click();
    assert.deepEqual(await chosen.locator('option').allTextContents(), ['JONES (MANAGER)', 'FORD (ANALYST)', 'SMITH (CLERK)']);
    // the filter narrows the available list; Remove sends one back
    await page.fill('#P50_MEMBERS_filter', 'sco');
    assert.deepEqual(await available.locator('option').allTextContents(), ['SCOTT (ANALYST)']);
    await chosen.selectOption('7369');
    await chosen.press('Delete');
    assert.deepEqual(await chosen.locator('option').allTextContents(), ['JONES (MANAGER)', 'FORD (ANALYST)']);
    // the item's own select holds the value, in the chosen order
    assert.equal(await page.evaluate(() => [...(document.getElementById('P50_MEMBERS') as HTMLSelectElement).selectedOptions].map((o) => o.value).join(':')), '7566:7902');

    // Select Many: chips, Enter adds, the chip's button and Backspace remove
    const skills = page.locator('#P50_SKILLS_search');
    await skills.click();
    await skills.fill('type');
    await skills.press('Enter');
    await skills.fill('sq');
    await skills.press('Enter');
    await skills.fill('test');
    await skills.press('Enter');
    const chips = page.locator('[data-item="P50_SKILLS"] .select-pick-chips .tag');
    assert.equal(await chips.count(), 3);
    await page.getByRole('button', { name: 'Remove TypeScript' }).click();
    await skills.press('Backspace'); // the last chosen (in list order): Testing
    assert.deepEqual((await chips.allTextContents()).map((t) => t.replace('×', '')), ['SQL']);
    await skills.press('Escape');
    assert.equal(await skills.getAttribute('aria-expanded'), 'false');

    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save' }).click()]);
    assert.deepEqual(await chosenTeam(page), ['JONES', 'FORD']);
    // shown again in the saved order, with the chips of the saved values
    assert.deepEqual(await page.locator('#P50_MEMBERS_chosen option').allTextContents(), ['JONES (MANAGER)', 'FORD (ANALYST)']);
    assert.deepEqual((await page.locator('[data-item="P50_SKILLS"] .select-pick-chips .tag').allTextContents()).map((t) => t.replace('×', '')), ['SQL']);
    assert.equal(await page.locator('#P50_DEPTNO_search').inputValue(), 'RESEARCH');
    assert.deepEqual(await violations(page), []);
  });

  test('without JavaScript the plain selects save the same values', async () => {
    const page = await open({ javaScriptEnabled: false });
    assert.equal(await page.locator('#P50_MEMBERS_available').count(), 0);
    await page.selectOption('#P50_DEPTNO', '20');
    // the department's employees come with the page: save the department first (the cascade needs JavaScript)
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot[value="SAVE"]')]);
    await page.selectOption('#P50_MEMBERS', ['7788', '7876']);
    await page.selectOption('#P50_SKILLS', ['DESIGN', 'A11Y']);
    await Promise.all([page.waitForNavigation(), page.click('button.btn-hot[value="SAVE"]')]);
    // without JavaScript there is no ordering: the values come in the list's order
    assert.deepEqual(await chosenTeam(page), ['ADAMS', 'SCOTT']);
    assert.deepEqual(await page.locator('#P50_SKILLS option:checked').allTextContents(), ['Design', 'Accessibility']);
  });

  test('a phone: the shuttle stacks and an open list box fits', async () => {
    const page = await open({ width: 390 });
    await page.locator('#P50_DEPTNO_search').click();
    await page.locator('#P50_DEPTNO_search').fill('acc');
    await page.locator('#P50_DEPTNO_search').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#P50_MEMBERS_available option').length === 3);
    await page.locator('#P50_SKILLS_search').click();
    assert.equal(await page.locator('#P50_SKILLS_search ~ [role=listbox]').isVisible(), true);
    assert.ok((await overflow(page)) <= 1, 'no sideways scrolling at 390 px');
    const a = await page.locator('#P50_MEMBERS_available').boundingBox();
    const c = await page.locator('#P50_MEMBERS_chosen').boundingBox();
    assert.ok(a && c && c.y > a.y + a.height - 1, 'the chosen list is under the available one');
    assert.deepEqual(await violations(page), []);
  });
});
