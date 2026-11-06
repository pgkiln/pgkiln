import type { FastifyInstance, FastifyReply } from 'fastify';
import { apiRoleProblem } from '../api.ts';
import { owner } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { AUTOREST_METHODS, describeColumns, keyColumns, MAX_PAGE, qualified, RELKINDS, type RestObject } from '../runtime/autorest.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { publicUrl } from '../sso.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { splitRoles } from './users.ts';
import { restNav } from './rest-modules.ts';
import { currentWorkspace, usableSchemas, workshopDb } from './workspaces.ts';
import { scopedTx as tx, tr, withTranslator, type BuilderTranslate } from './i18n.ts';

// (sprint 100, Database Actions DA-11 part 1) SQL Workshop › RESTful Services: AutoREST. A developer publishes a
// table or view of a schema the SQL Workshop may use through an application of the workspace (meta.rest_object,
// migration 113); src/runtime/autorest.ts serves it at /a/<alias>/autorest/<object>/. The application decides who
// may call it (its tokens and OAuth clients, App › REST API) and as which database role it runs: never the
// object's owner or a role that bypasses row level security. This page lists the published objects, enables and
// changes them, and shows the URLs, cURL and fetch examples and the OpenAPI link.

const PAGE = `${BASE}/sql/rest`;
const ALIAS = /^[a-z][a-z0-9_-]{0,62}$/;

interface Rel {
  schema: string;
  name: string;
  kind: string;
}
interface WsApp {
  id: number;
  alias: string;
  name: string;
  db_role: string | null;
}
type Row = RestObject & { app_alias: string; app_name: string; db_role: string | null };

const many = (v: unknown) => ([] as string[]).concat((v as string | string[] | undefined) ?? []);
const KINDS = { r: 'table', p: 'table', v: 'view', m: 'mview', f: 'foreign' } as const;
const kindLabel = (k: string) => (Object.hasOwn(KINDS, k) ? tx(`ar.kind.${KINDS[k as keyof typeof KINDS]}`) : RELKINDS[k] ?? k);
const anyOf = (roles: string[]) => roles.join(` ${tx('rm.or')} `);
const autoUrl = (alias: string, o?: string) => `${publicUrl()}/a/${alias}/autorest/${o ? `${o}/` : ''}`;

/** The applications of the developer's current workspace. */
async function workspaceApps(s: Session): Promise<WsApp[]> {
  return (await owner.query<WsApp>(`select id, alias, name, db_role from meta.app a where meta.app_workspace(a.id) = $1 order by lower(name)`, [currentWorkspace(s)])).rows;
}

/** The published objects of the current workspace (one, with id). */
async function rows(s: Session, id?: number): Promise<Row[]> {
  return (await owner.query<Row>(
    `select o.*, a.alias as app_alias, a.name as app_name, a.db_role from meta.rest_object o join meta.app a on a.id = o.app_id
      where meta.app_workspace(a.id) = $1 ${id !== undefined ? 'and o.id = $2' : ''} order by a.alias, o.alias`,
    id !== undefined ? [currentWorkspace(s), id] : [currentWorkspace(s)],
  )).rows;
}

/** Tables and views the SQL Workshop's connection may use. */
async function relations(s: Session): Promise<Rel[]> {
  const db = await workshopDb(s);
  const schemas = (await usableSchemas(db)).filter((x) => !SYSTEM_SCHEMAS.includes(x));
  if (!schemas.length) return [];
  return (await db.query<Rel>(
    `select n.nspname as schema, c.relname as name, c.relkind::text as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
        and not (n.nspname = 'public' and c.relname like 'pgkiln\\_%')
      order by 1, 2 limit 5000`, [schemas])).rows;
}

/** A relation the workshop may use, by schema and name. */
async function findRel(s: Session, schema: unknown, name: unknown): Promise<Rel | undefined> {
  if (typeof schema !== 'string' || typeof name !== 'string' || SYSTEM_SCHEMAS.includes(schema)) return undefined;
  return (await relations(s)).find((r) => r.schema === schema && r.name === name);
}

