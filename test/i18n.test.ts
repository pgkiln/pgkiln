// Globalization: language choice, translated app texts, text messages,
// pgapex's own texts, date formats, XLIFF/CSV import and export.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { fromXliff, parseCsv, toCsv, toXliff } from '../src/builder/globalization.ts';
import { fromAcceptLanguage, translator } from '../src/i18n.ts';
import { applyMask } from '../src/runtime/format.ts';
import { clearLocaleCache } from '../src/runtime/locale.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});

after(async () => {
  await app.close();
  await closePools();
});

const dutch = () => new Browser(app, { 'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8' });

describe('choosing the language', () => {
  test('the browser language picks the translation; ?lang= switches for the session', async () => {
    assert.match((await dutch().get('/a/hr/login')).body, /<html lang="nl">[\s\S]*Gebruikersnaam/);
    const en = new Browser(app, { 'accept-language': 'en-GB,en;q=0.9' });
    assert.match((await en.get('/a/hr/login')).body, /<html lang="en">[\s\S]*Username/);
    await en.get('/a/hr/login?lang=nl');
    assert.match((await en.get('/a/hr/login')).body, /Gebruikersnaam/, 'remembered in the session');
    await en.get('/a/hr/login?lang=xx');
    assert.match((await en.get('/a/hr/login')).body, /Gebruikersnaam/, 'unknown languages are ignored');
  });

  test('"always the primary language" ignores the browser', async () => {
    await owner.query(`update meta.app set language_from = 'primary', languages = '{}' where id = $1`, [appId]);
    try {
      assert.match((await dutch().get('/a/hr/login')).body, /<html lang="en">[\s\S]*Username/);
    } finally {
      await owner.query(`update meta.app set language_from = 'user', languages = '{nl}' where id = $1`, [appId]);
    }
  });

  test('Accept-Language matching', () => {
    assert.equal(fromAcceptLanguage('nl-BE,nl;q=0.9', ['en', 'nl']), 'nl');
    assert.equal(fromAcceptLanguage('de;q=0.5, fr;q=0.9', ['en', 'de', 'fr']), 'fr');
    assert.equal(fromAcceptLanguage('pt-BR', ['en', 'pt-BR']), 'pt-BR');
    assert.equal(fromAcceptLanguage('*', ['en']), undefined);
    assert.equal(fromAcceptLanguage(undefined, ['en']), undefined);
  });

  test('right-to-left languages get dir="rtl"', async () => {
    await owner.query(`update meta.app set languages = '{nl,ar}' where id = $1`, [appId]);
    try {
      assert.match((await new Browser(app, { 'accept-language': 'ar' }).get('/a/hr/login')).body, /<html lang="ar" dir="rtl">/);
    } finally {
      await owner.query(`update meta.app set languages = '{nl}' where id = $1`, [appId]);
      clearLocaleCache(appId);
    }
  });
});

