// Sprint 31 globalization: number format masks on columns, charts and items
// (HR page 29), the automatic time zone (browser, My account, app default,
// SET LOCAL timezone) and the built-in texts in German, French and Spanish.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { appTx, closePools, owner } from '../src/db.ts';
import { BUILTIN_LANGUAGES, builtinTexts, translator } from '../src/i18n.ts';
import { formatMaskError, formatSettingsProblem, maskedFormatter, dateFormatter } from '../src/runtime/format.ts';
import { sameOffset, zoneOffset } from '../src/runtime/locale.ts';
import { mergeReportSettings, formatProblems } from '../src/builder/report-settings.ts';
import { EN_SYMBOLS, numberSymbols } from '../src/numformat.ts';
import { Browser, pdfText } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let saved: { username: string; language: string | null; time_zone: string | null }[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  saved = (await owner.query(`select username, language, time_zone from meta.account where username in ('king', 'blake')`)).rows;
  await owner.query(`update meta.account set language = null, time_zone = null where username in ('king', 'blake')`);
});

after(async () => {
  for (const s of saved) await owner.query('update meta.account set language = $2, time_zone = $3 where username = $1', [s.username, s.language, s.time_zone]);
  await owner.query(`update meta.app set time_zone_auto = true, time_zone = null, currency = 'EUR' where id = $1`, [appId]);
  await app.close();
  await closePools();
});

