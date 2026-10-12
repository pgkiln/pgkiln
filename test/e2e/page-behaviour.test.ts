// Page behaviour in a real browser (migration 085): dynamic action chains with confirm, custom
// events, key release, before submit, Ajax callbacks and the session timeout warning.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import '../../src/env.ts';
import { buildApp } from '../../src/app.ts';
import { closePools, owner } from '../../src/db.ts';

let base = '';
let browser: Browser;
let close: () => Promise<void>;
let appId: number;
let pageId: number;
const made: { table: string; id: number }[] = [];

before(async () => {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  pageId = (await owner.one('select id from meta.page where app_id = $1 and page_no = 1', [appId])).id;
  const add = async (table: string, sql: string, params: unknown[]) => made.push({ table, id: (await owner.one(sql, params)).id });
  await add('item', `insert into meta.item (page_id, seq, name, type) values ($1, 990, 'P1_PB_A', 'text') returning id`, [pageId]);
  await add('dynamic_action', `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, message) values ($1, 990, 'ask', 'custom', 'PB_GO', 'confirm', 'Clear it?') returning id`, [pageId]);
  await add('dynamic_action', `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items) values ($1, 991, 'clear', 'custom', 'PB_GO', 'clear', 'P1_PB_A') returning id`, [pageId]);
  await add('dynamic_action', `insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, css_classes) values ($1, 992, 'typed', 'key_release', 'P1_PB_A', 'add_class', 'P1_PB_A', 'pb-typed') returning id`, [pageId]);
  await add('dynamic_action', `insert into meta.dynamic_action (page_id, seq, name, event, action, message) values ($1, 993, 'leave?', 'before_submit', 'confirm', 'Submit now?') returning id`, [pageId]);
  await add('process', `insert into meta.process (page_id, seq, name, type, point, code) values ($1, 990, 'PB_ECHO', 'sql', 'ajax', 'select upper(:X01) as shout') returning id`, [pageId]);
  close = async () => {
    for (const m of made.reverse()) await owner.query(`delete from meta.${m.table} where id = $1`, [m.id]);
    await owner.query('update meta.app set session_warning_seconds = 120 where id = $1', [appId]);
    await browser.close();
    await app.close();
    await closePools();
  };
});
after(async () => close());

async function signIn(page: Page) {
  await page.goto(`${base}/a/hr/login`);
  await page.fill('#username', 'king');
  await page.fill('#password', 'king');
  await Promise.all([page.waitForNavigation(), page.click('button.btn-hot')]);
  await page.goto(`${base}/a/hr/1`);
}

describe('page behaviour', () => {
  test('a declined confirm stops the actions after it; custom events, key release and Ajax callbacks', async () => {
    const page = await browser.newPage();
    try {
      await signIn(page);
      await page.click('#P1_PB_A');
      await page.keyboard.type('x');
      await page.locator('[data-item="P1_PB_A"].pb-typed').waitFor();
      page.once('dialog', (d) => void d.dismiss());
      await page.evaluate(() => (window as any).pgkiln.trigger('pb_go'));
      assert.equal(await page.inputValue('#P1_PB_A'), 'x', 'No: not cleared');
      page.once('dialog', (d) => void d.accept());
      await page.evaluate(() => (window as any).pgkiln.trigger('PB_GO'));
      assert.equal(await page.inputValue('#P1_PB_A'), '', 'Yes: cleared');
      const r = await page.evaluate(() => (window as any).pgkiln.server.process('PB_ECHO', { x01: 'hello' }));
      assert.equal(r.data.shout, 'HELLO');
    } finally {
      await page.close();
    }
  });

  test('before submit: a declined confirm keeps the page', async () => {
    const page = await browser.newPage();
    try {
      await signIn(page);
      await page.evaluate(() => ((window as any).__marker = 1));
      page.once('dialog', (d) => void d.dismiss());
      await page.evaluate(() => (document.querySelector('form.page-form') as HTMLFormElement).requestSubmit());
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => (window as any).__marker), 1, 'not submitted');
      page.once('dialog', (d) => void d.accept());
      await Promise.all([page.waitForNavigation(), page.evaluate(() => (document.querySelector('form.page-form') as HTMLFormElement).requestSubmit())]);
      assert.equal(await page.evaluate(() => (window as any).__marker), undefined, 'submitted');
    } finally {
      await page.close();
    }
  });

  test('the session timeout warning offers to stay signed in', async () => {
    // a warning as long as the idle time: it shows at once
    await owner.query('update meta.app set session_warning_seconds = 3600 where id = $1', [appId]);
    const page = await browser.newPage();
    try {
      await signIn(page);
      const dialog = page.locator('dialog.session-dialog[open]');
      await dialog.waitFor();
      assert.match((await dialog.textContent()) ?? '', /your session ends in \d+ minute/);
      const extend = page.waitForResponse((r) => r.url().endsWith('/a/hr/session/extend') && r.status() === 200);
      await dialog.getByRole('button', { name: 'Stay signed in' }).click();
      await extend;
    } finally {
      await page.close();
      await owner.query('update meta.app set session_warning_seconds = 120 where id = $1', [appId]);
    }
  });
});
