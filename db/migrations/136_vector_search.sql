-- =====================================================================
-- 136: vector providers, vector and hybrid search configurations,
--      vector columns kept current, Retrieve tools (sprint 136, AP-1;
--      APEX: Vector Providers, APEX_AI.GET_VECTOR_EMBEDDINGS, a search
--      configuration of type "Oracle Vector Search")
--
-- Everything here installs without pgvector: no meta table or function
-- uses the `vector` type. Vectors cross meta.* as real[] (pgvector casts
-- real[] to vector and back); the DDL that adds a vector column to an
-- application's table is written by the builder (SQL Workshop › Table
-- Properties › Add vector column) only when the extension is installed.
--
-- meta.app.vector_providers: the application's vector providers, a JSON
--   list (exported with the application in app.json, like ai_agents, 121):
--     {"name": "POLICY_EMBEDDINGS", "description": "…",
--      "type": "ai_service", "service": "EMBEDDINGS",
--      "model": "text-embedding-3-small", "dimensions": 1536,
--      "batch_size": 64, "per_minute": 60}
--     {"name": "TOY", "type": "function", "function": "sales.embed", "dimensions": 8}
--   ai_service: an AI service of the installation (OpenAI, Gemini or an
--   OpenAI-compatible endpoint such as Ollama) and an embedding model; its
--   key stays in meta.ai_service (encrypted, never exported). function: a
--   SQL / PL/pgSQL function (text) returning vector, real[] or float8[].
--   The server checks the list (src/ai/embeddings.ts).
--
-- meta.vector_provider(name, app) returns one definition (none are secret).
-- meta.embed(text, provider, app) returns the embedding as real[] for a
--   function provider, called as the caller's role (security invoker). An
--   AI service is called by the pgkiln server, not from SQL: meta.embed
--   says so for such a provider (vector search, Retrieve tools and the
--   vector column queue use it).
--
-- meta.search_config: search types `vector` (nearest rows by a vector
--   column, the user's text embedded by vector_provider; distance cosine,
--   l2 or inner_product; at least min_similarity) and `hybrid` (full-text
--   and vector rankings merged by reciprocal rank fusion, rows matched by
--   key_column). The new columns travel with the configuration
--   (to_jsonb of the row); the defaults trigger fills them for older exports.
--
-- Keeping a vector column current (triggers the builder creates on the
-- application's table; their arguments: app id, provider, vector column,
-- key column, source columns…):
--   meta.embedding_set()      BEFORE INSERT OR UPDATE OF the source columns:
--                             a function provider's embedding, at once;
--   meta.embedding_enqueue()  AFTER INSERT OR UPDATE OF the source columns:
--                             the row's key into meta.embedding_queue; the
--                             server embeds queued rows in batches, within
--                             the provider's requests per minute and the
--                             application's daily AI limits (src/embeddings.ts).
-- meta.embedding_queue: installation data, not exported (like
--   meta.process_job); only the owner reads it.
-- =====================================================================

alter table meta.app add column vector_providers jsonb not null default '[]'
  check (jsonb_typeof(vector_providers) = 'array');
comment on column meta.app.vector_providers is 'Vector providers (136): an AI service with an embedding model, or a function returning vector; exported with the application';

-- an export made before 136 has no vector_providers (nor one before 121 ai_tools / ai_agents)
create or replace function meta.app_ai_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.ai_tools := coalesce(new.ai_tools, '[]');
  new.ai_agents := coalesce(new.ai_agents, '[]');
  new.vector_providers := coalesce(new.vector_providers, '[]');
  return new;
end $$;

-- ---------------------------------------------------------------- providers and meta.embed

-- One vector provider of an application (the current one, or one the login may see).
create function meta.vector_provider(p_name text, p_app int default null) returns jsonb
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := coalesce(p_app, meta.app_id());
begin
  if v_app is null then
    raise exception 'meta.vector_provider: no current application (pass the application''s id)';
  end if;
  if not meta.app_visible(v_app) then
    raise exception 'Application % is not in this workspace.', v_app using errcode = '42501';
  end if;
  return (select e from meta.app a, jsonb_array_elements(a.vector_providers) e
           where a.id = v_app and e->>'name' = upper(p_name) limit 1);
