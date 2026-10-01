// SAML 2.0 sign-in against an in-process mock identity provider: responses are
// built and signed here (xml-crypto) with a throwaway key; a second key plays
// an attacker.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { SignedXml } from 'xml-crypto';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner, runtime } from '../src/db.ts';
import { publicUrl } from '../src/sso.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const IDP = 'urn:mock-idp';
const SP = 'urn:pgapex:test';
const ACS = () => `${publicUrl()}/sso/saml/mock-saml`;

function keyPair(cn: string) {
  const dir = mkdtempSync(join(tmpdir(), 'saml-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`, '-days', '2',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const pair = { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  rmSync(dir, { recursive: true });
  return pair;
}
const idp = keyPair('mock-idp');
const attacker = keyPair('attacker');

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
  await owner.query(
    `insert into meta.auth_provider (name, display_name, protocol, issuer, client_id, idp_sso_url, idp_cert, username_claim, groups_claim, auto_create)
     values ('mock-saml', 'Mock SAML', 'saml', $1, $2, 'https://idp.example.test/sso', $3, 'nameID', 'groups', true)`,
    [IDP, SP, idp.cert],
  );
  await owner.query(`update meta.app set sso_providers = array_append(sso_providers, 'mock-saml') where id = $1`, [appId]);
  await owner.query(`insert into meta.app_group_role (app_id, group_name, role) values ($1, 'saml-managers', 'saml-manager') on conflict do nothing`, [appId]);
});

async function cleanup() {
  await owner.query(`delete from meta.auth_provider where name = 'mock-saml'`);
  await owner.query(`delete from meta.account where username in ('sam', 'sam-attr')`);
  await owner.query(`update meta.app set sso_providers = array_remove(sso_providers, 'mock-saml') where id = $1`, [appId]);
  await owner.query(`delete from meta.app_group_role where app_id = $1 and group_name = 'saml-managers'`, [appId]);
}

beforeEach(() => owner.query(`delete from meta.activity_log where app_id is null and event = 'login_failed'`));

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

/** Start a sign-in: the AuthnRequest's ID and the RelayState. */
async function start(b: Browser) {
  const res = await b.get('/a/hr/sso/mock-saml');
  assert.equal(res.statusCode, 302);
  const url = new URL(String(res.headers.location));
  assert.equal(url.origin + url.pathname, 'https://idp.example.test/sso');
  const request = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  assert.match(request, new RegExp(`<saml:Issuer[^>]*>${SP}</saml:Issuer>`));
  assert.match(request, new RegExp(`AssertionConsumerServiceURL="${ACS()}"`));
  return { requestId: /ID="([^"]+)"/.exec(request)![1], relayState: url.searchParams.get('RelayState')! };
}

interface Opts {
  requestId: string;
  nameId?: string;
  groups?: string[];
  attrs?: Record<string, string>;
  audience?: string;
  issuer?: string;
  notOnOrAfter?: Date;
  key?: string | null; // null: unsigned
  cert?: string;
}

