-- =====================================================================
-- HR example, part 84: a header parameter in the REST module "hr"
-- (sprint 175; docs/guide/13-rest-api.md → Modules, templates and
-- handlers). GET /a/hr/rest/hr/whoami answers who the token belongs to
-- and echoes the caller's X-Request-Id header, so a client can match
-- the answer to its own log line:
--
--   curl http://127.0.0.1:3100/a/hr/rest/hr/whoami \
--        -H "Authorization: Bearer $TOKEN" -H "X-Request-Id: abc-123"
--   {"username": "king", "request_id": "abc-123"}
--
-- The answer carries an ETag, like every single-row GET of a module.
-- =====================================================================
update meta.rest_module m
   set templates = m.templates || $t$[{"uri": "whoami", "description": "The caller"}]$t$::jsonb,
       handlers = m.handlers || $h$[
  {"method": "GET", "path": "whoami", "type": "item", "description": "The caller, with the request's X-Request-Id",
   "params": [{"name": "x_request_id", "in": "header", "type": "string", "description": "Echoed back as request_id, for tracing"}],
   "source": "select :APP_USER as username, :X_REQUEST_ID as request_id"}
]$h$::jsonb
  from meta.app a
 where a.id = m.app_id and a.alias = 'hr' and m.name = 'hr'
   and not exists (select 1 from jsonb_array_elements(m.handlers) h where h->>'path' = 'whoami');
