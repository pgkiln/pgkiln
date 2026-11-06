import type { FastifyInstance, FastifyReply } from 'fastify';
import { embedTexts, MODEL_ENGINES, vectorProviderProblems, DEFAULT_BATCH, DEFAULT_PER_MINUTE, HNSW_MAX_DIMENSIONS, type VectorProvider } from '../ai/embeddings.ts';
import { providerLabel } from '../ai/service.ts';
import { isAiError } from '../ai/types.ts';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Session } from '../session.ts';
import { clientIp, logActivity } from '../session.ts';
import { pgvectorStatus, vectorTriggers, type PgvectorStatus } from '../vector.ts';
import { devDbForApp } from '../workspace-db.ts';
import { appOr404 } from './forms.ts';
import { isAdmin } from './locks.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { currentWorkspace, inWorkspaceSql } from './workspaces.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 136, AP-1; APEX: Workspace Utilities and Shared Components → Vector Providers)
//
// Shared Components → Generative AI → Vector providers: the application's providers, a JSON list in meta.app
// (vector_providers, migration 136) exported with the application. A provider is an AI service with an embedding
// model (OpenAI text-embedding-3-*, Gemini, any OpenAI-compatible endpoint such as Ollama) or a SQL / PL/pgSQL
// function returning vector; its dimensions are shown and checked (Test embeds a sample text). The key of an AI
// service stays with the service (Workspace utilities → AI services).
//
// Workspace utilities → Vector providers: whether pgvector is installed (administrators may create it), every
// provider of the workspace's applications and the vector columns that providers keep current.

