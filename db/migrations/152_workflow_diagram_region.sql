-- Sprint 160 (CD-7; APEX: Workflow Diagram region, 24.2+): a region that draws one workflow instance in a running
-- application: its steps, the ones it went through, where it is now, and a failed step in red, with who and when in
-- each step's tooltip. config {"instance_item": "P9_WORKFLOW_ID"}: the item that holds the instance id. The instance
-- is read through meta.workflows, so a user sees only workflows they started or administer.

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check check (type in (
  'report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter', 'ai_assistant', 'plugin', 'url', 'search', 'login',
  'form_designer', 'classic_report', 'breadcrumb', 'help_text', 'workflow_diagram'));
