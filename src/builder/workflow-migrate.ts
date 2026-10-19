import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { clientIp, logActivity } from '../session.ts';
import { workflowDiagram, type Step } from '../workflow.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';

// (123) Workflows in the builder: migrating running instances to a newer
// version (APEX 26.2: in-flight workflow migration) and the diagram as a file.
//
//   GET  …/workflow_definition/:cid/migrate   choose the version, the instances and the step mapping;
//                                             submitting the form (GET) previews what would happen
//   POST …/workflow_definition/:cid/migrate   apply: meta.migrate_workflows in one transaction; refused
//                                             (nothing changes) when an instance's step has no mapping
//   GET  …/workflow_definition/:cid/diagram.svg?v=<version>
//                                             the whole model as a standalone SVG file (PNG: builder.js
//                                             draws this SVG on a canvas; without JavaScript, the SVG)

interface Definition {
  id: number;
  app_id: number;
  name: string;
  title: string;
  steps: Step[];
  version: string;
  dev_version: string | null;
  dev_steps: Step[] | null;
  inactive_versions: { version: string; steps: Step[] }[];
}

interface Running {
  id: string;
  title: string;
  version: string;
  state: string;
  current_step: string | null;
  branches: boolean;
}

const ID = /^\d{1,9}$/;
const WF_ID = /^\d{1,18}$/;
const STEP = /^[A-Z][A-Z0-9_]{0,99}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;

async function definition(id: string, cid: string): Promise<Definition | undefined> {
  if (!ID.test(id) || !ID.test(cid)) return undefined;
  return owner.one('select id, app_id, name, title, steps, version, dev_version, dev_steps, inactive_versions from meta.workflow_definition where id = $1 and app_id = $2', [cid, id]);
}

/** Versions oldest first, the active one last. */
const ordered = (d: Definition) => [...(Array.isArray(d.inactive_versions) ? d.inactive_versions : []), { version: d.version, steps: d.steps }];

/** Repeated form fields (wf=1&wf=2) arrive as an array, a single one as a string. */
const many = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

/** The step mapping from the form: m.<STEP> = <STEP>. */
function mappingOf(q: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith('m.')) continue;
    const from = k.slice(2);
    const to = Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
    if (STEP.test(from) && (to === '' || STEP.test(to))) map[from] = to;
  }
  return map;
}

