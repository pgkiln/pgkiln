// A checkbox facet's ⋮ menu (sprint 84; APEX: the facet's menu): Clear, and the
// values by count or by name. HR page 11 (faceted search on employees) is the fixture.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { facetSortKey } from '../src/runtime/facets.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
let facetsId: number;
let reportId: number;

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  assert.equal((await king.login('king')).statusCode, 303);
  const r = await owner.one(`select r.id, (r.config->>'report')::int as report from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                              where a.alias = 'hr' and p.page_no = 11 and r.type = 'facets'`);
  facetsId = r.id;
  reportId = r.report;
});
after(async () => {
  await app.close();
  await closePools();
});

const unescape = (s: string) => s.replace(/&amp;/g, '&');
/** The Job facet's fieldset and its value labels in order. */
const jobFacet = (body: string) => {
  const start = body.indexOf(`id="R${facetsId}"`);
  const section = body.slice(start, body.indexOf('</section>', start));
  const fs = /<fieldset class="facet[^"]*">\s*<legend>Job[\s\S]*?<\/fieldset>/.exec(section)?.[0] ?? '';
  return { fs, labels: [...fs.matchAll(/<span class="facet-label">([^<]*)<\/span><span class="facet-count">(\d+)</g)].map((m) => ({ v: m[1], n: Number(m[2]) })) };
};

describe('facet menu', () => {
  test('values by count by default; the menu sorts them by name and back; Apply and Reset keep the order', async () => {
    const first = jobFacet((await king.get('/a/hr/11')).body);
    assert.match(first.fs, /<details class="menu facet-menu"><summary aria-label="Options of Job">/);
    const counts = first.labels.map((x) => x.n);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'by count');
    assert.doesNotMatch(first.fs, /facet-menu[\s\S]*>Clear</, 'nothing to clear yet');
    const byName = unescape(/<a href="([^"]+)">Sort by name</.exec(first.fs)![1]);
    assert.match(byName, new RegExp(`${facetSortKey(reportId, 'job')}=name`));
    const sorted = jobFacet((await king.get(byName)).body);
    const names = sorted.labels.map((x) => x.v);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'by name');
    assert.match(sorted.fs, /<a href="[^"]+" aria-current="true">Sort by name</);
    // filtering keeps the order; the menu then offers Clear
    const filtered = jobFacet((await king.get(`${byName}&r${reportId}_x_job=${encodeURIComponent(names[0])}`)).body);
    assert.equal(filtered.labels[0].v, names[0], 'still by name');
    assert.match(filtered.fs, /facet-menu[\s\S]*>Clear</);
    const back = unescape(/<a href="([^"]+)"(?: aria-current="true")?>Sort by count</.exec(filtered.fs)![1]);
    assert.doesNotMatch(back, /_fo_job=/);
  });

  test('another value of the order parameter is the default order', async () => {
    const odd = jobFacet((await king.get(`/a/hr/11?${facetSortKey(reportId, 'job')}=${encodeURIComponent("name'; drop table x")}`)).body);
    const counts = odd.labels.map((x) => x.n);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  });
});
