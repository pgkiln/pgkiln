// The builder's addresses and error pages (sprint 86, parity handoff BLD-6): the page designer by
// the application's id and the page's number (the internal id redirects a browser there), and HTML
// 404 and 500 pages for browsers under /builder; scripts keep their plain answers.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { builderErrorPages, builderServerError } from '../src/builder/errors.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page3: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  page3 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 3', [appId])).id;
});
after(async () => {
  await app.close();
  await closePools();
});

async function developer(html = true) {
  const b = new Browser(app);
  await b.get('/builder/login');
  await b.submit('/builder/login', { username: 'admin', password: 'admin' });
  if (html) b.headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  return b;
}

describe('the page designer by the page\'s number', () => {
  test('/builder/apps/:app/pages/:number opens the designer; its links use page numbers', async () => {
    const b = await developer();
    const res = await b.get(`/builder/apps/${appId}/pages/3?c=page`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Page designer: page 3,/);
    assert.match(res.body, new RegExp(`href="/builder/apps/${appId}/pages/2" title="Previous page: 2\\.`));
    assert.match(res.body, new RegExp(`class="pd-node" href="/builder/apps/${appId}/pages/3\\?c=region-\\d+"`));
    // its forms still post to the internal id (the number may change on save)
    assert.match(res.body, new RegExp(`<form method="post" action="/builder/pages/${page3}/layout/undo"`));
    assert.doesNotMatch(res.body, /action="\/builder\/apps\/\d+\/pages\/\d+\//);
    // the application's page list, and the toolbar's "go to page"
    assert.match((await b.get(`/builder/apps/${appId}`)).body, new RegExp(`<a href="/builder/apps/${appId}/pages/3"`));
    assert.equal((await b.get(`/builder/apps/${appId}/goto?page=3`)).headers.location, `/builder/apps/${appId}/pages/3`);
    // the developer toolbar's "Edit page" on the application's page
    await b.get(`/builder/apps/${appId}`);
    const hr = new Browser(app);
    hr.cookies = b.cookies;
    await hr.login('king');
    assert.match((await hr.get('/a/hr/3')).body, new RegExp(`href="/builder/apps/${appId}/pages/3"[^>]*>[\\s\\S]{0,400}Page 3`));
  });

  test('a browser that opens the internal id is sent to the number, with the same query; scripts are not', async () => {
    const b = await developer();
    const res = await b.get(`/builder/pages/${page3}?c=page&x=1`);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `/builder/apps/${appId}/pages/3?c=page&x=1`);
    const plain = await developer(false);
    assert.equal((await plain.get(`/builder/pages/${page3}`)).statusCode, 200, 'no redirect without Accept: text/html');
    // a page number that doesn't exist, or an app id that isn't a number
    assert.equal((await b.get(`/builder/apps/${appId}/pages/987654`)).statusCode, 404);
    assert.equal((await b.get(`/builder/apps/x/pages/3`)).statusCode, 404);
  });

  test('signed out: to the sign-in page, not the designer', async () => {
    const anon = new Browser(app);
    anon.headers.accept = 'text/html';
    const res = await anon.get(`/builder/apps/${appId}/pages/3`);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/builder/login');
  });
});

describe('the builder\'s error pages', () => {
  test('a browser gets an HTML 404 page for an unknown address, application or page', async () => {
    const b = await developer();
    for (const url of ['/builder/nope', `/builder/pages/999999999`, '/builder/apps/999999/shared', `/builder/apps/${appId}/pages/987654`, '/builder/pages/99999999999999']) {
      const res = await b.get(url);
      assert.equal(res.statusCode, 404, url);
      assert.match(String(res.headers['content-type']), /^text\/html/, url);
      assert.match(res.body, /<h1>Page not found<\/h1>/, url);
      assert.match(res.body, /<a class="btn btn-hot" href="\/builder">App Builder home<\/a>/);
    }
    // the address is shown escaped
    const odd = await b.get('/builder/%3Cscript%3Ealert(1)%3C/script%3E');
    assert.equal(odd.statusCode, 404);
    assert.doesNotMatch(odd.body, /<script>alert/);
    // in the builder's theme
    b.cookies.set('pgkiln_btheme', 'dark');
    assert.match((await b.get('/builder/nope')).body, /<html lang="en" data-theme="dark">/);
  });

  test('scripts and other addresses keep their plain answers', async () => {
    const plain = await developer(false);
    const res = await plain.get('/builder/nope');
    assert.equal(res.statusCode, 404);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal((await plain.get('/builder/pages/999999999')).body, 'Not found');
    const b = await developer();
    const outside = await b.get('/nope');
    assert.match(String(outside.headers['content-type']), /application\/json/, 'outside the builder: unchanged');
  });

  test('a server error on a builder page is an HTML 500 page for a browser, the error itself is not shown', async () => {
    const f = Fastify({ logger: false });
    await f.register(cookie);
    f.setErrorHandler((err, req, reply) => (builderServerError(req, reply, err as Error) ? reply : reply.send(err)));
    builderErrorPages(f);
    f.get('/builder/boom', async () => {
      throw new Error('secret detail: password=hunter2');
    });
    const html = await f.inject({ url: '/builder/boom', headers: { accept: 'text/html' } });
    assert.equal(html.statusCode, 500);
    assert.match(html.body, /<h1>Something went wrong<\/h1>/);
    assert.doesNotMatch(html.body, /hunter2/);
    const json = await f.inject({ url: '/builder/boom' });
    assert.equal(json.statusCode, 500);
    assert.match(String(json.headers['content-type']), /application\/json/);
    await f.close();
  });
});
