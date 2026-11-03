-- =====================================================================
-- HR example, part 72: search by meaning (sprint 136, AP-1; migration
-- 136; docs/guide/04-pages-and-regions.md "Vector search", 03-builder.md
-- "Vector providers", 20-ai-agents.md)
--
-- hr.policy (parts 42 and 71) gets two more policies and an audience:
-- "Salary bands" is for managers only, and row level security now shows
-- hr_app only the policies the user may read. Every search below runs as
-- hr_app, so an employee never finds the managers' policy.
--
-- With pgvector installed (the extension is created here when the server
-- has it and this connection may; otherwise this part only adds the
-- policies and says so):
--
--   - the vector provider POLICY_EMBEDDINGS (Shared Components → Vector
--     providers) of type function: hr.policy_embedding(text), a tiny
--     stand-in for an embedding model that maps words to eight topics
--     (moving house, time off, home working, sickness, pay, requests,
--     public holidays, anything else). It keeps the example working without
--     an AI service; for real use, make the provider an AI service with an
--     embedding model (e.g. OpenAI text-embedding-3-small, 1536 dimensions,
--     or Ollama's nomic-embed-text, 768) and add the column again with
--     Table Properties › Add vector column;
--   - what Table Properties › Add vector column writes: hr.policy.embedding
--     vector(8), an HNSW index (vector_cosine_ops) and a trigger
--     (meta.embedding_set) that embeds a policy when its title or body
--     changes;
--   - the search configuration POLICIES_MEANING (search type hybrid:
--     full-text on search_vector and the embedding, merged by reciprocal
--     rank fusion) joins page 42 "Search": "time off for a family move"
--     finds "Relocation leave", which uses none of those words;
--   - page 49 "Policy questions": an AI assistant region with the agent
--     POLICY_AGENT, whose Retrieve tool policy_search hands the model the
--     policies that match a question (as hr_app). Like parts 41, 42 and 64
--     it needs an AI service named HR_ASSISTANT.
-- =====================================================================

alter table hr.policy add column audience text not null default 'all' check (audience in ('all', 'managers'));

insert into hr.policy (title, body, audience) values
  ('Relocation leave', 'Employees who relocate to another city for the company get three paid days to settle into the new house, and help with the removal costs.', 'all'),
  ('Salary bands', 'Managers review the salary bands every spring; a raise above the band needs the director''s approval.', 'managers');

alter table hr.policy enable row level security;
create policy policy_visible on hr.policy for select
  using (audience = 'all' or meta.has_role('manager') or meta.has_role('admin'));

-- a stand-in for an embedding model: each word counts for one of eight topics (unknown words a little for the
-- last), and the vector is normalised, so the cosine of two texts says how much they share topics
create function hr.policy_embedding(p_text text) returns real[]
language sql immutable parallel safe set search_path = pg_catalog as $$
  with w as (select lower(m[1]) as w from regexp_matches(coalesce(p_text, ''), '([[:alpha:]]+)', 'g') m),
  d as (select case
                 when w ~ '^(relocat|move|moving|removal|house|settl|city|family)' then 1
                 when w ~ '^(leave|time|off|holiday|vacation|days|absence)$' then 2
                 when w ~ '^(home|remote|working|work)$' then 3
                 when w ~ '^(sick|ill|doctor)' then 4
                 when w ~ '^(salar|pay|band|raise|wage|scale)' then 5
                 when w ~ '^(request|approv|manager)' then 6
                 when w ~ '^(public|closed|office)' then 7
                 else 8 end as dim,
               case when w ~ '^(relocat|move|moving|removal|house|settl|city|family|leave|time|off|holiday|vacation|days|absence|home|remote|working|work|sick|ill|doctor|salar|pay|band|raise|wage|scale|request|approv|manager|public|closed|office)'
                    then 1.0 else 0.05 end as weight
          from w),
  v as (select i, coalesce((select sum(weight) from d where d.dim = i), 0) as x from generate_series(1, 8) i),
  n as (select sqrt(sum(x * x)) as n from v)
  select array_agg((case when n.n = 0 then (case when i = 8 then 1 else 0 end) else x / n.n end)::real order by i) from v, n
$$;
grant execute on function hr.policy_embedding(text) to hr_app;

update meta.app set
  vector_providers = vector_providers || $j$[
    {"name": "POLICY_EMBEDDINGS", "type": "function", "function": "hr.policy_embedding", "dimensions": 8,
     "description": "A stand-in for an embedding model (eight topics); use an AI service for real texts"}
  ]$j$::jsonb,
  ai_tools = ai_tools || $j$[
    {"name": "policy_search", "type": "retrieve", "search_config": "POLICIES_MEANING", "max_rows": 3,
     "description": "The HR policies that match a question, best first (title and text). Use it for every question about rules, leave, pay or working arrangements."}
  ]$j$::jsonb,
  ai_agents = ai_agents || $j$[
    {"name": "POLICY_AGENT", "description": "Answers questions about the HR policies the user may read",
     "service": "HR_ASSISTANT", "effort": "low", "tools": ["policy_search"], "max_steps": 3, "max_tokens": 1500,
     "system": "You answer questions of &APP_USER. about the company's HR policies. Look the policies up with policy_search and answer only from what it returns; say so when no policy covers the question. Name the policy you used. Be brief."}
  ]$j$::jsonb
 where alias = 'hr';

-- page 49: questions about the policies, answered through the Retrieve tool
insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 49, 'Policy questions', 'Policy questions', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, condition, config)
select p.id, r.seq, r.title, r.type, r.cols, 'standard', r.source, r.cond, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Not set up yet', 'static', 12,
   '<p class="alert alert-info">Policy questions need the pgvector extension in the database and an AI service named <b>HR_ASSISTANT</b> (App Builder → Workspace utilities → AI services, allowed for the HR application).</p>',
   'not (meta.ai_available(''HR_ASSISTANT'') and exists (select from pg_catalog.pg_extension where extname = ''vector''))', '{}'),
  (20, 'Ask about the policies', 'ai_assistant', 8, null,
   'meta.ai_available(''HR_ASSISTANT'') and exists (select from pg_catalog.pg_extension where extname = ''vector'')',
   $j${"agent": "POLICY_AGENT",
       "welcome": "Hello! Ask me about the HR policies, e.g. how much time off you get when you move for the company.",
       "placeholder": "e.g. Do I get time off for a family move?",
       "max_turns": 20,
       "error_message": "The policy assistant could not answer just now. Please try again later."}$j$)
  ) as r (seq, title, type, cols, source, cond, config)
 where a.alias = 'hr' and p.page_no = 49;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 30, 'Policy questions', 'book', 49 from meta.app where alias = 'hr';

