-- =====================================================================
-- 122: Team Development (APEX: Team Development in the workspace)
--
-- An issue tracker per workspace for the team that builds its
-- applications: issues (title, Markdown body, open or closed) with labels,
-- a milestone, assignees (the workspace's developers), a link to an
-- application and one of its pages, comments with @mentions of developers
-- (shown in the builder, never mailed) and a history of changes. Labels
-- belong to label groups (e.g. Type: Bug, Feature, Task; Priority: High,
-- Medium, Low); templates prefill new issues (kind 'issue') or comments
-- (kind 'response', canned answers). Developers save their own filtered
-- views of the list.
--
-- An issue may come from a user's feedback (meta.feedback, Activity →
-- Feedback) or a developer comment (meta.dev_comment): linked back.
--
-- Workspace data, like the SQL Workshop's scripts: written by the builder
-- as the owner, never read by the runtime; not part of an application's
-- export (kept by pgkiln import --replace) but part of the workspace export
-- (Workspace utilities → Export and import, part "team").
-- =====================================================================

create table meta.team_label_group (
  id           bigint generated always as identity primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  name         text not null check (name ~ '^\S(.{0,38}\S)?$'),
  description  text check (length(description) <= 500),
  seq          int  not null default 10
);
create unique index team_label_group_name on meta.team_label_group (workspace_id, lower(name));

