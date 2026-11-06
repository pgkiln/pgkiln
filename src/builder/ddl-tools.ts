import type { FastifyInstance } from 'fastify';
import { unifiedDiff } from '../cli/diff.ts';
import { owner } from '../db.ts';
import { changeScript, compare, ddlScript, OBJECT_TYPES, pick, readSchema, userSchemas, type Difference } from '../ddl.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { BASE, csrf, developer, region, send, shell, workshopTabs, type Req } from './ui.ts';
import type { Session } from '../session.ts';
import { workshopDb } from './workspaces.ts';
import { tr, type BuilderKey, type BuilderTranslate } from './i18n.ts';

// SQL Workshop → Generate DDL and Schema Comparison (APEX: SQL Workshop →
// Utilities). Both only read the catalog (src/ddl.ts); the scripts they
// write are shown and downloaded. (sprint 106) Compare's Apply and record
// runs the change script and records it (changelog.ts).

const TYPE_LABELS: Record<(typeof OBJECT_TYPES)[number], BuilderKey> = {
  types: 'ddl.type.types', sequences: 'ddl.type.sequences', tables: 'ddl.type.tables', views: 'ddl.type.views',
  functions: 'ddl.type.functions', triggers: 'ddl.type.triggers', policies: 'ddl.type.policies',
};
const STATE_LABELS: Record<Difference['state'], BuilderKey> = { source: 'cmp.only_source', target: 'cmp.only_target', different: 'cmp.different' };
const STATE_COUNTS: Record<Difference['state'], BuilderKey> = { source: 'cmp.n_only_source', target: 'cmp.n_only_target', different: 'cmp.n_different' };

const many = (v: unknown) => ([] as string[]).concat((v as string | string[] | undefined) ?? []);
const schemaSelect = (tx: BuilderTranslate, name: string, label: string, schemas: string[], current: string) =>
  html`<div class="field"><label class="label" for="f_${name}">${label}</label>
    <select id="f_${name}" name="${name}" required><option value="">${tx('ddl.choose_schema')}</option>${schemas.map((x) => html`<option value="${x}"${x === current ? raw(' selected') : ''}>${x}</option>`)}</select></div>`;

/** A unified diff with added and removed lines marked. */
const diffBlock = (d: Difference, source: string, target: string) => {
  const text = unifiedDiff(d.name, Buffer.from(`${d.target ?? ''}\n`), Buffer.from(`${d.source ?? ''}\n`), [target, source]);
  return html`<pre class="diff">${text.trimEnd().split('\n').map((l, i) => html`${i ? '\n' : ''}<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'diff-del' : null}">${l}</span>`)}</pre>`;
};

/** (sprint 106, DA-17) Apply the change script in one transaction and record it in the change log (changelog.ts). */
const applyForm = (s: Session, source: string, target: string, tx = tr(s)) =>
  html`<form method="post" action="${BASE}/sql/compare/apply" class="u-mt1">${csrf(s)}<input type="hidden" name="source" value="${source}"><input type="hidden" name="target" value="${target}">
    <button class="btn btn-hot" data-confirm="${tx('cmp.apply_confirm', { target })}">${icon('play')} ${tx('cmp.apply')}</button>
    <span class="muted small">${tx.rich('cmp.apply_note', { target, log: html`<a href="${BASE}/sql/changes?schema=${encodeURIComponent(target)}">${tx('cmp.change_log')}</a>` })}</span></form>`;

