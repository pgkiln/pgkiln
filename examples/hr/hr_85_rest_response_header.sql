-- =====================================================================
-- HR example, part 85: a response header from a PL/pgSQL REST handler
-- (sprint 176; docs/guide/13-rest-api.md → PL/pgSQL handlers).
-- POST /a/hr/rest/hr/leave answers 201 with a Location header that names
-- the new request, and GET /a/hr/rest/hr/leave/:id reads it back (row
-- level security decides whose requests the caller sees):
--
--   curl -i -X POST http://127.0.0.1:3100/a/hr/rest/hr/leave \
--        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
--        -d '{"start_date": "2027-03-01", "end_date": "2027-03-02"}'
--   HTTP/1.1 201 Created
--   location: /a/hr/rest/hr/leave/12
-- =====================================================================
update meta.rest_module m
   set templates = m.templates || $t$[{"uri": "leave/:id", "description": "One leave request"}]$t$::jsonb,
       handlers = (
         select jsonb_agg(case when h->>'path' = 'leave' and h->>'method' = 'POST'
                  then jsonb_set(h, '{source}', to_jsonb($s$declare
  v_id int;
begin
  v_id := hr.request_leave(:START_DATE::date, :END_DATE::date, :REASON);
  perform meta.rest_header('Location', '/a/hr/rest/hr/leave/' || v_id);
  perform meta.rest_reply(jsonb_build_object('id', v_id, 'status', 'requested'), 201);
end$s$::text))
                  else h end order by ord)
           from jsonb_array_elements(m.handlers) with ordinality as x(h, ord)
       ) || $h$[
  {"method": "GET", "path": "leave/:id", "type": "item", "description": "One leave request (the caller's own, or one of their staff)",
   "source": "select id, empno, start_date, end_date, days, status from hr.leave_request where id = :ID::int"}
]$h$::jsonb
  from meta.app a
 where a.id = m.app_id and a.alias = 'hr' and m.name = 'hr'
   and not exists (select 1 from jsonb_array_elements(m.handlers) h where h->>'path' = 'leave/:id');
