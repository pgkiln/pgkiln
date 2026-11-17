-- =====================================================================
-- HR example, part 92: an inline drawer's footer (sprint 219; APEX 26.1
-- Inline Drawer footer; docs/guide/04-pages-and-regions.md "Region
-- templates")
--
-- Page 44 (Region templates) has a Help drawer. A sub region of it with
-- position footer, "Still stuck?", shows in the drawer's footer: it
-- stays at the bottom while the help text scrolls.
-- =====================================================================
insert into meta.region (page_id, seq, title, type, template, source, config, parent_id, position)
select r.page_id, 10, 'Still stuck?', 'static', 'plain',
       '<p class="u-m0">Ask HR on extension 4242.</p>',
       '{}', r.id, 'footer'
  from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 44 and r.title = 'Help' and r.template = 'inline_drawer'
   and not exists (select 1 from meta.region x where x.parent_id = r.id and x.title = 'Still stuck?');
