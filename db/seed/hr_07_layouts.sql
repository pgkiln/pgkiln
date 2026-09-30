-- =====================================================================
-- HR sample, part 7: report layouts (see docs/guide/16-files.md)
--
-- The Directory (page 11) prints with the layout HR_DIRECTORY: A4
-- portrait, a larger font, a header and footer text, no stripes, the
-- table as wide as the page, and only the name, job, department and
-- manager columns.
-- =====================================================================
insert into meta.report_layout (app_id, name, paper, orientation, font_size, margin_mm, title, header, footer,
                                show_filters, full_width, heading_color, stripe_color, text_color)
select id, 'HR_DIRECTORY', 'A4', 'portrait', 10, 18, 'Staff directory',
       E'Human Resources · internal use only\nPrinted by &APP_USER. on &DATE.',
       '&APP_NAME. · staff directory', true, true, '#dbe7f5', null, '#1a1a1a'
  from meta.app where alias = 'hr';

update meta.region r
   set config = r.config || '{"pdf": {"layout": "HR_DIRECTORY", "columns": ["name", "job", "department", "manager"], "widths": {"name": 50}}}'
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 11 and r.type = 'report';