export async function ddlToolRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/ddl`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = await userSchemas(db, { usable: db !== owner });
    const tx = tr(s);
    const q = req.query ?? {};
    const schema = schemas.includes(q.schema ?? '') ? q.schema! : '';
    // the first visit: every type, comments and grants
    const fresh = !q.schema;
    const types = new Set(fresh ? OBJECT_TYPES : many(q.t).filter((x) => (OBJECT_TYPES as readonly string[]).includes(x)));
    const opts = { comments: fresh || q.comments === '1', grants: fresh || q.grants === '1' };
    let result: Raw | '' = '';
    if (schema) {
      try {
        const objects = pick(await readSchema(db.pool, schema), types, opts);
        const script = ddlScript(schema, objects);
        await logActivity({ username: s.username, event: 'generate_ddl', ip: clientIp(req), detail: `${schema}: ${objects.length} objects` });
        if (q.download === '1')
          return reply.header('content-disposition', `attachment; filename="${schema}.sql"`).type('application/sql; charset=utf-8').send(script);
        const qs = new URLSearchParams([['schema', schema], ...[...types].map((x) => ['t', x]), ...(opts.comments ? [['comments', '1']] : []), ...(opts.grants ? [['grants', '1']] : []), ['download', '1']]);
        result = region(tx('ddl.of', { schema }), html`<p class="muted">${tx('ddl.objects_review', { n: objects.length })}</p>
          <textarea class="code" rows="24" spellcheck="false" readonly aria-label="${tx('ddl.of', { schema })}" data-code="plpgsql">${script}</textarea>`,
          html`<a class="btn" href="${BASE}/sql/ddl?${qs.toString()}">${icon('download')} ${tx('ddl.download', { file: `${schema}.sql` })}</a>`);
      } catch (e) {
        result = html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`;
      }
    }
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('ddl', s)}
      <p class="muted">${tx('ddl.intro')}</p>
      <form method="get" class="u-mb1">
        <div class="form-grid">${schemaSelect(tx, 'schema', tx('sm.schema'), schemas, schema)}</div>
        <fieldset class="prop-group"><legend>${tx('ddl.objects')}</legend><div class="form-grid">
          ${OBJECT_TYPES.map((x) => html`<label class="check"><input type="checkbox" name="t" value="${x}"${types.has(x) ? raw(' checked') : ''}> ${tx(TYPE_LABELS[x])}</label>`)}
          <label class="check"><input type="checkbox" name="comments" value="1"${opts.comments ? raw(' checked') : ''}> ${tx('ddl.comments')}</label>
          <label class="check"><input type="checkbox" name="grants" value="1"${opts.grants ? raw(' checked') : ''}> ${tx('ddl.grants')}</label>
        </div></fieldset>
        <div class="buttons"><button class="btn btn-hot">${icon('code')} ${tx('ddl.generate')}</button></div>
      </form>
      ${result}`;
    return send(reply, s, shell(s, tx('sql.tool.ddl'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.ddl')]], main, 'sql'));
  });

  app.get(`${BASE}/sql/compare`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = await userSchemas(db, { usable: db !== owner });
    const q = req.query ?? {};
    const source = schemas.includes(q.source ?? '') ? q.source! : '';
    const target = schemas.includes(q.target ?? '') ? q.target! : '';
    const tx = tr(s);
    let result: Raw | '' = '';
    if (source && target && source === target) result = html`<div class="alert alert-error" role="alert">${tx('cmp.two_different')}</div>`;
    else if (source && target) {
      try {
        const [a, b] = await Promise.all([readSchema(db.pool, source), readSchema(db.pool, target)]);
        const { differences, same } = compare(a, b);
        const script = changeScript(source, target, a, b);
        await logActivity({ username: s.username, event: 'schema_compare', ip: clientIp(req), detail: `${source} → ${target}: ${differences.length} differences` });
        if (q.download === '1')
          return reply.header('content-disposition', `attachment; filename="${target}-like-${source}.sql"`).type('application/sql; charset=utf-8').send(script);
        const groups = (['source', 'target', 'different'] as const).map((st) => [st, differences.filter((d) => d.state === st)] as const).filter(([, list]) => list.length);
        result = html`${region(tx('cmp.summary'), html`<p>${differences.length
            ? tx('cmp.differences', { n: differences.length, parts: groups.map(([st, list]) => tx(STATE_COUNTS[st], { n: list.length })).join(', '), same })
            : tx('cmp.same', { n: same })}</p>`)}
          ${groups.map(([st, list]) => html`<div class="u-spacer"></div>${region(`${tx(STATE_LABELS[st])} (${st === 'source' ? source : st === 'target' ? target : tx('cmp.both', { source, target })})`,
            html`<ul class="compare-list">${list.map((d) => html`<li><details><summary><span class="tag">${d.kind}</span> ${d.name}</summary>
              ${st === 'different' ? diffBlock(d, source, target) : html`<pre class="diff">${d.source ?? d.target}</pre>`}</details></li>`)}</ul>`)}`)}
          <div class="u-spacer"></div>
          ${region(tx('cmp.script_title', { source, target }), html`<p class="muted">${tx('cmp.script_intro', { source, target })}</p>
            <textarea class="code" rows="20" spellcheck="false" readonly aria-label="${tx('cmp.change_script')}" data-code="plpgsql">${script}</textarea>`,
            html`<a class="btn" href="${BASE}/sql/compare?${new URLSearchParams({ source, target, download: '1' }).toString()}">${icon('download')} ${tx('scr.download')}</a>`)}
          ${differences.length ? applyForm(s, source, target) : ''}`;
      } catch (e) {
        result = html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`;
      }
    }
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('compare', s)}
      <p class="muted">${tx('cmp.intro')}</p>
      <form method="get" class="u-mb1">
        <div class="form-grid">${schemaSelect(tx, 'source', tx('cmp.source'), schemas, source)}${schemaSelect(tx, 'target', tx('cmp.target'), schemas, target)}</div>
        <div class="buttons"><button class="btn btn-hot">${icon('layers')} ${tx('cmp.compare')}</button></div>
      </form>
      ${result}`;
    return send(reply, s, shell(s, tx('sql.tool.compare'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.compare')]], main, 'sql'));
  });
}
