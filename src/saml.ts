import { randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { owner } from './db.ts';
import { MFA_REFUSED, mfaRequest, provedMfa, publicUrl, resolveAccount, sha256, SsoError, stepUpResult, usableUsername, type Provider, type SsoResult } from './sso.ts';

// SAML 2.0 sign-in (APEX: SAML Sign-In), service-provider initiated:
//
//   GET  /a/:alias/sso/:provider       AuthnRequest (HTTP-Redirect), RelayState = one-time state
//   POST /sso/saml/:provider           the IdP posts the response here (the ACS). The browser
//                                      sends no SameSite=Lax cookie on that cross-site POST, so
//                                      the page posts the response on to …
//   POST /sso/saml/:provider/finish    … here, same-site, with the browser-binding cookie
//   GET  /sso/saml/:provider/metadata  the service provider metadata for the IdP
//
// Checks (node-saml): the signature of the assertion with the IdP's certificate
// (unsigned assertions are refused), audience (our entity ID),
// recipient/destination, time conditions, and InResponseTo: the response must
// answer an AuthnRequest of this flow, once. On top: the assertion's issuer
// (node-saml doesn't check it for responses), the one-time state and the browser
// that started the flow (as for OpenID Connect).
// (sprint 132, SEC-4) The assertion's AuthnContextClassRef tells how the user signed in: with mfa_required it must
// be one of the provider's mfa_values; mfa_request asks for those (RequestedAuthnContext); a step-up adds ForceAuthn
// and checks the AuthnInstant.

const PENDING_MINUTES = 10;
const b64url = (b: Buffer) => b.toString('base64url');

export const spEntityId = (p: Pick<Provider, 'name' | 'client_id'>) => p.client_id || `${publicUrl()}/sso/saml/${p.name}/metadata`;
export const acsUrl = (p: Pick<Provider, 'name'>) => `${publicUrl()}/sso/saml/${p.name}`;
export const metadataUrl = (p: Pick<Provider, 'name'>) => `${publicUrl()}/sso/saml/${p.name}/metadata`;

/**
 * Where node-saml keeps AuthnRequest IDs: meta.saml_request. While a
 * response is checked, only the ID this flow sent is known.
 */
function requestCache(onSave: (id: string) => void, only?: string): CacheProvider {
  return {
    async saveAsync(key, value) {
      await owner.query('insert into meta.saml_request (id) values ($1) on conflict do nothing', [key]);
      onSave(key);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      if (only !== undefined && key !== only) return null;
      // node-saml reads the value with new Date(…)
      const r = await owner.one<{ created_at: Date }>(
        `select created_at from meta.saml_request where id = $1 and created_at > now() - make_interval(mins => $2)`,
        [key, PENDING_MINUTES],
      );
      return r ? new Date(r.created_at).toISOString() : null;
    },
    async removeAsync(key) {
      if (key === null) return null;
      const r = await owner.one<{ id: string }>('delete from meta.saml_request where id = $1 returning id', [key]);
      return r?.id ?? null;
    },
  };
}

function client(p: Provider, cache: CacheProvider, stepup = false) {
  if (!p.idp_sso_url || !p.idp_cert) throw new SsoError('The SAML provider is not configured completely.');
  const requested = mfaRequest(p);
  return new SAML({
    entryPoint: p.idp_sso_url,
    issuer: spEntityId(p),
    callbackUrl: acsUrl(p),
    idpCert: p.idp_cert,
    idpIssuer: p.issuer,
    audience: spEntityId(p),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: PENDING_MINUTES * 60_000,
    cacheProvider: cache,
    identifierFormat: null,
    // (sprint 132) a RequestedAuthnContext only when the administrator names the classes
    disableRequestedAuthnContext: !requested.length,
    authnContext: requested,
    racComparison: 'exact',
    forceAuthn: stepup,
    acceptedClockSkewMs: 60_000,
    signatureAlgorithm: 'sha256',
  });
}

/** Start: the IdP URL with the AuthnRequest, and the browser-binding cookie value. */
export async function startSamlSignIn(p: Provider, appId: number | null, next: string | undefined, link?: string, stepup?: string) {
  const state = b64url(randomBytes(32));
  const browserKey = b64url(randomBytes(32));
  await owner.query(`delete from meta.sso_pending where created_at < now() - make_interval(mins => $1)`, [PENDING_MINUTES]);
  await owner.query(`delete from meta.saml_request where created_at < now() - make_interval(mins => $1)`, [PENDING_MINUTES]);
  let requestId = '';
  const url = await client(p, requestCache((id) => (requestId = id)), !!stepup).getAuthorizeUrlAsync(state, undefined, {});
  if (!requestId) throw new SsoError('The AuthnRequest has no ID.');
  // code_verifier is unused for SAML; nonce holds the AuthnRequest ID the response must answer
  await owner.query(
    `insert into meta.sso_pending (state, app_id, provider_id, code_verifier, nonce, browser_hash, next, link_username, stepup_session)
     values ($1, $2, $3, '', $4, $5, $6, $7, $8)`,
    [state, appId, p.id, requestId, sha256(browserKey), next ?? null, link ?? null, stepup ?? null],
  );
  return { url, browserKey };
}

/** (sprint 132) The signed assertion's AuthnContextClassRefs and AuthnInstant (ms), read after node-saml checked it. */
export function authnContext(assertionXml: string): { classes: string[]; at: number | null } {
  // comments are outside the signature (exclusive c14n drops them): text split by one is read as one
  assertionXml = assertionXml.replace(/<!--[\s\S]*?-->/g, '');
  const classes = [...assertionXml.matchAll(/<(?:[\w-]+:)?AuthnContextClassRef\b[^>]*>\s*([^<\s]+)\s*</g)].map((m) => m[1]);
  const instant = /<(?:[\w-]+:)?AuthnStatement\b[^>]*\bAuthnInstant="([^"]+)"/.exec(assertionXml)?.[1];
  const at = instant ? Date.parse(instant) : NaN;
  return { classes, at: Number.isFinite(at) ? at : null };
}

