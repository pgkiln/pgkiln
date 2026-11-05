import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { embedsInDatabase, HNSW_MAX_DIMENSIONS, vectorProviderProblems, type VectorProvider } from '../ai/embeddings.ts';
import { joinStatements, recordChanges } from '../changelog.ts';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { readTable } from '../tabledef.ts';
import { backfill, DISTANCES, isDistance, kickEmbeddings, pgvectorStatus, queueState, vectorTriggers, type Distance } from '../vector.ts';
import { clearCompletions } from './code-editor.ts';
import { tr } from './i18n.ts';
import { isAdmin } from './locks.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { back, BASE, csrf, developer, flash, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { appAllowed, currentWorkspace, inWorkspaceSql, usableSchemas, workshopDb } from './workspaces.ts';

// (sprint 136, AP-1) SQL Workshop › Table Properties › Add vector column: an embedding column vector(n) (n: the
// chosen vector provider's dimensions), an HNSW index for the distance (vector_cosine_ops …), and a trigger that
// keeps it current when the source columns change:
//  - a function provider: BEFORE INSERT OR UPDATE OF … → meta.embedding_set (the embedding at once);
//  - an AI service (or a function, if chosen): AFTER INSERT OR UPDATE OF … → meta.embedding_enqueue (the row's key
//    queued; the server embeds queued rows in batches, src/vector.ts).
// Preview DDL shows the statements; Apply runs them in one transaction with the workshop's connection and records
// them in the Change Log; Open in the worksheet puts them there. The page also lists the table's vector columns
// with their progress (rows embedded, queued, failing) and a Backfill button that queues the rows without an
// embedding (or all rows). Names come from the catalog or are checked as plain identifiers before they reach DDL.

type Db = Awaited<ReturnType<typeof workshopDb>>;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : pg.escapeIdentifier(n));

interface Col { name: string; type: string; texty: boolean; dims: number | null; vector: boolean }

async function columnsOf(db: Db, oid: number): Promise<Col[]> {
  return (await db.query<Col>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typcategory = 'S' and a.attgenerated = '' as texty,
            t.typname = 'vector' as vector, case when t.typname = 'vector' and a.atttypmod > 0 then a.atttypmod end as dims
       from pg_attribute a join pg_type t on t.oid = a.atttypid
      where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [oid])).rows;
}

/** The single-column primary key of a table (the queue keys rows by it), or null. */
async function keyOf(db: Db, oid: number) {
  return (await db.one<{ k: string }>(
    `select a.attname as k from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = $1 and i.indisprimary and i.indnatts = 1`, [oid]))?.k ?? null;
}

/** The workspace's applications' vector providers, as options "appId:NAME". */
async function providerChoices(s: Parameters<typeof currentWorkspace>[0]) {
  const apps = (await owner.query<{ id: number; alias: string; vector_providers: VectorProvider[] }>(
    `select id, alias, vector_providers from meta.app a where ${inWorkspaceSql('a', 1)} and jsonb_array_length(vector_providers) > 0 order by alias`, [currentWorkspace(s)])).rows;
  return apps.flatMap((a) => a.vector_providers.filter((p) => !vectorProviderProblems(p).length).map((p) => ({ key: `${a.id}:${p.name}`, appId: a.id, alias: a.alias, p })));
}

/** The statements: the column, its HNSW index (up to 2,000 dimensions) and the trigger that keeps it. */
export function vectorDdl(o: { table: string; vectorType: string; column: string; index: string; trigger: string; dims: number; distance: Distance; mode: 'set' | 'queue'; appId: number; provider: string; key: string; sources: string[] }) {
  const args = [String(o.appId), o.provider, o.column, o.key, ...o.sources].map((x) => pg.escapeLiteral(x)).join(', ');
  return [
    `alter table ${o.table}\n  add column ${ident(o.column)} ${o.vectorType}(${o.dims})`,
    ...(o.dims <= HNSW_MAX_DIMENSIONS ? [`create index ${ident(o.index)} on ${o.table} using hnsw (${ident(o.column)} ${DISTANCES[o.distance].opclass})`] : []),
    o.mode === 'set'
      ? `create trigger ${ident(o.trigger)}\n  before insert or update of ${o.sources.map(ident).join(', ')} on ${o.table}\n  for each row execute function meta.embedding_set(${args})`
      : `create trigger ${ident(o.trigger)}\n  after insert or update of ${o.sources.map(ident).join(', ')} on ${o.table}\n  for each row execute function meta.embedding_enqueue(${args})`,
  ];
}

