-- ---------------------------------------------------------------------
-- 134: make sure an identity provider really did multi-factor sign-in
-- (sprint 132, SEC-4; beyond APEX, which trusts the IdP's sign-on policy).
--
-- meta.auth_provider:
--   mfa_required       refuse a sign-in (to applications and to the builder)
--                      unless the provider says it asked for a second factor:
--                      OpenID Connect through the ID token's amr or acr claim,
--                      SAML through the assertion's AuthnContextClassRef.
--   mfa_request        what to ask the provider for, space separated: OpenID
--                      Connect acr_values, or SAML AuthnContextClassRef values
--                      (a RequestedAuthnContext). null: ask for nothing.
--   mfa_values         the amr / acr / AuthnContextClassRef values that count
--                      as a second factor (any one of them is enough).
--   local_second_step  after a sign-in through this provider, pgkiln asks its
--                      own second step as after a password (the application's
--                      two-step rule; the developer's factor for the builder),
--                      for providers that cannot enforce MFA themselves.
--
-- meta.sso_pending.stepup_session: a step-up through the provider (an
-- authorization scheme with mfa_minutes, 133): the signed-in session the
-- provider's fresh multi-factor sign-in confirms. The provider is asked to
-- sign the user in again (prompt=login / max_age=0, SAML ForceAuthn).
-- ---------------------------------------------------------------------
alter table meta.auth_provider
  add column mfa_required      boolean not null default false,
  add column mfa_request       text check (length(mfa_request) <= 500),
  add column mfa_values        text[] not null default array[
    'mfa',
    'http://schemas.microsoft.com/claims/multipleauthn',
    'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract',
    'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered'],
  add column local_second_step boolean not null default false;
comment on column meta.auth_provider.mfa_required is
  'Refuse sign-ins the provider does not mark as multi-factor (amr / acr, SAML AuthnContextClassRef; 134).';
comment on column meta.auth_provider.mfa_request is
  'acr_values (OpenID Connect) or AuthnContextClassRef values (SAML) to request, space separated (134).';
comment on column meta.auth_provider.mfa_values is
  'amr / acr / AuthnContextClassRef values that count as a second factor (134).';
comment on column meta.auth_provider.local_second_step is
  'After a sign-in through this provider, pgkiln asks its own second step too (134).';

alter table meta.sso_pending
  add column stepup_session uuid references meta.session (id) on delete cascade;
comment on column meta.sso_pending.stepup_session is
  'A step-up through the provider: the signed-in session it confirms (134).';
