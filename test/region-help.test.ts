// The help of a region's Attributes (JSON) per region type (sprint 51).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { ALL_REGION_CONFIG_HELP, REGION_CONFIG_HELP, regionConfigHelp } from '../src/builder/region-help.ts';
import { COMPONENTS } from '../src/builder/components.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
before(async () => {
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  await closePools();
});

describe('region attributes help', () => {
  test('one type sees its own keys, the general ones and a link to its section of the guide', () => {
    const url = regionConfigHelp('url');
    assert.match(url.text, /"height":480/);
    assert.doesNotMatch(url.text, /page_size/);
    assert.match(url.text, /any region: \{"display_selector":true\}/);
    assert.equal(url.url, 'https://pgkiln.vargar.eu/docs/pages-and-regions#url-url-region');
    for (const key of ['page_size', 'formats', 'ai_filter', 'lazy']) assert.ok(regionConfigHelp('report').text.includes(`"${key}"`), key);
    assert.equal(regionConfigHelp('tasks').url, 'https://pgkiln.vargar.eu/docs/processing#approvals-and-the-task-list');
    assert.equal(regionConfigHelp(null).text, ALL_REGION_CONFIG_HELP);
    // every region type has its own keys or at least the general ones, and a guide section
    for (const type of COMPONENTS.region.fields.find((f) => f.name === 'type')!.options!) {
      assert.ok(regionConfigHelp(type).text.length > 10, type);
      assert.ok(regionConfigHelp(type).url, `${type}: a guide section`);
    }
    assert.ok(REGION_CONFIG_HELP.every(([types]) => types.length > 0));
  });

  test('the Page Designer shows the region\'s own help with the link', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const r = await owner.one(`select r.id, r.page_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                where a.alias = 'hr' and p.page_no = 42 and r.type = 'search'`);
    const page = (await dev.get(`/builder/pages/${r.page_id}?c=region-${r.id}`)).body;
    const help = /id="f_region_config"[\s\S]*?<small class="help">([\s\S]*?)<\/small>/.exec(page)?.[1] ?? '';
    assert.match(help, /&quot;configs&quot;/);
    assert.doesNotMatch(help, /page_size/);
    assert.match(help, /href="https:\/\/pgkiln\.vargar\.eu\/docs\/pages-and-regions#search-search-region"/);
  });
});
