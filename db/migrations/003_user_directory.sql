-- =====================================================================
-- 003: workspace user directory (like APEX accounts + Application Access
-- Control). One account per person; applications assign roles to
-- accounts. Replaces the per-application meta.app_user table (kept as a
-- compatible, writable view).
-- =====================================================================

create table meta.account (
  id            serial primary key,
  username      text not null check (username ~ '^[^\s:]{1,100}$'),
  display_name  text,
  email         text,
  -- null = no local password (for example an account that signs in via SSO)
  password_hash text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index account_username_key on meta.account (lower(username));

-- Which accounts may use which application, with which roles.
create table meta.app_access (
  app_id     int  not null references meta.app on delete cascade,
  account_id int  not null references meta.account on delete cascade,
  roles      text[] not null default '{}',
  primary key (app_id, account_id)
);
create index on meta.app_access (account_id);

-- 'assigned' : only accounts with an app_access row may sign in (default)
-- 'any_user' : every active account may sign in (roles from app_access if any)
alter table meta.app add column access_control text not null default 'assigned'
  check (access_control in ('assigned', 'any_user'));

-- Roles are resolved at sign-in and kept with the session.
alter table meta.session add column roles text[] not null default '{}';

-- ---------------------------------------------------------------------
-- Move existing per-application users into the directory. A username that
-- exists in several applications cannot be assumed to be the same person
-- (bcrypt hashes of the same password differ), so the first application's
-- user keeps the name and the others become '<username>@<alias>'.
-- Administrators can merge them afterwards by granting the first account
-- access and deleting the renamed one.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_id int;
begin
  for r in
    select u.*, a.alias,
           row_number() over (partition by lower(u.username) order by u.app_id, u.id) as rn
      from meta.app_user u join meta.app a on a.id = u.app_id
     order by u.app_id, u.id
  loop
    insert into meta.account (username, password_hash, active, last_login_at)
    values (case when r.rn = 1 then r.username else r.username || '@' || r.alias end,
            r.password_hash, r.active, r.last_login_at)
    returning id into v_id;
    insert into meta.app_access (app_id, account_id, roles) values (r.app_id, v_id, r.roles);
  end loop;
end
$$;

-- Sessions of the old model carry no roles: end them.
delete from meta.session where app_id is not null;

drop table meta.app_user;

-- ---------------------------------------------------------------------
-- Compatibility: meta.app_user as a writable view, so scripts written for
-- 0.2/0.3 keep working:
--   insert into meta.app_user (app_id, username, password_hash, roles) ...
-- creates the account if needed and grants it access with those roles.
-- ---------------------------------------------------------------------
create view meta.app_user as
  select ac.id, aa.app_id, ac.username, ac.password_hash, aa.roles, ac.active, ac.last_login_at
    from meta.app_access aa
    join meta.account ac on ac.id = aa.account_id;

create function meta.app_user_write() returns trigger
language plpgsql as $$
declare
  v_id int;
begin
  if tg_op = 'DELETE' then
    delete from meta.app_access where app_id = old.app_id and account_id = old.id;
    return old;
  end if;
  if tg_op = 'INSERT' then
    insert into meta.account (username, password_hash, active)
    values (new.username, new.password_hash, coalesce(new.active, true))
    on conflict (lower(username)) do nothing;
    select id into v_id from meta.account where lower(username) = lower(new.username);
    -- an existing account keeps its password unless it had none
    update meta.account set password_hash = new.password_hash where id = v_id and password_hash is null;
    insert into meta.app_access (app_id, account_id, roles)
    values (new.app_id, v_id, coalesce(new.roles, '{}'))
    on conflict (app_id, account_id) do update set roles = excluded.roles;
    return new;
  end if;
  -- UPDATE
  update meta.account set password_hash = new.password_hash, active = new.active where id = old.id;
  update meta.app_access set roles = new.roles where app_id = old.app_id and account_id = old.id;
  return new;
end
$$;

create trigger app_user_write instead of insert or update or delete on meta.app_user
  for each row execute function meta.app_user_write();

-- ---------------------------------------------------------------------
-- Authentication and roles
-- ---------------------------------------------------------------------

-- Verify a password for an application. bcrypt always runs (constant time
-- for unknown users); an account without access to the app fails exactly
-- like a wrong password, so the response doesn't reveal which accounts
-- exist or which apps they may use.
create or replace function meta.authenticate(p_app_id int, p_username text, p_password text) returns text
language plpgsql security definer set search_path = meta, public, pg_catalog as $$
declare
  v_acc meta.account;
  v_ok  boolean;
begin
  select * into v_acc from meta.account where lower(username) = lower(p_username) and active;
  v_ok := crypt(coalesce(p_password, ''), coalesce(v_acc.password_hash, gen_salt('bf', 10))) = v_acc.password_hash;
  if v_ok is not true then
    return null;
  end if;
  if not exists (select 1 from meta.app a where a.id = p_app_id and a.access_control = 'any_user')
     and not exists (select 1 from meta.app_access where app_id = p_app_id and account_id = v_acc.id) then
    return null;
  end if;
  update meta.account set last_login_at = now() where id = v_acc.id;
  return v_acc.username;
end
$$;

-- The roles an account has in an application (from app_access).
create function meta.account_roles(p_app_id int, p_username text) returns text[]
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce((select array(select distinct lower(r) from unnest(aa.roles) r order by 1)
                     from meta.app_access aa join meta.account ac on ac.id = aa.account_id
                    where aa.app_id = p_app_id and lower(ac.username) = lower(p_username) and ac.active), '{}')
$$;

-- Roles now come from the session (resolved at sign-in).
create or replace function meta.has_role(p_role text) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select exists (
    select 1 from meta.session s
     where s.id = nullif(current_setting('pgkiln.session_id', true), '')::uuid
       and lower(p_role) = any (select lower(r) from unnest(s.roles) r))
$$;

-- ---------------------------------------------------------------------
-- Privileges: the runtime may read accounts without password hashes.
-- ---------------------------------------------------------------------
grant select (id, username, display_name, email, active) on meta.account to pgkiln_runtime;
grant select on meta.app_access to pgkiln_runtime;
revoke all on function meta.account_roles(int, text) from public;
grant execute on function meta.account_roles(int, text) to pgkiln_runtime;
revoke all on function meta.authenticate(int, text, text) from public;
grant execute on function meta.authenticate(int, text, text) to pgkiln_runtime;
