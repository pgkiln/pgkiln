-- =====================================================================
-- 091: a workspace's message and environment banner (APEX: Administration
-- → Manage Service → Define Workspace Message, Define Environment Banner)
--
-- message      shown to the workspace's developers on the App Builder home
--              (plain text, at most 2000 characters)
-- banner_label a short label (e.g. DEVELOPMENT, TEST) shown in a coloured band
--              at the top of every builder page while the workspace is current
-- banner_color one colour of a fixed list (the builder's CSS draws them)
--
-- Administrators and the workspace's administrators set them.
-- Installation data, not exported.
-- =====================================================================
alter table meta.workspace
  add column message text check (length(message) between 1 and 2000),
  add column banner_label text check (banner_label ~ '^\S(.{0,38}\S)?$'),
  add column banner_color text not null default 'blue'
    check (banner_color in ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'));
comment on column meta.workspace.message is 'Workspace message (091): shown to its developers on the App Builder home.';
comment on column meta.workspace.banner_label is 'Environment banner (091): a label shown at the top of the builder while the workspace is current.';
