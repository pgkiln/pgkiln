-- ---------------------------------------------------------------------
-- 129: passkeys and trusted browsers for developers (sprint 127, SEC-2
-- part 2; beyond APEX).
--
-- meta.developer_factor gets a second kind, 'passkey' (WebAuthn): the
-- credential id (base64url, unique), its public key as a JWK, the COSE
-- algorithm, the signature counter, the relying party id it was made for
-- (the host name; a passkey only works on that domain) and the transports
-- the browser reported. A passkey keeps working without the instance key
-- (it is a public key). An authenticator app keeps its encrypted secret.
--
-- meta.developer_trusted_browser: "trust this browser" after a second
-- factor, for meta.setting mfa_trust_days days (0, the default: never).
-- Only the SHA-256 of the cookie's random token is stored; a reset, a new
-- password, removing a factor or "Forget trusted browsers" deletes them.
--
-- Owner-only, like meta.developer.
-- ---------------------------------------------------------------------
alter table meta.developer_factor drop constraint developer_factor_kind_check;
alter table meta.developer_factor
  alter column secret_enc drop not null,
  add column credential_id text unique,
  add column public_key   jsonb,
  add column alg          int,
  add column sign_count   bigint not null default 0,
  add column rp_id        text,
  add column transports   text[] not null default '{}',
  add constraint developer_factor_kind_check check (kind in ('totp', 'passkey')),
  add constraint developer_factor_kind_fields check (
    case kind
      when 'totp' then secret_enc is not null
      when 'passkey' then credential_id is not null and public_key is not null and alg is not null and rp_id is not null
    end);
comment on table meta.developer_factor is
  'A developer''s second factors: authenticator apps (TOTP, 128; the secret encrypted with the instance key) and passkeys (WebAuthn, 129; a public key).';

create table meta.developer_trusted_browser (
  token_hash  text primary key,
  username    text not null references meta.developer on update cascade on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);
create index on meta.developer_trusted_browser (username);
comment on table meta.developer_trusted_browser is
  'Browsers a developer trusted after a second factor (129): sha256 of the cookie token, until expires_at.';

insert into meta.setting (name, value) values ('mfa_trust_days', '0')
on conflict (name) do nothing;
