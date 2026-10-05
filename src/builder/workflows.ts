import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import type { Session } from '../session.ts';
import { invokeStepReferences, stepProblems, stepWarnings, workflowDiagram, type Step } from '../workflow.ts';
import type { ComponentSpec } from './components.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Shared Components → Workflows: versions (APEX: development, active,
// inactive), the diagram of the steps, problems with them, and the instances
// with the version they run and the steps they are at.
//
// The property form edits the development version's steps; the active
// version can't be changed (new instances start it): "Create new version"
// copies it into a development version, "Activate" makes that the active one.

interface Definition {
  id: number;
  name: string;
  steps: Step[];
  version: string;
  activated_at: string | null;
  dev_version: string | null;
  dev_steps: Step[] | null;
  inactive_versions: { version: string; steps: Step[]; activated_at: string | null; deactivated_at: string | null }[];
}

const when = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');

/** The property form shows the development version's steps, or the active ones read-only. */
export function workflowForm(spec: ComponentSpec, row: Definition): [ComponentSpec, Definition] {
  const dev = row.dev_version !== null && row.dev_version !== undefined;
  const fields = spec.fields.map((f) =>
    f.name !== 'steps' ? f
    : dev ? { ...f, label: `Steps of version ${row.dev_version} (development, JSON)` }
    : { ...f, label: `Steps of version ${row.version} (active, read-only)`, readonly: true,
        help: "New instances start the active version, so it can't be changed: create a new version below to edit a copy, then activate it." },
  );
  return [{ ...spec, fields }, dev ? { ...row, steps: row.dev_steps ?? [] } : row];
}

/**
 * Saving the form: the steps go to the development version. Without one, the
 * active steps must be unchanged (on a new definition they are version 1).
 */
export async function workflowBeforeSave(values: Record<string, unknown>, cid: string | undefined) {
  if (!cid || values.steps === undefined) return;
  const d = await owner.one('select version, dev_version, steps = $2::jsonb as same from meta.workflow_definition where id = $1', [cid, values.steps]);
  if (!d) return;
  if (d.dev_version !== null) {
    values.dev_steps = values.steps;
    delete values.steps;
  } else if (d.same) delete values.steps;
  else throw new Error(`Version ${d.version} is active and can't be changed. Create a new version to edit its steps.`);
}

