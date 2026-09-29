-- =====================================================================
-- HR sample, part 4: globalization and e-mail (see docs/guide/14-globalization-and-email.md)
--
--   * Dutch (nl) as a translated language; the language follows the browser
--     or the user's choice (My account, ?lang=nl, the picker on the login page)
--   * translations of the app's texts, and text messages for texts that
--     come from SQL (the dashboard's key figures use meta.message())
--   * e-mail: addresses for the demo accounts, a template, and a trigger that
--     mails the employee when leave is decided; "forgot password" is enabled
-- =====================================================================

update meta.app set languages = '{nl}', language_from = 'user', password_reset = true where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('HR Demo', 'HR Demo'),
  ('Only administrators can access this page.', 'Alleen beheerders hebben toegang tot deze pagina.'),
  ('Only managers can access this page.', 'Alleen managers hebben toegang tot deze pagina.'),
  ('Administration', 'Beheer'),
  ('Audit trail', 'Wijzigingslog'),
  ('Calendar', 'Kalender'),
  ('Dashboard', 'Dashboard'),
  ('Department grid', 'Afdelingenraster'),
  ('Departments', 'Afdelingen'),
  ('Directory', 'Personeelsgids'),
  ('Employee list', 'Medewerkerslijst'),
  ('Employees', 'Medewerkers'),
  ('Leave requests', 'Verlofaanvragen'),
  ('Org chart', 'Organogram'),
  ('Requests', 'Aanvragen'),
  ('Location', 'Locatie'),
  ('Name', 'Naam'),
  ('No.', 'Nr.'),
  ('Department', 'Afdeling'),
  ('Job', 'Functie'),
  ('Status', 'Status'),
  ('Filter', 'Filter'),
  ('Employee directory', 'Personeelsgids'),
  ('Leave calendar', 'Verlofkalender'),
  ('Leave (as far as you may see it)', 'Verlof (voor zover je het mag zien)'),
  ('Mark all read', 'Alles gelezen'),
  ('Notifications marked as read.', 'Meldingen gemarkeerd als gelezen.'),
  ('Headcount by department', 'Medewerkers per afdeling'),
  ('Hires per year', 'Nieuwe medewerkers per jaar'),
  ('Key figures', 'Kerncijfers'),
  ('Most recent hires', 'Nieuwste medewerkers'),
  ('My notifications', 'Mijn meldingen'),
  ('No notifications.', 'Geen meldingen.'),
  ('Salary and commission by department', 'Salaris en commissie per afdeling'),
  ('Salary budget by job', 'Salarisbudget per functie'),
  ('Who''s out this week', 'Wie is er deze week afwezig'),
  ('<p class="lead">Welcome back, <b>&AI_ENAME.</b>. Everything on this page is a row in the <code>meta</code> schema; the numbers respect row level security.</p>', '<p class="lead">Welkom terug, <b>&AI_ENAME.</b>. Alles op deze pagina is een rij in het <code>meta</code>-schema; de cijfers houden rekening met row level security.</p>'),
  ('Create', 'Aanmaken'),
  ('Salary', 'Salaris'),
  ('- All departments -', '- Alle afdelingen -'),
  ('Employees Form', 'Medewerker'),
  ('Apply Changes', 'Wijzigingen opslaan'),
  ('Cancel', 'Annuleren'),
  ('Delete', 'Verwijderen'),
  ('Give 10% raise', '10% opslag geven'),
  ('Delete this record?', 'Dit record verwijderen?'),
  ('Choosing a job suggests a salary (dynamic action calling hr.suggest_salary).', 'Bij het kiezen van een functie wordt een salaris voorgesteld (dynamische actie die hr.suggest_salary aanroept).'),
  ('Filtered by department (cascading list of values).', 'Gefilterd op afdeling (trapsgewijze waardenlijst).'),
  ('A database trigger keeps salaries below the president''s.', 'Een databasetrigger houdt salarissen onder dat van de president.'),
  ('Links an application user to this employee.', 'Koppelt een gebruiker aan deze medewerker.'),
  ('Active', 'Actief'),
  ('Commission', 'Commissie'),
  ('Empno', 'Personeelsnr.'),
  ('Hire date', 'In dienst sinds'),
  ('Manager', 'Manager'),
  ('App username', 'Gebruikersnaam'),
  ('Salary raised by 10%.', 'Salaris met 10% verhoogd.'),
  ('Only salesmen can earn commission.', 'Alleen verkopers kunnen commissie verdienen.'),
  ('Departments Form', 'Afdeling'),
  ('Deptno', 'Afdelingsnr.'),
  ('Dname', 'Afdelingsnaam'),
  ('Loc', 'Locatie'),
  ('Request leave', 'Verlof aanvragen'),
  ('- Any status -', '- Elke status -'),
  ('Approved', 'Goedgekeurd'),
  ('Pending', 'In behandeling'),
  ('Rejected', 'Afgewezen'),
  ('Withdrawn', 'Ingetrokken'),
  ('No leave requests visible to you.', 'Er zijn geen verlofaanvragen die jij mag zien.'),
  ('Requests you can see', 'Aanvragen die je mag zien'),
  ('Leave request', 'Verlofaanvraag'),
  ('Approve', 'Goedkeuren'),
  ('Close', 'Sluiten'),
  ('Reject', 'Afwijzen'),
  ('Submit request', 'Aanvraag indienen'),
  ('Withdraw', 'Intrekken'),
  ('Withdraw this request?', 'Deze aanvraag intrekken?'),
  ('Calculated by hr.business_days() as you pick dates.', 'Berekend door hr.business_days() terwijl je datums kiest.'),
  ('Working days', 'Werkdagen'),
  ('Decided by', 'Besloten door'),
  ('Decision note', 'Toelichting'),
  ('Employee', 'Medewerker'),
  ('Until', 'Tot en met'),
  ('Reason', 'Reden'),
  ('From', 'Vanaf'),
  ('Leave approved.', 'Verlof goedgekeurd.'),
  ('Leave rejected.', 'Verlof afgewezen.'),
  ('Leave request submitted; your manager has been notified.', 'Verlofaanvraag ingediend; je manager is op de hoogte gebracht.'),
  ('Request withdrawn.', 'Aanvraag ingetrokken.'),
  ('Reporting lines', 'Rapportagelijnen'),
  ('Organization chart', 'Organogram'),
  ('Changes recorded by the hr.audit() trigger', 'Wijzigingen vastgelegd door de trigger hr.audit()'),
  ('Ename', 'Naam'),
  ('Hiredate', 'In dienst sinds'),
  ('Sal', 'Salaris'),
  ('Comm', 'Commissie'),
  ('Mgr', 'Manager'),
  ('Message', 'Bericht'),
  ('Received', 'Ontvangen'),
  ('Days', 'Dagen'),
  ('Start Date', 'Begindatum'),
  ('End Date', 'Einddatum'),
  ('Direct Reports', 'Directe medewerkers'),
  ('Headcount', 'Aantal'),
  ('Count', 'Aantal'),
  ('Sum', 'Totaal'),
  ('Hires', 'Nieuwe medewerkers'),
  ('Created At', 'Aangemaakt'),
  ('Decided At', 'Besloten op')
) as t(source, target)
 where a.alias = 'hr';

