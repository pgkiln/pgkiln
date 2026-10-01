import { Client, InvalidCredentialsError, type Entry } from 'ldapts';
import { owner } from './db.ts';

// LDAP directories (APEX: LDAP Directory authentication). Signing in:
//   1. connect (ldap:// with optional StartTLS, or ldaps://), bind as the
//      service account (or anonymously) and search the user with the
//      directory's filter, the username escaped (RFC 4515);
//   2. bind as the user's DN with the password given. An empty password is
//      refused before that: LDAP treats it as an anonymous bind, which
//      "succeeds" for any DN;
//   3. read the user's display name, e-mail and groups (an attribute such as
//      memberOf, and/or a group search with the user's escaped DN);
//   4. find the account linked to the entry (entryUUID, else the DN), or link
//      one with the same username that has no link to this directory yet, or
//      create one when the directory allows (auto_create).
// Group names map to roles per application (meta.app_group_role), as with
// single sign-on.

export interface Directory {
  id: number;
  name: string;
  display_name: string;
  url: string;
  start_tls: boolean;
  tls_verify: boolean;
  bind_dn: string | null;
  bind_password: string | null;
  user_base: string;
  user_filter: string;
  username_attribute: string;
  display_name_attribute: string | null;
  email_attribute: string | null;
  group_attribute: string | null;
  group_base: string | null;
  group_filter: string | null;
  group_name_attribute: string;
  auto_create: boolean;
  enabled: boolean;
}

export class LdapError extends Error {}

const TIMEOUT_MS = Number(process.env.LDAP_TIMEOUT_MS ?? 5000);

/** An LDAP filter value with the special characters escaped (RFC 4515). */
export function escapeFilter(value: string) {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** The directories enabled for an application, in the app's order. */
export async function appDirectories(names: string[]): Promise<Directory[]> {
  if (!names.length) return [];
  const rows = (await owner.query<Directory>('select * from meta.ldap_directory where enabled and name = any($1)', [names])).rows;
  return names.flatMap((n) => rows.filter((r) => r.name === n));
}

export async function loadDirectory(id: number) {
  return owner.one<Directory>('select * from meta.ldap_directory where id = $1', [id]);
}

async function connect(d: Directory) {
  const tlsOptions = { rejectUnauthorized: d.tls_verify };
  // ldapts speaks TLS from the start whenever tlsOptions are given, so only for ldaps://
  const client = new Client({ url: d.url, timeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS, ...(d.url.startsWith('ldaps://') ? { tlsOptions } : {}) });
  if (d.start_tls && d.url.startsWith('ldap://')) await client.startTLS(tlsOptions);
  return client;
}

const first = (v: Entry[string] | undefined): string | null => {
  if (v === undefined) return null;
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined ? null : Buffer.isBuffer(x) ? x.toString('utf8') : String(x);
};
const all = (v: Entry[string] | undefined): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x))));
/** "cn=hr-managers,ou=groups,dc=example,dc=org" → "hr-managers" */
const rdnValue = (dn: string) => /^[^=]+=((?:\\.|[^,])*)/.exec(dn)?.[1]?.replace(/\\(.)/g, '$1') ?? dn;

export interface LdapUser {
  dn: string;
  subject: string;
  username: string;
  displayName: string | null;
  email: string | null;
  groups: string[];
}