describe('translated pages', () => {
  test('navigation, titles, labels, buttons, lists and derived headings are translated', async () => {
    const b = dutch();
    await b.login('king');
    const home = (await b.get('/a/hr/1')).body;
    assert.match(home, /Mijn meldingen/, 'region title');
    assert.match(home, /Medewerkers/, 'navigation');
    assert.match(home, /Welkom terug/, 'static region');
    assert.match(home, /Salarissen per maand/, 'text message from SQL (meta.message)');
    const emp = (await b.get('/a/hr/2')).body;
    assert.match(emp, /Salaris/, 'column heading');
    assert.match(emp, /In dienst sinds/, 'derived heading "Hiredate"');
    assert.match(emp, /- Alle afdelingen -/, 'null label');
    assert.match(emp, /Zoek in alle kolommen/, 'pgapex texts');
    const english = new Browser(app, { 'accept-language': 'en' });
    await english.login('king');
    assert.match((await english.get('/a/hr/1')).body, /My notifications/);
  });

  test('translations are escaped like any text', async () => {
    await owner.query(`insert into meta.translation (app_id, language, source, target) values ($1, 'nl', 'Dashboard', '<img src=x onerror=alert(1)>Dash')
      on conflict (app_id, language, source) do update set target = excluded.target`, [appId]);
    clearLocaleCache(appId);
    try {
      const b = dutch();
      await b.login('king');
      const body = (await b.get('/a/hr/1')).body;
      assert.doesNotMatch(body, /<img src=x/);
      assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;Dash/);
    } finally {
      await owner.query(`update meta.translation set target = 'Dashboard' where app_id = $1 and language = 'nl' and source = 'Dashboard'`, [appId]);
      clearLocaleCache(appId);
    }
  });

  test('dates follow the language (nl: DD-MM-YYYY) or the app’s mask', async () => {
    const b = dutch();
    await b.login('king');
    assert.match((await b.get('/a/hr/2')).body, /\d{2}-\d{2}-\d{4}/);
    await owner.query(`update meta.app set date_format = 'DD Mon YYYY' where id = $1`, [appId]);
    try {
      const en = new Browser(app, { 'accept-language': 'en' });
      await en.login('king');
      assert.match((await en.get('/a/hr/2')).body, /\d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/);
    } finally {
      await owner.query(`update meta.app set date_format = null where id = $1`, [appId]);
    }
  });

  test('date masks', () => {
    assert.equal(applyMask('2026-09-29', 'DD-MM-YYYY', 'nl'), '29-09-2026');
    assert.equal(applyMask('2026-09-29', 'DD MONTH YYYY', 'nl'), '29 SEPTEMBER 2026');
    assert.equal(applyMask('2026-09-29', 'Day DD Month', 'en'), 'Tuesday 29 September');
    assert.equal(applyMask('2026-09-29', 'dy dd mon yy', 'nl'), 'di 29 sep 26');
    assert.equal(applyMask('2026-09-29 14:05:09+00', 'HH24:MI:SS HH12 AM', 'en'), '14:05:09 02 PM');
    assert.equal(applyMask('2026-09-29', 'DD "de" MONTH', 'es'), '29 de SEPTIEMBRE');
    assert.equal(applyMask('not a date', 'DD', 'en'), 'not a date');
  });
});

describe('text messages', () => {
  test('meta.message() with parameters and fallback to the primary language', async () => {
    await owner.query(`insert into meta.text_message (app_id, name, language, text) values ($1, 'TEST_HELLO', 'en', 'Hello %0, you have %1 items')
      on conflict do nothing`, [appId]);
    try {
      const run = async (lang: string) => {
        const c = await owner.pool.connect();
        try {
          await c.query('begin');
          await c.query(`select set_config('pgapex.app_id', $1, true), set_config('pgapex.lang', $2, true)`, [String(appId), lang]);
          return (await c.query(`select meta.message('test_hello', 'Ann', '3') as m, meta.message('NO_SUCH') as n`)).rows[0];
        } finally {
          await c.query('rollback');
          c.release();
        }
      };
      assert.deepEqual(await run('en'), { m: 'Hello Ann, you have 3 items', n: 'NO_SUCH' });
      assert.equal((await run('nl')).m, 'Hello Ann, you have 3 items', 'falls back to the primary language');
      await owner.query(`insert into meta.text_message (app_id, name, language, text) values ($1, 'TEST_HELLO', 'nl', 'Hallo %0, je hebt %1 items')`, [appId]);
      assert.equal((await run('nl-BE')).m, 'Hallo Ann, je hebt 3 items', 'base language');
    } finally {
      await owner.query(`delete from meta.text_message where app_id = $1 and name = 'TEST_HELLO'`, [appId]);
    }
  });

  test('&APP_TEXT$NAME. substitutions and overriding pgapex’s own texts', async () => {
    await owner.query(`insert into meta.text_message (app_id, name, language, text) values ($1, 'login.title', 'nl', 'Inloggen bij HR'), ($1, 'login.submit', 'nl', 'Inloggen')`, [appId]);
    clearLocaleCache(appId);
    try {
      const body = (await dutch().get('/a/hr/login')).body;
      assert.match(body, /<title>Inloggen bij HR/);
      assert.match(body, />Inloggen<\/button>/);
    } finally {
      await owner.query(`delete from meta.text_message where app_id = $1 and name in ('login.title', 'login.submit')`, [appId]);
      clearLocaleCache(appId);
    }
  });

  test('pgapex texts: every Dutch text exists and placeholders match', () => {
    const t = translator('nl');
    assert.equal(t('report.range', { from: 1, to: 15, total: 40 }), '1–15 van 40');
    assert.equal(translator('nl-BE')('login.submit'), 'Aanmelden');
    assert.equal(translator('fr')('login.submit'), 'Sign in', 'unknown languages fall back to English');
  });
});

