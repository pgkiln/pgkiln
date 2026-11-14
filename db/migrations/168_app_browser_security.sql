-- =====================================================================
-- 168: browser security per application (sprint 188, NX-S4)
--
-- APEX: Security Attributes → Browser Security (Embed in Frames, Referrer
-- Policy, Allow Bot Access, HTTP Response Headers). pgkiln set the same
-- headers for every application; now each application can choose:
--
--   embed          'same_origin' (default: frame-ancestors 'self',
--                  X-Frame-Options SAMEORIGIN), 'deny' (frame-ancestors
--                  'none', X-Frame-Options DENY) or 'origins' (the https
--                  origins of embed_origins, e.g. an intranet portal)
--   embed_origins  ["https://portal.example.com", …] (at most 10)
--   referrer       'same-origin' (default), 'strict-origin-when-cross-origin',
--                  'strict-origin' or 'no-referrer'
--   robots         'auto' (default: noindex, nofollow when the application
--                  needs a sign-in), 'index' or 'noindex'
--   headers        [{"name": "X-Team", "value": "sales"}, …]: extra response
--                  headers (at most 20); never one pgkiln sets for security
--                  (Content-Security-Policy, X-Content-Type-Options,
--                  X-Frame-Options, Referrer-Policy, Permissions-Policy,
--                  Strict-Transport-Security, Cache-Control, Set-Cookie …)
--
-- Pages keep Cache-Control: no-store (they carry the session's CSRF token).
-- An empty object is today's behaviour. Exported with the application
-- like its other columns; src/security.ts checks the values again.
-- =====================================================================

alter table meta.app add column browser_security jsonb not null default '{}'::jsonb
  check (jsonb_typeof(browser_security) = 'object' and length(browser_security::text) <= 20000);
comment on column meta.app.browser_security is
  'Browser security per application (168): embed, embed_origins, referrer, robots, headers; {} = the defaults';