/** Why `role` may not serve the relation; null when it may. */
async function roleProblem(t: BuilderTranslate, role: string | null, rel: Pick<Rel, 'schema' | 'name'>): Promise<string | null> {
  if (!role) return t('ar.e.no_role');
  const problem = await apiRoleProblem(role);
  if (problem) return t('ar.e.role_problem', { problem });
  const r = await owner.one<{ owns: boolean }>(
    `select pg_has_role($1, c.relowner, 'MEMBER') as owns from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $2 and c.relname = $3`,
    [role, rel.schema, rel.name]);
  if (r?.owns) return t('ar.e.owner', { role, object: `${rel.schema}.${rel.name}` });
  return null;
}

interface Input {
  methods: string[];
  auth: 'token' | 'public';
  roles: string[];
  page_size: number;
  enabled: boolean;
}

/** The form's settings, or the problems with them. */
async function readInput(t: BuilderTranslate, b: Record<string, unknown>, rel: Pick<Rel, 'schema' | 'name' | 'kind'>, role: string | null): Promise<{ input: Input; problems: string[] }> {
  const problems: string[] = [];
  const methods = AUTOREST_METHODS.filter((m) => many(b.methods).includes(m));
  if (!methods.length) problems.push(t('ar.e.method'));
  const auth = b.auth === 'public' ? 'public' : b.auth === 'token' ? 'token' : null;
  if (!auth) problems.push(t('rm.e.auth'));
  const size = Number(b.page_size ?? 25);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) problems.push(t('ar.e.page_size', { max: MAX_PAGE }));
  const cols = role ? await describeColumns(owner, rel.schema, rel.name, role) : [];
  if (rel.kind === 'm' && methods.some((m) => m !== 'GET')) problems.push(t('ar.e.mview'));
  if (!keyColumns(cols).length && methods.some((m) => m === 'PUT' || m === 'DELETE')) problems.push(t('ar.e.no_key'));
  const roles = splitRoles(String(b.roles ?? ''));
  if (roles.some((r) => r.length > 100)) problems.push(t('rm.e.role_length'));
  return { input: { methods, auth: auth ?? 'token', roles, page_size: size, enabled: b.enabled === undefined ? true : b.enabled === '1' }, problems };
}

const methodChecks = (selected: string[]) =>
  html`<fieldset class="prop-group"><legend>${tx('ar.methods')}</legend><div class="form-grid">${AUTOREST_METHODS.map((m) =>
    html`<label class="check"><input type="checkbox" name="methods" value="${m}"${selected.includes(m) ? raw(' checked') : ''}> ${m} <small class="help">${
      tx(`ar.m.${m.toLowerCase() as 'get' | 'post' | 'put' | 'delete'}`)}</small></label>`)}</div></fieldset>`;

const authChoice = (auth: string) =>
  html`<fieldset class="prop-group"><legend>${tx('rm.who')}</legend>
    <label class="check"><input type="radio" name="auth" value="token"${auth !== 'public' ? raw(' checked') : ''}> ${tx('rm.auth_token')} <small class="help">${tx('ar.auth_token_help')}</small></label>
    <label class="check"><input type="radio" name="auth" value="public"${auth === 'public' ? raw(' checked') : ''}> ${tx('ar.auth_public')} <small class="help">${tx.code('ar.auth_public_help')}</small></label>
  </fieldset>`;

const errorList = (problems: string[]) =>
  problems.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : '';

