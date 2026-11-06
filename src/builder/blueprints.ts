import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { generate } from '../ai/service.ts';
import { AiError } from '../ai/types.ts';
import { blueprintJsonSchema, blueprintSql, buildBlueprint, checkBlueprint, COLUMN_TYPES, fromDraft, PAGE_TYPES, type Blueprint } from '../blueprint.ts';
import { owner } from '../db.ts';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { builderService } from './ai-builder.ts';
import { addDashboard } from './appsheets.ts';
import { finishGeneratedApp, checkNewApp, createApp, createAppError } from './newapp.ts';
import { currentWorkspace } from './workspaces.ts';
import { blueprintFromApp } from '../blueprint-from-app.ts';
import { devDbForApp } from '../workspace-db.ts';
import { isAdmin } from './locks.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { WIZARD_KINDS } from './wizards.ts';
import { scopedTx as tx } from './i18n.ts';

// Create → From a blueprint (migration 063, src/blueprint.ts): saved
// blueprints, an editor (JSON), an AI draft from a description (the App
// Builder's AI service, migration 062), the review (problems, or what will
// be created: tables as SQL, pages, menu, sample rows) and the creation,
// which only accepts a blueprint the review showed (a signature of its text
// made with the developer's session) and builds everything in one
// transaction.

export const EXAMPLE = {
  blueprint: 1,
  name: 'Projects',
  alias: 'projects',
  schema: 'projects',
  authentication: 'app_users',
  tables: [
    { name: 'project', label: 'Projects', columns: [
      { name: 'name', type: 'text', required: true, unique: true },
      { name: 'status', type: 'text', values: ['Planned', 'Active', 'Done'], required: true },
      { name: 'start_date', type: 'date' },
      { name: 'budget', type: 'number' },
    ] },
    { name: 'task', label: 'Tasks', columns: [
      { name: 'project_id', references: 'project', required: true },
      { name: 'title', type: 'text', required: true },
      { name: 'due', type: 'date' },
      { name: 'done', type: 'boolean' },
    ] },
  ],
  pages: [
    { type: 'report_form', table: 'project', page: 2, form_page: 3, label: 'Projects' },
    { type: 'report_form', table: 'task', page: 4, form_page: 5, label: 'Tasks' },
    { type: 'calendar', table: 'task', page: 6, label: 'Due dates' },
  ],
  dashboard: true,
  sample_data: [
    { table: 'project', columns: ['id', 'name', 'status', 'start_date', 'budget'], rows: [[1, 'Website', 'Active', '2026-09-01', 12000], [2, 'Office move', 'Planned', '2026-11-01', 30000]] },
    { table: 'task', columns: ['project_id', 'title', 'due', 'done'], rows: [[1, 'Design', '2026-10-15', true], [1, 'Build', '2026-11-30', false], [2, 'Find a place', '2026-10-31', false]] },
  ],
};

const MAX_SPEC_CHARS = 400_000;

