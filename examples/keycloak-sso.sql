-- Register the local Keycloak (docker compose --profile sso) as an identity
-- provider and offer it on the HR sample's login page.
--   Keycloak users: king / king-sso (groups hr-admins, hr-managers),
--                   allen / allen-sso (no groups), carol / carol-sso (hr-managers).
-- king and allen match existing pgapex accounts and are linked on first sign-in;
-- carol has no pgapex account and is created automatically (auto_create).
insert into meta.auth_provider (name, display_name, issuer, client_id, client_secret, groups_claim, auto_create)
values ('keycloak', 'Keycloak', 'http://127.0.0.1:8180/realms/pgapex', 'pgapex', 'pgapex-dev-secret', 'groups', true)
on conflict (name) do nothing;

update meta.app set sso_providers = array(select distinct unnest(sso_providers || '{keycloak}'))
 where alias = 'hr';

insert into meta.app_group_role (app_id, group_name, role)
select a.id, g.group_name, g.role
  from meta.app a, (values ('hr-admins', 'admin'), ('hr-managers', 'manager')) g(group_name, role)
 where a.alias = 'hr'
on conflict do nothing;
