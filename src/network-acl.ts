import dns from 'node:dns/promises';
import net from 'node:net';
import { owner } from './db.ts';
import { isPrivateAddress, matches, restHosts, scopeProblem, urlProblem, type OutboundScope } from './webclient.ts';

// (sprint 118, WS-9; APEX 26.2 workspace network ACLs) A workspace's network
// access list: when meta.workspace.network_restricted is on, the outgoing web
// calls made for its applications must match one of meta.workspace.network_hosts
// as well as the installation's lists (PGKILN_REST_ALLOWED_HOSTS /
// PGKILN_REST_PRIVATE_HOSTS). It only narrows: the installation's checks
// (allow-list, private addresses at connect time, redirects) stay as they are.
//
// Every caller of src/webclient.ts webRequest() passes a scope built here:
// websources.ts call() (meta.web_request, REST data sources, write-back,
// invoke API in pages, workflows and automations, the builder's Test), its
// token requests, objectstore.ts and the REST source catalogs' "read from a
// URL". A workspace's own mail service checks its SMTP host with
// mailHostAddress(). Refusals go to meta.network_refusal (7 days).
//
// No cache: one indexed query per call, so a narrowed list applies at once on
// every server.

export const KEEP_DAYS = 7;
/** At most this many refusals are kept per workspace. */
const KEEP_PER_WORKSPACE = 2000;

/** Entries of a network access list: host, *.domain, host:port, [IPv6]:port. */
export const HOST_ENTRY = /^(?:(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])(?::([1-9][0-9]{0,4}))?$/;

/** The entries of a typed list (comma, space or line separated), checked; throws with a message. */
export function parseHostList(text: string): string[] {
  const entries = [...new Set(text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  for (const e of entries) {
    const m = HOST_ENTRY.exec(e);
    if (!m || (m[1] && Number(m[1]) > 65535))
      throw new Error(`"${e.slice(0, 80)}" is not a host: use api.example.com, *.example.com or api.example.com:8443 (no scheme, no path).`);
  }
  if (entries.length > 200) throw new Error('At most 200 entries.');
  return entries;
}

interface WorkspaceRow {
  id: number;
  name: string;
  network_restricted: boolean;
  network_hosts: string[];
}

function scopeOf(w: WorkspaceRow, appId: number | null, what: string): OutboundScope {
  return {
    workspaceId: w.id,
    workspaceName: w.name,
    appId,
    what,
    hosts: w.network_restricted ? w.network_hosts : null,
    refused: (url, list, message) => void recordRefusal(w.id, appId, what, url, list, message),
  };
}

/** The scope of an application's outgoing calls (its workspace's list); null for no application. */
export async function scopeForApp(appId: number | null | undefined, what: string): Promise<OutboundScope | null> {
  if (appId === null || appId === undefined || !Number.isInteger(Number(appId))) return null;
  const w = await owner.one<WorkspaceRow>(
    'select w.id, w.name, w.network_restricted, w.network_hosts from meta.workspace w where w.id = meta.app_workspace($1)', [appId]);
  return w ? scopeOf(w, Number(appId), what) : null;
}

/** The scope of a workspace's own outgoing calls (no application: REST source catalogs, its mail service). */
export async function scopeForWorkspace(workspaceId: number, what: string): Promise<OutboundScope | null> {
  const w = await owner.one<WorkspaceRow>('select id, name, network_restricted, network_hosts from meta.workspace where id = $1', [workspaceId]);
  return w ? scopeOf(w, null, what) : null;
}

/** Keep a refusal (never throws: a refusal is already an error for the caller). */
export async function recordRefusal(workspaceId: number | null, appId: number | null, what: string, url: URL, list: 'installation' | 'workspace', message: string) {
  try {
    await owner.query(
      `insert into meta.network_refusal (workspace_id, app_id, what, host, url, list, message) values ($1, $2, $3, $4, $5, $6, $7)`,
      [workspaceId, appId, what.slice(0, 100), url.host.slice(0, 300), `${url.protocol}//${url.host}${url.pathname}`.slice(0, 1000), list, message.slice(0, 1000)]);
  } catch {
    // an application deleted meanwhile, or the database is away: nothing to keep
  }
}

/** Forget old refusals (the scheduler's pass, with the web requests' purge). */
export async function purgeRefusals() {
  await owner.query(`delete from meta.network_refusal where at < now() - make_interval(days => ${KEEP_DAYS})`);
  await owner.query(
    `delete from meta.network_refusal r using (
       select id, row_number() over (partition by workspace_id order by id desc) as n from meta.network_refusal
     ) x where r.id = x.id and x.n > ${KEEP_PER_WORKSPACE}`);
}

/**
 * Where a workspace's own SMTP service may connect: the host must pass the
 * installation's lists and the workspace's, and it is resolved here once; the
 * connection then goes to the checked address (no DNS rebinding), with the
 * host name kept for TLS. Throws an Error with the reason.
 */
export async function mailHostAddress(scope: OutboundScope, host: string, port: number): Promise<{ address: string; servername: string | undefined }> {
  let url: URL;
  try {
    url = new URL(`https://${net.isIPv6(host) ? `[${host}]` : host}:${port}/`);
  } catch {
    throw new Error(`The SMTP host ${host} is not valid.`);
  }
  const hosts = restHosts();
  const problem = urlProblem(url, hosts) ?? scopeProblem(scope, url);
  if (problem) {
    scope.refused?.(url, urlProblem(url, hosts) ? 'installation' : 'workspace', problem);
    throw new Error(problem);
  }
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(bare) ? [{ address: bare }] : await dns.lookup(bare, { all: true }).catch(() => []);
  if (!addresses.length) throw new Error(`The SMTP host ${host} has no address.`);
  const priv = matches(hosts.private, url);
  if (!priv && addresses.some((a) => isPrivateAddress(a.address))) {
    const msg = `The SMTP host ${host} resolves to a private, loopback or link-local address (allow it with PGKILN_REST_PRIVATE_HOSTS).`;
    scope.refused?.(url, 'installation', msg);
    throw new Error(msg);
  }
  return { address: addresses[0].address, servername: net.isIP(bare) ? undefined : bare };
}