export async function workflowMigrateRoutes(app: FastifyInstance) {
  const url = (d: Definition) => `${BASE}/apps/${d.app_id}/shared/workflow_definition/${d.id}`;

  app.get(`${BASE}/apps/:id/shared/workflow_definition/:cid/diagram.svg`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await definition(req.params.id, req.params.cid);
    if (!d) return reply.code(404).send('Not found');
    const v = String(req.query.v ?? '');
    const versions = [...ordered(d), ...(d.dev_version ? [{ version: d.dev_version, steps: d.dev_steps ?? [] }] : [])];
    const pick = v ? versions.find((x) => x.version === v) : versions[versions.length - 1];
    if (!pick) return reply.code(404).send('No such version');
    const svg = workflowDiagram(pick.steps, { id: 'export', standalone: { title: `${d.name} version ${pick.version}` } }).toString();
    if (!svg) return reply.code(404).send('This version has no steps to draw.');
    const file = `${d.name.toLowerCase()}-v${pick.version}.svg`.replace(/[^a-z0-9._-]/gi, '_');
    return reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file}"`)
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'no-store')
      .send(svg);
  });

  app.get(`${BASE}/apps/:id/shared/workflow_definition/:cid/migrate`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    const d = a ? await definition(req.params.id, req.params.cid) : undefined;
    if (!a || !d) return reply.code(404).send('Not found');
    const q = req.query as Record<string, unknown>;
    const versions = ordered(d);
    const position = (v: string) => versions.findIndex((x) => x.version === v);
    const running = (
      await owner.query<Running>(
        `select w.id::text, w.title, coalesce(w.version, '1') as version, w.state, w.current_step,
                exists (select 1 from meta.workflow_branch b where b.workflow_id = w.id and b.state in ('active', 'waiting', 'faulted')) as branches
           from meta.workflow w where w.definition_id = $1 and w.state in ('active', 'waiting', 'faulted') order by w.id`,
        [d.id],
      )
    ).rows;
    // the versions an instance can move to: newer than the oldest running one
    const oldest = Math.min(...running.map((w) => position(w.version)).map((p) => (p < 0 ? -1 : p)), versions.length - 1);
    const targets = versions.filter((_, i) => i > oldest).map((x) => x.version).reverse();
    const to = typeof q.to === 'string' && targets.includes(q.to) ? q.to : targets[0];
    const target = versions.find((x) => x.version === to);
    const older = running.filter((w) => to !== undefined && position(w.version) < position(to));
    const picked = q.preview ? many(q.wf).filter((x) => WF_ID.test(x) && older.some((w) => w.id === x)) : older.map((w) => w.id);
    const chosen = older.filter((w) => picked.includes(w.id));
    const targetSteps = (target?.steps ?? []).filter((x) => x && typeof x.name === 'string' && x.type !== 'draft');
    const asked = mappingOf(q);
    // each step a chosen instance is at: the mapping asked for, or the step of the same name
    const current = [...new Set(chosen.map((w) => w.current_step).filter((x): x is string => !!x && STEP.test(x)))].sort();
    const mapping = Object.fromEntries(current.map((st) => [st, st in asked ? asked[st] : targetSteps.some((x) => x.name === st) ? st : '']));

    let preview: { workflow_id: string; from_version: string | null; from_step: string | null; to_step: string | null; problem: string | null }[] | null = null;
    let previewError: string | null = null;
    if (q.preview && to) {
      if (!chosen.length) previewError = 'Choose the instances to migrate.';
      else {
        try {
          preview = (await owner.query('select workflow_id::text, from_version, from_step, to_step, problem from meta.migrate_workflows($1, $2, $3::bigint[], $4, false, $5)',
            [d.id, to, chosen.map((w) => w.id), mapping, s.username])).rows;
        } catch (e) {
          previewError = (e as Error).message;
        }
      }
    }
    const ready = !!preview && preview.every((r) => !r.problem);
    const self = `${url(d)}/migrate`;
    const hidden = html`<input type="hidden" name="to" value="${to ?? ''}">${chosen.map((w) => html`<input type="hidden" name="wf" value="${w.id}">`)}${Object.entries(mapping).map(([k, v]) => html`<input type="hidden" name="${`m.${k}`}" value="${v}">`)}`;
    const body = !running.length
      ? region('Migrate running instances', html`<p class="muted u-mt0">${d.name} has no running instances.</p><p><a class="btn" href="${BASE}/apps/${a.id}/shared?c=workflow_definition-${d.id}">Back to ${d.name}</a></p>`)
      : !targets.length
        ? region('Migrate running instances', html`<p class="muted u-mt0">Every running instance of ${d.name} runs the active version ${d.version}: there is no newer version to move them to.</p>
            <p><a class="btn" href="${BASE}/apps/${a.id}/shared?c=workflow_definition-${d.id}">Back to ${d.name}</a></p>`)
        : html`${region('Migrate running instances', html`<form method="get" action="${self}">
            <input type="hidden" name="preview" value="1">
            <p class="muted u-mt0">Move running instances to a newer version: each goes on at the step of the new version its current step is mapped to,
              keeping its variables and the task it waits for. Every instance must have a mapping, or nothing moves. Instances inside parallel branches move once their branches have joined.</p>
            <div class="form-grid">
              <div class="field"><label class="label" for="wf-to">To version</label>
                <select id="wf-to" name="to">${targets.map((v) => html`<option value="${v}"${v === to ? raw(' selected') : ''}>${v}${v === d.version ? ' (active)' : ' (inactive)'}</option>`)}</select>
                <small class="help">Changing it: preview again to see its steps.</small></div>
            </div>
            <fieldset class="prop-group u-mt1"><legend>Instances on an older version</legend>
              ${older.length
                ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Migrate</th><th class="num">Id</th><th>Title</th><th>Version</th><th>State</th><th>At</th></tr></thead><tbody>
                    ${older.map((w) => html`<tr><td data-label="Migrate"><input type="checkbox" name="wf" value="${w.id}" id="${`wf-${w.id}`}"${picked.includes(w.id) ? raw(' checked') : ''} aria-label="${`Migrate instance ${w.id}`}"></td>
                      <td class="num" data-label="Id"><label for="${`wf-${w.id}`}">${w.id}</label></td><td data-label="Title">${w.title}</td><td data-label="Version">${w.version}</td>
                      <td data-label="State">${w.state}</td><td data-label="At">${w.branches ? 'parallel branches' : (w.current_step ?? '—')}</td></tr>`)}
                  </tbody></table></div>`
                : html`<p class="muted">No running instance is older than version ${to}.</p>`}
            </fieldset>
            ${current.length
              ? html`<fieldset class="prop-group u-mt1"><legend>Map the current steps to steps of version ${to}</legend>
                  <div class="wf-migrate-map">${current.map((st) => html`<label>${st}
                    <select name="${`m.${st}`}"><option value="">— no mapping —</option>${targetSteps.map((x) => html`<option value="${x.name}"${mapping[st] === x.name ? raw(' selected') : ''}>${x.name} (${x.type})</option>`)}</select></label>`)}</div>
                </fieldset>`
              : ''}
            <div class="buttons u-mt1"><button class="btn">Preview</button> <a class="btn" href="${BASE}/apps/${a.id}/shared?c=workflow_definition-${d.id}">Cancel</a></div>
          </form>`)}
          ${previewError ? html`<div class="alert alert-error u-mt1" role="alert">${previewError}</div>` : ''}
          ${preview
            ? region('Preview', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th class="num">Id</th><th>From</th><th>To</th><th>Result</th></tr></thead><tbody>
                  ${preview.map((r) => html`<tr><td class="num" data-label="Id">${r.workflow_id}</td><td data-label="From">${r.from_version ? `${r.from_version}: ${r.from_step ?? '—'}` : '—'}</td>
                    <td data-label="To">${r.to_step ? `${to}: ${r.to_step}` : '—'}</td><td data-label="Result">${r.problem ? html`<span class="wf-problem">${r.problem}</span>` : html`<span class="tag tag-info">ready</span>`}</td></tr>`)}
                </tbody></table></div>
                ${ready
                  ? html`<form method="post" action="${self}" class="u-mt1">${csrf(s)}${hidden}
                      <button class="btn btn-hot" data-confirm="${`Migrate ${preview.length} instance(s) to version ${to}?`}">Migrate ${preview.length} instance(s)</button></form>`
                  : html`<p class="wf-problem">Map a step for every instance (or leave the others out) and preview again: nothing is migrated while one can't move.</p>`}`)
            : ''}
          ${target ? region(`Version ${to}`, html`<div class="wf-wrap">${workflowDiagram(target.steps, { id: 'target' })}</div>`) : ''}`;
    const main = html`${appHeader(a, 'shared')}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, `Migrate ${d.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`],
      [d.name, `${BASE}/apps/${a.id}/shared?c=workflow_definition-${d.id}`], ['Migrate instances']], main));
  });

  app.post(`${BASE}/apps/:id/shared/workflow_definition/:cid/migrate`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await definition(req.params.id, req.params.cid);
    if (!d) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const to = typeof b.to === 'string' && LABEL.test(b.to) ? b.to : '';
    const ids = many(b.wf).filter((x) => WF_ID.test(x));
    const mapping = mappingOf(b);
    const self = `${url(d)}/migrate`;
    try {
      if (!to) throw new Error('Choose the version to migrate to.');
      const rows = await owner.tx(async (c) =>
        (await c.query('select workflow_id::text, from_step, to_step from meta.migrate_workflows($1, $2, $3::bigint[], $4, true, $5)', [d.id, to, ids, mapping, s.username])).rows);
      logActivity({ appId: d.app_id, username: s.username, event: 'workflow', ip: clientIp(req), detail: `${d.name}: ${rows.length} instance(s) migrated to version ${to}` });
      flash(s, `${rows.length} instance(s) of ${d.name} migrated to version ${to}.`);
      return back(reply, s, `${BASE}/apps/${d.app_id}/shared?c=workflow_definition-${d.id}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      const qs = new URLSearchParams([['preview', '1'], ['to', to], ...ids.map((x) => ['wf', x]), ...Object.entries(mapping).map(([k, v]) => [`m.${k}`, v])]);
      return back(reply, s, `${self}?${qs}`);
    }
  });
}
