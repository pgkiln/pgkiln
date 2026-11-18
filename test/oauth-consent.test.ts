// Sprint 222 (parity: REST data sources, "Missing: the OAuth2 authorization code flow"; migration 184): a web
// credential of grant type authorization_code. A developer clicks Authorize, the browser goes to the service's
// authorization URL with a one-time state and a PKCE challenge, the service sends it back to /builder/oauth/callback
// with a code, and pgkiln exchanges it for tokens: the refresh token is kept encrypted and every call uses it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY = 'test-only-secret-key-0123456789abcdef';
process.env.PGKILN_REST_ALLOWED_HOSTS = '127.0.0.1,localhost';
process.env.PGKILN_REST_PRIVATE_HOSTS = '127.0.0.1';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const ws = await import('../src/websources.ts');
const { consentRedirectUri } = await import('../src/builder/oauth-consent.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
let mock: http.Server;
let mockBase = '';
let appId: number;
let wsId: number;
const NAME = 'T222_CONSENT';

// the service: /token exchanges a code (checking the PKCE verifier and the redirect URI) or a refresh token
const codes = new Map<string, { challenge: string; redirect: string }>();
let tokenCalls: URLSearchParams[] = [];
let tokenAuth: (string | undefined)[] = [];
let sendRefresh = true;
let failToken = false;
let access = '';
let n = 0;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  wsId = (await owner.one('select meta.app_workspace($1) as w', [appId])).w;
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/token') {
        const f = new URLSearchParams(body);
        tokenCalls.push(f);
        tokenAuth.push(req.headers.authorization);
        if (failToken) return send(400, { error: 'invalid_client', error_description: 'secret-detail-should-not-show' });
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code') ?? '');
          if (!c) return send(400, { error: 'invalid_grant' });
          codes.delete(f.get('code')!);
          const s256 = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
          if (s256 !== c.challenge || f.get('redirect_uri') !== c.redirect) return send(400, { error: 'invalid_grant' });
        } else if (f.get('grant_type') !== 'refresh_token') return send(400, { error: 'unsupported_grant_type' });
        access = `at-${++n}`;
        return send(200, { access_token: access, token_type: 'bearer', expires_in: 3600, ...(sendRefresh ? { refresh_token: `rt-${n}` } : {}) });
      }
      if (u.pathname === '/api') return req.headers.authorization === `Bearer ${access}` ? send(200, { ok: true }) : send(401, {});
      send(404, {});
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  await owner.query('delete from meta.web_credential where app_id = $1 and name = $2', [appId, NAME]);
  await owner.query('delete from meta.workspace_credential where workspace_id = $1 and name = $2', [wsId, NAME]);
});

after(async () => {
  await owner.query('delete from meta.web_credential where app_id = $1 and name = $2', [appId, NAME]);
  await owner.query('delete from meta.workspace_credential where workspace_id = $1 and name = $2', [wsId, NAME]);
  await owner.query('delete from meta.web_credential_pending');
  mock.close();
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};
/** The service's side of consent: it reads the authorization request and makes a code for it. */
function consent(location: string) {
  const u = new URL(location);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! });
  return { state: u.searchParams.get('state')!, code, url: u };
}
/** The page's messages (every alert's text). */
const flashOf = async (b: InstanceType<typeof Browser>, url: string) =>
  [...(await b.get(url)).body.matchAll(/<div class="alert alert-(?:error|success)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, '')).join(' | ');
/** The callback, then the page it sends back to: its message. */
const callback = async (b: InstanceType<typeof Browser>, query: string) => {
  const r = await b.get(`/builder/oauth/callback?${query}`);
  assert.equal(r.statusCode, 303);
  return flashOf(b, r.headers.location as string);
};

describe('the authorization request and the token request', () => {
  test('the authorization URL keeps the endpoint\'s own parameters and adds the code flow\'s', () => {
    const u = new URL(ws.authorizationUrl({ authorize_url: 'https://login.example.com/authorize?access_type=offline&prompt=consent', username: 'client-1', scope: 'read write' },
      { state: 'st', challenge: 'ch', redirectUri: 'https://pgkiln.example.com/builder/oauth/callback' }));
    assert.equal(u.origin + u.pathname, 'https://login.example.com/authorize');
    assert.deepEqual(Object.fromEntries(u.searchParams), { access_type: 'offline', prompt: 'consent', response_type: 'code', client_id: 'client-1',
      redirect_uri: 'https://pgkiln.example.com/builder/oauth/callback', scope: 'read write', state: 'st', code_challenge: 'ch', code_challenge_method: 'S256' });
    assert.throws(() => ws.authorizationUrl({ authorize_url: 'javascript:alert(1)', username: 'c', scope: null }, { state: 's', challenge: 'c', redirectUri: 'r' }), /http/);
  });

  test('the code is exchanged with the verifier; a confidential client authenticates, a public one sends its id', () => {
    const base: Omit<import('../src/websources.ts').WebCredential, 'secret_enc'> = { id: 1, app_id: 1, name: 'X', type: 'oauth2', username: 'client-1', header_name: null, token_url: 'https://x/token', scope: 'read', valid_for: [], grant_type: 'authorization_code' };
    const code = { code: 'c1', verifier: 'v1', redirectUri: 'https://p/cb' };
    const pub = ws.tokenRequest({ ...base, secret_enc: null }, null, code);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(pub.body)), { grant_type: 'authorization_code', code: 'c1', redirect_uri: 'https://p/cb', code_verifier: 'v1', client_id: 'client-1' });
    assert.equal(pub.headers.authorization, undefined);
    const conf = ws.tokenRequest({ ...base, secret_enc: encryptSecret('s3cret') }, null, code);
    assert.match(conf.headers.authorization!, /^Basic /);
    assert.equal(new URLSearchParams(conf.body).get('client_id'), null);
    // before consent there is nothing to ask with
    assert.throws(() => ws.tokenRequest({ ...base, secret_enc: null }, null), /not authorized yet/);
  });

  test('the credential needs an authorization URL', () => {
    const c = { type: 'oauth2', grant_type: 'authorization_code', token_url: 'https://x/token', username: 'c' };
    assert.match(ws.credentialProblems(c).join(' '), /authorization URL/);
    assert.match(ws.credentialProblems({ ...c, authorize_url: 'ftp://x' }).join(' '), /authorization URL/);
    assert.deepEqual(ws.credentialProblems({ ...c, authorize_url: 'https://x/authorize' }), []);
  });
});

