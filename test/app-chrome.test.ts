// Sprint 72: the application's chrome like APEX's: the user menu with the
// account's display name, the Install button of an installable application,
// and icon names that are also modifiers. (The developer toolbar: devbar.test.ts;
// the Iris colours: theme-styles.test.ts.)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { icon, isIcon } from '../src/icons.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let pwa: boolean;
before(async () => {
  app = await buildApp({ logger: false });
  pwa = (await owner.one(`select pwa from meta.app where alias = 'hr'`)).pwa;
});
after(async () => {
  await owner.query(`update meta.account set display_name = null where username = 'scott'`);
  await owner.query(`update meta.app set pwa = $1 where alias = 'hr'`, [pwa]);
  await app.close();
  await closePools();
});

describe('application chrome', () => {
  test('the user menu shows the display name (escaped), the user name under it', async () => {
    await owner.query(`update meta.account set display_name = '<b>Scott</b> Tiger' where username = 'scott'`);
    const b = new Browser(app);
    await b.login('scott');
    const page = (await b.get('/a/hr/1')).body;
    assert.match(page, /<summary><svg[^>]*>.*?<\/svg><span>&lt;b&gt;Scott&lt;\/b&gt; Tiger<\/span><\/summary>/s);
    assert.match(page, /<strong>&lt;b&gt;Scott&lt;\/b&gt; Tiger<\/strong><div class="muted">scott<\/div>/);
    await owner.query(`update meta.account set display_name = null where username = 'scott'`);
    assert.match((await b.get('/a/hr/1')).body, /<span>scott<\/span><\/summary>/);
  });

  test('an installable application has a hidden Install button; others none', async () => {
    const b = new Browser(app);
    await b.login('scott');
    await owner.query(`update meta.app set pwa = false where alias = 'hr'`);
    try {
      assert.doesNotMatch((await b.get('/a/hr/1')).body, /data-pwa-install/);
      await owner.query(`update meta.app set pwa = true where alias = 'hr'`);
      assert.match((await b.get('/a/hr/1')).body, /<button type="button" class="icon-button t-install" data-pwa-install hidden title="Install app" aria-label="Install app">/);
    } finally {
      await owner.query(`update meta.app set pwa = $1 where alias = 'hr'`, [pwa]);
    }
  });

  test('"info" alone is the icon; after another icon it is the modifier', () => {
    assert.ok(isIcon('info'));
    assert.match(String(icon('info')), /#info"/);
    assert.match(String(icon('user info')), /class="icon icon-info"[^>]*><use href="[^"]*#user"/);
  });
});
