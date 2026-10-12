-- =====================================================================
-- 078: the URL region (APEX: URL region): another site's page in the
-- region, in a sandboxed iframe. The source is the URL; its origin is
-- literal (an item can't choose the host), and the page's
-- Content-Security-Policy frames exactly the origins of its URL regions
-- (src/runtime/url-region.ts).
-- =====================================================================

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check check (type in (
  'report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter', 'ai_assistant', 'plugin', 'url'));
