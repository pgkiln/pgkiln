-- =====================================================================
-- 096: developers' e-mail addresses and "Find my workspace" (APEX: the
-- workspace sign-in page → Find My Workspace)
--
-- meta.developer.email: optional; a developer sets their own on the
-- Developers page, administrators set anyone's. "Find my workspace" on the
-- builder's sign-in page mails the developer accounts with that address the
-- workspaces they belong to, through the mail service administrators choose
-- for the builder (meta.setting builder_mail_service and builder_mail_from).
-- The page answers the same whether or not an account has the address.
-- =====================================================================
alter table meta.developer
  add column email text check (email is null or (email ~ '^[^@\s<>"(),;:\\]+@[^@\s<>"(),;:\\]+\.[^@\s<>"(),;:\\]+$' and length(email) <= 254));
create index developer_email_idx on meta.developer (lower(email)) where email is not null;
comment on column meta.developer.email is 'The developer''s e-mail address (096): "Find my workspace" sends their workspaces to it.';
