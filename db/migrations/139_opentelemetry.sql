-- =====================================================================
-- 139: OpenTelemetry (sprint 139, AP-6; APEX: Workspace Utilities →
--      OpenTelemetry)
--
-- The instance's collector and its choices are instance settings in
-- meta.setting (otel_*: enabled, endpoint, service name, sample ratio,
-- user attribute, values, signals, builder requests, browser spans;
-- metrics_endpoint for GET /metrics) and, as only the owner reads it,
-- meta.instance_setting (otel_headers_enc: headers encrypted with the
-- instance key; metrics_token_hash), else the standard OTEL_*
-- environment variables (src/telemetry/config.ts). No table needed.
--
-- meta.workspace.telemetry: what the workspace's applications send:
--   'instance' (the default: the instance's collector, when there is one),
--   'off' (nothing, not even to the instance's), 'own' (also to the
--   workspace's own collector, telemetry_endpoint, an OTLP/HTTP base URL
--   reached through the workspace's network access list and the
--   installation's allow-list). telemetry_headers_enc: headers for it
--   (an API key), encrypted like a web credential's secret, write-only.
--   telemetry_values: send SQL statements with their literals, bind
--   values, query strings and tool arguments to the own collector.
--   Installation data: not in the workspace export.
-- =====================================================================

alter table meta.workspace
  add column telemetry text not null default 'instance' constraint workspace_telemetry_ok check (telemetry in ('instance', 'off', 'own')),
  add column telemetry_endpoint text constraint workspace_telemetry_endpoint_ok
    check (telemetry_endpoint is null or (telemetry_endpoint ~ '^https?://[^\s#@]+$' and length(telemetry_endpoint) <= 500)),
  add column telemetry_headers_enc text,
  add column telemetry_values boolean not null default false,
  add constraint workspace_telemetry_own check (telemetry <> 'own' or telemetry_endpoint is not null);

comment on column meta.workspace.telemetry is 'OpenTelemetry of the workspace''s applications: instance (the instance''s collector), off, own (also its own collector) (139)';
comment on column meta.workspace.telemetry_endpoint is 'The workspace''s own OTLP/HTTP collector (base URL; /v1/traces and /v1/logs are appended) (139)';
comment on column meta.workspace.telemetry_headers_enc is 'Headers for the own collector, encrypted with PGKILN_SECRET_KEY (139)';
comment on column meta.workspace.telemetry_values is 'The own collector also receives values: SQL literals, bind values, query strings (139)';
