-- =====================================================================
-- 135: full-text search configurations (sprint 135, AP-2; APEX: a search
-- configuration's Search Type "Oracle Text" next to "Standard")
--
-- A search configuration gets a search type:
--
--   standard  every word of the search text in one of the searchable
--             columns (ILIKE), as before (080);
--   fulltext  PostgreSQL full-text search: the source's tsvector (a column,
--             an expression, or built from the searchable columns) matched
--             with websearch_to_tsquery(<text search configuration>, <text>),
--             the best match first (ts_rank_cd), the matched words
--             highlighted with ts_headline (src/runtime/search.ts).
--
-- The type is open for later ones: `vector` (embeddings) and `hybrid`
-- (full-text and vector results merged by reciprocal rank fusion) will be
-- added to the same check with their own columns.
--
--   fts_vector    a tsvector column of the source, or an expression giving a
--                 tsvector; empty: to_tsvector over the searchable columns
--   fts_config    the text search configuration (pg_ts_config: english,
--                 dutch, german, simple…); empty: the one of the
--                 application's primary language, else simple
--   did_you_mean  with pg_trgm installed: when nothing is found, suggest
--                 the closest words of the source (any search type)
--
-- export_app / import_app need no change: the configuration is exported as
-- to_jsonb of its row, and the before-insert trigger below fills the new
-- columns for exports made before 135.
-- =====================================================================

alter table meta.search_config
  add column search_type  text not null default 'standard',
  add column fts_vector   text,
  add column fts_config   text,
  add column did_you_mean boolean not null default false;

alter table meta.search_config
  add constraint search_config_search_type_check check (search_type in ('standard', 'fulltext')),
  -- a name only (it is checked against pg_ts_config and passed as a query parameter, never as SQL)
  add constraint search_config_fts_config_check check (fts_config is null or fts_config ~ '^[a-z_][a-z0-9_]{0,62}$'),
  add constraint search_config_fts_list_check check (search_type = 'standard' or source_type <> 'list');

comment on column meta.search_config.search_type is 'standard (ILIKE per word) or fulltext (websearch_to_tsquery, ts_rank_cd, ts_headline); later vector, hybrid';
comment on column meta.search_config.fts_vector is 'fulltext: a tsvector column or expression; empty: to_tsvector over the searchable columns';
comment on column meta.search_config.fts_config is 'fulltext: the text search configuration (pg_ts_config); empty: the application language''s, else simple';
comment on column meta.search_config.did_you_mean is 'with pg_trgm: suggest the closest words when nothing is found';

-- an export made before 135 has none of the new columns
create or replace function meta.search_config_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.seq := coalesce(new.seq, 10);
  new.source_type := coalesce(new.source_type, 'table');
  new.searchable_columns := coalesce(new.searchable_columns, '{}');
  new.max_results := coalesce(new.max_results, 10);
  new.search_type := coalesce(new.search_type, 'standard');
  new.did_you_mean := coalesce(new.did_you_mean, false);
  return new;
end $$;
