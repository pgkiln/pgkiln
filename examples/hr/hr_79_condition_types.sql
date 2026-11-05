-- =====================================================================
-- HR example, part 79: declarative server-side conditions (sprint 154, CD-2)
--
-- The Employee page's buttons showed with SQL conditions such as
-- ":P3_EMPNO is not null". The same tests as condition types: no query,
-- and the Page Designer's tree says "When P3_EMPNO is not empty".
-- Department (page 5) gets the same; the leave request's Approve and
-- Reject (page 7) stay SQL: they call hr.current_empno().
-- =====================================================================

update meta.button b
   set condition_type = case when b.condition ~* ' is not null$' then 'item_not_null' else 'item_null' end,
       condition = substring(b.condition from '^:([A-Z][A-Z0-9_]*) ')
  from meta.page p join meta.app a on a.id = p.app_id
 where b.page_id = p.id and a.alias = 'hr' and p.page_no in (3, 5)
   and b.condition_type is null
   and b.condition ~ '^:P[35]_(EMPNO|DEPTNO) is (not )?null$';