end
$$;

-- The embedding of a text by a function provider, as real[] (cast it: meta.embed(…)::vector).
-- Runs the provider's function as the caller (security invoker): its grants apply.
create function meta.embed(p_text text, p_provider text, p_app int default null) returns real[]
language plpgsql volatile set search_path = meta, pg_catalog as $$
declare
  v   jsonb := meta.vector_provider(p_provider, p_app);
  fn  text;
  r   real[];
begin
  if v is null then
    raise exception 'meta.embed: there is no vector provider %', upper(p_provider);
  end if;
  if p_text is null then
    return null;
  end if;
  if v->>'type' is distinct from 'function' then
    raise exception 'meta.embed: vector provider % uses AI service %, which the pgkiln server calls: use it in a vector search configuration, a Retrieve tool or a vector column (Table Properties › Add vector column); in SQL only function providers embed',
      v->>'name', v->>'service';
  end if;
  fn := v->>'function';
  if fn !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,62}$' then
    raise exception 'meta.embed: the function of vector provider % is schema.name', v->>'name';
  end if;
  execute format('select (%I.%I($1))::real[]', split_part(fn, '.', 1), split_part(fn, '.', 2)) into r using p_text;
  if r is not null and cardinality(r) is distinct from (v->>'dimensions')::int then
    raise exception 'meta.embed: % returned % dimensions, vector provider % has %', fn, cardinality(r), v->>'name', v->>'dimensions';
  end if;
  return r;
end
$$;

-- ---------------------------------------------------------------- keeping vector columns current

create table meta.embedding_queue (
  id             bigserial primary key,
  app_id         int  not null references meta.app on delete cascade,
  provider       text not null,
  -- the table whose trigger queued the row (pg_class oid)
  tbl            oid  not null,
  vector_column  text not null,
  key_column     text not null,
  source_columns text[] not null,
  key_value      text not null,
  queued_at      timestamptz not null default now(),
  next_at        timestamptz not null default now(),
  attempts       int  not null default 0,
  last_error     text,
  unique (tbl, vector_column, key_value)
);
create index on meta.embedding_queue (next_at);
create index on meta.embedding_queue (app_id, provider);
revoke all on meta.embedding_queue from public;
comment on table meta.embedding_queue is 'Rows whose vector column the pgkiln server re-embeds (136): queued by meta.embedding_enqueue() triggers and Backfill';

-- the trigger arguments: app id, provider, vector column, key column, source columns
create function meta.embedding_args_ok(p_args text[]) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select cardinality(p_args) between 5 and 24
     and p_args[1] ~ '^[0-9]{1,10}$'
     and p_args[2] ~ '^[A-Za-z][A-Za-z0-9_]{0,59}$'
     and not exists (select from unnest(p_args[3:]) c where c !~ '^[a-z_][a-z0-9_$]{0,62}$')
$$;

-- the text a row is embedded from: its source columns, one per line
create function meta.embedding_text(p_row jsonb, p_columns text[]) returns text
language sql immutable set search_path = pg_catalog as $$
  select nullif(concat_ws(E'\n', variadic array(select p_row->>c from unnest(p_columns) with ordinality u(c, n) order by n)), '')
$$;

-- BEFORE INSERT OR UPDATE OF …: a function provider's embedding, set at once (as the role that writes the row)
create function meta.embedding_set() returns trigger
language plpgsql volatile set search_path = meta, pg_catalog as $$
declare
  v_args text[] := array(select unnest(tg_argv));
  v_cols text[];
  v_vec  real[];
begin
  if not meta.embedding_args_ok(v_args) then
    raise exception 'meta.embedding_set: the arguments are app id, provider, vector column, key column, source columns';
  end if;
  v_cols := v_args[5:];
  if tg_op = 'UPDATE' and meta.embedding_text(to_jsonb(old), v_cols) is not distinct from meta.embedding_text(to_jsonb(new), v_cols)
     and to_jsonb(new)->>v_args[3] is not null then
    return new;
  end if;
  v_vec := meta.embed(meta.embedding_text(to_jsonb(new), v_cols), v_args[2], v_args[1]::int);
  new := jsonb_populate_record(new, jsonb_build_object(v_args[3], translate(v_vec::text, '{}', '[]')));
  return new;
