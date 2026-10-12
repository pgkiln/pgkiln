-- =====================================================================
-- HR example, part 52: feedback (migration 084; docs/guide/03-builder.md,
-- "Feedback")
--
-- Users send feedback about a page from the navigation bar's Feedback link;
-- developers answer under Application → Activity → Feedback. One answered
-- example from the user king.
-- =====================================================================

update meta.app set feedback = true where alias = 'hr';

insert into meta.feedback (app_id, page_no, username, kind, rating, body, status, response, responded_by, responded_at)
select id, 2, 'king', 'idea', 4, 'Could the employee list show the hire date as well?', 'done',
       'Added in the column list: open Actions → Columns and show "Hiredate".', 'admin', now()
  from meta.app where alias = 'hr';