type Body = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const crumbs = (a: { id: number; name: string }, last?: string): [string, string?][] => [
  [tx('vp.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('vp.shared_components'), `${BASE}/apps/${a.id}/shared`],
  ...(last ? [[tx('vp.vector_providers'), `${BASE}/apps/${a.id}/vector-providers`], [last]] as [string, string?][] : [[tx('vp.vector_providers')]] as [string, string?][]),
];

/** pgvector's state as a short paragraph (with how to get it). */
export function pgvectorNote(st: PgvectorStatus, admin: boolean, s: Session): Raw {
  if (st.installed) return html`<p class="muted u-mt0">${icon('check')} ${tx.rich('vp.installed', { version: st.version ?? '', schema: html`<code>${st.schema}</code>` })}</p>`;
  return html`<div class="alert alert-info" role="status"><p><strong>${tx('vp.pgvector_is_not_installed_in')}</strong>
    ${tx('vp.not_installed_detail')}</p>
    ${st.available
      ? admin && st.canCreate
        ? html`<form method="post" action="${BASE}/vector-providers/extension">${csrf(s)}<button class="btn btn-hot">${icon('plus')} ${tx('vp.create_extension', { version: st.availableVersion ?? '' })}</button></form>`
        : html`<p>${tx.rich('vp.has_pgvector', { version: st.availableVersion ?? '', who: admin ? tx('vp.a_superuser') : tx('vp.an_administrator'), sql: html`<code>create extension vector;</code>` })}</p>`
      : html`<p>${tx.rich('vp.no_package', { apt: html`<code>apt install postgresql-17-pgvector</code>`, docker: html`<code>pgvector/pgvector:pg17</code>`, vector: html`<i>vector</i>` })}</p>`}
  </div>`;
}

async function servicesOf(appId: number) {
  return (await owner.query<{ name: string; provider: string; model: string }>(
    `select s.name, s.provider, s.model from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1
      where s.enabled and s.provider <> 'anthropic' order by s.name`, [appId])).rows;
}

async function providerForm(a: any, s: Session, x: Partial<VectorProvider>, original: string, problems: string[]): Promise<Raw> {
  const services = await servicesOf(a.id);
  // (151) a model in the database: is PostgresML there?
  const pgml = !!(await (await devDbForApp(a.id)).query(`select to_regprocedure('pgml.embed(text, text, jsonb)') is not null as ok`)).rows[0]?.ok;
  const svc: [string, string][] = [['', '-'], ...services.map((v): [string, string] => [v.name, `${v.name} (${providerLabel(v.provider)})`])];
  if (x.service && !services.some((v) => v.name === x.service)) svc.push([x.service, `${x.service} (not available to this application)`]);
  const configs = original
    ? (await owner.query<{ id: number; name: string; search_type: string }>(`select id, name, search_type from meta.search_config where app_id = $1 and vector_provider = $2 order by name`, [a.id, original])).rows
    : [];
  const columns = original ? (await vectorTriggers(await devDbForApp(a.id))).filter((t) => t.appId === a.id && t.provider === original) : [];
  return html`${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    <form method="post" action="${BASE}/apps/${a.id}/vector-providers/provider">${csrf(s)}<input type="hidden" name="original" value="${original}">
      <fieldset class="prop-group"><legend>${tx('vp.vector_provider')}</legend><div class="form-grid">
        ${input('name', tx('vp.name_static_id'), x.name ?? '', { required: true, placeholder: tx('vp.e_g_doc_embeddings'), help: tx('vp.upper_case_letters_digits_and') })}
        ${input('description', tx('vp.description'), x.description ?? '')}
        ${select('type', tx('vp.type'), x.type ?? 'ai_service', [['ai_service', tx('vp.ai_service_with_an_embedding')], ['database_model', tx('vp.model_in_the_database_postgresml')], ['function', tx('vp.sql_or_pl_pgsql_function')]], tx('vp.where_the_embeddings_come_from'))}
        ${input('dimensions', tx('vp.dimensions'), x.dimensions ?? '', { type: 'number', required: true, placeholder: tx('vp.eg_1536'), help: tx('vp.dimensions_help', { max: HNSW_MAX_DIMENSIONS }) })}
      </div></fieldset>
      <fieldset class="prop-group"><legend>${tx('vp.ai_service')}</legend><div class="form-grid">
        ${services.length ? '' : html`<p class="muted" data-wide>${tx.rich('vp.no_service', { link: html`<a href="${BASE}/ai">${tx('vp.workspace_utilities_ai_services')}</a>` })}</p>`}
        ${select('service', tx('vp.ai_service'), x.service ?? '', svc, tx('vp.its_key_base_url_and'))}
        ${input('model', tx('vp.embedding_model'), x.model ?? '', { placeholder: tx('vp.e_g_text_embedding_3'), help: tx('vp.exactly_as_the_provider_names') })}
        ${input('batch_size', tx('vp.texts_per_request'), x.batch_size ?? '', { type: 'number', placeholder: String(DEFAULT_BATCH), help: tx('vp.when_the_server_embeds_queued') })}
        ${input('per_minute', tx('vp.requests_per_minute'), x.per_minute ?? '', { type: 'number', placeholder: String(DEFAULT_PER_MINUTE), help: tx('vp.at_most_this_many_background') })}
      </div></fieldset>
      <fieldset class="prop-group"><legend>${tx('vp.model_in_the_database')}</legend><div class="form-grid">
        ${pgml ? '' : html`<p class="muted" data-wide>${tx.rich('vp.no_pgml', { pgml: html`<code>pgml</code>`, sql: html`<code>create extension pgml;</code>` })}</p>`}
        ${select('engine', tx('vp.engine'), x.engine ?? 'pgml', MODEL_ENGINES.map((e): [string, string] => [e, e === 'pgml' ? tx('vp.postgresml_pgml_embed_model_text') : e]), tx('vp.the_extension_that_runs_the'))}
        ${input('db_model', tx('vp.model'), x.type === 'database_model' ? (x.model ?? '') : '', { placeholder: tx('vp.e_g_intfloat_e5_small'), help: tx('vp.a_model_the_engine_loads') })}
      </div></fieldset>
      <fieldset class="prop-group"><legend>${tx('vp.function')}</legend><div class="form-grid">
        ${input('function', tx('vp.function'), x.function ?? '', { placeholder: tx('vp.e_g_sales_embed'), help: tx('vp.schema_name_of_a_function') })}
      </div></fieldset>
      <div class="buttons"><button class="btn btn-hot">${original ? tx('vp.save') : tx('vp.add_vector_provider')}</button></div>
    </form>
    ${original ? html`
      <form method="post" action="${BASE}/apps/${a.id}/vector-providers/test" class="u-mt1">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn">${icon('play')} ${tx('vp.test_embed_a_sample_text')}</button></form>
      <h3>${tx('vp.used_by')}</h3>
      ${configs.length || columns.length ? html`<ul>
        ${configs.map((c) => html`<li>${tx.rich('vp.used_config', { link: html`<a href="${BASE}/apps/${a.id}/shared?c=search_config-${c.id}">${c.name}</a>`, type: c.search_type })}</li>`)}
        ${columns.map((c) => html`<li>${tx.rich('vp.used_column', { link: html`<a href="${BASE}/sql/objects/vector?${new URLSearchParams({ o: c.table })}"><code>${c.table}.${c.vectorColumn}</code></a>`, mode: c.mode === 'set' ? tx('vp.set_by_trigger') : tx('vp.queued_server') })}</li>`)}
      </ul>` : html`<p class="muted">${tx('vp.no_search_configuration_or_vector')}</p>`}
      <form method="post" action="${BASE}/apps/${a.id}/vector-providers/provider/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn btn-danger" data-confirm="${tx('vp.delete_confirm', { name: original })}">${tx('vp.delete_vector_provider')}</button></form>` : ''}`;
}

const intOrUndef = (v: string, what: string, errors: string[]) => {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isInteger(n)) errors.push(tx('vp.whole_number', { what }));
  return n;
};

function providerFrom(b: Body, errors: string[]): VectorProvider {
  const type = one(b.type) as VectorProvider['type'];
  const x: VectorProvider = { name: one(b.name).trim().toUpperCase(), type, dimensions: intOrUndef(one(b.dimensions), tx('vp.f_dimensions'), errors) ?? 0 };
  const description = one(b.description).trim().slice(0, 500);
  if (description) x.description = description;
  if (type === 'ai_service') {
    x.service = one(b.service).trim().toUpperCase();
    x.model = one(b.model).trim();
    const batch = intOrUndef(one(b.batch_size), tx('vp.f_batch'), errors);
    if (batch !== undefined) x.batch_size = batch;
    const pm = intOrUndef(one(b.per_minute), tx('vp.f_per_minute'), errors);
    if (pm !== undefined) x.per_minute = pm;
  }
  if (type === 'function') x.function = one(b.function).trim();
  if (type === 'database_model') {
    x.engine = one(b.engine).trim() as VectorProvider['engine'];
    x.model = one(b.db_model).trim();
  }
  return x;
}

/** Change the application's list in one transaction (row locked); `change` returns problems to refuse with. */
async function update(appId: number, change: (list: VectorProvider[]) => string[] | Promise<string[]>) {
  return owner.tx(async (c) => {
    const row = (await c.query<{ vector_providers: VectorProvider[] }>('select vector_providers from meta.app where id = $1 for update', [appId])).rows[0];
    const list = [...(row?.vector_providers ?? [])];
    const problems = await change(list);
    if (problems.length) return problems;
    await c.query('update meta.app set vector_providers = $2, updated_at = now() where id = $1', [appId, JSON.stringify(list)]);
    return [];
  });
}

export async function vectorProviderRoutes(app: FastifyInstance) {
  const load = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return null;
    const a = await appOr404(req.params.id);
    if (!a) {
      reply.code(404).send('Not found');
      return null;
    }
    return { s, a };
  };

  app.get(`${BASE}/apps/:id(^\\d+$)/vector-providers`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const list = (a.vector_providers ?? []) as VectorProvider[];
    const st = await pgvectorStatus(await devDbForApp(a.id));
    const main = html`${appHeader(a, 'shared', s)}
      <div class="title-row"><h1>${tx('vp.vector_providers')}</h1></div>
      <p class="muted u-mt0">${tx('vp.a_vector_provider_turns_text')}</p>
      ${pgvectorNote(st, await isAdmin(s.username), s)}
      ${region(tx('vp.providers'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('vp.name')}</th><th>${tx('vp.type')}</th><th>${tx('vp.model_or_function')}</th><th class="num">${tx('vp.dimensions')}</th></tr></thead>
        <tbody>${list.length ? list.map((p) => html`<tr><td data-label="${tx('vp.name')}"><a href="${BASE}/apps/${a.id}/vector-providers/provider?name=${encodeURIComponent(p.name)}">${p.name}</a>${p.description ? html` <span class="muted">${p.description}</span>` : ''}</td>
          <td data-label="${tx('vp.type')}">${p.type === 'ai_service' ? html`AI service ${p.service}` : p.type === 'database_model' ? `in the database (${p.engine})` : 'function'}</td><td data-label="${tx('vp.model_or_function')}"><code>${p.type === 'function' ? p.function : p.model}</code></td>
          <td class="num" data-label="${tx('vp.dimensions')}">${p.dimensions}</td></tr>`)
          : html`<tr><td colspan="4" class="empty">${tx('vp.no_vector_providers_yet')}</td></tr>`}</tbody></table></div>
        <p><a class="btn" href="${BASE}/apps/${a.id}/vector-providers/provider">${icon('plus')} ${tx('vp.add_vector_provider')}</a></p>`)}`;
    return send(reply, s, shell(s, tx('vp.vector_providers'), crumbs(a), main));
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/vector-providers/provider`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = String((req.query as Record<string, unknown>)?.name ?? '').toUpperCase();
    const x = name ? ((a.vector_providers ?? []) as VectorProvider[]).find((p) => p.name === name) : {};
    if (!x) return reply.code(404).send('Not found');
    const title = name || 'New vector provider';
    const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${title}</h1></div>${region(tx('vp.vector_provider'), await providerForm(a, s, x, name, []))}`;
    return send(reply, s, shell(s, title, crumbs(a, title), main));
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/vector-providers/provider`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const b = (req.body ?? {}) as Body;
    const original = one(b.original).toUpperCase();
    const errors: string[] = [];
    const x = providerFrom(b, errors);
    const problems = errors.length ? errors : await update(a.id, (list) => {
      const out = vectorProviderProblems(x);
      const at = original ? list.findIndex((p) => p.name === original) : -1;
      if (original && at < 0) out.push(tx('vp.gone', { name: original }));
      if (list.some((p, i) => p.name === x.name && i !== at)) out.push(tx('vp.exists', { name: x.name }));
      if (out.length) return out;
      if (at >= 0) list[at] = x;
      else list.push(x);
      return [];
    });
    if (problems.length) {
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${original || 'New vector provider'}</h1></div>${region(tx('vp.vector_provider'), await providerForm(a, s, x, original, problems))}`;
      return send(reply.code(422), s, shell(s, original || 'New vector provider', crumbs(a, original || 'New vector provider'), main));
    }
    // a renamed provider keeps its search configurations
    if (original && original !== x.name) await owner.query('update meta.search_config set vector_provider = $3 where app_id = $1 and vector_provider = $2', [a.id, original, x.name]);
    flash(s, tx('vp.vector_provider_saved'));
    return back(reply, s, `${BASE}/apps/${a.id}/vector-providers/provider?name=${encodeURIComponent(x.name)}`);
  });

  app.post(`${BASE}/apps/:id(^\\d+$)/vector-providers/provider/delete`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = one((req.body as Body)?.name).toUpperCase();
    await update(a.id, (list) => {
      const at = list.findIndex((p) => p.name === name);
      if (at >= 0) list.splice(at, 1);
      return [];
    });
    flash(s, tx('vp.deleted', { name }));
    return back(reply, s, `${BASE}/apps/${a.id}/vector-providers`);
  });

  // Test: embed a sample text (an AI service: one request, logged under AI usage; a function: as the developer connection)
  app.post(`${BASE}/apps/:id(^\\d+$)/vector-providers/test`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = one((req.body as Body)?.name).toUpperCase();
    const p = ((a.vector_providers ?? []) as VectorProvider[]).find((x) => x.name === name);
    if (!p) return reply.code(404).send('Not found');
    const problems = vectorProviderProblems(p);
    const to = `${BASE}/apps/${a.id}/vector-providers/provider?name=${encodeURIComponent(name)}`;
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, to);
    }
    const t0 = performance.now();
    try {
      const [v] = await embedTexts(p, [tx('vp.the_quick_brown_fox_jumps')], { appId: a.id, user: s.username, pageNo: null }, await devDbForApp(a.id));
      flash(s, `${name} answered in ${Math.round(performance.now() - t0)} ms with ${v.length} dimensions, as the provider says: [${v.slice(0, 4).map((n) => n.toFixed(4)).join(', ')}, …].`);
    } catch (e) {
      flash(s, `${name}: ${isAiError(e) ? e.message : (e as Error).message}`, 'error');
    }
    return back(reply, s, to);
  });

  // ---------------------------------------------------------------- Workspace utilities → Vector providers

  app.get(`${BASE}/vector-providers`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const admin = await isAdmin(s.username);
    const st = await pgvectorStatus(owner);
    const apps = (await owner.query<{ id: number; name: string; alias: string; vector_providers: VectorProvider[] }>(
      `select id, name, alias, vector_providers from meta.app a where ${inWorkspaceSql('a', 1)} and jsonb_array_length(vector_providers) > 0 order by name`, [currentWorkspace(s)])).rows;
    const ids = new Set(apps.map((x) => x.id));
    const columns = st.installed ? (await vectorTriggers(owner)).filter((t) => ids.has(t.appId)) : [];
    const rows = apps.flatMap((x) => x.vector_providers.map((p) => ({ app: x, p })));
    const main = html`<div class="title-row"><h1>${tx('vp.vector_providers')}</h1></div>
      <p class="muted u-mt0">${tx('vp.the_vector_providers_of_this')}</p>
      ${pgvectorNote(st, admin, s)}
      ${region(tx('vp.providers'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('vp.application')}</th><th>${tx('vp.name')}</th><th>${tx('vp.type')}</th><th>${tx('vp.model_or_function')}</th><th class="num">${tx('vp.dimensions')}</th></tr></thead>
        <tbody>${rows.length ? rows.map(({ app: x, p }) => html`<tr><td data-label="${tx('vp.application')}">${x.name}</td>
          <td data-label="${tx('vp.name')}"><a href="${BASE}/apps/${x.id}/vector-providers/provider?name=${encodeURIComponent(p.name)}">${p.name}</a></td>
          <td data-label="${tx('vp.type')}">${p.type === 'ai_service' ? html`AI service ${p.service}` : p.type === 'database_model' ? `in the database (${p.engine})` : 'function'}</td><td data-label="${tx('vp.model_or_function')}"><code>${p.type === 'function' ? p.function : p.model}</code></td>
          <td class="num" data-label="${tx('vp.dimensions')}">${p.dimensions}</td></tr>`)
          : html`<tr><td colspan="5" class="empty">${tx('vp.no_vector_providers_yet')}</td></tr>`}</tbody></table></div>`)}
      ${region(tx('vp.vector_columns'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('vp.column')}</th><th>${tx('vp.provider')}</th><th>${tx('vp.source_columns')}</th><th>${tx('vp.kept_by')}</th></tr></thead>
        <tbody>${columns.length ? columns.map((c) => html`<tr><td data-label="${tx('vp.column')}"><a href="${BASE}/sql/objects/vector?${new URLSearchParams({ o: c.table })}"><code>${c.table}.${c.vectorColumn}</code></a></td>
          <td data-label="${tx('vp.provider')}">${c.provider}</td><td data-label="${tx('vp.source_columns')}">${c.sourceColumns.join(', ')}</td><td data-label="${tx('vp.kept_by')}">${c.mode === 'set' ? 'a trigger' : 'the server\'s queue'}</td></tr>`)
          : html`<tr><td colspan="4" class="empty">${tx('vp.no_vector_columns_yet_sql')}</td></tr>`}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, tx('vp.vector_providers'), [[tx('vp.app_builder'), BASE], [tx('vp.workspace_utilities'), `${BASE}/utilities`], [tx('vp.vector_providers')]], main));
  });

  // administrators: create extension vector (pgvector is not a trusted extension: the owner connection must be a superuser)
  app.post(`${BASE}/vector-providers/extension`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators create extensions.');
    try {
      await owner.query('create extension if not exists vector');
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: 'create extension if not exists vector' });
      flash(s, tx('vp.the_pgvector_extension_is_installed'));
    } catch (e) {
      flash(s, `create extension vector failed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, `${BASE}/vector-providers`);
  });
}

export const vectorProviderOptions = async (appId: number) =>
  (((await owner.one<{ vector_providers: VectorProvider[] }>('select vector_providers from meta.app where id = $1', [appId]))?.vector_providers ?? []) as VectorProvider[]);
