-- =====================================================================
-- HR example, part 46: static application files and a JavaScript action
-- (docs/guide/09-dynamic-actions.md, "Execute JavaScript", and
--  docs/guide/04-shared-components.md, "Static application files")
--
-- hr.js and hr.css are files of the application, loaded by every page.
-- hr.js registers hr.annualSalary; on the employee form (page 3) two
-- dynamic actions call it, when the form opens and when the salary
-- changes, to show the salary per year under the field. No inline code:
-- the page loads /a/hr/static/hr.js with <script src>.
-- =====================================================================

insert into meta.static_file (app_id, name, mime, content)
select a.id, 'hr.js', 'text/javascript', convert_to($js$// HR example: functions for "Execute JavaScript" dynamic actions.
pgapex.actions.register('hr.annualSalary', (da) => {
  const monthly = Number(String(pgapex.getValue('P3_SAL') || '').replace(/[^0-9.-]/g, ''));
  for (const field of da.elements) {
    let out = field.querySelector('.hr-annual');
    if (!out) {
      out = document.createElement('small');
      out.className = 'help hr-annual';
      out.setAttribute('aria-live', 'polite');
      field.append(out);
    }
    out.textContent = monthly > 0 ? `Per year: ${(monthly * 12).toLocaleString(document.documentElement.lang)}` : '';
  }
});
$js$, 'utf8')
  from meta.app a where a.alias = 'hr';

insert into meta.static_file (app_id, name, mime, content)
select a.id, 'hr.css', 'text/css', convert_to($css$/* HR example: styles of hr.js's output */
.hr-annual { font-variant-numeric: tabular-nums; }
$css$, 'utf8')
  from meta.app a where a.alias = 'hr';

update meta.app set static_includes = '{hr.js,hr.css}' where alias = 'hr';

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, code)
select p.id, x.seq, x.name, x.event, x.trig, 'execute_javascript', 'P3_SAL', 'hr.annualSalary'
  from meta.page p join meta.app a on a.id = p.app_id,
       (values (60, 'Salary per year (on open)', 'load', null), (61, 'Salary per year', 'change', 'P3_SAL')) x(seq, name, event, trig)
 where a.alias = 'hr' and p.page_no = 3;
