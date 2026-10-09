-- SAML sign-in for the HR sample with the development Keycloak:
--   docker compose --profile sso up -d keycloak     (the realm has a SAML client for pgkiln)
--   psql "$DATABASE_URL" -f examples/keycloak-saml.sql
-- Then use "Sign in with Keycloak (SAML)" on /a/hr/login: king / king-sso (linked to the HR
-- account king) or carol / carol-sso (created; manager through the hr-managers group).
-- Keycloak makes its signing key at the first start, so the certificate is read from the
-- realm's SAML descriptor (psql runs the command between backquotes).

\set cert `curl -s http://127.0.0.1:8180/realms/pgkiln/protocol/saml/descriptor | sed -n 's:.*<ds\:X509Certificate>\([^<]*\)</ds\:X509Certificate>.*:\1:p' | head -1`

insert into meta.auth_provider (name, display_name, protocol, issuer, client_id, idp_sso_url, idp_cert,
                                username_claim, groups_claim, auto_create, link_existing)
values ('keycloak-saml', 'Keycloak (SAML)', 'saml', 'http://127.0.0.1:8180/realms/pgkiln',
        'http://127.0.0.1:3100/sso/saml/keycloak-saml/metadata', 'http://127.0.0.1:8180/realms/pgkiln/protocol/saml',
        E'-----BEGIN CERTIFICATE-----\n' || :'cert' || E'\n-----END CERTIFICATE-----', 'nameID', 'groups', true, true)
on conflict (name) do update set idp_cert = excluded.idp_cert;

update meta.app set sso_providers = array_append(sso_providers, 'keycloak-saml')
 where alias = 'hr' and not 'keycloak-saml' = any(sso_providers);

insert into meta.app_group_role (app_id, group_name, role)
select id, 'hr-managers', 'manager' from meta.app where alias = 'hr'
on conflict do nothing;
