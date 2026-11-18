// Sprint 224 (parity: REST data sources, "Missing: XML / SOAP"): a REST data source reads an XML response (by its
// content type) with the same row selector and column paths as JSON, through xmlToJson (src/xml.ts: no DTDs, no
// entities, limits); a body template in XML (a SOAP envelope) gets XML-escaped values and an XML content type; a SOAP
// fault's code is named in the error, never its text.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const ws = await import('../src/websources.ts');
const { xmlToJson } = await import('../src/xml.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
let mock: http.Server;
let mockBase = '';
let appId: number;
const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a catalogue -->
<c:catalog xmlns:c="urn:example:catalog" updated="2026-11-18">
  <c:book id="b1" lang="en"><title>PostgreSQL &amp; you</title><price currency="EUR">39.50</price><published>2026-03-01</published><tags><tag>db</tag><tag>sql</tag></tags></c:book>
  <c:book id="b2"><title><![CDATA[APEX <and> pgkiln]]></title><price currency="USD">12</price><published/></c:book>
</c:catalog>`;
const soap = (inner: string) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, 'http://x');
      const send = (status: number, type: string | null, text: string) => {
        res.writeHead(status, type ? { 'content-type': type } : {});
        res.end(text);
      };
      if (u.pathname === '/catalog') return send(200, 'application/xml; charset=utf-8', CATALOG);
      if (u.pathname === '/plain') return send(200, null, CATALOG);
      if (u.pathname === '/html') return send(200, 'text/html', '<html><body><p>Sign in</p></body></html>');
      if (u.pathname === '/doctype') return send(200, 'text/xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>');
      if (u.pathname === '/soap') {
        const city = /<city>([^<]*)<\/city>/.exec(body)?.[1] ?? '';
        if (city === 'nowhere')
          return send(500, 'text/xml; charset=utf-8', soap('<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unknown city: secret-internal-detail</faultstring></soap:Fault>'));
        return send(200, 'text/xml; charset=utf-8', soap(`<GetForecastResponse xmlns="urn:weather"><Forecast day="2026-11-18"><Temp>7.5</Temp><City>${city}</City></Forecast><Forecast day="2026-11-19"><Temp>9</Temp><City>${city}</City></Forecast></GetForecastResponse>`));
      }
      send(404, 'text/plain', 'not found');
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'T224%'`, [appId]);
});
after(async () => {
  await owner.query(`delete from meta.rest_source where app_id = $1 and name like 'T224%'`, [appId]);
  mock.close();
  await app.close();
  await closePools();
});

const source = async (name: string, over: Record<string, unknown>) => {
  const v = { url: `${mockBase}/catalog`, method: 'GET', params: [], body: null, row_selector: null, columns: [], ...over };
  await owner.query(`insert into meta.rest_source (app_id, name, url, method, params, body, row_selector, columns, headers) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [appId, name, v.url, v.method, JSON.stringify(v.params), v.body, v.row_selector, JSON.stringify(v.columns), JSON.stringify(over.headers ?? {})]);
  return ws.loadSource(appId, name);
};

describe('XML as JSON', () => {
  test('attributes, repeated elements, text, CDATA, namespaces', () => {
    const doc = xmlToJson(CATALOG) as any;
    assert.deepEqual(Object.keys(doc), ['catalog']);
    assert.equal(doc.catalog['@updated'], '2026-11-18');
    assert.equal(doc.catalog.book.length, 2);
    assert.deepEqual(doc.catalog.book[0], {
      '@id': 'b1', '@lang': 'en', title: 'PostgreSQL & you', price: { '@currency': 'EUR', '#text': '39.50' }, published: '2026-03-01', tags: { tag: ['db', 'sql'] },
    });
    assert.equal(doc.catalog.book[1].title, 'APEX <and> pgkiln');
    assert.equal(doc.catalog.book[1].published, null);
    // one element is an object, not an array
    assert.deepEqual(xmlToJson('<a><b>1</b></a>'), { a: { b: '1' } });
    assert.deepEqual(xmlToJson('<a/>'), { a: null });
  });

  test('safe: no DTD, no entities, __proto__ is a plain key, limits', () => {
    assert.throws(() => xmlToJson('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), /document type declaration/);
    assert.throws(() => xmlToJson('<x>&ext;</x>'), /Undefined entity/);
    const doc = xmlToJson('<x><__proto__><polluted>yes</polluted></__proto__></x>') as any;
    assert.equal(({} as any).polluted, undefined);
    assert.deepEqual(doc.x.__proto__, { polluted: 'yes' });
    assert.throws(() => xmlToJson(`${'<a>'.repeat(200)}${'</a>'.repeat(200)}`), /deeper/);
  });

  test('an XML body template: values escaped, an XML content type', () => {
    const s = { id: 1, app_id: 1, name: 'X', url: 'https://x/soap', method: 'POST', credential: null, headers: { SOAPAction: '"urn:GetForecast"' },
      params: [{ name: 'city', in: 'body' as const }], body: '<Envelope><city>{city}</city></Envelope>', row_selector: null, columns: [], cache_seconds: 0, timeout_s: 10, max_rows: 100 };
    const r = ws.buildRequest(s, { city: `A&B <"x">'` });
    assert.equal(r.body, '<Envelope><city>A&amp;B &lt;&quot;x&quot;&gt;&apos;</city></Envelope>');
    assert.equal(r.headers['content-type'], 'text/xml; charset=utf-8');
    assert.equal(r.headers.soapaction, '"urn:GetForecast"');
    // a JSON template is unchanged
    assert.equal(ws.buildRequest({ ...s, body: '{"city": {city}}' }, { city: 'A"B' }).body, '{"city": "A\\"B"}');
  });
});

