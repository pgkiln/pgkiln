-- =====================================================================
-- 121: AI agents and AI tools (sprint 111, WS-4; APEX 26.1 / 26.2: Shared
--      Components → AI Agents, AI Tools), more AI providers, and a log of
--      every tool call
--
-- meta.app.ai_tools: the application's AI tools, a JSON list. A tool is
--   what an agent may do, each one an approved, constrained action:
--     {"name": "top_earners", "type": "sql", "description": "…",
--      "sql": "select … where dname ilike :DNAME", "parameters": {"DNAME": {"type": "string"}},
--      "max_rows": 20, "timeout_s": 10, "authz": "MANAGER"}
--   Types: sql (a query, run as the application's role through RLS in a
--   read-only transaction with a time limit), function (a PL/pgSQL
--   function called with named arguments, as the application's role; it
--   may change data), rest (a REST data source of the application),
--   javascript (a function registered with pgkiln.actions.register and/or
--   the dynamic actions of the custom event with the tool's action name,
--   run in the user's browser after the answer) and navigate (the model
--   picks one of the tool's pages and item values; pgkiln checks the user
--   may open the page and builds the URL with its checksum).
-- meta.app.ai_agents: the application's AI agents, a JSON list:
--     {"name": "HR_AGENT", "description": "…", "service": "HR_ASSISTANT",
--      "system": "…", "effort": "low" | "medium" | "high" | null,
--      "tools": ["top_earners", "open_employee"], "max_steps": 5,
--      "max_tokens": 2000, "authz": "MANAGER"}
--   An AI assistant region names an agent ("agent" in its config) instead
--   of a service, a system prompt and tools of its own.
-- Both are definitions of the application: export_app copies every column
-- of meta.app, so they travel with it (no redefinition of export_app /
-- import_app). An export made before 121 has neither key: the trigger
-- below turns the NULL from jsonb_populate_record into an empty list.
-- The builder checks both lists (src/runtime/ai-agents.ts); the runtime
-- checks them again before it uses them.
--
-- meta.ai_service.provider: also "gemini" (Google Gemini through its
--   OpenAI-compatible endpoint) and "openai_compatible" (any endpoint that
--   speaks OpenAI's Chat Completions: Ollama, vLLM, Azure OpenAI, a
--   gateway). An OpenAI-compatible service needs a base URL; its key may
--   be empty (a local Ollama needs none).
--
-- meta.ai_tool_call: one row per tool call of an assistant or agent (app,
--   page, user, agent, tool, type, the arguments the model gave, status,
--   duration, a short message). The arguments may hold user data: only
--   the owner reads the table (Activity → AI usage); kept 30 days.
--   Installation data, like meta.ai_usage: not exported.
-- =====================================================================

alter table meta.app add column ai_tools jsonb not null default '[]'
  check (jsonb_typeof(ai_tools) = 'array');
alter table meta.app add column ai_agents jsonb not null default '[]'
  check (jsonb_typeof(ai_agents) = 'array');
comment on column meta.app.ai_tools is 'AI tools (121): what the application''s AI agents may do (sql, function, rest, javascript, navigate)';
comment on column meta.app.ai_agents is 'AI agents (121): AI service, system prompt, reasoning effort, tools, limits and authorization of each agent';

create function meta.app_ai_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.ai_tools := coalesce(new.ai_tools, '[]');
  new.ai_agents := coalesce(new.ai_agents, '[]');
  return new;
end $$;
create trigger app_ai_default before insert or update on meta.app
  for each row execute function meta.app_ai_default();

alter table meta.ai_service drop constraint ai_service_provider_check;
alter table meta.ai_service add constraint ai_service_provider_check
  check (provider in ('anthropic', 'openai', 'gemini', 'openai_compatible'));
alter table meta.ai_service add constraint ai_service_compatible_url
  check (provider <> 'openai_compatible' or base_url is not null);
-- conversations keep the provider's format (Gemini and OpenAI-compatible: OpenAI's)
alter table meta.ai_conversation drop constraint ai_conversation_provider_check;
alter table meta.ai_conversation add constraint ai_conversation_provider_check
  check (provider in ('anthropic', 'openai', 'gemini', 'openai_compatible'));

create table meta.ai_tool_call (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  app_id      int not null references meta.app on delete cascade,
  page_no     int,
  region_id   int,
  username    text,
  -- null: a tool of the region itself (no agent)
  agent       text,
  tool        text not null,
  type        text not null,
  -- the model's arguments (checked), cut to a few kilobytes
  arguments   jsonb not null default '{}',
  status      text not null check (status in ('ok', 'error', 'refused')),
  duration_ms int not null default 0,
  message     text
);
create index on meta.ai_tool_call (app_id, id desc);
create index on meta.ai_tool_call (at);
revoke all on meta.ai_tool_call from public;
comment on table meta.ai_tool_call is 'Tool calls of AI assistants and agents (121), with their arguments; kept 30 days';
