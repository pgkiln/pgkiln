-- =====================================================================
-- 084: feedback (APEX: Feedback, Team Development → Feedback)
--
-- With meta.app.feedback on, the application's navigation bar has a
-- "Feedback" link: users send a comment, an idea or a problem (with an
-- optional rating) about the page they came from, and see their earlier
-- feedback with the developers' answers. Developers read, answer and
-- close it in the builder (Application → Feedback). The setting travels
-- with the export; the feedback itself is installation data.
-- =====================================================================

alter table meta.app add column feedback boolean not null default false;

-- an export made before 084 has no feedback setting: NULL becomes false
create function meta.app_feedback_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.feedback := coalesce(new.feedback, false);
  return new;
end $$;
create trigger app_feedback before insert or update on meta.app
  for each row execute function meta.app_feedback_default();

create table meta.feedback (
  id           bigint generated always as identity primary key,
  app_id       int not null references meta.app on delete cascade,
  page_no      int,
  username     text not null,
  session_id   uuid,
  kind         text not null check (kind in ('comment', 'idea', 'problem')),
  rating       smallint check (rating between 1 and 5),
  body         text not null check (length(body) between 1 and 4000),
  user_agent   text check (length(user_agent) <= 300),
  status       text not null default 'open' check (status in ('open', 'in_progress', 'done', 'declined')),
  response     text check (length(response) <= 4000),
  responded_by text,
  responded_at timestamptz,
  created_at   timestamptz not null default now()
);
create index feedback_app on meta.feedback (app_id, created_at desc);
revoke all on meta.feedback from public;
-- the runtime records feedback and shows users their own (src/runtime/feedback.ts); developers answer
grant select, insert on meta.feedback to pgkiln_runtime;

comment on table meta.feedback is 'Feedback of application users and the developers'' answers (084); not exported';
comment on column meta.app.feedback is 'Users can send feedback from the navigation bar (084)';
