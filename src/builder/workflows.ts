import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import type { Session } from '../session.ts';
import { invokeStepReferences, outcomeMap, stepProblems, stepWarnings, workflowDiagram, type Step } from '../workflow.ts';
import type { ComponentSpec } from './components.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';
import { scopedTx as tx, type BuilderKey } from './i18n.ts';

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
  // (123) a new definition's steps are its active version 1: no drafts there
  const hasDraft = (v: unknown) => {
    try {
      const x = typeof v === 'string' ? JSON.parse(v) : v;
      return Array.isArray(x) && x.some((st) => st?.type === 'draft');
    } catch {
      return false;
    }
  };
  if (!cid && hasDraft(values.steps)) throw new Error(tx('wfv.draft_new'));
  if (!cid || values.steps === undefined) return;
  const d = await owner.one('select version, dev_version, steps = $2::jsonb as same from meta.workflow_definition where id = $1', [cid, values.steps]);
  if (!d) return;
  if (d.dev_version !== null) {
    values.dev_steps = values.steps;
    delete values.steps;
  } else if (d.same) delete values.steps;
  else if (hasDraft(values.steps)) throw new Error(tx('wfv.draft_active', { version: d.version }));
  else throw new Error(tx('wfv.active_fixed', { version: d.version }));
}

