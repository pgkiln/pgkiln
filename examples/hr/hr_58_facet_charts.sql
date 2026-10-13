-- =====================================================================
-- HR example, part 58: facet charts
-- (docs/guide/04-pages-and-regions.md, faceted search)
--
-- The faceted search on page 21 shows a bar chart of the jobs and a pie
-- chart of the salary ranges under their facets; a bar or a slice filters
-- the report on its value.
-- =====================================================================

update meta.region r
   set config = jsonb_set(r.config, '{facets}', (
         select jsonb_agg(case f->>'column' when 'job' then f || '{"chart": "bar"}'
                                            when 'salary' then f || '{"chart": "pie"}'
                                            else f end order by n)
           from jsonb_array_elements(r.config->'facets') with ordinality x(f, n)))
  from meta.page p join meta.app a on a.id = p.app_id
 where p.id = r.page_id and a.alias = 'hr' and p.page_no = 21 and r.type = 'facets';
