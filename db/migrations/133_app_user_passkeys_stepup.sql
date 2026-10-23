-- ---------------------------------------------------------------------
-- 133: passkeys, e-mail codes and step-up for application users (sprint
-- 131, SEC-3 part 2; beyond APEX).
--
-- meta.account_factor gets a second kind, 'passkey' (WebAuthn), with the
-- same columns as a developer's (129): the credential id (base64url, unique),
-- its public key as a JWK, the COSE algorithm, the signature counter, the
-- relying party id (host name) it was made for and the transports. A passkey
-- keeps working without the instance key (it is a public key).
--
-- meta.app.mfa_email: at the second step, a user may ask for a one-time code
-- by e-mail (through the application's mail service) instead of opening their
-- authenticator app. Only users who have an authenticator app or a passkey
-- are offered it: an e-mail code is never someone's only factor (SEC-6).
--
-- meta.authz_scheme.mfa_minutes (step-up): the scheme passes only when the
-- session's last second step is at most this many minutes old; a page that
-- needs it asks for a code (or a passkey) again before it opens. null: no
-- step-up (the default). Exported with the application.
-- ---------------------------------------------------------------------
alter table meta.account_factor drop constraint account_factor_kind_check;
alter table meta.account_factor
  alter column secret_enc drop not null,
  add column credential_id text unique,
  add column public_key   jsonb,
  add column alg          int,
  add column sign_count   bigint not null default 0,
  add column rp_id        text,
  add column transports   text[] not null default '{}',
  add constraint account_factor_kind_check check (kind in ('totp', 'passkey')),
  add constraint account_factor_kind_fields check (
    case kind
      when 'totp' then secret_enc is not null
      when 'passkey' then credential_id is not null and public_key is not null and alg is not null and rp_id is not null
    end);
comment on table meta.account_factor is
  'An application account''s second factors: authenticator apps (TOTP, 132; the secret encrypted with the instance key) and passkeys (WebAuthn, 133; a public key).';

alter table meta.app add column mfa_email boolean not null default false;
comment on column meta.app.mfa_email is
  'Two-step sign-in (133): users with an authenticator app or a passkey may get a one-time code by e-mail instead.';

alter table meta.authz_scheme
  add column mfa_minutes int check (mfa_minutes between 1 and 1440);
comment on column meta.authz_scheme.mfa_minutes is
  'Step-up (133): the scheme passes only when the session''s last second step is at most this many minutes old (null: no step-up).';

-- meta.app.api_self_tokens: signed-in users create their own REST API token
-- on My account. A user the application requires a second step of gets one
-- only after a second step at most 15 minutes old; the builder's "Issue a
-- token" refuses such accounts (SEC-3: no token around two-step sign-in).
alter table meta.app add column api_self_tokens boolean not null default false;
comment on column meta.app.api_self_tokens is
  'Users create their own REST API token on My account (133); after a recent second step when the app requires one of them.';