/** A Response with a signed Assertion, base64 encoded (HTTP-POST binding). */
function response(o: Opts) {
  const now = new Date();
  const later = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const iso = (d: Date) => d.toISOString();
  const attrs = { ...(o.groups ? { groups: o.groups } : {}), ...Object.fromEntries(Object.entries(o.attrs ?? {}).map(([k, v]) => [k, [v]])) };
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Date.now()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS()}" InResponseTo="${o.requestId}">`
    + `<saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>`
    + `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + `<saml:Assertion ID="_a${Date.now()}${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(now)}">`
    + `<saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${o.nameId ?? 'sam'}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.requestId}" NotOnOrAfter="${iso(later)}" Recipient="${ACS()}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(later)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + (Object.keys(attrs).length
      ? `<saml:AttributeStatement>${Object.entries(attrs).map(([k, vs]) => `<saml:Attribute Name="${k}">${vs.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('')}</saml:AttributeStatement>`
      : '')
    + `</saml:Assertion></samlp:Response>`;
  if (o.key === null) return Buffer.from(xml).toString('base64');
  const sig = new SignedXml({
    privateKey: o.key ?? idp.key,
    publicCert: o.cert ?? idp.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return Buffer.from(sig.getSignedXml()).toString('base64');
}

/** The IdP posts to the ACS; the relay page posts on to /finish. */
async function deliver(b: Browser, SAMLResponse: string, RelayState: string) {
  const relay = await b.post('/sso/saml/mock-saml', { SAMLResponse, RelayState });
  assert.equal(relay.statusCode, 200);
  assert.match(relay.body, /<form method="post" action="\/sso\/saml\/mock-saml\/finish" data-autosubmit>/);
  return b.post('/sso/saml/mock-saml/finish', { SAMLResponse, RelayState });
}
const roles = async (b: Browser) => /Roles: ([^<]*)</.exec((await b.get('/a/hr/1')).body)?.[1] ?? '';

describe('SAML sign-in', () => {
  test('a signed response signs the user in; groups map to roles; the account is linked by NameID', async () => {
    const b = new Browser(app);
    const { requestId, relayState } = await start(b);
    const res = await deliver(b, response({ requestId, groups: ['saml-managers'], attrs: { displayName: 'Sam Saml', email: 'sam@example.org' } }), relayState);
    assert.equal(res.statusCode, 303, (res.body.match(/<p[^>]*>([^<]*)<\/p>/g) ?? []).join(' | '));
    assert.match(await roles(b), /saml-manager/);
    const acc = await owner.one(`select a.display_name, a.email, i.subject from meta.account a join meta.account_identity i on i.account_id = a.id where a.username = 'sam'`);
    assert.deepEqual(acc, { display_name: 'Sam Saml', email: 'sam@example.org', subject: 'sam' });
  });

  test('the username can come from an attribute', async () => {
    await owner.query(`update meta.auth_provider set username_claim = 'uid' where name = 'mock-saml'`);
    const b = new Browser(app);
    const { requestId, relayState } = await start(b);
    assert.equal((await deliver(b, response({ requestId, nameId: 'opaque-123', attrs: { uid: 'sam-attr' }, groups: ['saml-managers'] }), relayState)).statusCode, 303);
    assert.ok(await owner.one(`select 1 from meta.account where username = 'sam-attr'`));
    await owner.query(`update meta.auth_provider set username_claim = 'nameID' where name = 'mock-saml'`);
  });

  test('unsigned, forged, misdirected, expired or foreign responses are refused', async () => {
    // each with the reason it must be refused for (the groups would grant access otherwise)
    const cases: [string, (requestId: string) => string, RegExp][] = [
      ['unsigned', (requestId) => response({ requestId, key: null, groups: ['saml-managers'] }), /Invalid signature/],
      ['signed by another key', (requestId) => response({ requestId, key: attacker.key, cert: attacker.cert, groups: ['saml-managers'] }), /Invalid signature/],
      ['other audience', (requestId) => response({ requestId, audience: 'urn:someone-else', groups: ['saml-managers'] }), /audience mismatch/],
      ['other issuer', (requestId) => response({ requestId, issuer: 'urn:evil-idp', groups: ['saml-managers'] }), /comes from urn:evil-idp/],
      ['expired', (requestId) => response({ requestId, notOnOrAfter: new Date(Date.now() - 10 * 60_000), groups: ['saml-managers'] }), /No valid subject confirmation/],
      ['answers another request', () => response({ requestId: '_not-our-request', groups: ['saml-managers'] }), /InResponseTo is not valid/],
    ];
    for (const [name, make, reason] of cases) {
      const b = new Browser(app);
      const { requestId, relayState } = await start(b);
      const res = await deliver(b, make(requestId), relayState);
      assert.equal(res.statusCode, 403, name);
      assert.match(res.body, reason, name);
      assert.equal(await roles(b), '', `${name}: not signed in`);
    }
  });

  test('a response works once, in the browser that started the sign-in', async () => {
    const b = new Browser(app);
    const { requestId, relayState } = await start(b);
    const saml = response({ requestId, groups: ['saml-managers'] });
    // another browser (login CSRF: the victim never started this sign-in)
    const victim = new Browser(app);
    const csrf = await deliver(victim, saml, relayState);
    assert.equal(csrf.statusCode, 403);
    assert.match(csrf.body, /started in another browser/);
    // the state was used up by that attempt, so the real browser must start again
    const again = await start(b);
    const fresh = response({ requestId: again.requestId, groups: ['saml-managers'] });
    assert.equal((await deliver(b, fresh, again.relayState)).statusCode, 303);
    const replay = await deliver(b, fresh, again.relayState);
    assert.equal(replay.statusCode, 403, 'replayed');
    assert.match(replay.body, /expired or was already used/);
  });

  test('metadata for the IdP; the OIDC callback refuses SAML providers; the runtime role sees nothing', async () => {
    const md = await new Browser(app).get('/sso/saml/mock-saml/metadata');
    assert.equal(md.statusCode, 200);
    assert.match(md.body, new RegExp(`entityID="${SP}"`));
    assert.match(md.body, new RegExp(`Location="${ACS()}"`));
    assert.equal((await new Browser(app).get('/sso/callback/mock-saml?code=x&state=y')).statusCode, 404);
    await assert.rejects(runtime.query('select * from meta.saml_request'), /permission denied/);
    await assert.rejects(runtime.query('select idp_cert from meta.auth_provider'), /permission denied/);
  });

  test('the builder adds a SAML provider; a bare base64 certificate becomes PEM', async () => {
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    await dev.get('/builder/users/providers');
    const body = idp.cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const res = await dev.submit('/builder/users/providers', {
      name: 'builder-saml', protocol: 'saml', display_name: 'Builder SAML', issuer: 'urn:builder-idp',
      idp_sso_url: 'https://idp.example.test/sso', idp_cert: body, username_claim: 'nameID', groups_claim: 'groups', enabled: 'true',
    });
    assert.equal(res.statusCode, 303);
    try {
      const row = await owner.one(`select id, protocol, client_id, idp_cert from meta.auth_provider where name = 'builder-saml'`);
      assert.equal(row.protocol, 'saml');
      assert.equal(row.client_id, `${publicUrl()}/sso/saml/builder-saml/metadata`);
      assert.match(row.idp_cert, /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/);
      const page = (await dev.get(`/builder/users/providers/${row.id}`)).body;
      assert.match(page, /\/sso\/saml\/builder-saml\/metadata/);
      assert.doesNotMatch(page, /Test discovery/);
    } finally {
      await owner.query(`delete from meta.auth_provider where name = 'builder-saml'`);
    }
  });
});
