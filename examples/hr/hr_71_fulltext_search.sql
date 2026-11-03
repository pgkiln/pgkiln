-- =====================================================================
-- HR example, part 71: a full-text search configuration (sprint 135, AP-2;
-- migration 135; docs/guide/04-pages-and-regions.md, search region)
--
-- hr.policy (part 42) gets what SQL Workshop › Table Properties › Add
-- full-text search writes: a stored generated tsvector column over the
-- title (weight A) and the body (weight B) in the english text search
-- configuration, and a GIN index on it.
--
-- The search configuration POLICIES searches it with search type fulltext:
-- page 42 "Search" then finds "Requesting leave" for "request" and
-- "Working from home" for "works home", the best match first and the
-- matched words highlighted. "Did you mean" suggests the closest words when
-- nothing is found, once the pg_trgm extension is installed (without it,
-- nothing is suggested).
-- =====================================================================

alter table hr.policy
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'B')) stored;
create index policy_search_vector_idx on hr.policy using gin (search_vector);

insert into meta.search_config (app_id, name, label, seq, source_type, source, search_type, fts_vector, fts_config, did_you_mean,
                                title_column, description_column, icon, max_results)
select id, 'POLICIES', 'HR policies', 25, 'table', 'hr.policy', 'fulltext', 'search_vector', 'english', true,
       'title', 'body', 'book', 5
  from meta.app where alias = 'hr';

update meta.region r
   set config = jsonb_set(r.config, '{configs}', (r.config->'configs') || '["POLICIES"]'::jsonb)
         || '{"placeholder": "Search employees, departments, policies and shortcuts…"}'::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 42 and r.type = 'search';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('HR policies', 'HR-regelingen'),
  ('Search employees, departments, policies and shortcuts…', 'Zoek medewerkers, afdelingen, regelingen en snelkoppelingen…')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
