-- (sprint 238, MG-14) Inline dialog regions opened by their static id.
--
--   meta.button.target_region   a redirect button opens the inline dialog (or drawer) region with this static id:
--                               on this page (href="#R<id>", without JavaScript the CSS :target shows it), or on its
--                               target page (the page's link with #<static id>)
--   meta.process.open_region    after a submit in which this process ran, the page that comes back opens the inline
--                               dialog region with this static id ("add another")
--   meta.branch.open_region     the page this branch goes to opens the inline dialog region with this static id
--
-- The values have the format of meta.region.static_id. Every column may be null, so an export made before 194 imports
-- unchanged (meta.import_app's jsonb_populate_record leaves a missing key null); meta.export_app exports them as it
-- exports every column of these tables.

alter table meta.button  add column target_region text check (target_region ~ '^[a-z][a-z0-9_-]{0,49}$');
alter table meta.process add column open_region   text check (open_region ~ '^[a-z][a-z0-9_-]{0,49}$');
alter table meta.branch  add column open_region   text check (open_region ~ '^[a-z][a-z0-9_-]{0,49}$');

comment on column meta.button.target_region is 'redirect: the static id of an inline dialog or drawer region it opens (on its target page, else this page)';
comment on column meta.process.open_region is 'the static id of an inline dialog or drawer region the page that comes back opens after this process ran';
comment on column meta.branch.open_region is 'the static id of an inline dialog or drawer region the target page opens';