describe('a REST data source of XML', () => {
  test('rows by the row selector, columns by attribute and element paths, typed', async () => {
    const s = await source('T224_BOOKS', {
      row_selector: 'catalog.book',
      columns: [{ name: 'id', path: '@id', type: 'text' }, { name: 'title', type: 'text' }, { name: 'price', path: 'price.#text', type: 'number' },
        { name: 'currency', path: 'price.@currency' }, { name: 'published', type: 'date' }, { name: 'tags', path: 'tags.tag', type: 'json' }],
    });
    const { json } = await ws.fetchSource(s, {});
    const { rows } = ws.toRows(json, s);
    assert.deepEqual(rows, [
      { id: 'b1', title: 'PostgreSQL & you', price: 39.5, currency: 'EUR', published: '2026-03-01', tags: ['db', 'sql'] },
      { id: 'b2', title: 'APEX <and> pgkiln', price: 12, currency: 'USD', published: null, tags: null },
    ]);
    // in SQL, as the regions read them
    const sql = ws.withRest(ws.rowsSql(s.columns, rows), 'select title from rest where price > 20');
    assert.deepEqual((await owner.query(sql)).rows, [{ title: 'PostgreSQL & you' }]);
  });

  test('without a content type, XML is recognised; HTML and a DTD are errors', async () => {
    const plain = await source('T224_PLAIN', { url: `${mockBase}/plain`, row_selector: 'catalog.book' });
    assert.equal(ws.toRows((await ws.fetchSource(plain, {})).json, plain).rows.length, 2);
    await assert.rejects(ws.fetchSource(await source('T224_HTML', { url: `${mockBase}/html` }), {}), /not JSON/);
    await assert.rejects(ws.fetchSource(await source('T224_DTD', { url: `${mockBase}/doctype` }), {}), /not well-formed XML: XML with a document type declaration/);
  });

  test('SOAP: an envelope with escaped values; the response\'s rows; a fault names its code only', async () => {
    const s = await source('T224_SOAP', {
      url: `${mockBase}/soap`, method: 'POST', headers: { SOAPAction: '"urn:weather#GetForecast"' },
      params: [{ name: 'city', in: 'body' }],
      body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetForecast xmlns="urn:weather"><city>{city}</city></GetForecast></soap:Body></soap:Envelope>',
      row_selector: 'Envelope.Body.GetForecastResponse.Forecast',
      columns: [{ name: 'day', path: '@day', type: 'date' }, { name: 'temp', path: 'Temp', type: 'number' }, { name: 'city', path: 'City' }],
    });
    const n = seen.length;
    const { rows } = ws.toRows((await ws.fetchSource(s, { city: 'Den Haag & <Delft>' })).json, s);
    assert.deepEqual(rows, [{ day: '2026-11-18', temp: 7.5, city: 'Den Haag & <Delft>' }, { day: '2026-11-19', temp: 9, city: 'Den Haag & <Delft>' }]);
    const req = seen[n];
    assert.match(req.body, /<city>Den Haag &amp; &lt;Delft&gt;<\/city>/);
    assert.equal(req.headers['content-type'], 'text/xml; charset=utf-8');
    assert.equal(req.headers.soapaction, '"urn:weather#GetForecast"');
    const err = await ws.fetchSource(s, { city: 'nowhere' }).catch((e: Error) => e);
    assert.match((err as Error).message, /answered 500 \(SOAP fault: Client\)/);
    assert.doesNotMatch((err as Error).message, /secret-internal-detail/);
  });

  test('the builder\'s Test shows the rows and suggests columns of an XML source', async () => {
    const s = await source('T224_TEST', { row_selector: 'catalog.book' });
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    await b.get(`/builder/apps/${appId}/shared?c=rest_source-${s.id}`);
    await b.submit(`/builder/apps/${appId}/rest-sources/${s.id}/test`, {});
    const page = (await b.get(`/builder/apps/${appId}/shared?c=rest_source-${s.id}`)).body;
    assert.match(page, /200 in \d+ ms: 2 row\(s\)/);
    assert.match(page, /PostgreSQL &amp;amp; you|PostgreSQL &amp; you/);
    // the suggestion: attributes as quoted paths
    assert.match(page, /&quot;@id&quot;|\\&quot;@id\\&quot;|@id/);
  });
});

describe('HR part 93: the departments as XML', () => {
  test('the media handler answers XML; the source reads it; page 23 shows it', async () => {
    const res = await app.inject({ method: 'GET', url: '/a/hr/rest/v1/departments.xml' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /application\/xml/);
    assert.match(res.body, /^(<\?xml version="1.0"\?>)?<departments><department id="10"><name>ACCOUNTING<\/name>/);
    const doc = xmlToJson(res.body) as any;
    const s = await ws.loadSource(appId, 'DEPARTMENTS_XML');
    const { rows } = ws.toRows(doc, s);
    assert.deepEqual(rows[0], { deptno: 10, dname: 'ACCOUNTING', location: 'New York' });
    assert.ok(await owner.one(`select 1 from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 23 and r.rest_source = 'DEPARTMENTS_XML'`, [appId]));
  });
});
