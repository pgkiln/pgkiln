-- =====================================================================
-- HR example, part 89: session management (docs/guide/08-security.md,
-- sprint 189)
--
-- HR keeps a session for at most 8 hours (never longer than the
-- instance's limit), and a user who comes back after the session has
-- ended sees page 52, "Session ended", a page without sign-in, instead of
-- the sign-in form. Deep linking stays on: after signing in the user goes
-- to the page the link asked for. Settings → Errors and Sessions shows
-- the same values, and Expire bookmarks there.
-- =====================================================================
insert into meta.page (app_id, page_no, name, title, requires_auth)
select id, 52, 'Session ended', 'Session ended', false from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source)
select p.id, 10, 'Session ended', 'static', 12, 'standard',
       '<p>Your session has ended, so you were signed out. Nothing you saved is lost.</p>'
       || '<p><a class="btn btn-hot" href="/a/hr/login">Sign in again</a></p>'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 52;

update meta.app set session_max_hours = 8, session_timeout_page = 52 where alias = 'hr';