/** The list and the Enable form. */
const listPage = (s: Session, q: Record<string, unknown>, problems: string[] = []) => withTranslator(tr(s), () => listPageInner(s, q, problems));
async function listPageInner(s: Session, q: Record<string, unknown>, problems: string[]) {
  const [list, apps, rels] = await Promise.all([rows(s), workspaceApps(s), relations(s)]);
  const usable = apps.filter((a) => a.db_role);
  const wantedRel = typeof q.schema === 'string' && typeof q.name === 'string' ? `${q.schema}.${q.name}` : '';
  const wantedRelKey = rels.find((r) => `${r.schema}.${r.name}` === wantedRel) ? JSON.stringify([q.schema, q.name]) : '';
  const bySchema = new Map<string, Rel[]>();
  for (const r of rels) bySchema.set(r.schema, [...(bySchema.get(r.schema) ?? []), r]);
  const table = list.length
    ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('ar.object')}</th><th>URL</th><th>${tx('rm.application')}</th><th>${tx('ar.methods')}</th><th>${tx('rm.access')}</th></tr></thead><tbody>
        ${list.map((o) => html`<tr${o.enabled ? '' : raw(' class="muted"')}>
          <td data-label="${tx('ar.object')}"><a href="${PAGE}/${o.id}">${o.schema_name}.${o.object_name}</a>${o.enabled ? '' : html` <span class="tag">${tx('rm.off')}</span>`}</td>
          <td data-label="URL" class="wrap-anywhere"><code>/a/${o.app_alias}/autorest/${o.alias}/</code></td>
          <td data-label="${tx('rm.application')}">${o.app_name}</td>
          <td data-label="${tx('ar.methods')}">${o.methods.join(', ')}</td>
          <td data-label="${tx('rm.access')}">${o.auth === 'public' ? html`<strong>${tx('rm.public')}</strong>` : tx('rm.token')}${o.roles.length ? `, ${tx('rm.role', { roles: anyOf(o.roles) })}` : ''}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="muted">${tx.rich('ar.none_yet', { menu: raw(`<em>${esc(tx('ar.menu_enable'))}</em>`) })}</p>`;
  const form = html`<form method="post" action="${PAGE}" id="enable">${csrf(s)}
      ${errorList(problems)}
      <div class="form-grid">
        <div class="field"><label class="label" for="f_object">${tx('ar.table_or_view')}</label>
          <select id="f_object" name="object" required><option value="">${tx('ar.choose')}</option>${[...bySchema].map(([schema, rs]) =>
            html`<optgroup label="${schema}">${rs.map((r) => {
              const v = JSON.stringify([r.schema, r.name]);
              return html`<option value="${v}"${v === wantedRelKey ? raw(' selected') : ''}>${r.schema}.${r.name}${r.kind === 'r' || r.kind === 'p' ? '' : ` (${kindLabel(r.kind)})`}</option>`;
            })}</optgroup>`)}</select></div>
        <div class="field"><label class="label" for="f_app">${tx('rm.application')}</label>
          <select id="f_app" name="app_id" required>${usable.map((a) => html`<option value="${a.id}"${String(q.app_id ?? '') === String(a.id) ? raw(' selected') : ''}>${a.name} (${a.alias}, ${tx('ar.runs_as', { role: a.db_role })})</option>`)}</select>
          <small class="help">${tx('ar.app_help')}</small></div>
        <div class="field"><label class="label" for="f_alias">${tx('ar.url_name')}</label>
          <input id="f_alias" name="alias" value="${String(q.alias ?? '')}" placeholder="${tx('ar.object_name_ph')}">
          <small class="help">/a/&lt;app&gt;/autorest/<b>name</b>/ — ${tx('ar.url_name_rule')}</small></div>
        <div class="field"><label class="label" for="f_roles">${tx('rm.roles')}</label>
          <input id="f_roles" name="roles" value="${String(q.roles ?? '')}" placeholder="${tx('ar.any_caller')}">
          <small class="help">${tx('ar.roles_help')}</small></div>
        <div class="field"><label class="label" for="f_page_size">${tx('rm.page_size')}</label>
          <input id="f_page_size" name="page_size" type="number" min="1" max="${MAX_PAGE}" value="${String(q.page_size ?? 25)}">
          <small class="help">${tx('ar.page_size_help', { max: MAX_PAGE })}</small></div>
      </div>
      ${methodChecks(many(q.methods).length ? many(q.methods) : ['GET'])}
      ${authChoice(String(q.auth ?? 'token'))}
      <div class="buttons"><button class="btn btn-hot"${usable.length ? '' : raw(' disabled')}>${icon('bolt')} ${tx('ar.enable')}</button></div>
      ${usable.length ? '' : html`<p class="muted">${tx('ar.no_usable_app')}</p>`}
    </form>`;
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('rest', s)}${restNav('autorest')}
    <p class="muted">${tx.code('ar.intro')} ${tx.rich('ar.intro_module', { module: raw(`<a href="${BASE}/sql/rest/modules">${esc(tx('ar.module_link'))}</a>`) })}</p>
    ${region(tx('ar.published'), table)}
    ${region(tx('ar.enable_a'), form)}`;
  return shell(s, tx('sql.tool.rest'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.rest')]], main, 'sql');
}

/** One published object: checks, endpoints, examples, settings. */
const detailPage = (s: Session, o: Row, problems: string[] = []) => withTranslator(tr(s), () => detailPageInner(s, o, problems));
async function detailPageInner(s: Session, o: Row, problems: string[]) {
  const rel = { schema: o.schema_name, name: o.object_name };
  const info = await owner.one<{ kind: string; rls: boolean; force: boolean; policies: number; invoker: boolean; oid: number }>(
    `select c.relkind::text as kind, c.relrowsecurity as rls, c.relforcerowsecurity as force, c.oid::int as oid,
            (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
            coalesce(c.reloptions && array['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false) as invoker
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`, [o.schema_name, o.object_name]);
  const role = o.db_role;
  const problem = info ? await roleProblem(tx, role, rel) : tx('ar.gone');
  const cols = info && role ? await describeColumns(owner, o.schema_name, o.object_name, role) : [];
  const key = keyColumns(cols);
  const privs = info && role && !problem
    ? (await owner.one<Record<string, boolean>>(
      `select has_table_privilege($1, $2::oid, 'SELECT') as "GET", has_table_privilege($1, $2::oid, 'INSERT') as "POST",
              has_table_privilege($1, $2::oid, 'UPDATE') or has_any_column_privilege($1, $2::oid, 'UPDATE') as "PUT", has_table_privilege($1, $2::oid, 'DELETE') as "DELETE",
              has_any_column_privilege($1, $2::oid, 'SELECT') as sel`, [role, info.oid]))!
    : null;
  const check = (ok: boolean | null, text: Raw | string) => html`<li>${ok === null ? 'ℹ' : ok ? '✓' : '✗'} ${text}</li>`;
  const priv = { GET: 'select', POST: 'insert', PUT: 'update', DELETE: 'delete' } as Record<string, string>;
  const checks = html`<ul class="checklist">
    ${check(!problem, problem ?? tx.code('ar.chk.runs_as', { role: role ?? '' }))}
    ${privs ? o.methods.map((m) => check(m === 'GET' ? privs.GET || privs.sel : privs[m], privs[m] || (m === 'GET' && privs.sel)
      ? html`${m}: ${tx.code('ar.chk.may', { role: role ?? '', priv: priv[m] })}`
      : html`${m}: ${tx.code('ar.chk.may_not', { role: role ?? '', priv: priv[m] })} — <code>grant ${priv[m]} on ${qualified(o)} to ${role};</code>`)) : ''}
    ${info && (info.kind === 'r' || info.kind === 'p') ? check(info.rls ? true : null, info.rls ? (info.policies === 1 ? tx('ar.chk.rls_on_1') : tx('ar.chk.rls_on', { n: info.policies })) : tx('ar.chk.rls_off')) : ''}
    ${info && info.kind === 'v' ? check(info.invoker, info.invoker ? tx('ar.chk.invoker') : html`${tx('ar.chk.definer')} <code>alter view ${qualified(o)} set (security_invoker = true);</code>`) : ''}
    ${info ? check(key.length ? true : null, key.length ? html`${tx('ar.chk.key', { columns: key.map((k) => k.name).join(', ') })} <code>…/${o.alias}/&lt;${key.map((k) => k.name).join(',')}&gt;</code>` : tx('ar.chk.no_key')) : ''}
    ${cols.some((c) => !c.readable) ? check(null, tx('ar.chk.hidden_columns', { columns: cols.filter((c) => !c.readable).map((c) => c.name).join(', ') })) : ''}
  </ul>`;
  const base = autoUrl(o.app_alias, o.alias);
  const keyEx = key.map((k) => `<${k.name}>`).join(',');
  const endpoints: [string, string, string][] = [];
  if (o.methods.includes('GET')) endpoints.push(['GET', base, tx('ar.ep.rows', { max: MAX_PAGE, size: o.page_size })]);
  if (o.methods.includes('POST')) endpoints.push(['POST', base, tx('ar.ep.post')]);
  if (key.length) {
    if (o.methods.includes('GET')) endpoints.push(['GET', `${base}${keyEx}`, tx('ar.ep.one')]);
    if (o.methods.includes('PUT')) endpoints.push(['PUT', `${base}${keyEx}`, tx('ar.ep.put')]);
    if (o.methods.includes('DELETE')) endpoints.push(['DELETE', `${base}${keyEx}`, tx('ar.ep.delete')]);
  }
  const auth = o.auth === 'public' ? '' : ' -H "Authorization: Bearer $TOKEN"';
  const sample = cols.filter((c) => c.readable && c.pk === null).slice(0, 2);
  const body = JSON.stringify(Object.fromEntries(sample.map((c) => [c.name, c.cat === 'N' ? 1 : c.cat === 'B' ? true : '…'])));
  const textCol = cols.find((c) => c.readable && c.cat === 'S');
  const curl = [
    o.methods.includes('GET') ? `curl "${base}?limit=10${textCol ? '&q=a' : ''}"${auth}` : '',
    o.methods.includes('GET') && key.length ? `curl ${base}1${auth}` : '',
    o.methods.includes('POST') ? `curl -X POST ${base}${auth} -H "Content-Type: application/json" -d '${body}'` : '',
    o.methods.includes('PUT') && key.length ? `curl -X PUT ${base}1${auth} -H "Content-Type: application/json" -d '${body}'` : '',
    o.methods.includes('DELETE') && key.length ? `curl -X DELETE ${base}1${auth}` : '',
  ].filter(Boolean).join('\n');
  const fetchEx = `const res = await fetch('${base}?limit=10'${o.auth === 'public' ? '' : `, {\n  headers: { Authorization: \`Bearer \${token}\` },\n}`});\nconst { items, has_more } = await res.json();`;
  const openapi = `${publicUrl()}/a/${o.app_alias}/autorest/openapi.json`;
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('rest', s)}
    <h2 class="u-mb1 wrap-anywhere">${o.schema_name}.${o.object_name} <span class="muted small">${info ? kindLabel(info.kind) : ''} · ${o.enabled ? tx('ar.enabled_l') : tx('rm.disabled_suffix')}</span></h2>
    ${errorList(problems)}
    ${!o.enabled ? html`<div class="alert alert-info" role="status">${tx('ar.disabled_alert')}</div>` : ''}
    <div class="columns">
      ${region(tx('rm.checks'), checks)}
      ${region(tx('ar.endpoints'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('rm.method')}</th><th>URL</th><th>${tx('ar.does')}</th></tr></thead><tbody>
        ${endpoints.map(([m, u, d]) => html`<tr><td data-label="${tx('rm.method')}"><code>${m}</code></td><td data-label="URL" class="wrap-anywhere"><code>${u}</code></td><td data-label="${tx('ar.does')}">${d}</td></tr>`)}</tbody></table></div>
        <p class="wrap-anywhere">OpenAPI: <a href="${openapi}" target="_blank" rel="noopener"><code>${openapi}</code></a> <span class="muted small">${tx('ar.openapi_note')}</span></p>`)}
    </div>
    ${region(tx('rm.try_it'), html`${o.auth === 'public'
      ? html`<p class="muted u-mt0">${tx('ar.public_no_token')}</p>`
      : html`<p class="muted u-mt0">${tx.rich('ar.get_token', { token: raw('<code>$TOKEN</code>'), link: raw(`<a href="${BASE}/apps/${o.app_id}/api">${esc(o.app_name)} › REST API</a>`) })}${o.roles.length ? ` ${tx('ar.caller_needs', { roles: anyOf(o.roles) })}` : ''} ${tx('ar.status_codes')}</p>`}
      <h3 class="small">cURL</h3><pre class="source wrap-pre">${curl}</pre>
      <h3 class="small">JavaScript (fetch)</h3><pre class="source wrap-pre">${fetchEx}</pre>`)}
    ${region(tx('ar.settings'), html`<form method="post" action="${PAGE}/${o.id}">${csrf(s)}
        <p class="muted u-mt0 wrap-anywhere">${tx.rich('ar.published_by', { app: raw(`<a href="${BASE}/apps/${o.app_id}">${esc(o.app_name)}</a>`), role: raw(`<code>${esc(role ?? '—')}</code>`), path: raw(`<code>/a/${esc(o.app_alias)}/autorest/${esc(o.alias)}/</code>`) })}</p>
        <div class="form-grid">
          <div class="field"><label class="label" for="f_roles">${tx('rm.roles')}</label><input id="f_roles" name="roles" value="${o.roles.join(', ')}" placeholder="${tx('ar.any_caller')}"><small class="help">${tx('ar.roles_help')}</small></div>
          <div class="field"><label class="label" for="f_page_size">${tx('rm.page_size')}</label><input id="f_page_size" name="page_size" type="number" min="1" max="${MAX_PAGE}" value="${o.page_size}"></div>
          <div class="field"><label class="label" for="f_enabled">${tx('rm.status')}</label><select id="f_enabled" name="enabled"><option value="1"${o.enabled ? raw(' selected') : ''}>${tx('rm.enabled')}</option><option value="0"${o.enabled ? '' : raw(' selected')}>${tx('rm.disabled_404')}</option></select></div>
        </div>
        ${methodChecks(o.methods)}
        ${authChoice(o.auth)}
        <div class="buttons"><button class="btn btn-hot">${tx('rm.save')}</button></div>
      </form>
      <form method="post" action="${PAGE}/${o.id}/delete" class="u-mt1">${csrf(s)}
        <button class="btn btn-danger">${icon('trash')} ${tx('ar.remove')}</button> <span class="muted small">${tx('ar.remove_help')}</span>
      </form>`)}`;
  return shell(s, `REST ${o.schema_name}.${o.object_name}`, [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.rest'), PAGE], [`${o.schema_name}.${o.object_name}`]], main, 'sql');
}

const parseObject = (v: unknown): [string, string] | null => {
  try {
    const x = JSON.parse(String(v ?? ''));
    return Array.isArray(x) && x.length === 2 && x.every((y) => typeof y === 'string') ? [x[0], x[1]] : null;
  } catch {
    return null;
  }
};

async function rowOr404(req: Req, reply: FastifyReply, s: Session) {
  const id = Number(req.params.id);
  const o = Number.isInteger(id) && id > 0 ? (await rows(s, id))[0] : undefined;
  if (!o) reply.code(404).send('Not found');
  return o;
}

export async function autoRestBuilderRoutes(app: FastifyInstance) {
  app.get(PAGE, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return send(reply, s, await listPage(s, req.query ?? {}));
  });

  // an object's ⋯ menu (REST › Enable / Disable): its page when it is published, else the Enable form for it
  app.get(`${PAGE}/object`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const q = req.query ?? {};
    const rel = await findRel(s, q.schema, q.name);
    if (!rel) return reply.code(404).send('Not found');
    const hit = (await rows(s)).find((o) => o.schema_name === rel.schema && o.object_name === rel.name);
    return reply.redirect(hit ? `${PAGE}/${hit.id}` : `${PAGE}?${new URLSearchParams({ schema: rel.schema, name: rel.name })}#enable`);
  });

  app.post(PAGE, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pick = parseObject(b.object);
    const rel = pick ? await findRel(s, pick[0], pick[1]) : undefined;
    const again = async (problems: string[]) =>
      send(reply.code(200), s, await listPage(s, { ...b, ...(rel ? { schema: rel.schema, name: rel.name } : {}) }, problems));
    if (!rel) return again([tr(s)('ar.e.choose_object')]);
    const a = (await workspaceApps(s)).find((x) => String(x.id) === String(b.app_id ?? ''));
    if (!a) return again([tr(s)('rm.e.choose_app')]);
    const alias = String(b.alias ?? '').trim() || rel.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 63);
    const problems: string[] = [];
    if (!ALIAS.test(alias)) problems.push(tr(s)('ar.e.url_name'));
    const rp = await roleProblem(tr(s), a.db_role, rel);
    if (rp) problems.push(rp);
    const { input, problems: more } = await readInput(tr(s), b, rel, a.db_role);
    problems.push(...more);
    if (problems.length) return again(problems);
    try {
      const r = await owner.one<{ id: number }>(
        `insert into meta.rest_object (app_id, schema_name, object_name, alias, methods, auth, roles, page_size, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [a.id, rel.schema, rel.name, alias, input.methods, input.auth, input.roles, input.page_size, s.username]);
      await logActivity({ appId: a.id, username: s.username, event: 'autorest', ip: clientIp(req), detail: `enabled ${rel.schema}.${rel.name} as ${alias} (${input.methods.join(', ')}, ${input.auth})` });
      flash(s, tr(s)('ar.published_at', { object: `${rel.schema}.${rel.name}`, path: `/a/${a.alias}/autorest/${alias}/` }));
      return back(reply, s, `${PAGE}/${r!.id}`);
    } catch (e) {
      const err = e as { code?: string; constraint?: string; message: string };
      if (err.code !== '23505') throw e;
      return again([/alias/.test(err.constraint ?? '') ? tr(s)('ar.e.alias_taken', { app: a.name, alias }) : tr(s)('ar.e.already', { app: a.name, object: `${rel.schema}.${rel.name}` })]);
    }
  });

  app.get(`${PAGE}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = await rowOr404(req, reply, s);
    if (!o) return;
    return send(reply, s, await detailPage(s, o));
  });

  app.post(`${PAGE}/:id`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = await rowOr404(req, reply, s);
    if (!o) return;
    const kind = (await owner.one<{ k: string }>(`select c.relkind::text as k from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`, [o.schema_name, o.object_name]))?.k ?? 'r';
    const { input, problems } = await readInput(tr(s), (req.body ?? {}) as Record<string, unknown>, { schema: o.schema_name, name: o.object_name, kind }, o.db_role);
    if (problems.length) return send(reply, s, await detailPage(s, o, problems));
    await owner.query(`update meta.rest_object set methods = $2, auth = $3, roles = $4, page_size = $5, enabled = $6, updated_at = now() where id = $1`,
      [o.id, input.methods, input.auth, input.roles, input.page_size, input.enabled]);
    await logActivity({ appId: o.app_id, username: s.username, event: 'autorest', ip: clientIp(req), detail: `changed ${o.schema_name}.${o.object_name} (${input.methods.join(', ')}, ${input.auth}${input.enabled ? '' : ', disabled'})` });
    flash(s, tr(s)('rm.saved'));
    return back(reply, s, `${PAGE}/${o.id}`);
  });

  app.post(`${PAGE}/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = await rowOr404(req, reply, s);
    if (!o) return;
    await owner.query('delete from meta.rest_object where id = $1', [o.id]);
    await logActivity({ appId: o.app_id, username: s.username, event: 'autorest', ip: clientIp(req), detail: `disabled ${o.schema_name}.${o.object_name}` });
    flash(s, tr(s)('ar.unpublished', { object: `${o.schema_name}.${o.object_name}` }));
    return back(reply, s, PAGE);
  });
}
