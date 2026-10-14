// Sprint 67: REST source catalogs (migration 095). The OpenAPI 3 / Swagger 2
// reader (paths, parameters with the service's own names, rows and columns,
// write-back operations, notes), catalog files, the builder's pages, and a REST
// data source made from a catalog service in an application.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { catalogDocument, fromOpenApi, readCatalogText, snake, serviceName, wholeCatalogProblems } from '../src/restcatalog.ts';
import { buildRequest, type RestSource } from '../src/websources.ts';
import { Browser } from './helpers.ts';

export const PETSTORE = {
  openapi: '3.0.3',
  info: { title: 'S67 Petstore', version: '1.0.7', description: 'Pets for sale.' },
  servers: [{ url: 'https://petstore.example.com/{basePath}', variables: { basePath: { default: 'v1' } } }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets', summary: 'List all pets',
        parameters: [
          { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'X-Request-ID', in: 'header', schema: { type: 'string' } },
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Pet' } }, total: { type: 'integer' } } } } } } },
      },
      post: { operationId: 'createPet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } }, responses: { 201: { description: 'created' } } },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'showPetById', responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      put: { operationId: 'updatePet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } }, responses: { 200: { description: 'ok' } } },
      delete: { operationId: 'deletePet', responses: { 204: { description: 'gone' } } },
      head: { responses: { 200: { description: 'there' } } },
    },
  },
  components: {
    schemas: {
      NewPet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tag: { type: 'string' }, birthDate: { type: 'string', format: 'date' }, owner: { type: 'object' } } },
      Pet: { allOf: [{ $ref: '#/components/schemas/NewPet' }, { type: 'object', properties: { id: { type: 'integer' }, 'created-at': { type: 'string', format: 'date-time' }, weight: { type: 'number' }, sold: { type: 'boolean' } } }] },
    },
  },
};

const SWAGGER = {
  swagger: '2.0',
  info: { title: 'S67 Orders', version: '2' },
  host: 'orders.example.com',
  basePath: '/api',
  schemes: ['http', 'https'],
  paths: {
    '/orders': {
      get: { operationId: 'getOrders', parameters: [{ name: 'status', in: 'query', type: 'string', enum: ['open', 'closed'], required: true }], responses: { 200: { schema: { type: 'array', items: { $ref: '#/definitions/Order' } } } } },
      post: { operationId: 'addOrder', parameters: [{ name: 'order', in: 'body', schema: { $ref: '#/definitions/Order' } }, { name: 'file', in: 'formData', type: 'file' }], responses: { 201: { description: 'ok' } } },
    },
  },
  definitions: { Order: { type: 'object', properties: { orderId: { type: 'integer' }, placed: { type: 'string', format: 'date-time' }, lines: { type: 'array', items: { type: 'object' } } } } },
};

let app: FastifyInstance;
let mock: http.Server;
let mockBase = '';
let admin: Browser;
let dev: Browser;
let wsId: number;
let appId: number;
const DEV = 's67_dev';
const DEV_PW = 'S67-dev-password!';

async function cleanup() {
  await owner.query(`delete from meta.rest_catalog where name like 'S67%'`);
  await owner.query(`delete from meta.workspace where name = 'S67 Other'`);
  await owner.query(`delete from meta.developer where username = $1`, [DEV]);
  await owner.query(`delete from meta.rest_source where name like 'S67\\_%' or name in ('LIST_PETS', 'GET_ORDERS')`);
}

