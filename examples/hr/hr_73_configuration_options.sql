-- =====================================================================
-- HR example, part 73: a configurable build option (sprint 137, AP-3;
-- migration 137; docs/guide/06-processing.md "Build options",
-- 03-builder.md "Add feature")
--
-- LEAVE_FORECAST (part 22: the Forecast region of page 22, excluded) is
-- marked configurable. In the builder, Create page → Feature →
-- Configuration options then adds page 9020 "Configuration" where HR's
-- administrators (king, demo) switch the forecast on and off while the
-- application runs, without a developer. Nothing else changes until that
-- feature is added.
-- =====================================================================

update meta.build_option o set configurable = true,
       description = coalesce(o.description, 'The leave forecast on the leave planner (page 22)')
  from meta.app a
 where a.id = o.app_id and a.alias = 'hr' and o.name = 'LEAVE_FORECAST';
