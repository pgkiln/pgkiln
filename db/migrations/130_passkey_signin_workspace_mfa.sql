-- ---------------------------------------------------------------------
-- 130: passkey sign-in and a workspace two-factor rule (sprint 128,
-- SEC-2 part 3; beyond APEX).
--
-- meta.workspace.mfa_required_since: when set, every developer of the
-- workspace needs a second factor, with the instance's grace period
-- (mfa_grace_days) counted from this moment; null = the instance policy
-- alone decides. Administrators of the instance are covered only where they
-- are members. `pgkiln admin set-2fa-policy off` clears it everywhere.
--
-- meta.setting mfa_passkey_signin ('on', the default, or 'off'): a
-- developer may sign in with a passkey alone, without the password, when
-- the authenticator verified them (fingerprint, face, PIN). It counts as
-- both factors.
-- ---------------------------------------------------------------------
alter table meta.workspace add column mfa_required_since timestamptz;

comment on column meta.workspace.mfa_required_since is 'Two-factor sign-in required for this workspace''s developers since (null = not by the workspace) (130).';

insert into meta.setting (name, value) values ('mfa_passkey_signin', 'on') on conflict (name) do nothing;
