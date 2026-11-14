-- =====================================================================
-- HR example, part 88: browser security (docs/guide/08-security.md,
-- sprint 188)
--
-- HR may be shown in a frame by pages of this server only (the default),
-- tells other sites only its origin when a link leads there, is never
-- indexed by search engines, and names its owner in a response header.
-- Settings → Security → Browser security shows the same values.
-- =====================================================================
update meta.app set browser_security = '{
  "embed": "same_origin",
  "embed_origins": [],
  "referrer": "strict-origin-when-cross-origin",
  "robots": "noindex",
  "headers": [{"name": "X-Content-Owner", "value": "HR department"}]
}'::jsonb where alias = 'hr';
