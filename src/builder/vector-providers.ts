import type { FastifyInstance, FastifyReply } from 'fastify';
import { embedTexts, vectorProviderProblems, DEFAULT_BATCH, DEFAULT_PER_MINUTE, HNSW_MAX_DIMENSIONS, type VectorProvider } from '../ai/embeddings.ts';
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
  ['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`],
  ...(last ? [['Vector providers', `${BASE}/apps/${a.id}/vector-providers`], [last]] as [string, string?][] : [['Vector providers']] as [string, string?][]),
];

/** pgvector's state as a short paragraph (with how to get it). */
export function pgvectorNote(st: PgvectorStatus, admin: boolean, s: Session): Raw {
  if (st.installed) return html`<p class="muted u-mt0">${icon('check')} pgvector ${st.version} is installed (schema <code>${st.schema}</code>).</p>`;
  return html`<div class="alert alert-info" role="status"><p><strong>pgvector is not installed in this database.</strong>
    Vector providers can be defined, but vector columns, vector search and Retrieve tools need the extension.</p>
    ${st.available
      ? admin && st.canCreate
        ? html`<form method="post" action="${BASE}/vector-providers/extension">${csrf(s)}<button class="btn btn-hot">${icon('plus')} Create extension vector ${st.availableVersion}</button></form>`
        : html`<p>The database server has pgvector ${st.availableVersion}: ${admin ? 'a superuser' : 'an administrator'} runs <code>create extension vector;</code> in this database.</p>`
      : html`<p>The database server doesn't have the pgvector package: install it (for example <code>apt install postgresql-17-pgvector</code>, the <code>pgvector/pgvector:pg17</code> Docker image, or your cloud provider's <i>vector</i> extension), then create the extension.</p>`}
  </div>`;
}

async function servicesOf(appId: number) {
  return (await owner.query<{ name: string; provider: string; model: string }>(
    `select s.name, s.provider, s.model from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1
      where s.enabled and s.provider <> 'anthropic' order by s.name`, [appId])).rows;
}

async function providerForm(a: any, s: Session, x: Partial<VectorProvider>, original: string, problems: string[]): Promise<Raw> {
  const services = await servicesOf(a.id);
  const svc: [string, string][] = [['', '-'], ...services.map((v): [string, string] => [v.name, `${v.name} (${providerLabel(v.provider)})`])];
  if (x.service && !services.some((v) => v.name === x.service)) svc.push([x.service, `${x.service} (not available to this application)`]);
  const configs = original
    ? (await owner.query<{ id: number; name: string; search_type: string }>(`select id, name, search_type from meta.search_config where app_id = $1 and vector_provider = $2 order by name`, [a.id, original])).rows
    : [];
  const columns = original ? (await vectorTriggers(await devDbForApp(a.id))).filter((t) => t.appId === a.id && t.provider === original) : [];
  return html`${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    <form method="post" action="${BASE}/apps/${a.id}/vector-providers/provider">${csrf(s)}<input type="hidden" name="original" value="${original}">
      <fieldset class="prop-group"><legend>Vector provider</legend><div class="form-grid">
        ${input('name', 'Name (static ID)', x.name ?? '', { required: true, placeholder: 'e.g. DOC_EMBEDDINGS', help: 'Upper case letters, digits and _. Search configurations name it; in SQL: meta.embed(text, \'DOC_EMBEDDINGS\') (function providers).' })}
        ${input('description', 'Description', x.description ?? '')}
        ${select('type', 'Type', x.type ?? 'ai_service', [['ai_service', 'AI service with an embedding model'], ['function', 'SQL or PL/pgSQL function']], 'Where the embeddings come from.')}
        ${input('dimensions', 'Dimensions', x.dimensions ?? '', { type: 'number', required: true, placeholder: 'e.g. 1536', help: `The length of each vector: text-embedding-3-small 1536 (or fewer: OpenAI shortens them), text-embedding-3-large 3072, nomic-embed-text 768, gemini-embedding-001 3072. A vector column is vector(n) with this n; an HNSW index takes up to ${HNSW_MAX_DIMENSIONS}.` })}
      </div></fieldset>
      <fieldset class="prop-group"><legend>AI service</legend><div class="form-grid">
        ${services.length ? '' : html`<p class="muted" data-wide>This application may not use an OpenAI, Gemini or OpenAI-compatible AI service yet: an administrator adds one under <a href="${BASE}/ai">Workspace utilities → AI services</a> (Claude has no embeddings) and allows this application to use it.</p>`}
        ${select('service', 'AI service', x.service ?? '', svc, 'Its key, base URL and daily limits apply; the texts to embed go to its provider.')}
        ${input('model', 'Embedding model', x.model ?? '', { placeholder: 'e.g. text-embedding-3-small', help: 'Exactly as the provider names it: text-embedding-3-small, gemini-embedding-001, nomic-embed-text, mxbai-embed-large …' })}
        ${input('batch_size', 'Texts per request', x.batch_size ?? '', { type: 'number', placeholder: String(DEFAULT_BATCH), help: 'When the server embeds queued rows (vector columns).' })}
        ${input('per_minute', 'Requests per minute', x.per_minute ?? '', { type: 'number', placeholder: String(DEFAULT_PER_MINUTE), help: 'At most this many background requests per minute (per server), under the provider\'s rate limit.' })}
      </div></fieldset>
      <fieldset class="prop-group"><legend>Function</legend><div class="form-grid">
        ${input('function', 'Function', x.function ?? '', { placeholder: 'e.g. sales.embed', help: 'schema.name of a function (text) returning vector, real[] or float8[]. meta.embed calls it as the role that runs the query (its grants apply): grant execute on it to the application\'s role.' })}
      </div></fieldset>
      <div class="buttons"><button class="btn btn-hot">${original ? 'Save' : 'Add vector provider'}</button></div>
    </form>
    ${original ? html`
      <form method="post" action="${BASE}/apps/${a.id}/vector-providers/test" class="u-mt1">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn">${icon('play')} Test: embed a sample text</button></form>
      <h3>Used by</h3>
      ${configs.length || columns.length ? html`<ul>
        ${configs.map((c) => html`<li>Search configuration <a href="${BASE}/apps/${a.id}/shared?c=search_config-${c.id}">${c.name}</a> (${c.search_type})</li>`)}
        ${columns.map((c) => html`<li>Vector column <a href="${BASE}/sql/objects/vector?${new URLSearchParams({ o: c.table })}"><code>${c.table}.${c.vectorColumn}</code></a> (${c.mode === 'set' ? 'set by a trigger' : 'queued for the server'})</li>`)}
      </ul>` : html`<p class="muted">No search configuration or vector column uses this provider yet.</p>`}
      <form method="post" action="${BASE}/apps/${a.id}/vector-providers/provider/delete" class="danger-zone">${csrf(s)}<input type="hidden" name="name" value="${original}">
        <button class="btn btn-danger" data-confirm="Delete vector provider ${original}? Search configurations and vector columns that use it stop working.">Delete vector provider</button></form>` : ''}`;
}

