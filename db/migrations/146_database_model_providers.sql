-- Sprint 151 (AP-1 leftover; APEX: a Vector Provider with an ONNX model loaded in the database): vector providers of
-- type database_model. The model runs inside PostgreSQL, through an extension (engine), with no AI service:
--
--   {"name": "DOCS_E5", "type": "database_model", "engine": "pgml", "model": "intfloat/e5-small-v2", "dimensions": 384}
--
-- engine pgml (PostgresML): pgml.embed(model, text) runs the model (Hugging Face transformers, ONNX among them) in the
-- database server and returns real[]. Like a function provider, meta.embed() runs it as the caller (its grants
-- apply: the application's role needs USAGE on schema pgml), so vector columns are kept at once by their trigger,
-- searches embed the search text in the query, and a Retrieve tool needs no AI service. The model name is a
-- parameter, never SQL. Other engines can be added here (the list in src/ai/embeddings.ts names them).

create or replace function meta.embed(p_text text, p_provider text, p_app int default null) returns real[]
language plpgsql stable set search_path = meta, pg_catalog as $$
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
  if v->>'type' = 'database_model' then
    -- (146) a model in the database
    if v->>'engine' is distinct from 'pgml' then
      raise exception 'meta.embed: vector provider % has engine %, which pgkiln doesn''t know (pgml)', v->>'name', coalesce(v->>'engine', '(none)');
    end if;
    if coalesce(v->>'model', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$' then
      raise exception 'meta.embed: the model of vector provider % is a model name', v->>'name';
    end if;
    if to_regprocedure('pgml.embed(text, text, jsonb)') is null then
      raise exception 'meta.embed: vector provider % runs model % with PostgresML, which is not installed in this database (create extension pgml)', v->>'name', v->>'model'
        using errcode = '42883';
    end if;
    execute 'select (pgml.embed($1, $2))::real[]' into r using v->>'model', p_text;
  elsif v->>'type' = 'function' then
    fn := v->>'function';
    if fn !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,62}$' then
      raise exception 'meta.embed: the function of vector provider % is schema.name', v->>'name';
    end if;
    execute format('select (%I.%I($1))::real[]', split_part(fn, '.', 1), split_part(fn, '.', 2)) into r using p_text;
  else
    raise exception 'meta.embed: vector provider % uses AI service %, which the pgkiln server calls: use it in a vector search configuration, a Retrieve tool or a vector column (Table Properties › Add vector column); in SQL only function and database model providers embed',
      v->>'name', v->>'service';
  end if;
  if r is not null and cardinality(r) is distinct from (v->>'dimensions')::int then
    raise exception 'meta.embed: vector provider % returned % dimensions, it has %', v->>'name', cardinality(r), v->>'dimensions';
  end if;
  return r;
end
$$;
