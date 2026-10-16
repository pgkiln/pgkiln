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

// SQL Workshop → Generate DDL and Schema Comparison (APEX: SQL Workshop →
// Utilities). Both only read the catalog (src/ddl.ts); the scripts they
// write are shown and downloaded. (sprint 106) Compare's Apply and record
// runs the change script and records it (changelog.ts).

const TYPE_LABELS: Record<(typeof OBJECT_TYPES)[number], string> = {
  types: 'Types and domains', sequences: 'Sequences', tables: 'Tables (constraints, indexes)', views: 'Views and materialized views',
  functions: 'Functions and procedures', triggers: 'Triggers', policies: 'Row level security and policies',
};
const STATE_LABELS: Record<Difference['state'], string> = { source: 'Only in the source', target: 'Only in the target', different: 'Different' };

const many = (v: unknown) => ([] as string[]).concat((v as string | string[] | undefined) ?? []);
const schemaSelect = (name: string, label: string, schemas: string[], current: string) =>
  html`<div class="field"><label class="label" for="f_${name}">${label}</label>
    <select id="f_${name}" name="${name}" required><option value="">- choose a schema -</option>${schemas.map((x) => html`<option value="${x}"${x === current ? raw(' selected') : ''}>${x}</option>`)}</select></div>`;

/** A unified diff with added and removed lines marked. */
const diffBlock = (d: Difference, source: string, target: string) => {
  const text = unifiedDiff(d.name, Buffer.from(`${d.target ?? ''}\n`), Buffer.from(`${d.source ?? ''}\n`), [target, source]);
  return html`<pre class="diff">${text.trimEnd().split('\n').map((l, i) => html`${i ? '\n' : ''}<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'diff-del' : null}">${l}</span>`)}</pre>`;
};

/** (sprint 106, DA-17) Apply the change script in one transaction and record it in the change log (changelog.ts). */
const applyForm = (s: Session, source: string, target: string) =>
  html`<form method="post" action="${BASE}/sql/compare/apply" class="u-mt1">${csrf(s)}<input type="hidden" name="source" value="${source}"><input type="hidden" name="target" value="${target}">
    <button class="btn btn-hot" data-confirm="Run the change script on ${target} in one transaction?">${icon('play')} Apply and record</button>
    <span class="muted small">Runs the script on ${target} (commented-out drops stay out) and records it in the <a href="${BASE}/sql/changes?schema=${encodeURIComponent(target)}">change log</a>.</span></form>`;

