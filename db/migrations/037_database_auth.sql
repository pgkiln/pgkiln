-- Database-account authentication (APEX: Database Accounts). Users sign in
-- with a PostgreSQL login role and its password; pgapex checks them by
-- opening a short-lived connection as that role to its own database (it never
-- reads pg_authid). Only the roles listed per app, or the members of one
-- role, may sign in; nothing listed means nobody. The session's user is the
-- role name. The new columns are nullable so exports from older versions
-- still import.

alter table meta.app drop constraint app_authentication_check;
alter table meta.app add constraint app_authentication_check check (authentication in ('none', 'app_users', 'header', 'database'));

alter table meta.app add column db_auth_roles text[]
  check (db_auth_roles is null or (cardinality(db_auth_roles) <= 200 and array_position(db_auth_roles, null) is null));
alter table meta.app add column db_auth_member_of text
  check (db_auth_member_of is null or (octet_length(db_auth_member_of) between 1 and 63 and db_auth_member_of !~ '[[:cntrl:]]'));

comment on column meta.app.db_auth_roles is 'database authentication: the login roles that may sign in (exact names)';
comment on column meta.app.db_auth_member_of is 'database authentication: or every member of this role may sign in';