export async function workflowExtras(appId: number, row: Definition, s: Session, query: Record<string, string | undefined> = {}) {
  const tasks = new Set((await owner.query('select name from meta.task_definition where app_id = $1', [appId])).rows.map((r) => r.name as string));
  const dev = row.dev_version !== null && row.dev_version !== undefined;
  const shown = dev ? (row.dev_steps ?? []) : row.steps;
  const refs = {
    sources: new Map((await owner.query('select name, params, columns from meta.rest_source where app_id = $1', [appId])).rows.map((r) => [r.name as string, r])),
    credentials: new Set((await owner.query('select name from meta.web_credential where app_id = $1', [appId])).rows.map((r) => r.name as string)),
    startVars: [...String((row as { title?: string }).title ?? '').matchAll(/&([A-Za-z][A-Za-z0-9_]*)\./g)].map((m) => m[1]),
  };
  const invokeRefs = invokeStepReferences(shown, refs);
  const problems = [...stepProblems(shown, tasks), ...invokeRefs.errors];
  const warnings = problems.length ? [] : [...stepWarnings(shown), ...invokeRefs.warnings];
  const perVersion = new Map(
    (await owner.query(`select coalesce(version, '1') as version, count(*)::int as n, (count(*) filter (where state in ('active', 'waiting', 'faulted')))::int as running
                          from meta.workflow where definition_id = $1 group by 1`, [row.id])).rows.map((r) => [r.version as string, r]),
  );
  const counts = (await owner.query('select state, count(*)::int as n from meta.workflow where definition_id = $1 group by 1 order by 1', [row.id])).rows;
  const instances = (
    await owner.query(
      `select w.id::text, w.title, w.version, w.state, w.started_at, w.initiator,
              coalesce((select array_agg(b.current_step order by b.id) from meta.workflow_branch b
                         where b.workflow_id = w.id and b.state in ('active', 'waiting', 'faulted')
                           and not exists (select 1 from meta.workflow_branch c where c.parent_id = b.id and c.state in ('active', 'waiting', 'faulted'))),
                       case when w.state in ('active', 'waiting', 'faulted') and w.current_step is not null then array[w.current_step] else '{}'::text[] end) as active_steps
         from meta.workflow w where w.definition_id = $1 order by w.started_at desc, w.id desc limit 20`,
      [row.id],
    )
  ).rows;
  const picked = query.wf && /^\d{1,18}$/.test(query.wf) ? instances.find((w) => w.id === query.wf) : undefined;
  const pickedSteps = picked ? (await owner.one('select steps from meta.workflow where id = $1 and definition_id = $2', [picked.id, row.id]))?.steps : undefined;
  const action = `${BASE}/apps/${appId}/shared/workflow_definition/${row.id}/versions`;
  const usage = (v: string) => {
    const u = perVersion.get(v);
    return u ? `${u.n}${u.running ? ` (${u.running} running)` : ''}` : '0';
  };
  const inactive = Array.isArray(row.inactive_versions) ? row.inactive_versions : [];
  const nextLabel = String(Math.max(0, ...[row.version, ...inactive.map((v) => v.version)].filter((v) => /^\d{1,9}$/.test(v)).map(Number)) + 1);
  const versions = [
    ...(dev ? [{ version: row.dev_version!, state: 'development', at: null as string | null, steps: row.dev_steps ?? [] }] : []),
    { version: row.version, state: 'active', at: row.activated_at, steps: row.steps },
    ...[...inactive].reverse().map((v) => ({ version: v.version, state: 'inactive', at: v.activated_at, steps: v.steps })),
  ];
  return html`<fieldset class="prop-group u-mt125"><legend>Versions</legend>
    <p class="muted u-mt0">New instances start the <b>active</b> version; running instances keep the version they started with. Edit a <b>development</b> version, then activate it.</p>
    <div class="table-wrap"><table class="report report-reflow wf-versions"><thead><tr><th>Version</th><th>State</th><th>Activated</th><th class="num">Instances</th><th></th></tr></thead><tbody>
      ${versions.map((v, i) => html`<tr>
        <td data-label="Version"><b>${v.version}</b></td>
        <td data-label="State"><span class="tag${v.state === 'active' ? ' tag-info' : v.state === 'development' ? ' tag-warning' : ''}">${v.state}</span></td>
        <td data-label="Activated">${v.state === 'development' ? '—' : when(v.at)}</td>
        <td class="num" data-label="Instances">${usage(v.version)}</td>
        <td data-label="">${v.state === 'development'
          ? html`<form method="post" action="${action}" class="wf-version-actions">${csrf(s)}
              <button class="btn btn-hot" name="action" value="activate"${problems.length ? raw(' disabled') : ''} data-confirm="${`Activate version ${v.version}? New instances start it; running ones keep their version.`}">Activate</button>
              <button class="btn btn-danger" name="action" value="discard" data-confirm="${`Discard version ${v.version} and its changes?`}">Discard</button></form>`
          : v.steps !== shown ? html`<details class="wf-version-diagram"><summary>Diagram</summary><div class="wf-wrap">${workflowDiagram(v.steps, { id: `v${i}` })}</div></details>` : ''}</td>
      </tr>`)}
    </tbody></table></div>
    ${dev
      ? ''
      : html`<form method="post" action="${action}" class="search u-mwnone u-mt075">${csrf(s)}
          <label class="sr-only" for="wf-new-version">Label of the new version</label>
          <input id="wf-new-version" name="version" placeholder="${nextLabel}" maxlength="30" aria-describedby="wf-new-version-help">
          <button class="btn" name="action" value="new">Create new version</button>
          <small id="wf-new-version-help" class="help">A copy of version ${row.version} to edit; the label is optional (${nextLabel}).</small>
        </form>`}
  </fieldset>
  <fieldset class="prop-group u-mt125"><legend>Diagram of version ${dev ? `${row.dev_version} (development)` : row.version}</legend>
    ${problems.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    ${warnings.length ? html`<div class="alert wf-warnings" role="status"><ul class="u-m0">${warnings.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    <div class="wf-wrap">${workflowDiagram(shown, { id: 'def' })}</div>
    <p class="muted small">Instances: ${counts.length ? counts.map((c, i) => html`${i ? ', ' : ''}${c.n} ${c.state}`) : 'none yet'}. Running instances keep the steps of the version they started with.</p>
  </fieldset>
  ${instances.length
    ? html`<fieldset class="prop-group u-mt125"><legend>Instances</legend>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th class="num">Id</th><th>Title</th><th>Version</th><th>State</th><th>At</th><th>Started</th></tr></thead><tbody>
          ${instances.map((w) => html`<tr${picked?.id === w.id ? raw(' aria-current="true"') : ''}>
            <td class="num" data-label="Id"><a href="?c=workflow_definition-${row.id}&amp;wf=${w.id}">${w.id}</a></td>
            <td data-label="Title">${w.title}</td>
            <td data-label="Version">${w.version ?? '1'}</td>
            <td data-label="State"><span class="tag${w.state === 'faulted' ? ' tag-error' : w.state === 'completed' || w.state === 'terminated' ? '' : ' tag-info'}">${w.state}</span></td>
            <td data-label="At">${w.active_steps.join(', ') || '—'}</td>
            <td data-label="Started">${when(w.started_at)} · ${w.initiator}</td></tr>`)}
        </tbody></table></div>
        ${picked && Array.isArray(pickedSteps)
          ? html`<h3 class="u-mt125">Instance ${picked.id}, version ${picked.version ?? '1'}${picked.active_steps.length ? `: at ${picked.active_steps.join(', ')}` : ''}</h3>
              <div class="wf-wrap">${workflowDiagram(pickedSteps, { active: picked.active_steps, id: `wf${picked.id}` })}</div>`
          : html`<p class="muted small">Pick an instance to see where it is in the diagram of its version.</p>`}
      </fieldset>`
    : ''}`;
}

export async function workflowBuilderRoutes(app: FastifyInstance) {
  // versions: create (a copy of the active one), activate, discard
  app.post(`${BASE}/apps/:id/shared/workflow_definition/:cid/versions`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { id, cid } = req.params as { id: string; cid: string };
    const d = /^\d{1,9}$/.test(id) && /^\d{1,9}$/.test(cid)
      ? await owner.one('select id, name, dev_version, dev_steps from meta.workflow_definition where id = $1 and app_id = $2', [cid, id])
      : undefined;
    if (!d) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    try {
      if (b.action === 'new') {
        const label = String(b.version ?? '').trim();
        if (label && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(label)) throw new Error('A version label is letters, digits, dots, dashes and underscores (at most 30).');
        const v = (await owner.one('select meta.new_workflow_version($1, $2) as v', [d.id, label || null])).v;
        flash(s, `Version ${v} created (development): edit its steps, then activate it.`);
      } else if (b.action === 'activate') {
        if (!d.dev_version) throw new Error('There is no version in development.');
        const tasks = new Set((await owner.query('select name from meta.task_definition where app_id = $1', [id])).rows.map((r) => r.name as string));
        const problems = stepProblems(d.dev_steps, tasks);
        if (problems.length) throw new Error(`Version ${d.dev_version} can't be activated: ${problems.join(' ')}`);
        const v = (await owner.one('select meta.activate_workflow_version($1) as v', [d.id])).v;
        flash(s, `Version ${v} is active: new instances start it.`);
      } else if (b.action === 'discard') {
        await owner.query('select meta.discard_workflow_version($1)', [d.id]);
        flash(s, d.dev_version ? `Version ${d.dev_version} discarded.` : 'There was no version in development.');
      } else return reply.code(400).send('Unknown action');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${id}/shared?c=workflow_definition-${d.id}`);
  });
}