export async function workflowExtras(appId: number, row: Definition, s: Session, query: Record<string, string | undefined> = {}) {
  const taskDefs = (await owner.query('select name, type, outcomes from meta.task_definition where app_id = $1', [appId])).rows;
  const tasks = new Set(taskDefs.map((r) => r.name as string));
  const outcomes = outcomeMap(taskDefs);
  const dev = row.dev_version !== null && row.dev_version !== undefined;
  const shown = dev ? (row.dev_steps ?? []) : row.steps;
  const refs = {
    sources: new Map((await owner.query('select name, params, columns from meta.rest_source where app_id = $1', [appId])).rows.map((r) => [r.name as string, r])),
    // (141) the application's credentials and its workspace's
    credentials: new Set((await owner.query('select name from meta.web_credential where app_id = $1 union select name from meta.workspace_credential where workspace_id = meta.app_workspace($1)', [appId])).rows.map((r) => r.name as string)),
    startVars: [...String((row as { title?: string }).title ?? '').matchAll(/&([A-Za-z][A-Za-z0-9_]*)\./g)].map((m) => m[1]),
  };
  const invokeRefs = invokeStepReferences(shown, refs);
  const problems = [...stepProblems(shown, tasks, { outcomes, drafts: dev }), ...invokeRefs.errors];
  const drafts = dev ? (row.dev_steps ?? []).filter((x) => x?.type === 'draft').map((x) => x.name) : [];
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
  const base = `${BASE}/apps/${appId}/shared/workflow_definition/${row.id}`;
  const action = `${base}/versions`;
  const usage = (v: string) => {
    const u = perVersion.get(v);
    return u ? `${u.n}${u.running ? ` ${tx('wfv.running', { n: u.running })}` : ''}` : '0';
  };
  const inactive = Array.isArray(row.inactive_versions) ? row.inactive_versions : [];
  const nextLabel = String(Math.max(0, ...[row.version, ...inactive.map((v) => v.version)].filter((v) => /^\d{1,9}$/.test(v)).map(Number)) + 1);
  const versions = [
    ...(dev ? [{ version: row.dev_version!, state: 'development', at: null as string | null, steps: row.dev_steps ?? [] }] : []),
    { version: row.version, state: 'active', at: row.activated_at, steps: row.steps },
    ...[...inactive].reverse().map((v) => ({ version: v.version, state: 'inactive', at: v.activated_at, steps: v.steps })),
  ];
  return html`<fieldset class="prop-group u-mt125"><legend>${tx('wfv.versions')}</legend>
    <p class="muted u-mt0">${tx.rich('wfv.intro', { active: html`<b>${tx('wfv.state.active')}</b>`, development: html`<b>${tx('wfv.state.development')}</b>` })}</p>
    <div class="table-wrap"><table class="report report-reflow wf-versions"><thead><tr><th>${tx('wfv.version')}</th><th>${tx('wfv.state')}</th><th>${tx('wfv.activated')}</th><th class="num">${tx('wfv.instances')}</th><th></th></tr></thead><tbody>
      ${versions.map((v, i) => html`<tr>
        <td data-label="${tx('wfv.version')}"><b>${v.version}</b></td>
        <td data-label="${tx('wfv.state')}"><span class="tag${v.state === 'active' ? ' tag-info' : v.state === 'development' ? ' tag-warning' : ''}">${tx(`wfv.state.${v.state}` as BuilderKey)}</span></td>
        <td data-label="${tx('wfv.activated')}">${v.state === 'development' ? '—' : when(v.at)}</td>
        <td class="num" data-label="${tx('wfv.instances')}">${usage(v.version)}</td>
        <td data-label="">${v.state === 'development'
          ? html`<form method="post" action="${action}" class="wf-version-actions">${csrf(s)}
              <button class="btn btn-hot" name="action" value="activate"${problems.length || drafts.length ? raw(' disabled') : ''} data-confirm="${tx('wfv.activate_confirm', { version: v.version })}">${tx('wfv.activate')}</button>
              <button class="btn btn-danger" name="action" value="discard" data-confirm="${tx('wfv.discard_confirm', { version: v.version })}">${tx('wfv.discard')}</button></form>`
          : v.steps !== shown ? html`<details class="wf-version-diagram"><summary>${tx('wfv.diagram')}</summary><div class="wf-wrap">${workflowDiagram(v.steps, { id: `v${i}` })}</div></details>` : ''}</td>
      </tr>`)}
    </tbody></table></div>
    ${dev
      ? ''
      : html`<form method="post" action="${action}" class="search u-mwnone u-mt075">${csrf(s)}
          <label class="sr-only" for="wf-new-version">${tx('wfv.new_label')}</label>
          <input id="wf-new-version" name="version" placeholder="${nextLabel}" maxlength="30" aria-describedby="wf-new-version-help">
          <button class="btn" name="action" value="new">${tx('wfv.new')}</button>
          <small id="wf-new-version-help" class="help">${tx('wfv.new_help', { version: row.version, next: nextLabel })}</small>
        </form>`}
  </fieldset>
  <fieldset class="prop-group u-mt125"><legend>${dev ? tx('wfv.diagram_dev', { version: row.dev_version! }) : tx('wfv.diagram_of', { version: row.version })}</legend>
    ${problems.length ? html`<div class="alert alert-error" role="alert"><ul class="u-m0">${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    ${warnings.length ? html`<div class="alert wf-warnings" role="status"><ul class="u-m0">${warnings.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    ${drafts.length ? html`<div class="alert wf-warnings" role="status">${tx('wfv.drafts', { steps: drafts.join(', '), version: row.dev_version! })}</div>` : ''}
    <div class="wf-wrap">${workflowDiagram(shown, { id: 'def' })}</div>
    <p class="wf-export">
      <a class="btn btn-sm" href="${`${base}/diagram.svg?v=${encodeURIComponent(dev ? row.dev_version! : row.version)}`}" download data-wf-svg>${tx('wfv.svg')}</a>
      <button type="button" class="btn btn-sm" data-wf-png hidden>${tx('wfv.png')}</button>
    </p>
    <p class="muted small">${tx.rich('wfv.counts', { counts: counts.length ? html`${counts.map((c, i) => html`${i ? ', ' : ''}${c.n} ${c.state}`)}` : tx('wfv.none_yet') })}</p>
  </fieldset>
  ${instances.length
    ? html`<fieldset class="prop-group u-mt125"><legend>${tx('wfv.instances')}</legend>
        ${instances.some((w) => ['active', 'waiting', 'faulted'].includes(w.state) && (w.version ?? '1') !== row.version)
          ? html`<p class="u-mt0"><a class="btn btn-sm" href="${`${base}/migrate`}" title="${tx('wfv.migrate_title')}">${tx('wfv.migrate')}</a></p>` : ''}
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th class="num">${tx('wfv.id')}</th><th>${tx('wfv.title')}</th><th>${tx('wfv.version')}</th><th>${tx('wfv.state')}</th><th>${tx('wfv.at')}</th><th>${tx('wfv.started')}</th></tr></thead><tbody>
          ${instances.map((w) => html`<tr${picked?.id === w.id ? raw(' aria-current="true"') : ''}>
            <td class="num" data-label="${tx('wfv.id')}"><a href="?c=workflow_definition-${row.id}&amp;wf=${w.id}">${w.id}</a></td>
            <td data-label="${tx('wfv.title')}">${w.title}</td>
            <td data-label="${tx('wfv.version')}">${w.version ?? '1'}</td>
            <td data-label="${tx('wfv.state')}"><span class="tag${w.state === 'faulted' ? ' tag-error' : w.state === 'completed' || w.state === 'terminated' ? '' : ' tag-info'}">${w.state}</span></td>
            <td data-label="${tx('wfv.at')}">${w.active_steps.join(', ') || '—'}</td>
            <td data-label="${tx('wfv.started')}">${when(w.started_at)} · ${w.initiator}</td></tr>`)}
        </tbody></table></div>
        ${picked && Array.isArray(pickedSteps)
          ? html`<h3 class="u-mt125">${picked.active_steps.length ? tx('wfv.instance_at', { id: picked.id, version: picked.version ?? '1', steps: picked.active_steps.join(', ') }) : tx('wfv.instance', { id: picked.id, version: picked.version ?? '1' })}</h3>
              <div class="wf-wrap">${workflowDiagram(pickedSteps, { active: picked.active_steps, id: `wf${picked.id}` })}</div>`
          : html`<p class="muted small">${tx('wfv.pick')}</p>`}
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
        if (label && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(label)) throw new Error(tx('wfv.bad_label'));
        const v = (await owner.one('select meta.new_workflow_version($1, $2) as v', [d.id, label || null])).v;
        flash(s, tx('wfv.created', { version: v }));
      } else if (b.action === 'activate') {
        if (!d.dev_version) throw new Error(tx('wfv.no_dev'));
        const tasks = new Set((await owner.query('select name from meta.task_definition where app_id = $1', [id])).rows.map((r) => r.name as string));
        const outcomes = outcomeMap((await owner.query('select name, type, outcomes from meta.task_definition where app_id = $1', [id])).rows);
        const problems = stepProblems(d.dev_steps, tasks, { outcomes, drafts: false });
        if (problems.length) throw new Error(tx('wfv.cant_activate', { version: d.dev_version, problems: problems.join(' ') }));
        const v = (await owner.one('select meta.activate_workflow_version($1) as v', [d.id])).v;
        flash(s, tx('wfv.activated_flash', { version: v }));
      } else if (b.action === 'discard') {
        await owner.query('select meta.discard_workflow_version($1)', [d.id]);
        flash(s, d.dev_version ? tx('wfv.discarded', { version: d.dev_version }) : tx('wfv.was_no_dev'));
      } else return reply.code(400).send('Unknown action');
    } catch (e) {
      flash(s, (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${id}/shared?c=workflow_definition-${d.id}`);
  });
}
