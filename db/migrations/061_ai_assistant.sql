-- =====================================================================
-- 061: AI assistant region (chat with an optional context from queries
--      and tools: an AI agent) and natural-language filters on reports
--
-- Region type "ai_assistant": a chat with an AI service (migration 060).
--   Its settings are in the region's config (so they travel with the
--   export): the service, a system prompt, a welcome text, context queries
--   (run as the application's role before each question, their rows are
--   given to the model as data) and tools the model may call (SQL run as
--   the application's role with the model's arguments as bind values, or a
--   REST data source). See src/runtime/assistant.ts.
--
-- meta.ai_conversation: one conversation per session and region (the
--   provider's message history and the transcript shown). It belongs to the
--   session: signing out or the session's end deletes it. User data of
--   this installation: not exported; only the owner reads it (the server
--   loads it by the session id), so applications can't read other users'
--   conversations.
--
-- Natural-language filters (NL2IR) need no table: "ai_filter" in a report
-- region's config ({"service": "NAME"}) adds an "Ask" box above the report.
-- =====================================================================

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
                  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter', 'ai_assistant'));

create table meta.ai_conversation (
  id          bigserial primary key,
  app_id      int  not null references meta.app on delete cascade,
  region_id   int  not null references meta.region on delete cascade,
  session_id  uuid not null references meta.session on delete cascade,
  username    text,
  service     text not null,
  provider    text not null check (provider in ('anthropic', 'openai')),
  -- the provider's message history (sent again with each question), append-only
  messages    jsonb not null default '[]' check (jsonb_typeof(messages) = 'array'),
  -- what the page shows: [{"role": "user"|"assistant", "text": "…", "tools": [{"name": "…", "ok": true}]}]
  turns       jsonb not null default '[]' check (jsonb_typeof(turns) = 'array'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (session_id, region_id)
);
create index on meta.ai_conversation (app_id);
create index on meta.ai_conversation (region_id);
revoke all on meta.ai_conversation from public;
comment on table meta.ai_conversation is 'AI assistant conversations, one per session and region; deleted with the session; never exported';
