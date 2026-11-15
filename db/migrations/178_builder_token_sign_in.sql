-- =====================================================================
-- 178: a builder token remembers the sign-in it was made with
--      (sprint 204, NX-F4 follow-up)
--
-- A token (171) is made within minutes of a sign-in with the factors
-- its developer must use. It now keeps how that sign-in was made, so
-- that every request can check it against the developer's rules of
-- that moment, not those of the day it was made:
--
--   auth_mfa  a second factor was given (an authenticator app, a
--             passkey, a recovery code; or the identity provider
--             decided on it)
--   auth_sso  through an identity provider or LDAP directory, not the
--             pgkiln password
--   auth_via  which one (the provider's name, or ldap:<directory>)
--
-- A token whose developer must now sign in through single sign-on, or
-- now needs a second factor (they set one up, the instance or a
-- workspace requires one), and whose sign-in did not do that, is
-- refused (403) until its developer makes a new one. So is a token made
-- through an identity that is no longer linked or enabled for the
-- builder, while single sign-on is required.
--
-- Tokens made before this migration were made under sprint 194's
-- step-up, which already asked for the factors needed then: they are
-- taken to have used a second factor when their developer has one now
-- or signed in through single sign-on, and single sign-on when their
-- developer must use it now.
--
-- The activity log gets an index for the calls made with tokens
-- (Security → Builder tokens → Calls; administrators: every token).
-- =====================================================================

alter table meta.builder_token
  add column auth_mfa boolean not null default false,
  add column auth_sso boolean not null default false,
  add column auth_via text check (length(auth_via) <= 200);

update meta.builder_token t
   set auth_sso = coalesce((select not d.break_glass and exists (select 1 from meta.workspace_member m join meta.workspace w on w.id = m.workspace_id
                                                                   where m.username = d.username and w.sso_only)
                              from meta.developer d where d.username = t.username), false);
update meta.builder_token t
   set auth_mfa = t.auth_sso or exists (select 1 from meta.developer_factor f where f.username = t.username);

comment on column meta.builder_token.auth_mfa is 'The sign-in the token was made after used a second factor (178).';
comment on column meta.builder_token.auth_sso is 'The sign-in the token was made after went through an identity provider or LDAP directory (178).';
comment on column meta.builder_token.auth_via is 'That provider (its name) or directory (ldap:<name>) (178).';

-- every call made with a builder token: event builder_api, refusals forbidden; detail "token #<id> <name>: …"
create index if not exists activity_log_token_calls on meta.activity_log (id desc)
  where event in ('builder_api', 'forbidden') and detail like 'token #%';
