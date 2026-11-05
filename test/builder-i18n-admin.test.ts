// Sprint 152 (WS-7 leftover): the rest of Administration in the builder languages: Workspace utilities, the
// workspace dashboard, Mail queue, Network access, Instance settings and LDAP directories. Signed in after a
// language link, each screen comes in that language (its title, regions and labels); English stays as it was.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { builderTranslator } from '../src/builder/i18n.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let before_: string | null = null;

before(async () => {
  app = await buildApp({ logger: false });
  before_ = (await owner.one(`select language from meta.developer where username = 'admin'`)).language;
});
after(async () => {
  await owner.query(`update meta.developer set language = $1 where username = 'admin'`, [before_]);
  await app.close();
  await closePools();
});

async function admin(lang: string) {
  await owner.query(`update meta.developer set language = $1 where username = 'admin'`, [lang]);
  const b = new Browser(app);
  await b.get(`/builder/login?lang=${lang}`);
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SCREENS: [string, string[]][] = [
  ['/builder/utilities', ['wu.title', 'wu.users', 'wu.ai_text', 'wu.cross_app']],
  ['/builder/dashboard', ['wd.title', 'wd.per_app', 'wd.col.views_week']],
  ['/builder/mail-queue', ['mq.title', 'mq.per_hour', 'mq.failures', 'mq.stat.delivered']],
  ['/builder/network', ['na.title', 'na.outgoing', 'na.refusals', 'na.check']],
  ['/builder/instance', ['ins.title', 'ins.sessions', 'ins.checks', 'ins.configuration']],
  ['/builder/users/directories', ['ldap.title', 'ldap.directories', 'ldap.user_base', 'ldap.groups']],
];

describe('Administration screens in the builder languages', () => {
  for (const lang of ['de', 'ja', 'en'])
    test(`${lang}: every screen shows its texts in that language`, async () => {
      const b = await admin(lang);
      const tx = builderTranslator(lang as 'de');
      for (const [url, keys] of SCREENS) {
        const res = await b.get(url);
        assert.equal(res.statusCode, 200, url);
        for (const k of keys) assert.ok(res.body.includes(esc(tx(k as 'wu.title'))), `${url} (${lang}) shows ${k}: ${tx(k as 'wu.title')}`);
      }
    });

  test('English is what it was (tests and e2e tests assert it)', async () => {
    const page = (await (await admin('en')).get('/builder/mail-queue')).body;
    assert.match(page, /<h1>Mail queue<\/h1>/);
    assert.match(page, /Mail that will not be tried again: the provider refused it, or it failed 5 times\. <b>Retry<\/b> queues it again with fresh attempts; <b>Purge<\/b> deletes it\./);
  });
});
