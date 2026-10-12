// Region templates (sprint 57, migration 088): hero, title bar, buttons
// container, inline dialog and drawer, wizard; the carousel style of the
// display selector and the wizard progress list template. HR page 44.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { mergeDisplaySelectorSettings } from '../src/builder/region-settings.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
const R: Record<string, number> = {};

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
  for (const r of (await owner.query(`select r.id, r.title from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                                       where a.alias = 'hr' and p.page_no = 44`)).rows) R[r.title] = r.id;
});
after(async () => {
  await app.close();
  await closePools();
});

const regionOf = (page: string, id: number) => {
  const start = page.search(new RegExp(`<(section|dialog|nav)[^>]* id="R${id}"`));
  assert.ok(start >= 0, `region ${id}`);
  return page.slice(start, page.indexOf(/^<dialog/.test(page.slice(start)) ? '</dialog>' : '</section>', start));
};

describe('region templates on HR page 44', () => {
  test('each template\'s markup', async () => {
    const page = (await king.get('/a/hr/44')).body;
    const hero = regionOf(page, R['Welcome to HR']);
    assert.match(hero, /class="region region-static region-hero/);
    assert.match(hero, /<span class="region-hero-icon"><svg class="icon"/);
    assert.match(hero, /<div class="region-hero-buttons">/);
    assert.match(regionOf(page, R['Employees this month']), /<div class="region-title-bar"><h2 id="R\d+_title">Employees this month<\/h2><div class="region-title-buttons">/);
    const buttons = regionOf(page, R.Actions);
    assert.doesNotMatch(buttons, /<h2/);
    assert.match(buttons, /<div class="region-buttons">/);
    const dialog = regionOf(page, R['Leave policy']);
    assert.match(dialog, /^<dialog class="region region-static region-inline_dialog [^"]*" id="R\d+" aria-labelledby="R\d+_title" data-inline-region>/);
    assert.match(dialog, /data-region-close aria-label="Dismiss"/);
    assert.match(regionOf(page, R.Help), /region-inline_drawer/);
    assert.match(regionOf(page, R['Personal details']), /region-wizard/);
  });

  test('the carousel and the wizard progress', async () => {
    const page = (await king.get('/a/hr/44')).body;
    assert.match(page, /<nav class="rds rds-carousel" id="rds\d+" aria-label="Highlights" data-rds="\d+" data-rds-remember data-rds-interval="8" aria-roledescription="carousel">/);
    assert.doesNotMatch(page.slice(page.indexOf('rds-carousel'), page.indexOf('</nav>', page.indexOf('rds-carousel'))), /data-rds-all/, 'no Show all');
    assert.match(page, /<li class="wizard-step is-current" aria-current="step"><span class="wizard-step-no" aria-hidden="true">1<\/span><span class="wizard-step-label">Personal details<\/span><\/li>/);
    assert.match(page, /<li class="wizard-step is-todo"><span class="wizard-step-no" aria-hidden="true">2<\/span>/);
  });

  test('builder: the carousel style and its interval', () => {
    assert.deepEqual(mergeDisplaySelectorSettings({}, { style: 'carousel', interval: '8', show_all: '', remember: 'true' }), { style: 'carousel', interval: 8, show_all: false });
    assert.deepEqual(mergeDisplaySelectorSettings({ interval: 5 }, { style: 'tabs', interval: '8', show_all: 'true', remember: 'true' }), {});
    assert.equal(mergeDisplaySelectorSettings({}, { style: 'carousel', interval: '999', show_all: 'true', remember: 'true' }).interval, undefined);
  });

  test('the database takes the new templates and nothing else', async () => {
    const r = R['Personal details'];
    await assert.rejects(owner.query(`update meta.region set template = 'fancy' where id = $1`, [r]), /region_template_check/);
  });
});