describe('builder: globalization', () => {
  test('XLIFF and CSV round trips', () => {
    const rows = [{ text: 'Tom & Jerry <b>', places: 'page 1', target: 'Tom & "Jerry"' }, { text: 'a,b\nc', places: 'nav', target: '' }];
    const x = fromXliff(toXliff('hr', 'en', 'nl', rows));
    assert.equal(x.lang, 'nl');
    assert.deepEqual(x.pairs, [['Tom & Jerry <b>', 'Tom & "Jerry"'], ['a,b\nc', '']]);
    const csv = parseCsv(toCsv(rows));
    assert.deepEqual(csv[1].slice(0, 2), ['Tom & Jerry <b>', 'Tom & "Jerry"']);
    assert.deepEqual(csv[2].slice(0, 2), ['a,b\nc', '']);
  });

  test('developers translate, export and import', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = await b.get(`/builder/apps/${appId}/globalization?lang=nl`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /texts translated/);
    const xlf = await b.get(`/builder/apps/${appId}/globalization/export?lang=nl&format=xliff`);
    assert.match(xlf.body, /<source>Employees<\/source>\s*<target>Medewerkers<\/target>/);
    const doc = xlf.body.replace('<target>Medewerkers</target>', '<target>Werknemers</target>');
    await b.get(`/builder/apps/${appId}/globalization?lang=nl`);
    await b.submit(`/builder/apps/${appId}/globalization/import`, { lang: 'nl', doc });
    try {
      assert.equal((await owner.one(`select target from meta.translation where app_id = $1 and language = 'nl' and source = 'Employees'`, [appId])).target, 'Werknemers');
    } finally {
      await owner.query(`update meta.translation set target = 'Medewerkers' where app_id = $1 and language = 'nl' and source = 'Employees'`, [appId]);
      clearLocaleCache(appId);
    }
    await b.get(`/builder/apps/${appId}/globalization`);
    const bad = await b.submit(`/builder/apps/${appId}/globalization/import`, { lang: 'nl', doc: doc.replace('target-language="nl"', 'target-language="de"') });
    assert.equal(bad.statusCode, 303);
    assert.match((await b.get(`/builder/apps/${appId}/globalization`)).body, /not a translated language/);
  });

  test('export and import keep text messages, translations and e-mail templates', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.ok(doc.translations.length > 50);
    assert.ok(doc.text_messages.some((m: { name: string }) => m.name === 'KPI_PAYROLL'));
    assert.ok(doc.email_templates.some((t: { static_id: string }) => t.static_id === 'LEAVE_DECIDED'));
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_copy_i18n') as id`, [JSON.stringify(doc)])).id;
    try {
      const n = await owner.one(
        `select (select count(*) from meta.translation where app_id = $1)::int as t, (select count(*) from meta.text_message where app_id = $1)::int as m,
                (select count(*) from meta.email_template where app_id = $1)::int as e`, [id]);
      assert.deepEqual(n, { t: doc.translations.length, m: doc.text_messages.length, e: doc.email_templates.length });
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });
});
