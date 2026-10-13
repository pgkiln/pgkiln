-- =====================================================================
-- 093: workspace preferences and extension links (APEX: Administration →
-- Manage Service → Set Workspace Preferences, Manage Extension Links)
--
-- sql_workshop   false: the SQL Workshop (SQL Commands, Object Browser,
--                scripts, data loading, Quick SQL, query builder, DDL and
--                compare, AI) is refused while the workspace is current
-- rest_services  false: the REST modules of the workspace's applications
--                answer 404 at run time (/a/<alias>/rest/...)
--
-- meta.workspace_link: links to other tools (monitoring, a wiki, a ticket
-- system) shown in the builder's Extensions menu while the workspace is current.
--
-- Administrators and the workspace's administrators set them.
-- Installation data, not exported.
-- =====================================================================
alter table meta.workspace
  add column sql_workshop boolean not null default true,
  add column rest_services boolean not null default true;
comment on column meta.workspace.sql_workshop is 'Workspace preference (093): false refuses the SQL Workshop while the workspace is current.';
comment on column meta.workspace.rest_services is 'Workspace preference (093): false turns off the REST modules of the workspace''s applications.';

create table meta.workspace_link (
  id           serial primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  label        text not null check (label ~ '^\S(.{0,58}\S)?$'),
  url          text not null check (url ~ '^https?://[^\s<>"]+$' and length(url) <= 2000),
  description  text check (length(description) <= 500),
  position     int  not null default 0,
  unique (workspace_id, label)
);
revoke all on meta.workspace_link from public;
comment on table meta.workspace_link is 'Extension links (093): a workspace''s links to other tools, in the builder''s Extensions menu. Not exported.';

