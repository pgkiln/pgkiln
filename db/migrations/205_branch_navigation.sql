-- Sprint 249 (MG-22, MG-23): branches whose target comes from an item, and branches from a modal dialog page that
-- send the page below to their target.
--
--   meta.branch.target_type 'item'   the target page is the value of an item (a page item, an application item or the
--                                    built-in APP_PREVIOUS_PAGE): a page number or page alias of this application. The
--                                    runtime checks it is a page of the application the user may open; anything else
--                                    goes to the page itself (src/runtime/logic.ts itemTarget). target_items are signed
--                                    for that page, as for a page target.
--   meta.branch.target_item          the item's name
--   meta.branch.in_page_below        on a modal dialog page: the dialog closes and the page below goes to the target
--                                    (with its items and checksum), instead of refreshing. Not with stay_in_dialog.
--
-- Both columns are nullable, so an export made before 205 imports unchanged (meta.import_app's jsonb_populate_record
-- leaves a missing key null); meta.export_app exports them as it exports every column of meta.branch.

alter table meta.branch drop constraint branch_target_type_check;
alter table meta.branch add constraint branch_target_type_check check (target_type in ('page', 'url', 'function', 'app', 'item'));

alter table meta.branch
  add column target_item   text check (target_item ~ '^[A-Za-z][A-Za-z0-9_]{0,127}$'),
  add column in_page_below boolean,
  add constraint branch_item_check check (target_type <> 'item' or target_item is not null),
  add constraint branch_below_check check (not (coalesce(in_page_below, false) and coalesce(stay_in_dialog, false)));

comment on column meta.branch.target_item is 'item: the item holding the target page (a page number or alias of this application; sprint 249)';
comment on column meta.branch.in_page_below is 'In a modal dialog page, the dialog closes and the page below goes to the target (sprint 249)';