export async function ddlToolRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/ddl`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = await userSchemas(db, { usable: db !== owner });
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
        result = region(`DDL of ${schema}`, html`<p class="muted">${objects.length} object(s). Review the script before you run it (SQL Workshop → SQL Scripts).</p>
          <textarea class="code" rows="24" spellcheck="false" readonly aria-label="DDL of ${schema}" data-code="plpgsql">${script}</textarea>`,
          html`<a class="btn" href="${BASE}/sql/ddl?${qs.toString()}">${icon('download')} Download ${schema}.sql</a>`);
      } catch (e) {
        result = html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`;
      }
    }
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('ddl')}
      <p class="muted">The DDL of a schema's objects, from the database catalog, in an order that runs: types, sequences, tables, functions, views, constraints, indexes, triggers, row level security, comments and grants (APEX: Generate DDL). Objects of extensions are left out.</p>
      <form method="get" class="u-mb1">
        <div class="form-grid">${schemaSelect('schema', 'Schema', schemas, schema)}</div>
        <fieldset class="prop-group"><legend>Objects</legend><div class="form-grid">
          ${OBJECT_TYPES.map((x) => html`<label class="check"><input type="checkbox" name="t" value="${x}"${types.has(x) ? raw(' checked') : ''}> ${TYPE_LABELS[x]}</label>`)}
          <label class="check"><input type="checkbox" name="comments" value="1"${opts.comments ? raw(' checked') : ''}> Comments</label>
          <label class="check"><input type="checkbox" name="grants" value="1"${opts.grants ? raw(' checked') : ''}> Grants</label>
        </div></fieldset>
        <div class="buttons"><button class="btn btn-hot">${icon('code')} Generate</button></div>
      </form>
      ${result}`;
    return send(reply, s, shell(s, 'Generate DDL', [['SQL Workshop', `${BASE}/sql`], ['Generate DDL']], main, 'sql'));
  });

  app.get(`${BASE}/sql/compare`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const schemas = await userSchemas(db, { usable: db !== owner });
    const q = req.query ?? {};
    const source = schemas.includes(q.source ?? '') ? q.source! : '';
    const target = schemas.includes(q.target ?? '') ? q.target! : '';
    let result: Raw | '' = '';
    if (source && target && source === target) result = html`<div class="alert alert-error" role="alert">Choose two different schemas.</div>`;
    else if (source && target) {
      try {
        const [a, b] = await Promise.all([readSchema(db.pool, source), readSchema(db.pool, target)]);
        const { differences, same } = compare(a, b);
        const script = changeScript(source, target, a, b);
        await logActivity({ username: s.username, event: 'schema_compare', ip: clientIp(req), detail: `${source} → ${target}: ${differences.length} differences` });
        if (q.download === '1')
          return reply.header('content-disposition', `attachment; filename="${target}-like-${source}.sql"`).type('application/sql; charset=utf-8').send(script);
        const groups = (['source', 'target', 'different'] as const).map((st) => [st, differences.filter((d) => d.state === st)] as const).filter(([, list]) => list.length);
        result = html`${region('Summary', html`<p>${differences.length
            ? `${differences.length} difference(s): ${groups.map(([st, list]) => `${list.length} ${STATE_LABELS[st].toLowerCase()}`).join(', ')}; ${same} object(s) the same.`
            : `The schemas are the same (${same} objects).`}</p>`)}
          ${groups.map(([st, list]) => html`<div class="u-spacer"></div>${region(`${STATE_LABELS[st]} (${st === 'source' ? source : st === 'target' ? target : `${source} and ${target}`})`,
            html`<ul class="compare-list">${list.map((d) => html`<li><details><summary><span class="tag">${d.kind}</span> ${d.name}</summary>
              ${st === 'different' ? diffBlock(d, source, target) : html`<pre class="diff">${d.source ?? d.target}</pre>`}</details></li>`)}</ul>`)}`)}
          <div class="u-spacer"></div>
          ${region(`Change script: make ${target} like ${source}`, html`<p class="muted">Creates what only ${source} has, changes what differs, and lists what only ${target} has as commented-out drops; columns that change identity or generation, and types, domains and sequences that differ, are left for review. Nothing runs until you choose Apply and record.</p>
            <textarea class="code" rows="20" spellcheck="false" readonly aria-label="Change script" data-code="plpgsql">${script}</textarea>`,
            html`<a class="btn" href="${BASE}/sql/compare?${new URLSearchParams({ source, target, download: '1' }).toString()}">${icon('download')} Download</a>`)}
          ${differences.length ? applyForm(s, source, target) : ''}`;
      } catch (e) {
        result = html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>`;
      }
    }
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('compare')}
      <p class="muted">Compares the objects of two schemas of this database by their DDL (APEX: Schema Comparison), e.g. a development copy with the schema it came from, and writes a script that makes the target like the source. The order of a table's columns is not compared.</p>
      <form method="get" class="u-mb1">
        <div class="form-grid">${schemaSelect('source', 'Source', schemas, source)}${schemaSelect('target', 'Target (to make like the source)', schemas, target)}</div>
        <div class="buttons"><button class="btn btn-hot">${icon('layers')} Compare</button></div>
      </form>
      ${result}`;
    return send(reply, s, shell(s, 'Schema Comparison', [['SQL Workshop', `${BASE}/sql`], ['Schema Comparison']], main, 'sql'));
  });
}
