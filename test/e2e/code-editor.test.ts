// The builder's code editor in a real browser: the highlighted layer follows
// the textarea, completions come with Ctrl+Space (and after "." ":" "&"),
// accepting inserts text, editing keys work, the form still saves, and the
// strict CSP is never violated.
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
let appId: number;
let region: { id: number; page_id: number; source: string };
let staticRegion: { id: number; page_id: number; source: string };

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  region = (await owner.one(
    `select r.id, r.page_id, r.source from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 2 and r.type = 'report' order by r.id limit 1`, [appId]))!;
  staticRegion = (await owner.one(
    `select r.id, r.page_id, r.source from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.type = 'static' order by r.id limit 1`, [appId]))!;
  close = async () => {
    await owner.query('update meta.region set source = $2 where id = $1', [region.id, region.source]);
    await owner.query('update meta.region set source = $2 where id = $1', [staticRegion.id, staticRegion.source]);
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

const options = (page: Page) => page.locator('.ce-pop:not([hidden]) [role=option]');
const value = (page: Page, sel: string) => page.locator(sel).inputValue();

describe('code editor', () => {
  test('the highlighted layer is present and follows the textarea', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/pages/${region.page_id}?c=region-${region.id}`);
    const ta = page.locator('#f_region_source');
    await page.waitForSelector('.ce #f_region_source');
    const layer = page.locator('.ce:has(#f_region_source) .ce-code');
    const sync = () => page.evaluate(() => {
      const t = document.querySelector<HTMLTextAreaElement>('#f_region_source')!;
      return { code: t.closest('.ce')!.querySelector('.ce-code')!.textContent!.replace(/\n $/, ''), value: t.value };
    });
    let s = await sync();
    assert.equal(s.code, s.value, 'the layer shows the same text');
    assert.ok(await layer.locator('.t-kw').count() > 0, 'keywords are highlighted');
    assert.equal(await layer.locator('.t-kw').first().textContent(), 'select');
    assert.ok(await layer.locator('.t-bind').count() > 0, ':P2_ binds are highlighted');
    assert.equal(await page.locator('.ce:has(#f_region_source) .ce-nums').textContent().then((t) => t!.trim().split('\n')[0]), '1', 'line numbers');
    // the textarea stays the labelled, native field
    assert.equal(await ta.getAttribute('name'), 'source');
    assert.equal(await page.locator('label[for="f_region_source"]').count(), 1);
    assert.equal(await ta.getAttribute('aria-controls'), await page.locator('.ce:has(#f_region_source) [role=listbox]').getAttribute('id'));
    // typing updates the layer
    await ta.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type("\n-- note 'x'");
    await page.waitForTimeout(50);
    s = await sync();
    assert.equal(s.code, s.value);
    assert.equal(await layer.locator('.t-com').last().textContent(), "-- note 'x'");
    // a long script: the layer draws the visible lines and stays aligned with the scroll position
    await page.evaluate(() => {
      const t = document.querySelector<HTMLTextAreaElement>('#f_region_source')!;
      t.value = Array.from({ length: 3000 }, (_, i) => `select ${i} as n from hr.emp -- ${i}`).join('\n');
      t.scrollTop = 20000;
      t.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(100);
    const view = await page.evaluate(() => {
      const t = document.querySelector<HTMLTextAreaElement>('#f_region_source')!;
      const ce = t.closest('.ce')!;
      const lh = parseFloat(getComputedStyle(t).lineHeight);
      const firstVisible = Math.floor(t.scrollTop / lh);
      const code = ce.querySelector<HTMLElement>('.ce-code')!;
      const line = code.textContent!.split('\n').find((l) => l.startsWith(`select ${firstVisible} `));
      // where that line is drawn, relative to the textarea's content box
      const top = code.getBoundingClientRect().top - t.getBoundingClientRect().top;
      const rendered = code.textContent!.split('\n').length;
      const firstDrawn = Number(/select (\d+)/.exec(code.textContent!)![1]);
      return { line: !!line, offset: top - (firstDrawn * lh - t.scrollTop), rendered, lh, firstDrawn, scrollTop: t.scrollTop };
    });
    assert.ok(view.line, 'the first visible line is drawn');
    assert.ok(view.rendered < 200, `only the visible lines are drawn (${view.rendered})`);
    assert.ok(Math.abs(view.offset) <= 1, `the layer is at the scroll position (${JSON.stringify(view)})`);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('Ctrl+Space shows suggestions; alias. lists columns; accepting inserts text; the form still saves', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/pages/${region.page_id}?c=region-${region.id}`);
    const ta = page.locator('#f_region_source');
    await ta.fill('select  from hr.emp e');
    await ta.focus();
    await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('#f_region_source')!.setSelectionRange(7, 7));
    await page.keyboard.press('Control+Space');
    await options(page).first().waitFor();
    const labels = await options(page).locator('.ce-opt-label').allTextContents();
    assert.ok(labels.includes('ename'), `columns of the table in FROM come first: ${labels.slice(0, 8)}`);
    assert.ok(!labels.slice(0, labels.indexOf('ename')).some((l) => l === 'select' || l === 'from'), 'columns before keywords');
    // ARIA: the active option is announced through aria-activedescendant
    const active = await ta.getAttribute('aria-activedescendant');
    assert.ok(active && (await page.locator(`#${active}`).getAttribute('aria-selected')) === 'true');
    // typing filters; arrows move; Enter accepts
    await page.keyboard.type('en');
    await page.waitForTimeout(50);
    assert.equal(await options(page).first().locator('.ce-opt-label').textContent(), 'ename');
    await page.keyboard.press('Enter');
    assert.equal(await value(page, '#f_region_source'), 'select ename from hr.emp e');
    assert.equal(await options(page).count(), 0, 'the list closes');
    // alias. → that table's columns, shown without Ctrl+Space
    await page.keyboard.type(', e.');
    await options(page).first().waitFor();
    const cols = await options(page).locator('.ce-opt-label').allTextContents();
    assert.ok(cols.includes('sal') && cols.includes('deptno') && !cols.includes('select'), cols.join());
    await page.keyboard.type('sa');
    await page.keyboard.press('Tab');
    assert.equal(await value(page, '#f_region_source'), 'select ename, e.sal from hr.emp e');
    // items as binds
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' where e.deptno = :P2');
    await options(page).first().waitFor();
    assert.equal(await options(page).first().locator('.ce-opt-label').textContent(), 'P2_DEPTNO');
    // the mouse works too
    await options(page).first().click();
    assert.equal(await value(page, '#f_region_source'), 'select ename, e.sal from hr.emp e where e.deptno = :P2_DEPTNO');
    // Escape closes
    await page.keyboard.press('Control+Space');
    await options(page).first().waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await options(page).count(), 0);
    // the form posts the textarea as before
    await Promise.all([page.waitForNavigation(), page.locator('#f_region_source').evaluate((t: HTMLTextAreaElement) => t.form!.requestSubmit())]);
    const saved = await owner.one('select source from meta.region where id = $1', [region.id]);
    assert.equal(saved.source, 'select ename, e.sal from hr.emp e where e.deptno = :P2_DEPTNO');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('Tab indents, Escape then Tab leaves, Enter keeps the indent, brackets pair; undo works', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/pages/${region.page_id}?c=region-${region.id}`);
    const ta = page.locator('#f_region_source');
    await ta.fill('');
    await ta.focus();
    await page.keyboard.type('select count(');
    assert.equal(await value(page, '#f_region_source'), 'select count()', 'the bracket is closed');
    await page.keyboard.type('*)');
    assert.equal(await value(page, '#f_region_source'), 'select count(*)', 'typing the closer steps over it');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('from x');
    await page.keyboard.press('Enter');
    await page.keyboard.type('where');
    assert.equal(await value(page, '#f_region_source'), 'select count(*)\n  from x\n  where', 'Tab indents, Enter keeps the indent');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await value(page, '#f_region_source'), 'select count(*)\n  from x\nwhere');
    // select everything and indent
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Tab');
    assert.equal(await value(page, '#f_region_source'), '  select count(*)\n    from x\n  where');
    await page.keyboard.press('Control+z');
    assert.equal(await value(page, '#f_region_source'), 'select count(*)\n  from x\nwhere', 'undo');
    // the matching bracket is marked
    await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('#f_region_source')!.setSelectionRange(12, 12));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.ce:has(#f_region_source) .t-match').count(), 2);
    // Escape, then Tab moves on to the next field
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'f_region_source');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('HTML regions: &ITEM. completion; the language follows the region type; plain without JavaScript', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/pages/${staticRegion.page_id}?c=region-${staticRegion.id}`);
    const ta = page.locator('#f_region_source');
    assert.equal(await page.locator('.ce:has(#f_region_source)').getAttribute('data-lang'), 'html');
    await ta.fill('<p class="lead">Hello ');
    await ta.focus();
    await page.keyboard.press('End');
    await page.keyboard.type('&AI_');
    await options(page).first().waitFor();
    await page.keyboard.press('Enter');
    assert.equal(await value(page, '#f_region_source'), '<p class="lead">Hello &AI_EMPNO.');
    const layer = page.locator('.ce:has(#f_region_source) .ce-code');
    assert.equal(await layer.locator('.t-sub').textContent(), '&AI_EMPNO.');
    assert.ok(await layer.locator('.t-tag').count() >= 1);
    assert.equal(await layer.locator('.t-attr').textContent(), 'class');
    // switching the type to report makes it SQL
    await page.selectOption('#f_region_type', 'report');
    assert.equal(await page.locator('.ce:has(#f_region_source)').getAttribute('data-lang'), 'sql');
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
    // no JavaScript: a plain textarea
    const plain = await browser.newContext({ javaScriptEnabled: false });
    const p2 = await plain.newPage();
    await p2.goto(`${base}/builder/login`);
    await p2.fill('#f_username', 'admin');
    await p2.fill('#f_password', 'admin');
    await Promise.all([p2.waitForNavigation(), p2.click('button.btn-hot')]);
    await p2.goto(`${base}/builder/sql`);
    assert.equal(await p2.locator('.ce').count(), 0);
    assert.ok(await p2.locator('textarea[name=sql]').isVisible());
    await plain.close();
  });

  test('SQL Workshop and the inline check; fits a phone screen', async () => {
    const { context, page } = await builder({ width: 390, height: 844 });
    await page.goto(`${base}/builder/sql`);
    const ta = page.locator('textarea[name=sql]');
    await ta.fill('select * from h');
    await ta.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Space');
    await options(page).first().waitFor();
    assert.ok((await options(page).locator('.ce-opt-label').allTextContents()).includes('hr'), 'schemas');
    await page.keyboard.press('Escape');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `no horizontal page overflow (${overflow}px)`);
    // the Advisor check on a component field
    await page.goto(`${base}/builder/pages/${region.page_id}?c=region-${region.id}`);
    await page.locator('#f_region_source').fill('select nope from hr.emp');
    await page.locator('.ce:has(#f_region_source) .ce-check').click();
    await page.locator('.ce:has(#f_region_source) .ce-msg-error').waitFor();
    assert.match(await page.locator('.ce:has(#f_region_source) .ce-msg').textContent() ?? '', /column "nope" does not exist/);
    await page.locator('#f_region_source').fill('select ename from hr.emp');
    await page.locator('.ce:has(#f_region_source) .ce-check').click();
    await page.locator('.ce:has(#f_region_source) .ce-msg-ok').waitFor();
    const o2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o2 <= 1, `the designer fits too (${o2}px)`);
    assert.deepEqual(await page.evaluate(() => (window as any).__csp), []);
    await context.close();
  });

  test('keyboard only: the list is announced to screen readers; the textarea keeps the focus', async () => {
    const { context, page } = await builder();
    await page.goto(`${base}/builder/sql`);
    const ta = page.locator('textarea[name=sql]');
    await ta.fill('select * from hr.');
    await ta.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Space');
    await options(page).first().waitFor();
    const live = page.locator('.ce [aria-live=polite]');
    await page.waitForFunction(() => /suggestions?:/.test(document.querySelector('.ce [aria-live=polite]')!.textContent || ''));
    assert.match(await live.textContent() ?? '', /\d+ suggestions?: \w+, (table|view)/);
    await page.keyboard.press('ArrowDown');
    const second = await options(page).nth(1).locator('.ce-opt-label').textContent();
    await page.waitForFunction((l) => (document.querySelector('.ce [aria-live=polite]')!.textContent || '').startsWith(`${l},`), second);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'sql', 'the focus never leaves the textarea');
    await page.keyboard.press('Enter');
    assert.equal(await value(page, 'textarea[name=sql]'), `select * from hr.${second}`);
    assert.equal(await live.textContent(), '', 'nothing left to announce once closed');
    // the decorative layers are hidden from assistive technology
    assert.equal(await page.locator('.ce-hl').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('.ce-gutter').getAttribute('aria-hidden'), 'true');
    assert.equal(await ta.getAttribute('aria-label'), 'SQL');
    await context.close();
  });

  test('touch screens: Suggest opens the list, a tap inserts; fits phone and tablet widths', async () => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: viewport.width < 600 });
      const page = await context.newPage();
      page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
      await page.goto(`${base}/builder/login`);
      await page.fill('#f_username', 'admin');
      await page.fill('#f_password', 'admin');
      await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
      await page.goto(`${base}/builder/pages/${region.page_id}?c=region-${region.id}`);
      const ta = page.locator('#f_region_source');
      await ta.fill('select e. from hr.emp e');
      await ta.tap();
      await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('#f_region_source')!.setSelectionRange(9, 9));
      const suggest = page.locator('.ce:has(#f_region_source) .ce-suggest');
      assert.ok(await suggest.isVisible(), 'a Suggest button');
      const box = (await suggest.boundingBox())!;
      assert.ok(box.height >= 36, `big enough to tap (${box.height}px)`);
      await suggest.tap();
      await options(page).first().waitFor();
      assert.equal(await suggest.getAttribute('aria-expanded'), 'true');
      const list = (await page.locator('.ce-pop:not([hidden])').boundingBox())!;
      assert.ok(list.x >= 0 && list.x + list.width <= viewport.width + 1, `the list is on screen (${JSON.stringify(list)})`);
      const sal = options(page).filter({ has: page.locator('.ce-opt-label', { hasText: /^sal$/ }) });
      await sal.tap();
      assert.equal(await value(page, '#f_region_source'), 'select e.sal from hr.emp e');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'f_region_source', 'the tap keeps the focus (and the keyboard) in the field');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `no horizontal page overflow at ${viewport.width}px (${overflow}px)`);
      await context.close();
    }
  });

  test('a dynamic action: language and check follow the action', async () => {
    const { context, page } = await builder();
    const pg2 = await owner.one(`select id from meta.page where app_id = $1 and page_no = 2`, [appId]);
    await page.goto(`${base}/builder/pages/${pg2!.id}?new=dynamic_action`);
    const sel = page.locator('select[name=action]');
    const ta = page.locator('textarea[name=code]');
    const ce = page.locator('.ce:has(textarea[name=code])');
    await sel.selectOption('set_value');
    assert.equal(await ce.getAttribute('data-lang'), 'sql');
    assert.equal(await ta.getAttribute('data-code-check'), 'select');
    await sel.selectOption('execute_sql');
    assert.equal(await ce.getAttribute('data-lang'), 'plpgsql');
    assert.equal(await ta.getAttribute('data-code-check'), 'statements');
    assert.ok(await ce.locator('.ce-check').isVisible());
    await context.close();
  });
});