before(async () => {
  await cleanup();
  mock = http.createServer((req, res) => {
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...PETSTORE, info: { ...PETSTORE.info, title: 'S67 From URL' }, servers: [{ url: '/v2' }] }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($2), false)`, [DEV, DEV_PW]);
  wsId = (await owner.one(`insert into meta.workspace (name) values ('S67 Other') returning id`)).id;
  await owner.query('delete from meta.workspace_member where username = $1', [DEV]);
  await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2)', [wsId, DEV]);
  admin = new Browser(app);
  await admin.get('/builder/login');
  await admin.submit('/builder/login', { username: 'admin', password: 'admin' });
  dev = new Browser(app);
  await dev.get('/builder/login');
  await dev.submit('/builder/login', { username: DEV, password: DEV_PW });
});

after(async () => {
  await cleanup();
  mock.close();
  await app.close();
  await closePools();
});

describe('reading an OpenAPI document', () => {
  test('OpenAPI 3: services, parameters under the service\'s own names, rows, columns and write-back', () => {
    const { catalog, notes } = fromOpenApi(PETSTORE);
    assert.equal(catalog.name, 'S67 Petstore');
    assert.equal(catalog.base_url, 'https://petstore.example.com/v1', 'the server variable\'s default');
    assert.equal(catalog.api_version, '1.0.7');
    assert.deepEqual(catalog.services.map((s) => `${s.name} ${s.method} ${s.path}`), [
      'LIST_PETS GET /pets', 'CREATE_PET POST /pets', 'SHOW_PET_BY_ID GET /pets/{pet_id}', 'UPDATE_PET PUT /pets/{pet_id}', 'DELETE_PET DELETE /pets/{pet_id}',
    ]);
    const list = catalog.services[0];
    assert.deepEqual(list.params, [
      { name: 'page_size', in: 'query', default: '20', key: 'pageSize' },
      { name: 'x_request_id', in: 'header', key: 'X-Request-ID' },
    ], 'no Authorization header and no cookie: a web credential signs in');
    assert.equal(list.row_selector, 'items');
    assert.deepEqual(list.columns.map((c) => `${c.name}:${c.type}:${c.path}`), [
      'name:text:name', 'tag:text:tag', 'birth_date:date:birthDate', 'owner:json:owner', 'id:integer:id', 'created_at:timestamp:$["created-at"]', 'weight:number:weight', 'sold:boolean:sold',
    ]);
    assert.deepEqual(list.key_columns, ['id']);
    assert.deepEqual(list.operations, { fetch: { method: 'GET', path: '/{id}' }, update: { method: 'PUT', path: '/{id}' }, delete: { method: 'DELETE', path: '/{id}' }, insert: { method: 'POST' } });
    assert.deepEqual(catalog.services[1].params, [{ name: 'name', in: 'body', required: true }, { name: 'tag', in: 'body' }, { name: 'birth_date', in: 'body', key: 'birthDate' }]);
    assert.ok(notes.some((n) => /Authorization header is left out/.test(n)), notes.join('\n'));
    assert.ok(notes.some((n) => /cookie parameter session is not supported/.test(n)));
    assert.ok(notes.some((n) => /HEAD \/pets\/\{petId\}: only GET, POST/.test(n)));
    assert.ok(notes.some((n) => /nested request body property/.test(n)), 'owner (an object) is not a body parameter');
    assert.deepEqual(wholeCatalogProblems(catalog), []);
  });

  test('Swagger 2.0: host, base path and https; a body parameter; an array response', () => {
    const { catalog, notes } = fromOpenApi(SWAGGER);
    assert.equal(catalog.base_url, 'https://orders.example.com/api');
    const [get, post] = catalog.services;
    assert.equal(get.name, 'GET_ORDERS');
    assert.deepEqual(get.params, [{ name: 'status', in: 'query', default: 'open', required: true }], 'a required enum defaults to its first value');
    assert.equal(get.row_selector, null);
    assert.deepEqual(get.columns.map((c) => `${c.name}:${c.type}`), ['order_id:integer', 'placed:timestamp', 'lines:json']);
    assert.deepEqual(post.params.map((p) => p.name), ['order_id', 'placed']);
    assert.ok(notes.some((n) => /formData parameter file/.test(n)));
    assert.deepEqual(wholeCatalogProblems(catalog), []);
  });

  test('a relative server URL needs the document\'s address or a base URL; circular references end', () => {
    const relative = { ...PETSTORE, servers: [{ url: '/v2' }] };
    assert.throws(() => fromOpenApi(relative), /enter the base URL/);
    assert.equal(fromOpenApi(relative, { from: 'https://api.example.org/docs/openapi.json' }).catalog.base_url, 'https://api.example.org/v2');
    assert.equal(fromOpenApi(relative, { baseUrl: 'https://test.example.org/x/' }).catalog.base_url, 'https://test.example.org/x');
    const loop = {
      openapi: '3.1.0', info: { title: 'Loop', version: '1' }, servers: [{ url: 'https://loop.example.com' }],
      paths: { '/a': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } } },
      components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } },
    };
    const { catalog, notes } = fromOpenApi(loop);
    assert.equal(catalog.services[0].name, 'GET_A');
    assert.ok(notes.some((n) => /too deep \(or circular\)/.test(n)));
  });

  test('not OpenAPI, OpenAPI 2 in YAML, an unsupported version: clear messages', () => {
    assert.throws(() => readCatalogText('{"a": 1}'), /not an OpenAPI 3 or Swagger 2\.0 document/);
    assert.throws(() => readCatalogText('openapi: 3.0.0\ninfo:\n  title: x\n'), /YAML: pgkiln reads JSON/);
    assert.throws(() => readCatalogText(JSON.stringify({ openapi: '4.0.0', paths: {} })), /OpenAPI 4\.0\.0 is not supported/);
  });

  test('names: parameters and columns in snake case, services in upper case', () => {
    assert.equal(snake('petId'), 'pet_id');
    assert.equal(snake('X-Request-ID'), 'x_request_id');
    assert.equal(snake('HTTPStatus'), 'http_status');
    assert.equal(snake('2fa'), '_2fa');
    assert.equal(serviceName('listPets'), 'LIST_PETS');
    assert.equal(serviceName('get_/v1/things/by_id'), 'GET_V1_THINGS_BY_ID');
    assert.equal(serviceName('123'), 'S_123');
  });

  test('a catalog file reads back as the same catalog', () => {
    const { catalog } = fromOpenApi(PETSTORE);
    const again = readCatalogText(JSON.stringify(catalogDocument(catalog))).catalog;
    assert.deepEqual(again, catalog);
  });
});

describe('parameters under the service\'s names', () => {
  test('query, header and body parameters are sent with their "key"', () => {
    const src = {
      id: 0, app_id: 0, name: 'S67_T', url: 'https://petstore.example.com/v1/pets', method: 'POST', credential: null, headers: {},
      params: [{ name: 'page_size', in: 'query', key: 'pageSize' }, { name: 'x_request_id', in: 'header', key: 'X-Request-ID' }, { name: 'birth_date', in: 'body', key: 'birthDate' }],
      body: null, row_selector: null, columns: [], cache_seconds: 0, timeout_s: 5, max_rows: 10,
    } as unknown as RestSource;
    const r = buildRequest(src, { page_size: '5', x_request_id: 'abc', birth_date: '2020-01-02' });
    assert.equal(r.url, 'https://petstore.example.com/v1/pets?pageSize=5');
    assert.equal(r.headers['x-request-id'], 'abc');
    assert.deepEqual(JSON.parse(r.body!), { birthDate: '2020-01-02' });
  });
});

describe('the builder', () => {
  let catalogId: number;

  test('Workspace utilities show the tile; a developer imports a pasted document into their workspace', async () => {
    assert.match((await dev.get('/builder/utilities')).body, /href="\/builder\/rest-catalogs"/);
    const list = await dev.get('/builder/rest-catalogs');
    assert.equal(list.statusCode, 200);
    const res = await dev.upload('/builder/rest-catalogs/import', { text: JSON.stringify(PETSTORE), url: '', base_url: '', name: '' }, {});
    assert.equal(res.statusCode, 303);
    catalogId = Number(/rest-catalogs\/(\d+)/.exec(res.headers.location as string)![1]);
    const c = await owner.one('select workspace_id, name, source, created_by from meta.rest_catalog where id = $1', [catalogId]);
    assert.deepEqual(c, { workspace_id: wsId, name: 'S67 Petstore', source: 'openapi', created_by: DEV });
    const page = (await dev.get(res.headers.location as string)).body;
    assert.match(page, /Catalog S67 Petstore imported with 5 service/);
    assert.match(page, /What the document had that the catalog doesn&#39;t use|What the document had that the catalog doesn't use/);
    assert.match(page, /LIST_PETS/);
    // the same name again in this workspace: refused
    const again = await dev.upload('/builder/rest-catalogs/import', { text: JSON.stringify(PETSTORE) }, {});
    assert.match((await dev.get(again.headers.location as string)).body, /has a catalog with that name already/);
  });

  test('a catalog from a URL (relative server: the document\'s own address)', async () => {
    const res = await dev.upload('/builder/rest-catalogs/import', { url: `${mockBase}/openapi.json` }, {});
    const id = Number(/rest-catalogs\/(\d+)/.exec(res.headers.location as string)?.[1]);
    assert.ok(id, (await dev.get(res.headers.location as string)).body.match(/alert[^<]*<[^<]*/)?.[0]);
    assert.equal((await owner.one('select base_url from meta.rest_catalog where id = $1', [id])).base_url, `${mockBase}/v2`);
  });

  test('a file upload; a service added, changed and refused when invalid; download and delete', async () => {
    const up = await dev.upload('/builder/rest-catalogs/import', { name: 'S67 Orders' }, { file: { name: 'orders.json', type: 'application/json', data: Buffer.from(JSON.stringify(SWAGGER)) } });
    const id = Number(/rest-catalogs\/(\d+)/.exec(up.headers.location as string)![1]);
    await dev.get(`/builder/rest-catalogs/${id}`);
    const bad = await dev.post(`/builder/rest-catalogs/${id}/services`, { __csrf: dev.lastCsrf, name: 'S67_BAD', method: 'GET', path: '/x/{nope}', params: '[]', columns: '[]' });
    assert.match((await dev.get(bad.headers.location as string)).body, /add a path parameter &quot;nope&quot;|add a path parameter "nope"/);
    const ok = await dev.post(`/builder/rest-catalogs/${id}/services`, {
      __csrf: dev.lastCsrf, name: 'S67_ONE', method: 'GET', path: '/orders/{order_id}', params: '[{"name": "order_id", "in": "path", "required": true}]', columns: '[{"name": "order_id", "path": "orderId", "type": "integer"}]',
    });
    const sid = Number(/service=(\d+)/.exec(ok.headers.location as string)![1]);
    assert.match((await dev.get(ok.headers.location as string)).body, /https:\/\/orders\.example\.com\/api\/orders\/\{order_id\}/);
    await dev.post(`/builder/rest-catalogs/${id}/services/${sid}`, { __csrf: dev.lastCsrf, name: 'S67_ONE', method: 'GET', path: '/orders/{order_id}', params: '[{"name": "order_id", "in": "path"}]', columns: '[]', description: 'One order' });
    assert.equal((await owner.one('select description from meta.rest_catalog_service where id = $1', [sid])).description, 'One order');
    const file = await dev.get(`/builder/rest-catalogs/${id}/download`);
    assert.match(String(file.headers['content-disposition']), /s67-orders\.catalog\.json/);
    const doc = JSON.parse(file.body);
    assert.equal(doc.format, 'pgkiln-rest-catalog/1');
    assert.deepEqual(doc.services.map((s: any) => s.name), ['GET_ORDERS', 'ADD_ORDER', 'S67_ONE']);
    // a changed base URL must still suit the services
    await dev.post(`/builder/rest-catalogs/${id}`, { __csrf: dev.lastCsrf, name: 'S67 Orders', base_url: 'https://orders.example.com/{v}' });
    assert.equal((await owner.one('select base_url from meta.rest_catalog where id = $1', [id])).base_url, 'https://orders.example.com/api');
    await dev.post(`/builder/rest-catalogs/${id}`, { __csrf: dev.lastCsrf, name: 'S67 Orders', base_url: 'https://test.orders.example.com/api/' });
    assert.equal((await owner.one('select base_url from meta.rest_catalog where id = $1', [id])).base_url, 'https://test.orders.example.com/api');
    // replace from a document: the services are the document's
    await dev.upload(`/builder/rest-catalogs/${id}/import`, { text: JSON.stringify(SWAGGER) }, {});
    assert.equal((await owner.one('select count(*)::int as n from meta.rest_catalog_service where catalog_id = $1', [id])).n, 2);
    await dev.post(`/builder/rest-catalogs/${id}/delete`, { __csrf: dev.lastCsrf });
    assert.ok(!(await owner.one('select 1 as x from meta.rest_catalog where id = $1', [id])));
  });

  test('an application of the workspace makes a REST data source from a service', async () => {
    // HR lives in the Default workspace: a catalog there
    const { catalog } = fromOpenApi({ ...PETSTORE, info: { ...PETSTORE.info, title: 'S67 Default' } });
    await admin.get('/builder');
    const res = await admin.upload('/builder/rest-catalogs/import', { text: JSON.stringify(catalogDocument(catalog)) }, {});
    const cid = Number(/rest-catalogs\/(\d+)/.exec(res.headers.location as string)![1]);
    const svc = await owner.one('select id from meta.rest_catalog_service where catalog_id = $1 and name = $2', [cid, 'LIST_PETS']);
    const page = (await admin.get(`/builder/apps/${appId}/shared?new=rest_source`)).body;
    assert.match(page, /From a REST source catalog/);
    assert.match(page, /<optgroup label="S67 Default">/);
    const made = await admin.post(`/builder/apps/${appId}/rest-sources/from-catalog`, { __csrf: admin.lastCsrf, service: String(svc.id), name: 's67_pets', credential: '' });
    assert.match(made.headers.location as string, /shared\?c=rest_source-\d+/);
    const src = await owner.one(`select url, method, params, row_selector, key_columns, operations, columns from meta.rest_source where app_id = $1 and name = 'S67_PETS'`, [appId]);
    assert.equal(src.url, 'https://petstore.example.com/v1/pets');
    assert.equal(src.row_selector, 'items');
    assert.deepEqual(src.key_columns, ['id']);
    assert.equal(src.operations.update.path, '/{id}');
    assert.equal(src.params[0].key, 'pageSize');
    // the same name again: a clear message
    const twice = await admin.post(`/builder/apps/${appId}/rest-sources/from-catalog`, { __csrf: admin.lastCsrf, service: String(svc.id), name: 'S67_PETS' });
    assert.match((await admin.get(twice.headers.location as string)).body, /has a REST data source with that name already/);
    // an unknown web credential: refused
    const cred = await admin.post(`/builder/apps/${appId}/rest-sources/from-catalog`, { __csrf: admin.lastCsrf, service: String(svc.id), name: 'S67_PETS2', credential: 'NOPE' });
    assert.match((await admin.get(cred.headers.location as string)).body, /has no web credential NOPE/);
  });
});