/** A signature of the reviewed text, bound to the developer's session. */
const sign = (s: Session, spec: string) => createHmac('sha256', s.csrf_token).update(`blueprint:${spec}`).digest('base64url');
const signed = (s: Session, spec: string, sig: unknown) => {
  const want = Buffer.from(sign(s, spec));
  const got = Buffer.from(String(sig ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
};

function parse(spec: string): { json: unknown; error: string | null } {
  if (spec.length > MAX_SPEC_CHARS) return { json: null, error: tx('bp.too_long', { n: MAX_SPEC_CHARS }) };
  try {
    return { json: JSON.parse(spec), error: null };
  } catch (e) {
    return { json: null, error: tx('bp.bad_json', { error: (e as Error).message }) };
  }
}

const page = (s: Session, reply: FastifyReply, crumb: string, main: Raw) =>
  send(reply, s, shell(s, tx('bp.blueprints'), [[tx('bp.app_builder'), BASE], [tx('bp.create'), `${BASE}/create`], [tx('bp.blueprints'), `${BASE}/blueprints`], ...(crumb ? [[crumb] as [string]] : [])], html`<div class="ab-narrow">${main}</div>`));

async function editor(s: Session, reply: FastifyReply, o: { id?: number | null; name: string; spec: string; description?: string; message?: Raw }) {
  const svc = await builderService();
  return page(s, reply, o.id ? o.name : tx('bp.new_blueprint'), html`<h1>${o.id ? tx('bp.title', { name: o.name }) : tx('bp.new_blueprint')}</h1>
    <p class="muted">${tx.rich('bp.intro', { id: html`<code>id</code>`, references: html`<code>"references"</code>`, pages: PAGE_TYPES.join(', '), review: html`<b>${tx('bp.review')}</b>` })}</p>
    ${o.message ?? ''}
    ${region(tx('bp.draft_with_ai'), svc
      ? html`<form method="post" action="${BASE}/blueprints/draft">${csrf(s)}
          <input type="hidden" name="id" value="${o.id ?? ''}"><input type="hidden" name="name" value="${o.name}">
          <div class="field"><label class="label" for="f_description">${tx('bp.describe_the_application')}</label>
            <textarea id="f_description" name="description" rows="3" maxlength="4000" required placeholder="${tx('bp.e_g_track_projects_with')}">${o.description ?? ''}</textarea>
            <small class="help">${tx('bp.ai_help', { service: svc.name })}</small></div>
          <div class="buttons"><button class="btn" data-busy="${tx('bp.thinking')}">${tx('bp.draft_a_blueprint')}</button></div>
        </form>`
      : html`<p class="muted">${tx.rich('bp.no_service', { link: html`<a href="${BASE}/sql/ai">${tx('bp.sql_workshop_ai')}</a>` })}</p>`)}
    ${region(tx('bp.blueprint'), html`<form method="post" action="${BASE}/blueprints/review">${csrf(s)}
      <input type="hidden" name="id" value="${o.id ?? ''}">
      <div class="form-grid"><div class="field"><label class="label" for="f_name">${tx('bp.name')}</label><input id="f_name" name="name" maxlength="100" required value="${o.name}"></div></div>
      <div class="field"><label class="label" for="f_spec">JSON</label>
        <textarea id="f_spec" name="spec" class="code" rows="24" spellcheck="false" data-code="json">${o.spec}</textarea>
        <small class="help">${tx.rich('bp.spec_help', { types: Object.keys(COLUMN_TYPES).join(', '), required: html`<code>"required"</code>`, unique: html`<code>"unique"</code>`, values: html`<code>"values"</code>`, kinds: WIZARD_KINDS.map(([k]) => k).join(', '), text: html`<code>"text"</code>`, dashboard: html`<code>"dashboard": true</code>`, navigation: html`<code>"navigation": [{"label", "page", "icon"}]</code>`, sample: html`<code>"sample_data": [{"table", "columns", "rows"}]</code>` })}</small></div>
      <div class="buttons"><button class="btn btn-hot">${tx('bp.review')}</button><button class="btn" formaction="${BASE}/blueprints/save">${tx('bp.save')}</button></div>
    </form>`)}`);
}

function review(s: Session, bp: Blueprint, spec: string, id: number | null, name: string): Raw {
  const sql = blueprintSql(bp);
  const rows = (t: string) => bp.sample_data.filter((d) => d.table === t).reduce((n, d) => n + d.rows.length, 0);
  return html`<h1>Review: ${bp.name}</h1>
    <p class="muted">${tx('bp.this_is_what_the_blueprint')}</p>
    ${region(tx('bp.application'), html`<dl class="bp-facts">
      <dt>${tx('bp.name')}</dt><dd>${bp.name}</dd><dt>${tx('bp.alias')}</dt><dd><code>/a/${bp.alias}</code></dd>
      <dt>${tx('bp.schema')}</dt><dd><code>${bp.schema}</code> ${tx.rich('bp.db_role', { role: html`<code>app_${bp.alias.replace(/-/g, '_')}</code>` })}</dd>
      <dt>${tx('bp.sign_in')}</dt><dd>${bp.authentication === 'none' ? 'none: every page is public' : 'a login page (application users)'}</dd></dl>`)}
    ${region(tx('bp.tables'), html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">${tx('bp.table')}</th><th scope="col">${tx('bp.columns')}</th><th scope="col" class="num">${tx('bp.sample_rows')}</th></tr></thead><tbody>
      ${bp.tables.map((t) => html`<tr><td data-label="${tx('bp.table')}"><code>${t.name}</code>${t.label ? html` <span class="muted">${t.label}</span>` : ''}</td>
        <td data-label="${tx('bp.columns')}">${t.columns.map((c, i) => html`${i ? ', ' : ''}<code>${c.name}</code> <span class="muted">${c.references ? `→ ${c.references}` : c.type}${c.required ? ', required' : ''}${c.unique ? ', unique' : ''}${c.values.length ? `, ${c.values.join(' / ')}` : ''}</span>`)}</td>
        <td data-label="${tx('bp.sample_rows')}" class="num">${rows(t.name)}</td></tr>`)}
    </tbody></table></div>
    <details class="u-mt1"><summary>${tx('bp.the_sql')}</summary><pre class="bp-sql">${sql.join(';\n\n')};</pre></details>`)}
    ${region(tx('bp.pages'), html`<ul>${bp.pages.map((p) => html`<li>Page ${p.page}${p.form_page ? html` and ${p.form_page}` : ''}: ${p.label} <span class="muted">(${p.type}${p.table ? ` on ${p.table}` : ''})</span></li>`)}
      ${bp.dashboard ? html`<li>${tx('bp.a_dashboard_with_charts_per')}</li>` : ''}</ul>
      ${bp.navigation ? html`<p>Menu: ${bp.navigation.map((n) => n.label).join(' · ')}</p>` : html`<p class="muted">${tx('bp.menu_home_and_the_pages')}</p>`}`)}
    ${region(tx('bp.create_the_application'), html`<form method="post" action="${BASE}/blueprints/create">${csrf(s)}
      <input type="hidden" name="id" value="${id ?? ''}"><input type="hidden" name="name" value="${name}">
      <input type="hidden" name="spec" value="${spec}"><input type="hidden" name="sig" value="${sign(s, spec)}">
      ${bp.authentication === 'none' ? '' : html`<div class="form-grid">
        <div class="field"><label class="label" for="f_admin_user">${tx('bp.first_user_admin_role')}</label><input id="f_admin_user" name="admin_user" required value="${s.username}" autocomplete="off"></div>
        <div class="field"><label class="label" for="f_admin_password">${tx('bp.password_for_a_new_account')}</label><input id="f_admin_password" name="admin_password" type="password" autocomplete="new-password"></div>
      </div>`}
      <div class="buttons"><button class="btn" formaction="${BASE}/blueprints/edit">${tx('bp.back_to_the_editor')}</button><button class="btn btn-hot">${icon('plus')} ${tx('bp.create_the_application')}</button></div>
    </form>`)}`;
}

/**
 * (sprint 61) Open a blueprint (e.g. a starter app of the App Gallery): its review when it can be
 * created, else the editor with its problems. Nothing is created before the developer confirms.
 */
export async function openBlueprint(s: Session, reply: FastifyReply, name: string, spec: string) {
  const { json, error } = parse(spec);
  const { blueprint, problems } = error ? { blueprint: null, problems: [error] } : checkBlueprint(json);
  const taken = blueprint ? await owner.one('select 1 from meta.app where alias = $1', [blueprint.alias]) : null;
  if (taken) problems.push(tx('bp.alias_taken', { alias: blueprint!.alias }));
  if (!blueprint || problems.length)
    return editor(s, reply, { name, spec, message: html`<div class="alert alert-error" role="alert"><p>${tx('bp.the_blueprint_can_t_be')}</p><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` });
  return page(s, reply, tx('bp.review_title'), review(s, blueprint, spec, null, name));
}

export async function blueprintRoutes(app: FastifyInstance) {
  app.get(`${BASE}/blueprints`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const list = (await owner.query(`select b.id, b.name, b.created_by, b.updated_at::text as updated, a.id as app_id, a.alias from meta.blueprint b left join meta.app a on a.id = b.app_id where b.workspace_id = $1 order by lower(b.name), b.id`, [currentWorkspace(s)])).rows;
    const apps = (await owner.query(`select id, name, alias from meta.app where meta.app_workspace(id) = $1 order by lower(name), id`, [currentWorkspace(s)])).rows;
    return page(s, reply, '', html`<h1>${tx('bp.blueprints')}</h1>
      <p class="muted">${tx('bp.list_intro')} <a class="btn btn-hot" href="${BASE}/blueprints/new">${icon('plus')} ${tx('bp.new_blueprint')}</a></p>
      ${list.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">${tx('bp.blueprint')}</th><th scope="col">${tx('bp.application_created')}</th><th scope="col">${tx('bp.changed')}</th><th scope="col"></th></tr></thead><tbody>
            ${list.map((x) => html`<tr><td data-label="${tx('bp.blueprint')}"><a href="${BASE}/blueprints/${x.id}">${x.name}</a> <span class="muted">${x.created_by ?? ''}</span></td>
              <td data-label="${tx('bp.application_created')}">${x.app_id ? html`<a href="${BASE}/apps/${x.app_id}">${x.alias}</a>` : '—'}</td><td data-label="${tx('bp.changed')}">${String(x.updated).slice(0, 16)}</td>
              <td><form method="post" action="${BASE}/blueprints/${x.id}/delete">${csrf(s)}<button class="btn btn-small">${tx('bp.delete')}</button></form></td></tr>`)}
          </tbody></table></div>`
        : html`<p class="muted">${tx('bp.no_saved_blueprints_yet')}</p>`}
      ${apps.length ? region(tx('bp.from_an_application'), html`<form method="post" action="${BASE}/blueprints/from-app">${csrf(s)}
        <p class="muted u-mt0">${tx('bp.a_blueprint_of_an_application')}</p>
        <div class="form-grid">
          <div class="field"><label class="label" for="f_bp_app">${tx('bp.application')}</label><select id="f_bp_app" name="app">${apps.map((a) => html`<option value="${a.id}">${a.name} (${a.alias})</option>`)}</select></div>
          <div class="field"><label class="check"><input type="checkbox" name="rows" value="true"> ${tx('bp.sample_rows_up_to_20')}</label>
            <small class="help">${tx('bp.the_rows_are_copied_into')}</small></div>
        </div>
        <div class="buttons"><button class="btn">${icon('layers')} ${tx('bp.create_a_blueprint')}</button></div></form>`) : ''}`);
  });

  // (sprint 66) a blueprint from an application of the current workspace, opened in the editor
  app.post(`${BASE}/blueprints/from-app`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const id = /^\d{1,9}$/.test(String(req.body?.app ?? '')) ? Number(req.body!.app) : null;
    const a = id === null ? null : await owner.one<{ id: number; name: string }>(
      `select id, name from meta.app where id = $1 and (meta.app_workspace(id) = $2 or $3)`, [id, currentWorkspace(s), await isAdmin(s.username)]);
    if (!a) return reply.code(404).send('Not found');
    const rows = req.body?.rows === 'true';
    const { spec, notes } = await blueprintFromApp(a.id, { sampleRows: rows ? await devDbForApp(a.id) : null });
    await logActivity({ appId: a.id, username: s.username, event: 'blueprint', ip: clientIp(req), detail: `blueprint from the application${rows ? ', with sample rows' : ''}` });
    return editor(s, reply, {
      name: `${a.name} blueprint`.slice(0, 100), spec: JSON.stringify(spec, null, 2),
      message: html`<div class="alert alert-info" role="status"><p>${tx.rich('bp.of_app', { app: a.name, review: html`<b>${tx('bp.review')}</b>` })}</p>
        ${notes.length ? html`<details><summary>${notes.length === 1 ? tx('bp.notes_1') : tx('bp.notes', { n: notes.length })}</summary><ul>${notes.map((n) => html`<li>${n}</li>`)}</ul></details>` : ''}</div>`,
    });
  });

  app.get(`${BASE}/blueprints/new`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return editor(s, reply, { name: tx('bp.projects'), spec: JSON.stringify(EXAMPLE, null, 2) });
  });

  app.get(`${BASE}/blueprints/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = await owner.one('select id, name, spec from meta.blueprint where id = $1 and workspace_id = $2', [req.params.id, currentWorkspace(s)]);
    if (!b) return reply.code(404).send('Not found');
    return editor(s, reply, { id: b.id, name: b.name, spec: JSON.stringify(b.spec, null, 2) });
  });

  const posted = (req: Req) => {
    const b = req.body ?? {};
    return { id: /^\d{1,9}$/.test(String(b.id ?? '')) ? Number(b.id) : null, name: String(b.name ?? '').trim().slice(0, 100) || 'Blueprint', spec: String(b.spec ?? '') };
  };

  app.post(`${BASE}/blueprints/edit`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return editor(s, reply, posted(req));
  });

  app.post(`${BASE}/blueprints/save`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = posted(req);
    const { json, error } = parse(o.spec);
    if (error || !json || typeof json !== 'object' || Array.isArray(json))
      return editor(s, reply, { ...o, message: html`<div class="alert alert-error" role="alert">${error ?? 'A blueprint is a JSON object.'}</div>` });
    const id = o.id
      ? (await owner.one('update meta.blueprint set name = $2, spec = $3, updated_at = now() where id = $1 and workspace_id = $4 returning id', [o.id, o.name, JSON.stringify(json), currentWorkspace(s)]))?.id
      : (await owner.one('insert into meta.blueprint (name, spec, created_by, workspace_id) values ($1, $2, $3, $4) returning id', [o.name, JSON.stringify(json), s.username, currentWorkspace(s)])).id;
    if (!id) return reply.code(404).send('Not found');
    flash(s, tx('bp.saved', { name: o.name }));
    return back(reply, s, `${BASE}/blueprints/${id}`);
  });

  app.post(`${BASE}/blueprints/draft`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = posted(req);
    const description = String(req.body?.description ?? '').trim().slice(0, 4000);
    try {
      const svc = await builderService();
      if (!svc) throw new AiError('config', tx('bp.the_app_builder_has_no'));
      if (!description) throw new AiError('config', tx('bp.describe_the_application_2'));
      const res = await generate(svc.name, {
        system: 'You design small business web applications on PostgreSQL as blueprints. Use singular lower-case table names, a few meaningful columns per table, '
          + '"references" for relations (never an id column: every table has one), "values" for short fixed lists, and pages of the given types (report_form for the main tables; '
          + 'calendar for dated rows; chart, cards or facets where they help). Page numbers start at 2 and are unique; a report_form also needs a form_page. '
          + 'Add 3 to 8 realistic sample rows per table (give parents an id so children can refer to it). Keep the alias and schema short, lower case.',
        prompt: description,
        schema: blueprintJsonSchema(),
      }, { appId: null, user: s.username, source: 'builder' });
      const spec = JSON.stringify(fromDraft(res.json), null, 2);
      return editor(s, reply, { ...o, name: o.id ? o.name : String((res.json as any)?.name ?? o.name).slice(0, 100), spec, description,
        message: html`<div class="alert alert-info">${tx('bp.drafted_by_ai_review_it')}</div>` });
    } catch (e) {
      return editor(s, reply, { ...o, description, message: html`<div class="alert alert-error" role="alert">${(e as Error).message}</div>` });
    }
  });

  app.post(`${BASE}/blueprints/review`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = posted(req);
    const { json, error } = parse(o.spec);
    const { blueprint, problems } = error ? { blueprint: null, problems: [error] } : checkBlueprint(json);
    const taken = blueprint ? await owner.one('select 1 from meta.app where alias = $1', [blueprint.alias]) : null;
    if (taken) problems.push(tx('bp.alias_taken_short', { alias: blueprint!.alias }));
    if (!blueprint || problems.length)
      return editor(s, reply, { ...o, message: html`<div class="alert alert-error" role="alert"><p>${tx('bp.the_blueprint_can_t_be')}</p><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` });
    return page(s, reply, tx('bp.review_title'), review(s, blueprint, o.spec, o.id, o.name));
  });

  app.post(`${BASE}/blueprints/create`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = posted(req);
    const b = req.body ?? {};
    // only what the review showed this developer
    if (!signed(s, o.spec, b.sig)) return reply.code(403).send('Review the blueprint before you create the application.');
    const { json, error } = parse(o.spec);
    const { blueprint, problems } = error ? { blueprint: null, problems: [error] } : checkBlueprint(json);
    if (!blueprint) return editor(s, reply, { ...o, message: html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` });
    try {
      const checked = await checkNewApp({ name: blueprint.name, alias: blueprint.alias, schema: blueprint.schema, authentication: blueprint.authentication, admin_user: String(b.admin_user ?? ''), admin_password: String(b.admin_password ?? '') }, currentWorkspace(s));
      const built = await owner.tx(async (c) => {
        const a = await createApp(c, checked).catch((e) => {
          throw new Error(createAppError(e, checked.alias));
        });
        const r = await buildBlueprint(c, blueprint, checked.role, { dashboard: (tables, no) => addDashboard(c, checked.alias, tables, no) });
        await finishGeneratedApp(c, a.id, { description: checked.description });
        if (o.id) await c.query('update meta.blueprint set app_id = $2, spec = $3, updated_at = now() where id = $1 and workspace_id = $4', [o.id, a.id, JSON.stringify(json), currentWorkspace(s)]);
        else await c.query('insert into meta.blueprint (name, spec, created_by, app_id, workspace_id) values ($1, $2, $3, $4, $5)', [o.name, JSON.stringify(json), s.username, a.id, currentWorkspace(s)]);
        return { ...r, existing: a.existingAccount };
      });
      await logActivity({ username: s.username, event: 'blueprint', ip: clientIp(req), detail: `created ${blueprint.alias} from blueprint ${o.name}` });
      flash(s, `${tx('bp.created', { alias: blueprint.alias, tables: blueprint.tables.length, rows: built.rows })}${built.existing ? ` ${tx('bp.admin_role', { user: String(b.admin_user) })}` : ''}`);
      return back(reply, s, `${BASE}/apps/${built.appId}`);
    } catch (e) {
      return page(s, reply, tx('bp.review_title'), html`<div class="alert alert-error" role="alert">${tx('bp.not_created', { error: (e as Error).message })}</div>${review(s, blueprint, o.spec, o.id, o.name)}`);
    }
  });

  app.post(`${BASE}/blueprints/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.query('delete from meta.blueprint where id = $1 and workspace_id = $2', [req.params.id, currentWorkspace(s)]);
    flash(s, r.rowCount ? tx('bp.blueprint_deleted_applications_created_from') : tx('bp.there_is_no_such_blueprint'));
    return back(reply, s, `${BASE}/blueprints`);
  });
}

