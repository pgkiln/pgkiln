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
import { checkNewApp, createApp, createAppError } from './newapp.ts';
import { currentWorkspace } from './workspaces.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { WIZARD_KINDS } from './wizards.ts';

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
  if (spec.length > MAX_SPEC_CHARS) return { json: null, error: `The blueprint is too long (at most ${MAX_SPEC_CHARS} characters).` };
  try {
    return { json: JSON.parse(spec), error: null };
  } catch (e) {
    return { json: null, error: `Not valid JSON: ${(e as Error).message}` };
  }
}

const page = (s: Session, reply: FastifyReply, crumb: string, main: Raw) =>
  send(reply, s, shell(s, 'Blueprints', [['App Builder', BASE], ['Create', `${BASE}/create`], ['Blueprints', `${BASE}/blueprints`], ...(crumb ? [[crumb] as [string]] : [])], html`<div class="ab-narrow">${main}</div>`));

async function editor(s: Session, reply: FastifyReply, o: { id?: number | null; name: string; spec: string; description?: string; message?: Raw }) {
  const svc = await builderService();
  return page(s, reply, o.id ? o.name : 'New blueprint', html`<h1>${o.id ? `Blueprint: ${o.name}` : 'New blueprint'}</h1>
    <p class="muted">A blueprint describes an application: its tables (every table gets an <code>id</code>; <code>"references"</code> makes a foreign key), pages (${PAGE_TYPES.join(', ')}), menu and sample rows. <b>Review</b> shows what it will create; nothing is created before you confirm it there.</p>
    ${o.message ?? ''}
    ${region('Draft with AI', svc
      ? html`<form method="post" action="${BASE}/blueprints/draft">${csrf(s)}
          <input type="hidden" name="id" value="${o.id ?? ''}"><input type="hidden" name="name" value="${o.name}">
          <div class="field"><label class="label" for="f_description">Describe the application</label>
            <textarea id="f_description" name="description" rows="3" maxlength="4000" required placeholder="e.g. Track projects with tasks and due dates, and the hours people spend on them">${o.description ?? ''}</textarea>
            <small class="help">The AI service ${svc.name} writes a blueprint into the editor below (replacing what is there). Only your description is sent.</small></div>
          <div class="buttons"><button class="btn" data-busy="Thinking…">Draft a blueprint</button></div>
        </form>`
      : html`<p class="muted">The App Builder has no AI service: an administrator chooses one under <a href="${BASE}/sql/ai">SQL Workshop → AI</a>. You can write the blueprint yourself.</p>`)}
    ${region('Blueprint', html`<form method="post" action="${BASE}/blueprints/review">${csrf(s)}
      <input type="hidden" name="id" value="${o.id ?? ''}">
      <div class="form-grid"><div class="field"><label class="label" for="f_name">Name</label><input id="f_name" name="name" maxlength="100" required value="${o.name}"></div></div>
      <div class="field"><label class="label" for="f_spec">JSON</label>
        <textarea id="f_spec" name="spec" class="code" rows="24" spellcheck="false" data-code="json">${o.spec}</textarea>
        <small class="help">Column types: ${Object.keys(COLUMN_TYPES).join(', ')}; <code>"required"</code>, <code>"unique"</code>, <code>"values"</code> (allowed texts). Page types: ${WIZARD_KINDS.map(([k]) => k).join(', ')} and blank (<code>"text"</code>). Optional: <code>"dashboard": true</code>, <code>"navigation": [{"label", "page", "icon"}]</code>, <code>"sample_data": [{"table", "columns", "rows"}]</code>.</small></div>
      <div class="buttons"><button class="btn btn-hot">Review</button><button class="btn" formaction="${BASE}/blueprints/save">Save</button></div>
    </form>`)}`);
}