end
$$;

-- AFTER INSERT OR UPDATE OF …: the row's key into the queue (the server embeds it)
create function meta.embedding_enqueue() returns trigger
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_args text[] := array(select unnest(tg_argv));
  v_app  int;
  v_key  text;
begin
  if not meta.embedding_args_ok(v_args) then
    raise exception 'meta.embedding_enqueue: the arguments are app id, provider, vector column, key column, source columns';
  end if;
  v_app := v_args[1]::int;
  if not meta.app_visible(v_app) then
    raise exception 'Application % is not in this workspace.', v_app using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and meta.embedding_text(to_jsonb(old), v_args[5:]) is not distinct from meta.embedding_text(to_jsonb(new), v_args[5:]) then
    return null;
  end if;
  v_key := to_jsonb(new)->>v_args[4];
  if v_key is null then
    return null;
  end if;
  insert into meta.embedding_queue (app_id, provider, tbl, vector_column, key_column, source_columns, key_value)
  values (v_app, upper(v_args[2]), tg_relid, v_args[3], v_args[4], v_args[5:], v_key)
  on conflict (tbl, vector_column, key_value) do update
     set app_id = excluded.app_id, provider = excluded.provider, key_column = excluded.key_column,
         source_columns = excluded.source_columns, queued_at = now(), next_at = now(), attempts = 0, last_error = null;
  return null;
end
$$;

grant execute on function meta.vector_provider(text, int), meta.embed(text, text, int), meta.embedding_args_ok(text[]),
  meta.embedding_text(jsonb, text[]), meta.embedding_set(), meta.embedding_enqueue() to public;

-- ---------------------------------------------------------------- vector and hybrid search configurations

alter table meta.search_config
  add column vector_provider text,
  add column vector_column   text,
  add column key_column      text,
  add column distance        text not null default 'cosine',
  add column min_similarity  real;

alter table meta.search_config drop constraint search_config_search_type_check;
alter table meta.search_config
  add constraint search_config_search_type_check check (search_type in ('standard', 'fulltext', 'vector', 'hybrid')),
  add constraint search_config_vector_provider_check check (vector_provider is null or vector_provider ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  -- column names only (quoted as identifiers by the server)
  add constraint search_config_vector_column_check check (vector_column is null or vector_column ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$'),
  add constraint search_config_key_column_check check (key_column is null or key_column ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$'),
  add constraint search_config_distance_check check (distance in ('cosine', 'l2', 'inner_product')),
  add constraint search_config_min_similarity_check check (min_similarity is null or min_similarity between -1 and 1),
  add constraint search_config_vector_check check (search_type not in ('vector', 'hybrid') or (vector_provider is not null and vector_column is not null)),
  add constraint search_config_hybrid_key_check check (search_type <> 'hybrid' or key_column is not null);

comment on column meta.search_config.search_type is 'standard (ILIKE per word), fulltext (websearch_to_tsquery, ts_rank_cd, ts_headline), vector (nearest by an embedding, 136) or hybrid (fulltext and vector by reciprocal rank fusion, 136)';
comment on column meta.search_config.vector_provider is 'vector, hybrid: the vector provider (static ID) that embeds the search text';
comment on column meta.search_config.vector_column is 'vector, hybrid: the source''s vector column';
comment on column meta.search_config.key_column is 'hybrid: the key that matches full-text and vector results';
comment on column meta.search_config.distance is 'vector, hybrid: cosine (<=>), l2 (<->) or inner_product (<#>)';
comment on column meta.search_config.min_similarity is 'vector, hybrid: at least this similarity (cosine: 1 - distance; inner product: the product; l2: 1 / (1 + distance))';

create or replace function meta.search_config_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.seq := coalesce(new.seq, 10);
  new.source_type := coalesce(new.source_type, 'table');
  new.searchable_columns := coalesce(new.searchable_columns, '{}');
  new.max_results := coalesce(new.max_results, 10);
  new.search_type := coalesce(new.search_type, 'standard');
  new.did_you_mean := coalesce(new.did_you_mean, false);
  new.distance := coalesce(new.distance, 'cosine');
  return new;
end $$;
