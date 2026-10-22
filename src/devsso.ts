import { randomBytes } from 'node:crypto';
import { owner } from './db.ts';
import { SsoError } from './sso.ts';

// (sprint 129, SEC-1) Developers sign in to the builder through an identity
// provider (OpenID Connect, SAML) or an LDAP directory that has "builder"
// turned on. The rules, as for application accounts (sso.ts, ldap.ts):
//  * a developer is found by the provider's stable subject
//    (meta.developer_identity), never by a name the provider sends alone;
//  * an existing developer with the same username is linked on the first
//    sign-in only when the source allows it (builder_link_existing), with a
//    verified e-mail address when that is the username, and never a
//    break-glass developer; otherwise the developer links the identity
//    themselves on the Security page, signed in;
//  * a new developer is created when the source allows it
//    (builder_auto_create), for members of builder_group when one is set;
//  * builder_admin_group, when set, decides on every sign-in who is an
//    instance administrator (break-glass developers and the last
//    administrator are never demoted).
// A workspace can require these sign-ins of its developers (sso_only);
// break-glass developers may still use the pgkiln password.

export interface BuilderSource {
  kind: 'provider' | 'directory';
  id: number;
  name: string;
  builder_auto_create: boolean;
  builder_link_existing: boolean;
  builder_group: string | null;
  builder_admin_group: string | null;
}

export interface BuilderIdentity {
  subject: string;
  username: string;
  name?: string | null;
  email?: string | null;
  /** false: the username is an unverified e-mail address and links nothing */
  mayLink: boolean;
  groups: string[];
}

const column = (k: BuilderSource['kind']) => (k === 'provider' ? 'provider_id' : 'directory_id');
const validEmail = (v: unknown): v is string => typeof v === 'string' && /^[^@\s<>"(),;:\\]+@[^@\s<>"(),;:\\]+\.[^@\s<>"(),;:\\]+$/.test(v) && v.length <= 254;

/** The providers and directories developers can sign in with. */
export async function builderSources() {
  const providers = (await owner.query<{ name: string; display_name: string }>('select name, display_name from meta.auth_provider where enabled and builder order by display_name')).rows;
  const directories = (await owner.query<{ name: string; display_name: string }>('select name, display_name from meta.ldap_directory where enabled and builder order by display_name')).rows;
  return { providers, directories };
}

export async function builderProvider(name: string) {
  return owner.one('select * from meta.auth_provider where enabled and builder and name = $1', [name]);
}
export async function builderDirectory(name: string) {
  return owner.one('select * from meta.ldap_directory where enabled and builder and name = $1', [name]);
}

/** The developer for an identity (see the rules above); throws SsoError when there is none. */
export async function resolveDeveloper(src: BuilderSource, id: BuilderIdentity): Promise<string> {
  const col = column(src.kind);
  return owner.tx(async (c) => {
    let username: string | undefined = (await c.query(`select username from meta.developer_identity where ${col} = $1 and subject = $2`, [src.id, id.subject])).rows[0]?.username;
    if (!username) {
      const existing = (
        await c.query(
          `select d.username, d.break_glass, exists (select 1 from meta.developer_identity i where i.username = d.username and i.${col} = $2) as linked
             from meta.developer d where lower(d.username) = lower($1)`,
          [id.username, src.id],
        )
      ).rows[0];
      if (existing) {
        if (existing.linked) throw new SsoError('This developer is already linked to another identity here.');
        if (!src.builder_link_existing || !id.mayLink || existing.break_glass)
          throw new SsoError(`A developer "${existing.username}" exists but is not linked to this identity. Sign in with the password and link it on the Security page.`);
        username = existing.username as string;
      } else {
        const member = !src.builder_group || id.groups.includes(src.builder_group) || (!!src.builder_admin_group && id.groups.includes(src.builder_admin_group));
        if (!src.builder_auto_create || !member) throw new SsoError(`There is no developer "${id.username}". Ask an administrator for access.`);
        // a password nobody knows: the developer signs in through the provider (an administrator can set one)
        username = (
          await c.query(
            `insert into meta.developer (username, password_hash, is_admin, email) values ($1, crypt($2, gen_salt('bf', 10)), false, $3) returning username`,
            [id.username, randomBytes(32).toString('base64url'), validEmail(id.email) ? id.email : null],
          )
        ).rows[0].username;
      }
      await c.query(`insert into meta.developer_identity (${col}, subject, username) values ($1, $2, $3)`, [src.id, id.subject, username]);
    }
    if (src.builder_admin_group) {
      const admin = id.groups.includes(src.builder_admin_group);
      // never the last administrator either: the instance would have none
      await c.query(
        `update meta.developer set is_admin = $2 where username = $1 and is_admin <> $2
            and ($2 or (not break_glass and (select count(*) from meta.developer where is_admin) > 1))`,
        [username, admin],
      );
    }
    return username!;
  });
}

/** Link an identity to a signed-in developer (Security page). */
export async function linkDeveloper(src: Pick<BuilderSource, 'kind' | 'id'>, subject: string, username: string) {
  const col = column(src.kind);
  const other = await owner.one(`select username from meta.developer_identity where ${col} = $1 and (subject = $2 or username = $3)`, [src.id, subject, username]);
  if (other) throw new SsoError(other.username === username ? 'You already linked an identity here; unlink it first.' : 'This identity is linked to another developer.');
  await owner.query(`insert into meta.developer_identity (${col}, subject, username) values ($1, $2, $3)`, [src.id, subject, username]);
}

/** A developer's linked identities (Security page, provider pages). */
export async function identitiesOf(username: string) {
  return (
    await owner.query<{ id: number; source: string; display_name: string; kind: 'provider' | 'directory'; linked_at: string }>(
      `select i.id, coalesce(p.name, d.name) as source, coalesce(p.display_name, d.display_name) as display_name,
              case when i.provider_id is null then 'directory' else 'provider' end as kind, i.linked_at
         from meta.developer_identity i
         left join meta.auth_provider p on p.id = i.provider_id
         left join meta.ldap_directory d on d.id = i.directory_id
        where i.username = $1 order by 3`,
      [username],
    )
  ).rows;
}

/**
 * Must the developer sign in through an identity provider? A member of a workspace that requires it,
 * unless break-glass.
 */
export async function ssoRequired(username: string) {
  const r = await owner.one(
    `select not d.break_glass and exists (select 1 from meta.workspace_member m join meta.workspace w on w.id = m.workspace_id
                                           where m.username = d.username and w.sso_only) as required
       from meta.developer d where d.username = $1`,
    [username],
  );
  return !!r?.required;
}

/** Instance administrators who may still sign in with the password. */
export async function breakGlassAdmins() {
  return (await owner.query<{ username: string }>('select username from meta.developer where is_admin and break_glass order by username')).rows.map((r) => r.username);
}

/** `pgkiln admin builder-sign-in password`: every workspace allows the password again. */
export async function clearSsoOnly() {
  return (await owner.query('update meta.workspace set sso_only = false where sso_only')).rowCount ?? 0;
}
