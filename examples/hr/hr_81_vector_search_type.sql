-- =====================================================================
-- HR example, part 81: search by meaning alone (search type vector)
--
-- Part 72 added POLICIES_MEANING, a hybrid search (full-text and vector
-- similarity combined). This part adds POLICIES_VECTOR to the same search
-- page (42): the vector similarity alone, so the two can be compared ("time
-- off for a family move" finds Relocation leave in both; a word that only
-- full-text matches finds nothing here). Only with pgvector, like part 72.
-- =====================================================================

do $$
begin
  if not exists (select from information_schema.columns where table_schema = 'hr' and table_name = 'policy' and column_name = 'embedding') then
    raise notice 'HR part 81: hr.policy has no vector column (pgvector is not installed): no vector search.';
    return;
  end if;
  insert into meta.search_config (app_id, name, label, seq, source_type, source, search_type,
                                  vector_provider, vector_column, key_column, distance, min_similarity,
                                  title_column, description_column, icon, max_results)
  select id, 'POLICIES_VECTOR', 'Policies by meaning only', 27, 'table', 'hr.policy', 'vector',
         'POLICY_EMBEDDINGS', 'embedding', 'id', 'cosine', 0.6,
         'title', 'body', 'sparkles', 3
    from meta.app where alias = 'hr';
  update meta.region r
     set config = jsonb_set(r.config, '{configs}', (r.config->'configs') || '["POLICIES_VECTOR"]'::jsonb)
    from meta.page p join meta.app a on a.id = p.app_id
   where r.page_id = p.id and a.alias = 'hr' and p.page_no = 42 and r.type = 'search';
end $$;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', 'Policies by meaning only', 'Regelingen alleen op betekenis'
  from meta.app a where a.alias = 'hr'
on conflict do nothing;