describe('Authorize in the builder', () => {
  let cid: number;
  const page = () => `/builder/apps/${appId}/shared?c=web_credential-${cid}`;
  before(async () => {
    cid = (await owner.one(`insert into meta.web_credential (app_id, name, type, username, token_url, authorize_url, scope, grant_type, valid_for)
      values ($1, $2, 'oauth2', 'client-222', $3, $4, 'api.read offline_access', 'authorization_code', $5) returning id`,
      [appId, NAME, `${mockBase}/token`, `${mockBase}/authorize?audience=api`, [`${mockBase}/api`]])).id;
  });

  test('consent, the code exchanged with PKCE, the refresh token stored encrypted, calls signed with the token', async () => {
    const b = await builder();
    const shown = (await b.get(page())).body;
    assert.match(shown, /Not authorized/);
    assert.ok(shown.includes(consentRedirectUri()), 'the redirect URI to register');
    const start = await b.submit(`/builder/apps/${appId}/web-credentials/${cid}/authorize`, {});
    assert.equal(start.statusCode, 303);
    const c = consent(start.headers.location as string);
    assert.equal(c.url.origin + c.url.pathname, `${mockBase}/authorize`);
    assert.equal(c.url.searchParams.get('audience'), 'api');
    assert.equal(c.url.searchParams.get('client_id'), 'client-222');
    assert.equal(c.url.searchParams.get('scope'), 'api.read offline_access');
    assert.equal(c.url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal((await owner.one('select count(*)::int as n from meta.web_credential_pending where credential_id = $1', [cid])).n, 1);
    // the state is kept hashed, never as sent
    assert.equal((await owner.one('select count(*)::int as n from meta.web_credential_pending where state_hash = $1', [c.state])).n, 0);

    tokenCalls = [];
    const back = await b.get(`/builder/oauth/callback?code=${c.code}&state=${c.state}`);
    assert.equal(back.statusCode, 303);
    assert.equal(back.headers.location, page());
    assert.match(await flashOf(b, page()), /is authorized: its refresh token is stored encrypted/);
    assert.equal(tokenCalls.length, 1);
    assert.equal(tokenCalls[0].get('scope'), null, 'the code carries the scope');
    const row = await owner.one('select refresh_token_enc, token_refreshed_at from meta.web_credential where id = $1', [cid]);
    assert.match(row.refresh_token_enc, /^v1:/);
    assert.ok(row.token_refreshed_at);
    assert.equal((await owner.one('select count(*)::int as n from meta.web_credential_pending where credential_id = $1', [cid])).n, 0, 'one-time');
    assert.match((await b.get(page())).body, /Authorize again/);

    // a call of the application: the access token from the exchange, no new token request
    const cred = await ws.loadCredential(appId, NAME);
    const res = await ws.call({ appId, url: `${mockBase}/api`, method: 'GET', headers: {}, credential: cred, what: 'test', timeoutMs: 5000 });
    assert.equal(res.status, 200);
    assert.equal(tokenCalls.length, 1);
    // after a restart (empty cache): the stored refresh token
    ws.clearTokens();
    const again = await ws.call({ appId, url: `${mockBase}/api`, method: 'GET', headers: {}, credential: await ws.loadCredential(appId, NAME), what: 'test', timeoutMs: 5000 });
    assert.equal(again.status, 200);
    assert.equal(tokenCalls.at(-1)!.get('grant_type'), 'refresh_token');
    assert.equal(tokenCalls.at(-1)!.get('refresh_token'), 'rt-1');

    // the same callback again: the state was used
    assert.match(await callback(b, `code=${c.code}&state=${c.state}`), /not valid any more/);
  });

  test('refused at the service, a wrong state, another session: nothing stored', async () => {
    const b = await builder();
    await owner.query('update meta.web_credential set refresh_token_enc = null, token_refreshed_at = null where id = $1', [cid]);
    await b.get(page());
    const c = consent((await b.submit(`/builder/apps/${appId}/web-credentials/${cid}/authorize`, {})).headers.location as string);
    // another developer's session can't finish it
    const other = await builder();
    assert.match(await callback(other, `code=${c.code}&state=${c.state}`), /not valid any more/);
    assert.match(await callback(b, `code=${c.code}&state=wrong-${c.state}`), /not valid any more/);
    // the developer said no: the service's error code, not its text
    await b.get(`/builder/oauth/callback?error=access_denied&error_description=${encodeURIComponent('<b>x</b>')}&state=${c.state}`);
    assert.match(await flashOf(b, page()), /did not authorize web credential T222_CONSENT \(access_denied\)/);
    assert.equal((await owner.one('select refresh_token_enc from meta.web_credential where id = $1', [cid])).refresh_token_enc, null);
  });

  test('no refresh token: a warning with the expiry; a failing token endpoint: its status, never its text', async () => {
    const b = await builder();
    await owner.query('update meta.web_credential set refresh_token_enc = $2 where id = $1', [cid, encryptSecret('old-refresh')]);
    await b.get(page());
    sendRefresh = false;
    let c = consent((await b.submit(`/builder/apps/${appId}/web-credentials/${cid}/authorize`, {})).headers.location as string);
    await b.get(`/builder/oauth/callback?code=${c.code}&state=${c.state}`);
    assert.match(await flashOf(b, page()), /sent no refresh token: it works until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.equal((await owner.one('select refresh_token_enc from meta.web_credential where id = $1', [cid])).refresh_token_enc, null, 'the earlier one is gone');
    sendRefresh = true;
    failToken = true;
    c = consent((await b.submit(`/builder/apps/${appId}/web-credentials/${cid}/authorize`, {})).headers.location as string);
    await b.get(`/builder/oauth/callback?code=${c.code}&state=${c.state}`);
    const msg = await flashOf(b, page());
    failToken = false;
    assert.match(msg, /could not be authorized: The token endpoint of web credential T222_CONSENT answered 400 \(invalid_client\)/);
    assert.doesNotMatch(msg, /secret-detail/);
  });

  test('a credential that is not ready goes back with a message', async () => {
    const b = await builder();
    await owner.query(`update meta.web_credential set grant_type = 'client_credentials' where id = $1`, [cid]);
    await b.get(page());
    const r = await b.submit(`/builder/apps/${appId}/web-credentials/${cid}/authorize`, {});
    assert.equal(r.headers.location, page());
    assert.match(await flashOf(b, page()), /not ready for consent/);
    await owner.query(`update meta.web_credential set grant_type = 'authorization_code' where id = $1`, [cid]);
  });
});

describe('a workspace credential', () => {
  test('its administrators authorize it in Workspace utilities', async () => {
    const id = (await owner.one(`insert into meta.workspace_credential (workspace_id, name, type, username, token_url, authorize_url, grant_type, secret_enc)
      values ($1, $2, 'oauth2', 'ws-client', $3, $4, 'authorization_code', $5) returning id`, [wsId, NAME, `${mockBase}/token`, `${mockBase}/authorize`, encryptSecret('ws-secret')])).id;
    const b = await builder();
    const form = (await b.get(`/builder/workspace-credentials?edit=${id}`)).body;
    assert.match(form, /name="authorize_url"/);
    assert.match(form, /Not authorized/);
    const c = consent((await b.submit(`/builder/workspace-credentials/${id}/authorize`, {})).headers.location as string);
    tokenAuth = [];
    const back = await b.get(`/builder/oauth/callback?code=${c.code}&state=${c.state}`);
    assert.equal(back.headers.location, `/builder/workspace-credentials?edit=${id}#credential-form`);
    assert.match(tokenAuth[0]!, /^Basic /, 'a confidential client');
    assert.match((await owner.one('select refresh_token_enc from meta.workspace_credential where id = $1', [id])).refresh_token_enc, /^v1:/);
    // saving the form keeps the authorization URL
    await b.get(`/builder/workspace-credentials?edit=${id}`);
    await b.submit('/builder/workspace-credentials', { id: String(id), name: NAME, type: 'oauth2', username: 'ws-client', grant_type: 'authorization_code', token_url: `${mockBase}/token`, authorize_url: `${mockBase}/authorize2`, valid_for: '' });
    assert.equal((await owner.one('select authorize_url from meta.workspace_credential where id = $1', [id])).authorize_url, `${mockBase}/authorize2`);
  });
});