function review(s: Session, bp: Blueprint, spec: string, id: number | null, name: string): Raw {
  const sql = blueprintSql(bp);
  const rows = (t: string) => bp.sample_data.filter((d) => d.table === t).reduce((n, d) => n + d.rows.length, 0);
  return html`<h1>Review: ${bp.name}</h1>
    <p class="muted">This is what the blueprint creates. Check it; go back to change it, or create the application.</p>
    ${region('Application', html`<dl class="bp-facts">
      <dt>Name</dt><dd>${bp.name}</dd><dt>Alias</dt><dd><code>/a/${bp.alias}</code></dd>
      <dt>Schema</dt><dd><code>${bp.schema}</code> (database role <code>app_${bp.alias.replace(/-/g, '_')}</code>)</dd>
      <dt>Sign-in</dt><dd>${bp.authentication === 'none' ? 'none: every page is public' : 'a login page (application users)'}</dd></dl>`)}
    ${region('Tables', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">Table</th><th scope="col">Columns</th><th scope="col" class="num">Sample rows</th></tr></thead><tbody>
      ${bp.tables.map((t) => html`<tr><td data-label="Table"><code>${t.name}</code>${t.label ? html` <span class="muted">${t.label}</span>` : ''}</td>
        <td data-label="Columns">${t.columns.map((c, i) => html`${i ? ', ' : ''}<code>${c.name}</code> <span class="muted">${c.references ? `→ ${c.references}` : c.type}${c.required ? ', required' : ''}${c.unique ? ', unique' : ''}${c.values.length ? `, ${c.values.join(' / ')}` : ''}</span>`)}</td>
        <td data-label="Sample rows" class="num">${rows(t.name)}</td></tr>`)}
    </tbody></table></div>
    <details class="u-mt1"><summary>The SQL</summary><pre class="bp-sql">${sql.join(';\n\n')};</pre></details>`)}
    ${region('Pages', html`<ul>${bp.pages.map((p) => html`<li>Page ${p.page}${p.form_page ? html` and ${p.form_page}` : ''}: ${p.label} <span class="muted">(${p.type}${p.table ? ` on ${p.table}` : ''})</span></li>`)}
      ${bp.dashboard ? html`<li>A dashboard with charts per table</li>` : ''}</ul>
      ${bp.navigation ? html`<p>Menu: ${bp.navigation.map((n) => n.label).join(' · ')}</p>` : html`<p class="muted">Menu: Home and the pages' own entries.</p>`}`)}
    ${region('Create the application', html`<form method="post" action="${BASE}/blueprints/create">${csrf(s)}
      <input type="hidden" name="id" value="${id ?? ''}"><input type="hidden" name="name" value="${name}">
      <input type="hidden" name="spec" value="${spec}"><input type="hidden" name="sig" value="${sign(s, spec)}">
      ${bp.authentication === 'none' ? '' : html`<div class="form-grid">
        <div class="field"><label class="label" for="f_admin_user">First user (admin role)</label><input id="f_admin_user" name="admin_user" required value="${s.username}" autocomplete="off"></div>
        <div class="field"><label class="label" for="f_admin_password">Password (for a new account)</label><input id="f_admin_password" name="admin_password" type="password" autocomplete="new-password"></div>
      </div>`}
      <div class="buttons"><button class="btn" formaction="${BASE}/blueprints/edit">Back to the editor</button><button class="btn btn-hot">${icon('plus')} Create the application</button></div>
    </form>`)}`;
}

export async function blueprintRoutes(app: FastifyInstance) {
  app.get(`${BASE}/blueprints`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const list = (await owner.query(`select b.id, b.name, b.created_by, b.updated_at::text as updated, a.id as app_id, a.alias from meta.blueprint b left join meta.app a on a.id = b.app_id order by lower(b.name), b.id`)).rows;
    return page(s, reply, '', html`<h1>Blueprints</h1>
      <p class="muted">Describe an application as a blueprint (tables, pages, menu, sample rows), review it and create it. <a class="btn btn-hot" href="${BASE}/blueprints/new">${icon('plus')} New blueprint</a></p>
      ${list.length
        ? html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th scope="col">Blueprint</th><th scope="col">Application created</th><th scope="col">Changed</th><th scope="col"></th></tr></thead><tbody>
            ${list.map((x) => html`<tr><td data-label="Blueprint"><a href="${BASE}/blueprints/${x.id}">${x.name}</a> <span class="muted">${x.created_by ?? ''}</span></td>
              <td data-label="Application created">${x.app_id ? html`<a href="${BASE}/apps/${x.app_id}">${x.alias}</a>` : '—'}</td><td data-label="Changed">${String(x.updated).slice(0, 16)}</td>
              <td><form method="post" action="${BASE}/blueprints/${x.id}/delete">${csrf(s)}<button class="btn btn-small">Delete</button></form></td></tr>`)}
          </tbody></table></div>`
        : html`<p class="muted">No saved blueprints yet.</p>`}`);
  });

  app.get(`${BASE}/blueprints/new`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return editor(s, reply, { name: 'Projects', spec: JSON.stringify(EXAMPLE, null, 2) });
  });

  app.get(`${BASE}/blueprints/:id(^\\d+$)`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = await owner.one('select id, name, spec from meta.blueprint where id = $1', [req.params.id]);
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
      ? (await owner.one('update meta.blueprint set name = $2, spec = $3, updated_at = now() where id = $1 returning id', [o.id, o.name, JSON.stringify(json)]))?.id
      : (await owner.one('insert into meta.blueprint (name, spec, created_by) values ($1, $2, $3) returning id', [o.name, JSON.stringify(json), s.username])).id;
    if (!id) return reply.code(404).send('Not found');
    flash(s, `Blueprint ${o.name} saved.`);
    return back(reply, s, `${BASE}/blueprints/${id}`);
  });

  app.post(`${BASE}/blueprints/draft`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const o = posted(req);
    const description = String(req.body?.description ?? '').trim().slice(0, 4000);
    try {
      const svc = await builderService();
      if (!svc) throw new AiError('config', 'The App Builder has no AI service yet.');
      if (!description) throw new AiError('config', 'Describe the application.');
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
        message: html`<div class="alert alert-info">Drafted by AI: review it before you create anything.</div>` });
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
    if (taken) problems.push(`An application with the alias ${blueprint!.alias} already exists.`);
    if (!blueprint || problems.length)
      return editor(s, reply, { ...o, message: html`<div class="alert alert-error" role="alert"><p>The blueprint can't be created yet:</p><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` });
    return page(s, reply, 'Review', review(s, blueprint, o.spec, o.id, o.name));
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
        if (o.id) await c.query('update meta.blueprint set app_id = $2, spec = $3, updated_at = now() where id = $1', [o.id, a.id, JSON.stringify(json)]);
        else await c.query('insert into meta.blueprint (name, spec, created_by, app_id) values ($1, $2, $3, $4)', [o.name, JSON.stringify(json), s.username, a.id]);
        return { ...r, existing: a.existingAccount };
      });
      await logActivity({ username: s.username, event: 'blueprint', ip: clientIp(req), detail: `created ${blueprint.alias} from blueprint ${o.name}` });
      flash(s, `Application ${blueprint.alias} created from the blueprint: ${blueprint.tables.length} table(s), ${built.rows} sample row(s).${built.existing ? ` The existing account ${String(b.admin_user)} got the admin role.` : ''}`);
      return back(reply, s, `${BASE}/apps/${built.appId}`);
    } catch (e) {
      return page(s, reply, 'Review', html`<div class="alert alert-error" role="alert">No application was created: ${(e as Error).message}</div>${review(s, blueprint, o.spec, o.id, o.name)}`);
    }
  });

  app.post(`${BASE}/blueprints/:id(^\\d+$)/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const r = await owner.query('delete from meta.blueprint where id = $1', [req.params.id]);
    flash(s, r.rowCount ? 'Blueprint deleted (applications created from it stay).' : 'There is no such blueprint.');
    return back(reply, s, `${BASE}/blueprints`);
  });
}