-- with pgvector: the extension (when this connection may create it), the vector column, the search configuration
-- and the search page
do $$
declare
  v_schema text;
begin
  if not exists (select from pg_extension where extname = 'vector') then
    if exists (select from pg_available_extensions where name = 'vector') and (select rolsuper from pg_roles where rolname = current_user) then
      create extension vector;
    else
      raise notice 'HR part 72: pgvector is not installed: hr.policy gets no vector column (install pgvector, then add one with Table Properties › Add vector column).';
      return;
    end if;
  end if;
  select n.nspname into v_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector';
  execute format('alter table hr.policy add column embedding %I.vector(8)', v_schema);
  execute format('create index policy_embedding_idx on hr.policy using hnsw (embedding %I.vector_cosine_ops)', v_schema);
  execute format($t$create trigger embedding_embed before insert or update of title, body on hr.policy
                    for each row execute function meta.embedding_set(%L, 'POLICY_EMBEDDINGS', 'embedding', 'id', 'title', 'body')$t$,
                 (select id from meta.app where alias = 'hr'));
  -- the policies there are: embedded now (the trigger does it for new and changed ones)
  execute format($u$update hr.policy set embedding = translate(meta.embed(meta.embedding_text(to_jsonb(policy), '{title,body}'), 'POLICY_EMBEDDINGS', %s)::text, '{}', '[]')::text::%I.vector$u$,
                 (select id from meta.app where alias = 'hr'), v_schema);
  insert into meta.search_config (app_id, name, label, seq, source_type, source, search_type, fts_vector, fts_config,
                                  vector_provider, vector_column, key_column, distance, min_similarity,
                                  title_column, description_column, icon, max_results)
  select id, 'POLICIES_MEANING', 'Policies by meaning', 26, 'table', 'hr.policy', 'hybrid', 'search_vector', 'english',
         'POLICY_EMBEDDINGS', 'embedding', 'id', 'cosine', 0.6,
         'title', 'body', 'book', 3
    from meta.app where alias = 'hr';
  update meta.region r
     set config = jsonb_set(r.config, '{configs}', (r.config->'configs') || '["POLICIES_MEANING"]'::jsonb)
    from meta.page p join meta.app a on a.id = p.app_id
   where r.page_id = p.id and a.alias = 'hr' and p.page_no = 42 and r.type = 'search';
end $$;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Policies by meaning', 'Regelingen op betekenis'),
  ('Policy questions', 'Vragen over regelingen'),
  ('Ask about the policies', 'Vraag naar de regelingen'),
  ('Not set up yet', 'Nog niet ingesteld'),
  ('Hello! Ask me about the HR policies, e.g. how much time off you get when you move for the company.',
   'Hallo! Vraag me naar de HR-regelingen, bijv. hoeveel vrij je krijgt als je voor het bedrijf verhuist.'),
  ('e.g. Do I get time off for a family move?', 'bijv. Krijg ik vrij voor een verhuizing met het gezin?')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