const as = async (user: string, headers: Record<string, string> = {}) => {
  const b = new Browser(app, headers);
  const res = await b.login(user);
  assert.equal(res.statusCode, 303, `login as ${user}`);
  return b;
};
const text = (body: string) => body.replace(/\s+/g, ' ');
const cellOf = (body: string, label: string) => [...text(body).matchAll(new RegExp(`data-label="${label}">([^<]*)<`, 'g'))].map((m) => m[1]);
const region = async (title: string) =>
  (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 29 and r.title = $2`, [appId, title])).id as number;

describe('number format masks (HR page 29)', () => {
  test('report columns: currency, groups, percent and leading zeros in English', async () => {
    const king = await as('king');
    const body = (await king.get('/a/hr/29?lang=en')).body;
    assert.ok(cellOf(body, 'Salary').includes('€5,000.00'), 'salary');
    assert.ok(cellOf(body, 'Per year').includes('60,000'), 'yearly');
    assert.ok(cellOf(body, 'Number').includes('07839'), 'empno');
    assert.match(cellOf(body, 'Commission \\(% of salary\\)').join(' '), /\d+\.\d%/);
    assert.ok(cellOf(body, 'Hired').includes('17 NOV 1981'), 'a date mask on a date column');
    // a metric card and the chart's values
    assert.match(text(body), /<span class="metric-value">€\d{3},\d{3}<\/span>/);
    assert.match(text(body), /data-tip="ACCOUNTING: €2,916\.67"/);
  });

  test('the same masks with Dutch separators', async () => {
    const king = await as('king');
    const body = (await king.get('/a/hr/29?lang=nl')).body;
    assert.ok(cellOf(body, 'Salaris').includes('€5.000,00'));
    assert.ok(cellOf(body, 'Per jaar').includes('60.000'));
    assert.match(text(body), /data-tip="ACCOUNTING: €2\.916,67"/);
    assert.match(cellOf(body, 'In dienst').join(' '), /17 NOV 1981/);
  });

  test('aggregates and control breaks keep the column mask (counts stay plain)', async () => {
    const king = await as('king');
    const r = await region('Salaries');
    const body = (await king.get(`/a/hr/29?lang=en&r${r}_a=sum|salary&r${r}_a=count|salary`)).body;
    assert.match(text(body), /Sum: €\d{1,3},\d{3}\.\d{2}/);
    assert.match(text(body), /Count: \d+</);
  });

  test('group by and pivot views use the masks', async () => {
    const king = await as('king');
    const r = await region('Salaries');
    const body = (await king.get(`/a/hr/29?lang=en&r${r}_v=group&r${r}_g=job&r${r}_gf=sum|salary`)).body;
    assert.match(text(body), /€\d{1,3}(,\d{3})*\.\d{2}/);
  });

  test('downloads: CSV and Excel keep raw numbers, the PDF prints the masks', async () => {
    const king = await as('king');
    const r = await region('Salaries');
    const csv = (await king.get(`/a/hr/29?r${r}_csv=1`)).body;
    assert.match(csv, /7839,King,President,5000\.00,60000\.00,/);
    const pdf = await king.request('GET', `/a/hr/29?r${r}_pdf=1&lang=en`);
    assert.equal(pdf.statusCode, 200);
    assert.match(pdfText(pdf.rawPayload), /5,000\.00/);
  });

  test('a number item with a mask: typed in the language, read back, shown formatted', async () => {
    const king = await as('king');
    await king.get('/a/hr/29?lang=nl');
    let res = await king.submit('/a/hr/29', { P29_AMOUNT: '1.234,50', __request: 'CONVERT' });
    assert.equal(res.statusCode, 303);
    let body = (await king.get('/a/hr/29')).body;
    assert.match(body, /<input type="text" id="P29_AMOUNT" name="P29_AMOUNT" value="1\.234,50" inputmode="decimal"/);
    assert.match(body, /id="P29_WITH_VAT">€1\.493,75</);
    // English: the same number in English notation
    await king.get('/a/hr/29?lang=en');
    body = (await king.get('/a/hr/29')).body;
    assert.match(body, /value="1,234\.50"/);
    res = await king.submit('/a/hr/29', { P29_AMOUNT: '2,000', __request: 'CONVERT' });
    body = (await king.get('/a/hr/29')).body;
    assert.match(body, /id="P29_WITH_VAT">€2,420\.00</);
  });

  test('text that is not a number is an error that shows an example, and the process does not run', async () => {
    const king = await as('king');
    await king.get('/a/hr/29?lang=en');
    const res = await king.submit('/a/hr/29', { P29_AMOUNT: '12,34', __request: 'CONVERT' });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /Amount must be a number, e\.g\. 1,234\.50\./);
    assert.match(res.body, /value="12,34"/);
    const nl = await king.submit('/a/hr/29?lang=nl', { P29_AMOUNT: 'twaalf', __request: 'CONVERT' });
    assert.match(nl.body, /Bedrag moet een getal zijn, bijvoorbeeld 1\.234,50\./);
  });

  test('a number item without a mask must hold a plain number', async () => {
    const king = await as('king');
    const page = (await owner.one(`select p.id from meta.page p where p.app_id = $1 and p.page_no = 29`, [appId])).id;
    await owner.query(`update meta.item set config = '{}' where page_id = $1 and name = 'P29_AMOUNT'`, [page]);
    try {
      const body = (await king.get('/a/hr/29?lang=en')).body;
      assert.match(body, /<input type="number" id="P29_AMOUNT"/);
      const res = await king.submit('/a/hr/29', { P29_AMOUNT: '1,5', __request: 'CONVERT' });
      assert.equal(res.statusCode, 422);
      assert.match(res.body, /Amount must be a number\./);
    } finally {
      await owner.query(`update meta.item set config = '{"format_mask": "999G999G990D00"}' where page_id = $1 and name = 'P29_AMOUNT'`, [page]);
    }
  });

  test('maskedFormatter: number masks for numbers, date masks for dates, the base for the rest', () => {
    const base = dateFormatter('en', 'YYYY/MM/DD', null);
    const f = maskedFormatter(base, 'en', EN_SYMBOLS, '999G990D00');
    assert.equal(f('1234.5', 1700), '1,234.50');
    assert.equal(f(12, 23), '12.00');
    assert.equal(f('2026-10-05', 1082), '2026/10/05');
    assert.equal(f('abc', 25), undefined);
    const d = maskedFormatter(base, 'en', EN_SYMBOLS, 'DD.MM.YYYY');
    assert.equal(d('2026-10-05', 1082), '05.10.2026');
    assert.equal(d('1234.5', 1700), undefined);
    assert.equal(maskedFormatter(base, 'en', EN_SYMBOLS, ''), base);
    assert.equal(maskedFormatter(base, 'de', numberSymbols('de', 'EUR'), 'FML999G990D00')('1234.5', 1700), '€1.234,50');
  });

  test('format settings are checked in the builder', () => {
    assert.equal(formatMaskError('999G990D00'), null);
    assert.equal(formatMaskError('DD-MON-YYYY'), null);
    assert.match(formatMaskError('99G') ?? '', /followed by a digit/);
    assert.equal(formatSettingsProblem('{"formats": {"sal": "FML999G990D00"}, "format_mask": "990"}'), null);
    assert.match(formatSettingsProblem({ formats: { sal: '9G' } }) ?? '', /^formats\.sal:/);
    assert.match(formatSettingsProblem({ formats: ['x'] }) ?? '', /formats: an object/);
    assert.match(formatSettingsProblem({ format_mask: 'abc' }) ?? '', /^format_mask:/);
    assert.equal(formatSettingsProblem('not json'), null);
    const merged = mergeReportSettings({}, { n: '2', col_0: 'sal', fmt_0: 'FML999G990D00', shown_0: 'true', col_1: 'comm', fmt_1: '9G', shown_1: 'true' }, new Set(), new Set(), new Set());
    assert.deepEqual(merged.formats, { sal: 'FML999G990D00' });
    assert.deepEqual(formatProblems({ n: '2', col_0: 'sal', fmt_0: 'FML999G990D00', col_1: 'comm', fmt_1: '9G' }), ['comm: a group separator must be followed by a digit']);
  });

  test('the builder saves column masks from Report settings and refuses bad ones in the attributes', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const r = await region('Salaries');
    const page = (await owner.one('select page_id, config from meta.region where id = $1', [r]));
    const before = page.config;
    try {
      const form = (await dev.get(`/builder/pages/${page.page_id}?c=region-${r}`)).body;
      assert.match(form, /name="fmt_\d+" value="FML999G990D00"/);
      const res = await dev.post(`/builder/pages/${page.page_id}/region/${r}/report-settings`, {
        __csrf: dev.lastCsrf, n: '2', col_0: 'salary', fmt_0: '999G990', shown_0: 'true', print_0: 'true', col_1: 'yearly', fmt_1: 'G9', shown_1: 'true', print_1: 'true',
      });
      assert.equal(res.statusCode, 303);
      const after = (await owner.one('select config from meta.region where id = $1', [r])).config;
      assert.deepEqual(after.formats, { salary: '999G990' });
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [r, before]);
    }
  });
});

describe('time zones', () => {
  test('appTx runs the queries in the request\'s time zone', async () => {
    const ctx = { appId, alias: 'hr', dbRole: null, appUser: 'king', sessionId: '0', lang: 'en' };
    const tz = (zone?: string | null) => appTx({ ...ctx, timeZone: zone }, async (c) => (await c.query(`select current_setting('TimeZone') as tz, '2026-01-01 12:00:00+00'::timestamptz::text as t`)).rows[0]);
    assert.deepEqual(await tz('Asia/Tokyo'), { tz: 'Asia/Tokyo', t: '2026-01-01 21:00:00+09' });
    const db = await tz(null);
    assert.notEqual(db.tz, 'Asia/Tokyo');
    // SET LOCAL: the next transaction on the pooled connection is back to the default
    assert.equal((await owner.one(`select current_setting('TimeZone') as tz`)).tz, db.tz);
  });

  test('offsets compare time zones (UTC and Etc/UTC are the same)', () => {
    assert.equal(sameOffset('UTC', 'Etc/UTC'), true);
    assert.equal(sameOffset('Europe/Amsterdam', 'Asia/Tokyo'), false);
    assert.equal(zoneOffset('No/Such_Zone'), null);
    assert.equal(sameOffset('No/Such_Zone', 'UTC'), false);
  });

  test('the browser\'s time zone, sent once, changes the times on the page', async () => {
    const king = await as('king');
    let body = (await king.get('/a/hr/29?lang=en')).body;
    // the page asks app.js for the browser's time zone
    assert.match(body, /"tz":"\/a\/hr\/tz"/);
    const res = await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz: 'Asia/Tokyo' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reload, true);
    body = (await king.get('/a/hr/29')).body;
    assert.ok(cellOf(body, 'Time zone').includes('Asia/Tokyo'));
    assert.match(cellOf(body, 'Time now')[0], /^\d{2} [A-Z]{3} \d{4} \d{2}:\d{2}:\d{2}$/);
    assert.doesNotMatch(body, /"tz":"\/a\/hr\/tz"/, 'asked once per session');
    // the same zone again: nothing to reload
    assert.equal((await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz: 'Asia/Tokyo' })).json().reload, false);
  });

  test('the sign-in form carries the browser\'s time zone into the new session', async () => {
    const b = new Browser(app);
    const login = (await b.get('/a/hr/login')).body;
    assert.match(login, /<input type="hidden" name="__tz" value="">/);
    const res = await b.post('/a/hr/login', { __csrf: b.lastCsrf, username: 'blake', password: 'blake', __tz: 'America/New_York' });
    assert.equal(res.statusCode, 303);
    const body = (await b.get('/a/hr/29')).body;
    assert.ok(cellOf(body, 'Time zone').includes('America/New_York'));
  });

  test('My account: the user\'s own time zone wins over the browser\'s and is kept on the account', async () => {
    const king = await as('king');
    await king.get('/a/hr/29');
    await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz: 'Asia/Tokyo' });
    let page = (await king.get('/a/hr/account?lang=en')).body;
    assert.match(page, /<select id="time_zone" name="time_zone"/);
    assert.match(page, /Automatic \(the browser&#39;s: Asia\/Tokyo\)|Automatic \(the browser's: Asia\/Tokyo\)/);
    assert.match(page, /<option value="Europe\/Lisbon">/);
    let res = await king.post('/a/hr/account', { __csrf: king.lastCsrf, time_zone: 'Europe/Lisbon' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one(`select time_zone from meta.account where username = 'king'`)).time_zone, 'Europe/Lisbon');
    assert.ok(cellOf((await king.get('/a/hr/29')).body, 'Time zone').includes('Europe/Lisbon'));
    // the next sign-in brings it back
    const again = await as('king');
    assert.ok(cellOf((await again.get('/a/hr/29')).body, 'Time zone').includes('Europe/Lisbon'));
    page = (await again.get('/a/hr/account')).body;
    assert.match(page, /<option value="Europe\/Lisbon" selected>/);
    // automatic again: the browser's (or the app's) time zone
    res = await again.post('/a/hr/account', { __csrf: again.lastCsrf, time_zone: '' });
    assert.equal(res.statusCode, 303);
    assert.equal((await owner.one(`select time_zone from meta.account where username = 'king'`)).time_zone, null);
  });

  test('the app\'s time zone applies without the automatic one, and when the browser sent nothing', async () => {
    await owner.query(`update meta.app set time_zone = 'Australia/Sydney' where id = $1`, [appId]);
    try {
      const king = await as('king');
      assert.ok(cellOf((await king.get('/a/hr/29')).body, 'Time zone').includes('Australia/Sydney'));
      await owner.query(`update meta.app set time_zone_auto = false where id = $1`, [appId]);
      // the browser's time zone is not taken, nor asked for
      assert.equal((await king.post('/a/hr/tz', { __csrf: king.lastCsrf, tz: 'Asia/Tokyo' })).json().reload, false);
      const body = (await king.get('/a/hr/29')).body;
      assert.ok(cellOf(body, 'Time zone').includes('Australia/Sydney'));
      assert.doesNotMatch(body, /"tz":/);
      assert.doesNotMatch((await king.get('/a/hr/account')).body, /name="time_zone"/);
    } finally {
      await owner.query(`update meta.app set time_zone = null, time_zone_auto = true where id = $1`, [appId]);
    }
  });

  test('Settings: the time zone must be one PostgreSQL knows, the currency an ISO code', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.post('/builder/login', { __csrf: dev.lastCsrf, username: 'admin', password: 'admin' });
    const page = (await dev.get(`/builder/apps/${appId}/settings`)).body;
    assert.match(page, /name="time_zone_auto" value="true" checked/);
    assert.match(page, /<option value="Europe\/Amsterdam">/);
    assert.match(page, /name="currency"[^>]*value="EUR"/);
  });
});

describe('built-in texts in German, French and Spanish', () => {
  test('every language has every text, with the same placeholders', () => {
    const en = builtinTexts('en')!;
    const holes = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join(' ');
    for (const [lang] of BUILTIN_LANGUAGES) {
      const own = builtinTexts(lang)!;
      assert.deepEqual(Object.keys(own).sort(), Object.keys(en).sort(), `${lang}: the same keys`);
      for (const k of Object.keys(en)) assert.equal(holes(own[k]), holes(en[k]), `${lang} ${k}: the same placeholders`);
      if (lang !== 'en') assert.notEqual(translator(lang)('login.title'), translator('en')('login.title'), `${lang} login.title`);
    }
    assert.deepEqual(BUILTIN_LANGUAGES.map(([l]) => l), ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl']);
  });

  for (const [lang, title, required] of [['de', 'Anmelden', /ist erforderlich|muss/], ['fr', 'Se connecter', /obligatoire/], ['es', 'Iniciar sesión', /obligatorio/]] as const)
    test(`${lang}: the sign-in page and messages`, async () => {
      const b = new Browser(app, { 'accept-language': `${lang},en;q=0.5` });
      await owner.query(`update meta.app set languages = array['nl', 'de', 'fr', 'es'] where id = $1`, [appId]);
      try {
        const body = (await b.get('/a/hr/login')).body;
        assert.match(body, new RegExp(`<html lang="${lang}"`));
        assert.match(body, new RegExp(title));
        assert.match(translator(lang)('error.required', { label: 'X' }), required);
      } finally {
        await owner.query(`update meta.app set languages = array['nl'] where id = $1`, [appId]);
      }
    });
});
