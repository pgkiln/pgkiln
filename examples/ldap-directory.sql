-- LDAP sign-in for the HR sample against the demo directory:
--   docker compose --profile ldap up -d ldap
--   psql "$DATABASE_URL" -f examples/ldap-directory.sql
-- Then sign in to /a/hr as blake / blake-ldap (linked to the HR account blake),
-- or dora / dora-ldap (a new account, with the manager role through the
-- hr-managers group). eve / eve-ldap has no groups and no access.

insert into meta.ldap_directory (name, display_name, url, bind_dn, bind_password, user_base, user_filter,
                                 group_base, group_filter, auto_create)
values ('demo', 'Demo directory', 'ldap://127.0.0.1:3890', 'cn=admin,dc=example,dc=org', 'admin',
        'ou=people,dc=example,dc=org', '(uid={username})',
        'ou=groups,dc=example,dc=org', '(member={dn})', true)
on conflict (name) do nothing;

update meta.app set ldap_directories = array['demo'] where alias = 'hr' and not 'demo' = any(ldap_directories);

insert into meta.app_group_role (app_id, group_name, role)
select id, 'hr-managers', 'manager' from meta.app where alias = 'hr'
on conflict do nothing;