const values = (v: unknown): string[] => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean));

/** Finish: check state, browser and the response; the account and its groups. */
export async function finishSamlSignIn(p: Provider, body: { SAMLResponse?: string; RelayState?: string }, browserKey: string | undefined): Promise<SsoResult> {
  const pending = await owner.one(
    `delete from meta.sso_pending where state = $1 and provider_id = $2 and created_at > now() - make_interval(mins => $3)
     returning app_id, nonce, browser_hash, next, link_username, stepup_session`,
    [body.RelayState ?? '', p.id, PENDING_MINUTES],
  );
  if (!pending) throw new SsoError('This sign-in has expired or was already used. Please try again.');
  if (!browserKey || sha256(browserKey) !== pending.browser_hash)
    throw new SsoError('This sign-in was started in another browser. Please try again.');
  if (!body.SAMLResponse || body.SAMLResponse.length > 500_000) throw new SsoError('The identity provider sent no SAML response.');
  let profile: Profile | null;
  try {
    ({ profile } = await client(p, requestCache(() => {}, pending.nonce)).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse }));
  } catch (e) {
    throw new SsoError(`The SAML response was not accepted: ${(e as Error).message}`);
  }
  // node-saml checks the issuer of logout messages only: the assertion must come from the configured IdP
  if (profile?.issuer !== p.issuer) throw new SsoError(`The SAML response comes from ${profile?.issuer ?? 'an unknown issuer'}, not from ${p.issuer}.`);
  if (!profile?.nameID) throw new SsoError('The SAML response names no user.');
  // (sprint 132, SEC-4) how the user signed in
  const how = authnContext(profile.getAssertionXml?.() ?? '');
  const mfa = provedMfa(p, how.classes);
  if (pending.stepup_session) return stepUpResult(p, pending, profile.nameID, mfa, how.at);
  if (p.mfa_required && !mfa) throw new SsoError(MFA_REFUSED);
  const username = p.username_claim === 'nameID' ? profile.nameID : values(profile[p.username_claim])[0];
  if (!usableUsername(username)) throw new SsoError(`The SAML response has no usable "${p.username_claim}" attribute.`);
  const name = values(profile.displayName ?? profile.cn)[0];
  const email = values(profile.email ?? profile.mail)[0];
  const groups = values(profile[p.groups_claim]);
  if (pending.app_id === null)
    // the builder: devsso.ts finds the developer (sprint 129)
    return { appId: null, next: pending.next, username, groups, link: pending.link_username, mfa, identity: { subject: profile.nameID, name: name ?? null, email: email ?? null, mayLink: true } };
  const account = await resolveAccount(p, { sub: profile.nameID, name, email: profile.email ?? profile.mail }, username);
  return { appId: pending.app_id, next: pending.next, username: account, groups, mfa };
}

/** Service provider metadata (entity ID, ACS) to register pgkiln at the IdP. */
export function samlMetadata(p: Provider) {
  return client(p, requestCache(() => {})).generateServiceProviderMetadata(null);
}