-- Texts computed in SQL: text messages in both languages.
insert into meta.text_message (app_id, name, language, text)
select a.id, m.name, m.language, m.text
  from meta.app a, (values
  ('KPI_EMPLOYEES', 'en', 'Employees'), ('KPI_EMPLOYEES', 'nl', 'Medewerkers'),
  ('KPI_PAYROLL', 'en', 'Monthly payroll'), ('KPI_PAYROLL', 'nl', 'Salarissen per maand'),
  ('KPI_DEPARTMENTS', 'en', 'Departments'), ('KPI_DEPARTMENTS', 'nl', 'Afdelingen'),
  ('KPI_PENDING', 'en', 'Pending leave (visible to you)'), ('KPI_PENDING', 'nl', 'Openstaand verlof (dat je mag zien)')
) as m(name, language, text)
 where a.alias = 'hr';

update meta.region r
   set source = E'select meta.message(''KPI_EMPLOYEES'') as title, count(*)::text as badge, ''users'' as icon from hr.emp where active\nunion all\nselect meta.message(''KPI_PAYROLL''), to_char(sum(sal), ''FM999G999''), ''chart'' from hr.emp where active\nunion all\nselect meta.message(''KPI_DEPARTMENTS''), count(*)::text, ''building'' from hr.dept\nunion all\nselect meta.message(''KPI_PENDING''), count(*)::text, ''calendar'' from hr.leave_request where status = ''PENDING'''
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 1 and r.title = 'Key figures';

-- E-mail addresses for the demo accounts (example.com never delivers anywhere).
update meta.account set email = lower(username) || '@example.com' where email is null
   and lower(username) in ('king', 'blake', 'jones', 'allen', 'scott', 'demo');

insert into meta.email_template (app_id, static_id, name, subject, body_html, body_text)
select a.id, 'LEAVE_DECIDED', 'Leave decided',
       'Your leave from #START# to #END# was #DECISION#',
       '<p>Hello #NAME#,</p><p>Your leave request from <b>#START#</b> to <b>#END#</b> was <b>#DECISION#</b> by #DECIDED_BY#.</p><p>#NOTE#</p><p><a href="#LINK#">Open your leave requests</a></p>',
       E'Hello #NAME#,\n\nYour leave request from #START# to #END# was #DECISION# by #DECIDED_BY#.\n#NOTE#\n\n#LINK#'
  from meta.app a where a.alias = 'hr';

-- Mail the employee when a manager decides. The mail is queued in the same
-- transaction, so it's only sent when the decision is committed.
create function hr.mail_leave_decided() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
declare
  v_email text;
  v_name  text;
begin
  if new.status not in ('APPROVED', 'REJECTED') then
    return new;
  end if;
  select a.email, coalesce(a.display_name, initcap(e.ename)) into v_email, v_name
    from hr.emp e join meta.account a on lower(a.username) = lower(e.username)
   where e.empno = new.empno;
  if v_email is not null and meta.app_id() is not null then
    perform meta.send_mail_template('LEAVE_DECIDED', jsonb_build_object(
      'NAME', v_name, 'START', to_char(new.start_date, 'DD Mon YYYY'), 'END', to_char(new.end_date, 'DD Mon YYYY'),
      'DECISION', lower(new.status), 'DECIDED_BY', new.decided_by, 'NOTE', coalesce(new.decision_note, ''),
      'LINK', coalesce(nullif(current_setting('pgapex.public_url', true), ''), 'http://127.0.0.1:3100') || '/a/hr/6'), v_email);
  end if;
  return new;
end
$$;

create trigger leave_decided_mail after update of status on hr.leave_request
  for each row when (old.status is distinct from new.status)
  execute function hr.mail_leave_decided();