/** Check a username and password against a directory; null when they don't match. */
export async function ldapAuthenticate(d: Directory, username: string, password: string): Promise<LdapUser | null> {
  if (!username || !password || username.length > 100 || password.length > 200) return null;
  const client = await connect(d);
  try {
    if (d.bind_dn) await client.bind(d.bind_dn, d.bind_password ?? '');
    const attributes = [d.username_attribute, d.display_name_attribute, d.email_attribute, d.group_attribute, 'entryUUID'].filter((x): x is string => !!x);
    const { searchEntries } = await client.search(d.user_base, {
      scope: 'sub',
      filter: d.user_filter.replaceAll('{username}', escapeFilter(username)),
      attributes,
      sizeLimit: 2,
    });
    // no such user, or the filter is ambiguous: refuse rather than guess
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];
    try {
      await client.bind(entry.dn, password);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return null;
      throw e;
    }
    const groups = new Set(d.group_attribute ? all(entry[d.group_attribute]).map(rdnValue) : []);
    if (d.group_base && d.group_filter) {
      // as the service account when there is one (users often may not search groups), else as the user just bound
      if (d.bind_dn) await client.bind(d.bind_dn, d.bind_password ?? '');
      const res = await client.search(d.group_base, {
        scope: 'sub',
        filter: d.group_filter.replaceAll('{dn}', escapeFilter(entry.dn)).replaceAll('{username}', escapeFilter(username)),
        attributes: [d.group_name_attribute],
        sizeLimit: 1000,
      });
      for (const g of res.searchEntries) groups.add(first(g[d.group_name_attribute]) ?? rdnValue(g.dn));
    }
    return {
      dn: entry.dn,
      subject: first(entry.entryUUID) ?? entry.dn.toLowerCase(),
      username: first(entry[d.username_attribute]) ?? username,
      displayName: d.display_name_attribute ? first(entry[d.display_name_attribute]) : null,
      email: d.email_attribute ? first(entry[d.email_attribute]) : null,
      groups: [...groups],
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** The account for a directory entry (see the steps above); throws LdapError when there is none. */
export async function resolveLdapAccount(d: Directory, u: LdapUser): Promise<string> {
  return owner.tx(async (c) => {
    let acc = (
      await c.query(
        `select a.username, a.active from meta.ldap_identity i join meta.account a on a.id = i.account_id
          where i.directory_id = $1 and i.subject = $2`,
        [d.id, u.subject],
      )
    ).rows[0];
    if (!acc) {
      let row = (
        await c.query(
          `select a.id, a.username, a.active,
                  exists (select 1 from meta.ldap_identity i where i.account_id = a.id and i.directory_id = $2) as has_identity
             from meta.account a where lower(a.username) = lower($1)`,
          [u.username, d.id],
        )
      ).rows[0];
      if (row?.has_identity) throw new LdapError('This account is already linked to another entry in the directory.');
      if (!row) {
        if (!d.auto_create) throw new LdapError(`There is no account for "${u.username}". Ask an administrator for access.`);
        row = (await c.query('insert into meta.account (username, display_name, email) values ($1, $2, $3) returning id, username, active', [u.username, u.displayName, u.email])).rows[0];
      }
      await c.query('insert into meta.ldap_identity (directory_id, subject, account_id) values ($1, $2, $3)', [d.id, u.subject, row.id]);
      acc = row;
    }
    if (!acc.active) throw new LdapError('Your account is disabled.');
    await c.query('update meta.account set last_login_at = now() where lower(username) = lower($1)', [acc.username]);
    return acc.username as string;
  });
}

/** Builder → "Test connection": bind as the service account and count the users the base holds. */
export async function testDirectory(d: Directory, username?: string): Promise<string> {
  const client = await connect(d);
  try {
    if (d.bind_dn) await client.bind(d.bind_dn, d.bind_password ?? '');
    if (username) {
      const { searchEntries } = await client.search(d.user_base, { scope: 'sub', filter: d.user_filter.replaceAll('{username}', escapeFilter(username)), attributes: ['dn'], sizeLimit: 2 });
      return searchEntries.length === 1 ? `Found ${searchEntries[0].dn}.` : searchEntries.length ? 'The filter matches more than one entry.' : `No entry matches ${d.user_filter.replace('{username}', username)}.`;
    }
    const { searchEntries } = await client.search(d.user_base, { scope: 'base', attributes: ['dn'] });
    return `Connected${d.bind_dn ? ` as ${d.bind_dn}` : ' anonymously'}; ${d.user_base} ${searchEntries.length ? 'exists' : 'was not found'}.`;
  } finally {
    await client.unbind().catch(() => {});
  }
}