create table meta.team_label (
  id           bigint generated always as identity primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  group_id     bigint references meta.team_label_group on delete set null,
  name         text not null check (name ~ '^\S(.{0,38}\S)?$'),
  -- a colour of a fixed palette (builder.css draws them); never free CSS
  color        text not null default 'gray' check (color in ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray')),
  description  text check (length(description) <= 500),
  seq          int  not null default 10
);
create unique index team_label_name on meta.team_label (workspace_id, lower(name));

create table meta.team_milestone (
  id           bigint generated always as identity primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  name         text not null check (name ~ '^\S(.{0,38}\S)?$'),
  description  text check (length(description) <= 500),
  due_date     date,
  status       text not null default 'open' check (status in ('open', 'closed')),
  created_at   timestamptz not null default now()
);
create unique index team_milestone_name on meta.team_milestone (workspace_id, lower(name));

create table meta.team_template (
  id           bigint generated always as identity primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  kind         text not null check (kind in ('issue', 'response')),
  name         text not null check (name ~ '^\S(.{0,58}\S)?$'),
  -- issue templates: the new issue's title and labels (by name)
  title        text check (length(title) <= 200),
  body         text not null default '' check (length(body) <= 20000),
  labels       text[] not null default '{}' check (cardinality(labels) <= 20),
  seq          int  not null default 10
);
create unique index team_template_name on meta.team_template (workspace_id, kind, lower(name));

create table meta.team_issue (
  id             bigint generated always as identity primary key,
  workspace_id   int  not null references meta.workspace on delete cascade,
  title          text not null check (length(btrim(title)) between 1 and 200),
  body           text not null default '' check (length(body) <= 20000),
  status         text not null default 'open' check (status in ('open', 'closed')),
  milestone_id   bigint references meta.team_milestone on delete set null,
  -- the application (of the same workspace) and page the issue is about
  app_id         int references meta.app on delete set null,
  page_no        int check (page_no >= 0),
  -- where it came from: a user's feedback or a developer comment
  feedback_id    bigint references meta.feedback on delete set null,
  dev_comment_id int references meta.dev_comment on delete set null,
  created_by     text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  closed_by      text,
  closed_at      timestamptz
);
create index team_issue_ws on meta.team_issue (workspace_id, status, updated_at desc);
create index team_issue_page on meta.team_issue (app_id, page_no) where status = 'open';
create index team_issue_feedback on meta.team_issue (feedback_id) where feedback_id is not null;
create index team_issue_comment_src on meta.team_issue (dev_comment_id) where dev_comment_id is not null;

create table meta.team_issue_label (
  issue_id bigint not null references meta.team_issue on delete cascade,
  label_id bigint not null references meta.team_label on delete cascade,
  primary key (issue_id, label_id)
);
create index on meta.team_issue_label (label_id);

create table meta.team_issue_assignee (
  issue_id bigint not null references meta.team_issue on delete cascade,
  username text   not null references meta.developer (username) on delete cascade on update cascade,
  primary key (issue_id, username)
);
create index on meta.team_issue_assignee (username);

create table meta.team_issue_comment (
  id         bigint generated always as identity primary key,
  issue_id   bigint not null references meta.team_issue on delete cascade,
  author     text not null,
  body       text not null check (length(btrim(body)) between 1 and 20000),
  created_at timestamptz not null default now()
);
create index on meta.team_issue_comment (issue_id, created_at);

-- the history of an issue: who changed what, when
create table meta.team_issue_event (
  id       bigint generated always as identity primary key,
  issue_id bigint not null references meta.team_issue on delete cascade,
  at       timestamptz not null default now(),
  username text,
  action   text not null check (action ~ '^[a-z_]{1,30}$'),
  detail   text check (length(detail) <= 1000)
);
create index on meta.team_issue_event (issue_id, at);

-- @mentions of the workspace's developers in an issue's body or a comment; shown in the builder until seen
create table meta.team_mention (
  id         bigint generated always as identity primary key,
  issue_id   bigint not null references meta.team_issue on delete cascade,
  comment_id bigint references meta.team_issue_comment on delete cascade,
  username   text   not null references meta.developer (username) on delete cascade on update cascade,
  by_user    text,
  created_at timestamptz not null default now(),
  seen_at    timestamptz
);
create index on meta.team_mention (username) where seen_at is null;

-- a developer's saved views of the issue list (the filters as a query string)
create table meta.team_view (
  id           bigint generated always as identity primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  username     text not null references meta.developer (username) on delete cascade on update cascade,
  name         text not null check (name ~ '^\S(.{0,38}\S)?$'),
  query        text not null default '' check (length(query) <= 1000),
  created_at   timestamptz not null default now()
);
create unique index team_view_name on meta.team_view (workspace_id, username, lower(name));

-- the label's group, the issue's milestone and its labels belong to the issue's workspace
create function meta.team_same_workspace() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  -- (nested: a record field is only read in the branch of its own table)
  if tg_table_name = 'team_label' then
    if new.group_id is not null
       and (select g.workspace_id from meta.team_label_group g where g.id = new.group_id) is distinct from new.workspace_id then
      raise exception 'the label group belongs to another workspace';
    end if;
  elsif tg_table_name = 'team_issue' then
    if new.milestone_id is not null
       and (select m.workspace_id from meta.team_milestone m where m.id = new.milestone_id) is distinct from new.workspace_id then
      raise exception 'the milestone belongs to another workspace';
    end if;
  elsif tg_table_name = 'team_issue_label' then
    if (select l.workspace_id from meta.team_label l where l.id = new.label_id)
       is distinct from (select i.workspace_id from meta.team_issue i where i.id = new.issue_id) then
      raise exception 'the label belongs to another workspace';
    end if;
  end if;
  return new;
end $$;
create trigger team_same_workspace before insert or update on meta.team_label for each row execute function meta.team_same_workspace();
create trigger team_same_workspace before insert or update on meta.team_issue for each row execute function meta.team_same_workspace();
create trigger team_same_workspace before insert or update on meta.team_issue_label for each row execute function meta.team_same_workspace();

revoke all on meta.team_label_group, meta.team_label, meta.team_milestone, meta.team_template, meta.team_issue, meta.team_issue_label,
  meta.team_issue_assignee, meta.team_issue_comment, meta.team_issue_event, meta.team_mention, meta.team_view from public;

comment on table meta.team_issue is 'Team Development (122): issues of a workspace; workspace data (the workspace export), not exported with an application';
comment on table meta.team_label is 'Team Development (122): labels of a workspace''s issues, in label groups, with a colour of a fixed palette';
comment on table meta.team_label_group is 'Team Development (122): label groups (e.g. Type, Priority)';
comment on table meta.team_milestone is 'Team Development (122): milestones of a workspace';
comment on table meta.team_template is 'Team Development (122): issue templates and canned responses';
comment on table meta.team_issue_event is 'Team Development (122): the history of an issue';
comment on table meta.team_mention is 'Team Development (122): @mentions of developers, shown in the builder until seen';
comment on table meta.team_view is 'Team Development (122): saved views of the issue list, per developer';
