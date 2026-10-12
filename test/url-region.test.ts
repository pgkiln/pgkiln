// URL region (migration 078): the iframe, its sandbox and height, and the
// page's Content-Security-Policy, which frames exactly the regions' origins.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { urlConfigProblem, urlTarget } from '../src/runtime/url-region.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let pageId: number;
const regions: number[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  pageId = (await owner.one(`select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 1`)).id;
});

after(async () => {
  await owner.query('delete from meta.region where id = any($1)', [regions]);
  await app.close();
  await closePools();
});

async function addRegion(source: string, config: object = {}, condition: string | null = null) {
  const r = await owner.one(
    `insert into meta.region (page_id, seq, title, type, source, config, condition) values ($1, 999, 'Embedded', 'url', $2, $3, $4) returning id`,
    [pageId, source, JSON.stringify(config), condition],
  );
  regions.push(r.id);
  return r.id as number;
}
const remove = async (id: number) => owner.query('delete from meta.region where id = $1', [id]);

describe('URL region', () => {
  test('the origin must be written out: https (http for localhost) or a path on this server', () => {
    assert.deepEqual(urlTarget('https://example.org/report?id=&P1_ID.'), { origin: 'https://example.org' });
    assert.deepEqual(urlTarget('https://maps.example.org:8443'), { origin: 'https://maps.example.org:8443' });
    assert.deepEqual(urlTarget('http://localhost:3000/x'), { origin: 'http://localhost:3000' });
    assert.deepEqual(urlTarget('/a/other/1'), { origin: null });
    for (const bad of ['', 'http://example.org/', 'https://&P1_HOST./x', 'https://example.org&P1_X./', 'javascript:alert(1)', '//evil.example/x',
      '/\\evil.example', 'https://user:pw@example.org/', 'data:text/html,hi', 'ftp://example.org/'])
      assert.ok('error' in urlTarget(bad), bad);
    assert.equal(urlConfigProblem({ height: 600, sandbox: ['allow-scripts'], fullscreen: true }), null);
    assert.equal(urlConfigProblem({ sandbox: false }), null);
    assert.match(urlConfigProblem({ height: 50 })!, /height/);
    assert.match(urlConfigProblem({ sandbox: ['allow-top-navigation'] })!, /unknown flag allow-top-navigation/);
  });

  test('the page frames the URL, items URL-encoded, with a sandbox, a height class and frame-src for its origin', async () => {
    const id = await addRegion('https://example.org/u/&APP_USER.?q=&APP_USER.&x=1', { height: 600 });
    try {
      const b = new Browser(app);
      await b.login('king');
      const res = await b.get('/a/hr/1');
      assert.equal(res.statusCode, 200);
      const frame = new RegExp(`id="R${id}"[\\s\\S]*?<iframe class="url-frame (x[A-Za-z0-9]{10})" src="([^"]+)" title="Embedded"[^>]*sandbox="([^"]+)"`).exec(res.body);
      assert.ok(frame, 'an iframe in the region');
      assert.equal(frame[2], 'https://example.org/u/king?q=king&amp;x=1');
      assert.equal(frame[3], 'allow-scripts allow-forms allow-popups allow-same-origin');
      assert.match(res.body, new RegExp(`\\.${frame[1]}\\{height:600px\\}`));
      assert.match(res.body, /<a href="https:\/\/example\.org\/u\/king\?q=king&amp;x=1" target="_blank" rel="noopener noreferrer">Open in a new tab<\/a>/);
      const csp = String(res.headers['content-security-policy']);
      assert.match(csp, /frame-src 'self' https:\/\/example\.org;/);
      // another page has no frame-src (default-src 'self' only)
      assert.doesNotMatch(String((await b.get('/a/hr/2')).headers['content-security-policy']), /frame-src/);
    } finally {
      await remove(id);
    }
  });

  test('sandbox false and fullscreen; a hidden region adds no origin; a bad URL shows an error and frames nothing', async () => {
    const open = await addRegion('https://open.example.org/', { sandbox: false, fullscreen: true });
    const hidden = await addRegion('https://hidden.example.org/', {}, '1 = 0');
    const bad = await addRegion('https://&APP_USER..example.org/');
    try {
      const b = new Browser(app);
      await b.login('king');
      const res = await b.get('/a/hr/1');
      const csp = String(res.headers['content-security-policy']);
      assert.match(csp, /frame-src 'self' https:\/\/open\.example\.org;/);
      assert.doesNotMatch(csp, /hidden\.example\.org|king/);
      const frame = /<iframe[^>]*src="https:\/\/open\.example\.org\/"[^>]*>/.exec(res.body)?.[0] ?? '';
      assert.doesNotMatch(frame, /sandbox/);
      assert.match(frame, /allowfullscreen/);
      assert.doesNotMatch(res.body, /hidden\.example\.org/);
      assert.match(res.body, new RegExp(`id="R${bad}"[\\s\\S]*?its host can&#39;t come from an item`));
    } finally {
      for (const id of [open, hidden, bad]) await remove(id);
    }
  });
});