async function page(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const tx = tr(s);
  const db = await workshopDb(s);
  const isPost = req.method === 'POST';
  const b: Body = (isPost ? req.body : req.query) ?? {};
  const ref = String(b.o ?? '');
  const t = ref ? await readTable(db, ref) : null;
  const schemas = (await usableSchemas(db)).filter((n) => !SYSTEM_SCHEMAS.includes(n));
  if (!t || !schemas.includes(t.schema)) return reply.code(404).send('Not found');
  const table = `${ident(t.schema)}.${ident(t.name)}`;
  const self = `${BASE}/sql/objects/vector?${new URLSearchParams({ o: table })}`;
  const oid = (await db.one<{ oid: number }>('select $1::regclass::oid as oid', [table]))!.oid;
  const st = await pgvectorStatus(db);
  const cols = await columnsOf(db, oid);
  const texty = cols.filter((c) => c.texty);
  const key = await keyOf(db, oid);
  const choices = await providerChoices(s);
  const triggers = st.installed ? await vectorTriggers(db, table) : [];

  // Backfill: queue the rows of a vector column that have no embedding (or all of them)
  if (isPost && b.mode === 'backfill') {
    const trg = triggers.find((x) => x.vectorColumn === String(b.column ?? ''));
    if (!trg || !(await appAllowed(s, trg.appId))) return reply.code(404).send('Not found');
    const n = await backfill(db, trg, b.all === 'on');
    kickEmbeddings();
    flash(s, tx('vec.backfill_queued', { n: String(n), column: trg.vectorColumn }));
    return back(reply, s, self);
  }

  const pick = choices.find((c) => c.key === String(b.provider ?? '')) ?? (isPost ? undefined : choices[0]);
  const column = isPost ? String(b.column ?? '').trim() : cols.some((c) => c.name === 'embedding') ? '' : 'embedding';
  const base = t.name.replace(/[^a-z0-9_]+/gi, '_').toLowerCase().slice(0, 40);
  const index = isPost ? String(b.index ?? '').trim() : `${base}_${column || 'embedding'}_idx`;
  const distance: Distance = isDistance(b.distance) ? b.distance : 'cosine';
  const mode: 'set' | 'queue' = pick && embedsInDatabase(pick.p) && (isPost ? b.keep === 'set' : true) ? 'set' : 'queue';
  const picked = new Set<string>();
  if (isPost) texty.forEach((c, i) => b[`c.${i}.use`] === 'on' && b[`c.${i}.name`] === c.name && picked.add(c.name));
  else texty.forEach((c) => picked.add(c.name));

  const errors: string[] = [];
  let ddl: string[] = [];
  let output: Raw | '' = '';
  if (isPost && st.installed) {
    if (!pick) errors.push(tx('vec.pick_provider'));
    if (!picked.size) errors.push(tx('fts.pick'));
    if (!key) errors.push(tx('vec.no_key'));
    for (const n of [column, index]) if (!NAME.test(n)) errors.push(tx('fts.bad_name', { name: n }));
    if (NAME.test(column) && cols.some((c) => c.name === column)) errors.push(tx('fts.exists', { name: column }));
    if (NAME.test(index) && (await db.one('select 1 as x from pg_class where relnamespace = $1::regnamespace and relname = $2', [ident(t.schema), index]))) errors.push(tx('fts.exists', { name: index }));
    const trigger = `${column}_embed`.slice(0, 63);
    if (!errors.length && pick && key) {
      ddl = vectorDdl({ table, vectorType: `${ident(st.schema!)}.vector`, column, index, trigger, dims: pick.p.dimensions, distance, mode, appId: pick.appId, provider: pick.p.name, key, sources: [...picked] });
    }
    if (ddl.length && b.mode === 'worksheet') {
      s.state.__SQLDRAFT = `${ddl.join(';\n\n')};`;
      flash(s, tx('te.review'));
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    if (ddl.length && b.mode === 'apply') {
      const c = await db.pool.connect();
      let failed = '';
      let at = '';
      try {
        await c.query('begin');
        for (const x of ddl) {
          at = x;
          await c.query(x);
        }
        await c.query('commit');
      } catch (e) {
        failed = (e as Error).message;
        await c.query('rollback').catch(() => {});
      } finally {
        c.release(true);
      }
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: ddl.join(';\n').slice(0, 2000) });
      clearCompletions();
      if (!failed) {
        await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'table', defaultSchema: t.schema, statements: [joinStatements(ddl)] });
        // the rows there are now: queued at once (the server embeds them; a function provider too)
        const trg = (await vectorTriggers(db, table)).find((x) => x.vectorColumn === column);
        const n = trg ? await backfill(db, trg, true) : 0;
        kickEmbeddings();
        flash(s, tx('vec.added', { table, column, n: String(n) }));
        return back(reply, s, self);
      }
      output = html`<div class="alert alert-error" role="alert"><p><strong>${tx('te.nothing_changed')}</strong>: ${tx('te.rolled_back')}</p><p>${failed}</p><pre class="source" data-code-view="sql" tabindex="0" aria-label="${tx('te.failed_stmt')}">${at}</pre></div>`;
    }
  }

  // the table's vector columns now, with their progress
  const existing: Raw[] = [];
  for (const c of cols.filter((x) => x.vector)) {
    const trg = triggers.find((x) => x.vectorColumn === c.name);
    const counts = (await db.one<{ total: number; done: number }>(`select count(*)::int as total, count(${ident(c.name)})::int as done from ${table}`))!;
    const q = await queueState(oid, c.name);
    const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 100;
    existing.push(html`<li class="vec-column"><p><code>${c.name}</code> <code>${c.type}</code>
        ${trg ? html`· ${tx('vec.kept_by', { provider: trg.provider, columns: trg.sourceColumns.join(', ') })} (${trg.mode === 'set' ? tx('vec.mode_set') : tx('vec.mode_queue')})` : html`· <span class="muted">${tx('vec.not_kept')}</span>`}</p>
      <p><progress max="100" value="${pct}" aria-label="${tx('vec.progress', { column: c.name })}">${pct}%</progress>
        ${tx('vec.counts', { done: String(counts.done), total: String(counts.total), queued: String(q.queued) })}${q.failing ? html` · <span class="tag tag-error">${tx('vec.failing', { n: String(q.failing) })}</span>` : ''}</p>
      ${q.message ? html`<p class="muted">${q.message}</p>` : ''}
      ${trg ? html`<form method="post" action="${BASE}/sql/objects/vector" class="buttons">${csrf(s)}<input type="hidden" name="o" value="${table}"><input type="hidden" name="column" value="${c.name}">
        <label class="check"><input type="checkbox" name="all"> ${tx('vec.reembed_all')}</label>
        <button class="btn" name="mode" value="backfill">${icon('refresh')} ${tx('vec.backfill')}</button>
        <a class="btn" href="${self}">${tx('vec.refresh')}</a></form>` : ''}</li>`);
  }

  const title = tx('vec.title', { table });
  const sel = (a: string, v: string) => (a === v ? ' selected' : '');
  const admin = await isAdmin(s.username);
  const form = !st.installed
    ? html`<div class="alert alert-info" role="status"><p>${tx('vec.missing')}</p>${st.available ? html`<p>${tx(admin && st.canCreate ? 'vec.missing_create' : 'vec.missing_admin', { version: st.availableVersion ?? '' })}</p>` : html`<p>${tx('vec.missing_package')}</p>`}
        <p><a class="btn" href="${BASE}/vector-providers">${icon('search')} ${tx('vec.utilities')}</a></p></div>`
    : !choices.length
      ? html`<p class="alert alert-info">${tx('vec.no_providers')}</p>`
      : !texty.length
        ? html`<p class="alert alert-info">${tx('fts.no_text')}</p>`
        : html`<form method="post" action="${BASE}/sql/objects/vector" class="fts-form">${csrf(s)}
      <input type="hidden" name="o" value="${table}">
      <div class="form-grid">
        <div class="field"><label class="label" for="vec-provider">${tx('vec.provider')}</label><select id="vec-provider" name="provider">${choices.map((c) => html`<option value="${c.key}"${sel(c.key, pick?.key ?? '')}>${c.alias} · ${c.p.name} (${c.p.type === 'function' ? c.p.function : c.p.model}, ${c.p.dimensions})</option>`)}</select>
          <small class="help">${tx('vec.provider_help')}</small></div>
        <div class="field"><label class="label" for="vec-keep">${tx('vec.keep')}</label><select id="vec-keep" name="keep"><option value="set"${sel(mode, 'set')}>${tx('vec.mode_set')}</option><option value="queue"${sel(mode, 'queue')}>${tx('vec.mode_queue')}</option></select>
          <small class="help">${tx('vec.keep_help')}</small></div>
      </div>
      <fieldset class="prop-group"><legend>${tx('vec.sources')}</legend>
        <div class="table-wrap"><table class="report"><thead><tr><th>${tx('fts.include')}</th><th>${tx('te.name')}</th><th>${tx('te.type')}</th></tr></thead><tbody>
        ${texty.map((c, i) => html`<tr><td class="te-c"><input type="hidden" name="c.${i}.name" value="${c.name}"><input type="checkbox" id="vec-c${i}" name="c.${i}.use"${picked.has(c.name) ? ' checked' : ''}></td>
          <td><label for="vec-c${i}">${c.name}</label></td><td><code>${c.type}</code></td></tr>`)}
        </tbody></table></div>
        <small class="help">${tx('vec.sources_help')}</small></fieldset>
      <div class="form-grid u-mt1">
        <div class="field"><label class="label" for="vec-distance">${tx('vec.distance')}</label><select id="vec-distance" name="distance">${(Object.keys(DISTANCES) as Distance[]).map((d) => html`<option${sel(d, distance)}>${d}</option>`)}</select><small class="help">${tx('vec.distance_help')}</small></div>
        <div class="field"><label class="label" for="vec-column">${tx('vec.column')}</label><input id="vec-column" name="column" value="${column}" required autocomplete="off" spellcheck="false" class="code"></div>
        <div class="field"><label class="label" for="vec-index">${tx('fts.index')}</label><input id="vec-index" name="index" value="${index}" required autocomplete="off" spellcheck="false" class="code"></div>
      </div>
      ${key ? '' : html`<p class="alert alert-error" role="alert">${tx('vec.no_key')}</p>`}
      ${ddl.length ? html`<h2>DDL</h2><pre class="source te-ddl" data-code-view="sql" tabindex="0" aria-label="DDL">${ddl.map((x) => `${x};`).join('\n\n')}</pre>` : ''}
      <div class="buttons te-buttons">
        <button class="btn" name="mode" value="preview">${icon('eye')} ${tx('te.preview')}</button>
        <button class="btn btn-hot" name="mode" value="apply">${icon('check')} ${tx('te.apply')}</button>
        <button class="btn" name="mode" value="worksheet">${icon('code')} ${tx('te.open_ws')}</button>
        <a class="btn" href="${BASE}/sql/objects/table?${new URLSearchParams({ o: table })}">${tx('common.cancel')}</a>
      </div></form>`;
  const main = html`<h1 class="u-mb1">${title}</h1>${workshopTabs('objects', s)}
    <p class="muted">${tx('vec.intro')}</p>
    ${existing.length ? html`<h2>${tx('vec.existing')}</h2><ul class="vec-columns">${existing}</ul>` : ''}
    ${errors.length ? html`<div class="alert alert-error" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    ${output}
    <h2>${tx('vec.add')}</h2>
    ${form}`;
  return send(reply, s, shell(s, title, [['SQL Workshop', `${BASE}/sql`], [tx('ob.title'), `${BASE}/sql/objects`], [tx('te.title_table', { table }), `${BASE}/sql/objects/table?${new URLSearchParams({ o: table })}`], [tx('vec.add')]], main, 'sql'));
}

export async function vectorColumnRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/objects/vector`, page);
  app.post(`${BASE}/sql/objects/vector`, page);
}
