-- SAML 2.0 single sign-on (APEX: SAML Sign-In) next to OpenID Connect. A SAML
-- identity provider is a row of meta.auth_provider with protocol 'saml', so it
-- shares the per-app sign-in buttons (meta.app.sso_providers), account links
-- (meta.account_identity, subject = the NameID) and group → role mapping.
--   issuer         the IdP's entity ID (responses must come from it)
--   client_id      pgkiln's entity ID at the IdP (the SP entity ID)
--   idp_sso_url    where to send the AuthnRequest (HTTP-Redirect binding)
--   idp_cert       the IdP's signing certificate (PEM); assertions must be signed
--   username_claim an attribute name, or "nameID"
--   groups_claim   the attribute holding the groups

alter table meta.auth_provider add column protocol text not null default 'oidc' check (protocol in ('oidc', 'saml'));
alter table meta.auth_provider add column idp_sso_url text check (idp_sso_url ~ '^https?://');
alter table meta.auth_provider add column idp_cert text;
-- SAML entity IDs may be URNs
alter table meta.auth_provider drop constraint auth_provider_issuer_check;
alter table meta.auth_provider add constraint auth_provider_issuer_check check (protocol = 'saml' or issuer ~ '^https?://');
alter table meta.auth_provider add constraint auth_provider_saml_check
  check (protocol = 'oidc' or (idp_sso_url is not null and idp_cert like '%BEGIN CERTIFICATE%'));

-- AuthnRequest IDs awaiting their response (InResponseTo); used once, 10 minutes
create table meta.saml_request (
  id         text primary key,
  created_at timestamptz not null default now()
);
revoke all on meta.saml_request from public;
