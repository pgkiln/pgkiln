-- =====================================================================
-- 088: more region templates (APEX: Hero, Title Bar, Buttons Container,
-- Inline Dialog, Inline Drawer, Wizard Container)
--
-- hero              a large banner: title, text, an icon, buttons
-- title_bar         the title and buttons on one line, without a card
-- buttons_container the buttons only (and any text), without a header
-- inline_dialog     hidden until opened (dynamic action "Open region", or
--                   a link to #R<id>); a dialog over the page
-- inline_drawer     the same, sliding in from the side
-- wizard            a narrow card for one step of a wizard (with the list
--                   template "wizard_progress" above it)
-- The carousel is a style of the display selector region ({"style":
-- "carousel"}); it needs no column.
-- =====================================================================
alter table meta.region drop constraint region_template_check;
alter table meta.region add constraint region_template_check
  check (template in ('standard', 'plain', 'collapsible', 'hero', 'title_bar', 'buttons_container', 'inline_dialog', 'inline_drawer', 'wizard'));
