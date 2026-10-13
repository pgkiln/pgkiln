-- =====================================================================
-- 092: application groups (APEX: Workspace Utilities → Application Groups)
--
-- A workspace's named groups of applications, to organise the App Builder:
-- the home page filters and labels applications by group. They change
-- nothing at run time. Installation data (like workspaces): not exported,
-- kept by an in-place import.
-- =====================================================================
create table meta.app_group (
  id           serial primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  name         text not null check (name ~ '^\S(.{0,58}\S)?$'),
  description  text check (length(description) <= 2000),
  unique (workspace_id, name)
);
create table meta.app_group_member (
  app_id   int primary key references meta.app on delete cascade,
  group_id int not null references meta.app_group on delete cascade
);
create index app_group_member_group_idx on meta.app_group_member (group_id);
revoke all on meta.app_group, meta.app_group_member from public;
comment on table meta.app_group is 'Application groups (092): a workspace''s named groups of applications, for the App Builder. Not exported.';
comment on table meta.app_group_member is 'The group of an application (092); none: ungrouped.';