const intOrUndef = (v: string, what: string, errors: string[]) => {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isInteger(n)) errors.push(`${what} is a whole number.`);
  return n;
};

function providerFrom(b: Body, errors: string[]): VectorProvider {
  const type = one(b.type) as VectorProvider['type'];
  const x: VectorProvider = { name: one(b.name).trim().toUpperCase(), type, dimensions: intOrUndef(one(b.dimensions), 'Dimensions', errors) ?? 0 };
  const description = one(b.description).trim().slice(0, 500);
  if (description) x.description = description;
  if (type === 'ai_service') {
    x.service = one(b.service).trim().toUpperCase();
    x.model = one(b.model).trim();
    const batch = intOrUndef(one(b.batch_size), 'Texts per request', errors);
    if (batch !== undefined) x.batch_size = batch;
    const pm = intOrUndef(one(b.per_minute), 'Requests per minute', errors);
    if (pm !== undefined) x.per_minute = pm;
  }
  if (type === 'function') x.function = one(b.function).trim();
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
      <div class="title-row"><h1>Vector providers</h1></div>
      <p class="muted u-mt0">A vector provider turns text into an embedding: a list of numbers whose distance says how close two texts are in meaning. Vector columns keep the embeddings of a table's rows (SQL Workshop › Table Properties › Add vector column), and search configurations of type vector or hybrid, and the Retrieve tools of AI agents, find rows by meaning. The texts go to the provider's AI service.</p>
      ${pgvectorNote(st, await isAdmin(s.username), s)}
      ${region('Providers', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Name</th><th>Type</th><th>Model or function</th><th class="num">Dimensions</th></tr></thead>
        <tbody>${list.length ? list.map((p) => html`<tr><td data-label="Name"><a href="${BASE}/apps/${a.id}/vector-providers/provider?name=${encodeURIComponent(p.name)}">${p.name}</a>${p.description ? html` <span class="muted">${p.description}</span>` : ''}</td>
          <td data-label="Type">${p.type === 'ai_service' ? html`AI service ${p.service}` : 'function'}</td><td data-label="Model or function"><code>${p.type === 'ai_service' ? p.model : p.function}</code></td>
          <td class="num" data-label="Dimensions">${p.dimensions}</td></tr>`)
          : html`<tr><td colspan="4" class="empty">No vector providers yet.</td></tr>`}</tbody></table></div>
        <p><a class="btn" href="${BASE}/apps/${a.id}/vector-providers/provider">${icon('plus')} Add vector provider</a></p>`)}`;
    return send(reply, s, shell(s, 'Vector providers', crumbs(a), main));
  });

  app.get(`${BASE}/apps/:id(^\\d+$)/vector-providers/provider`, async (req: Req, reply) => {
    const ok = await load(req, reply);
    if (!ok) return;
    const { s, a } = ok;
    const name = String((req.query as Record<string, unknown>)?.name ?? '').toUpperCase();
    const x = name ? ((a.vector_providers ?? []) as VectorProvider[]).find((p) => p.name === name) : {};
    if (!x) return reply.code(404).send('Not found');
    const title = name || 'New vector provider';
    const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${title}</h1></div>${region('Vector provider', await providerForm(a, s, x, name, []))}`;
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
      if (original && at < 0) out.push(`Vector provider ${original} no longer exists.`);
      if (list.some((p, i) => p.name === x.name && i !== at)) out.push(`A vector provider ${x.name} exists already.`);
      if (out.length) return out;
      if (at >= 0) list[at] = x;
      else list.push(x);
      return [];
    });
    if (problems.length) {
      const main = html`${appHeader(a, 'shared', s)}<div class="title-row"><h1 class="ai-name">${original || 'New vector provider'}</h1></div>${region('Vector provider', await providerForm(a, s, x, original, problems))}`;
      return send(reply.code(422), s, shell(s, original || 'New vector provider', crumbs(a, original || 'New vector provider'), main));
    }
    // a renamed provider keeps its search configurations
    if (original && original !== x.name) await owner.query('update meta.search_config set vector_provider = $3 where app_id = $1 and vector_provider = $2', [a.id, original, x.name]);
    flash(s, 'Vector provider saved.');
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
    flash(s, `Vector provider ${name} deleted.`);
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
      const [v] = await embedTexts(p, ['The quick brown fox jumps over the lazy dog.'], { appId: a.id, user: s.username, pageNo: null }, await devDbForApp(a.id));
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
    const main = html`<div class="title-row"><h1>Vector providers</h1></div>
      <p class="muted u-mt0">The vector providers of this workspace's applications (each application defines its own under Shared Components → Vector providers), and the vector columns they keep current.</p>
      ${pgvectorNote(st, admin, s)}
      ${region('Providers', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Application</th><th>Name</th><th>Type</th><th>Model or function</th><th class="num">Dimensions</th></tr></thead>
        <tbody>${rows.length ? rows.map(({ app: x, p }) => html`<tr><td data-label="Application">${x.name}</td>
          <td data-label="Name"><a href="${BASE}/apps/${x.id}/vector-providers/provider?name=${encodeURIComponent(p.name)}">${p.name}</a></td>
          <td data-label="Type">${p.type === 'ai_service' ? html`AI service ${p.service}` : 'function'}</td><td data-label="Model or function"><code>${p.type === 'ai_service' ? p.model : p.function}</code></td>
          <td class="num" data-label="Dimensions">${p.dimensions}</td></tr>`)
          : html`<tr><td colspan="5" class="empty">No vector providers yet.</td></tr>`}</tbody></table></div>`)}
      ${region('Vector columns', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Column</th><th>Provider</th><th>Source columns</th><th>Kept by</th></tr></thead>
        <tbody>${columns.length ? columns.map((c) => html`<tr><td data-label="Column"><a href="${BASE}/sql/objects/vector?${new URLSearchParams({ o: c.table })}"><code>${c.table}.${c.vectorColumn}</code></a></td>
          <td data-label="Provider">${c.provider}</td><td data-label="Source columns">${c.sourceColumns.join(', ')}</td><td data-label="Kept by">${c.mode === 'set' ? 'a trigger' : 'the server\'s queue'}</td></tr>`)
          : html`<tr><td colspan="4" class="empty">No vector columns yet (SQL Workshop › Table Properties › Add vector column).</td></tr>`}</tbody></table></div>`)}`;
    return send(reply, s, shell(s, 'Vector providers', [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Vector providers']], main));
  });

  // administrators: create extension vector (pgvector is not a trusted extension: the owner connection must be a superuser)
  app.post(`${BASE}/vector-providers/extension`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    if (!(await isAdmin(s.username))) return reply.code(403).send('Only administrators create extensions.');
    try {
      await owner.query('create extension if not exists vector');
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: 'create extension if not exists vector' });
      flash(s, 'The pgvector extension is installed.');
    } catch (e) {
      flash(s, `create extension vector failed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, `${BASE}/vector-providers`);
  });
}

export const vectorProviderOptions = async (appId: number) =>
  (((await owner.one<{ vector_providers: VectorProvider[] }>('select vector_providers from meta.app where id = $1', [appId]))?.vector_providers ?? []) as VectorProvider[]);
