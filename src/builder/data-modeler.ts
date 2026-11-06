import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { ddlScript, readSchema, type DdlObject } from '../ddl.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { autoLayout, cleanObjects, diagramSvg, lines, markers, matchNames, modelNames, objectHref, placeAll, readModel, type ModelTable, type Placed } from '../datamodel.ts';
import type { Session } from '../session.ts';
import { back, BASE, bicon, csrf, developer, flash, region, send, shell, workshopTabs, type Req } from './ui.ts';
import { currentWorkspace, sessionSchema, usableSchemas, workshopDb } from './workspaces.ts';
import { tr, type BuilderKey, type BuilderTranslate } from './i18n.ts';

// (sprint 98, Database Actions DA-10: Data Modeler) SQL Workshop → Data Modeler: named relational diagrams of a
// schema's tables and views, per workspace (meta.sql_diagram, migration 111). A diagram keeps only the objects'
// names and their boxes' positions; everything drawn is read from the catalog when it is shown (src/datamodel.ts),
// with the workshop's connection (an isolated workspace's developer login sees only its own schemas). The page
// shows the diagram as server-rendered SVG at the saved positions (it works without JavaScript: add and remove
// objects, auto layout, export SVG, DDL and the data dictionary are forms and links); public/data-modeler.js adds
// dragging, undo/redo, zoom, fit, the mini-map, Export PNG and print, and saves the positions.

const M = `${BASE}/sql/modeler`;

interface Diagram {
  id: string;
  name: string;
  schema_name: string;
  objects: unknown;
  created_by: string;
  updated_by: string | null;
  updated_at: string;
}

const ID_RE = /^\d{1,18}$/;

async function loadDiagram(s: Session, id: unknown): Promise<Diagram | null> {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return (await owner.one<Diagram>(`select id::text, name, schema_name, objects, created_by, updated_by, updated_at from meta.sql_diagram where id = $1 and workspace_id = $2`,
    [id, currentWorkspace(s)])) ?? null;
}

/** The diagram's tables as they are now, placed (its schema must still be usable by the workshop's connection). */
async function model(s: Session, d: Diagram) {
  const db = await workshopDb(s);
  if (!(await usableSchemas(db)).includes(d.schema_name)) return null;
  const saved = cleanObjects(d.objects);
  const tables = await readModel(db, d.schema_name, saved.map((o) => o.name));
  // in the saved order (readModel sorts by name)
  tables.sort((a, b) => saved.findIndex((o) => o.name === a.name) - saved.findIndex((o) => o.name === b.name));
  return { db, tables, placed: placeAll(d.schema_name, tables, saved), missing: saved.filter((o) => !tables.some((t) => t.name === o.name)).map((o) => o.name) };
}

async function saveObjects(s: Session, id: string, objects: Placed[]) {
  await owner.query(`update meta.sql_diagram set objects = $3, updated_by = $4, updated_at = now() where id = $1 and workspace_id = $2`,
    [id, currentWorkspace(s), JSON.stringify(objects.slice(0, 500)), s.username]);
}

const notFound = (reply: FastifyReply) => reply.code(404).send('Not found');
const fileName = (name: string) => name.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'diagram';
const when = (t: string) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/** The Diagrams list and the Create diagram form. */
async function listPage(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const db = await workshopDb(s);
  const [schemas, current, rows] = await Promise.all([
    usableSchemas(db),
    sessionSchema(s, db),
    owner.query<Diagram & { n: number }>(
      `select id::text, name, schema_name, jsonb_array_length(objects) as n, created_by, updated_by, updated_at
         from meta.sql_diagram where workspace_id = $1 order by lower(name)`, [currentWorkspace(s)]),
  ]);
  const pick = current ?? (schemas.includes('public') ? 'public' : schemas[0]);
  const tx = tr(s);
  const list = rows.rows.length
    ? html`<div class="table-wrap"><table class="report report-reflow" aria-label="${tx('dm.diagrams')}"><thead><tr><th>${tx('scr.name')}</th><th>${tx('sm.schema')}</th><th class="num">${tx('ddl.objects')}</th><th>${tx('scr.col.updated')}</th><th>${tx('scr.col.by')}</th><th><span class="sr-only">${tx('sm.col.actions')}</span></th></tr></thead>
      <tbody>${rows.rows.map((d) => html`<tr>
        <td data-label="${tx('scr.name')}" class="u-break"><a href="${M}/${d.id}">${d.name}</a></td>
        <td data-label="${tx('sm.schema')}" class="u-break">${d.schema_name}</td>
        <td data-label="${tx('ddl.objects')}" class="num">${d.n}</td>
        <td data-label="${tx('scr.col.updated')}">${when(d.updated_at)}</td>
        <td data-label="${tx('scr.col.by')}" class="u-break">${d.updated_by ?? d.created_by}</td>
        <td data-label="${tx('sm.col.actions')}"><form method="post" action="${M}/${d.id}/delete">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="${tx('dm.delete_confirm', { name: d.name })}">${icon('trash')} ${tx('scr.delete')}</button></form></td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${tx('dm.none_yet')}</p>`;
  const create = html`<form method="post" action="${M}" class="dm-create">${csrf(s)}
    <div class="form-grid">
      <div class="field"><label class="label" for="f_name">${tx('scr.name')}</label><input id="f_name" name="name" required maxlength="120" placeholder="${tx('dm.name_placeholder')}"></div>
      <div class="field"><label class="label" for="f_schema">${tx('sm.schema')}</label><select id="f_schema" name="schema">${schemas.map((n) => html`<option${n === pick ? raw(' selected') : ''}>${n}</option>`)}</select></div>
      <div class="field"><label class="label" for="f_objects">${tx('ddl.objects')}</label><input id="f_objects" name="objects" maxlength="2000" placeholder="${tx('dm.objects_placeholder')}">
        <small class="help">${tx.code('dm.objects_help')}</small></div>
    </div>
    <div class="buttons"><button class="btn btn-hot">${icon('plus')} ${tx('dm.create')}</button></div></form>`;
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('modeler', s)}
    <p class="muted u-mt0">${tx('dm.intro')}</p>
    ${region(tx('dm.diagrams'), list)}<div class="u-spacer"></div>${region(tx('dm.create'), create)}`;
  return send(reply, s, shell(s, tx('sql.tool.modeler'), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.modeler')]], main, 'sql'));
}

/** One diagram: the toolbar, the SVG, its objects, Add objects. */
async function diagramPage(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const d = await loadDiagram(s, req.params.id);
  if (!d) return notFound(reply);
  const m = await model(s, d);
  const tx = tr(s);
  const crumbs: [string, string?][] = [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.modeler'), M], [d.name]];
  if (!m) {
    const main = html`<h1 class="u-mb1">${d.name}</h1>${workshopTabs('modeler', s)}<div class="alert alert-error" role="alert">${tx('dm.schema_gone', { schema: d.schema_name })}</div>
      <form method="post" action="${M}/${d.id}/delete">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('dm.delete_confirm_short', { name: d.name })}">${icon('trash')} ${tx('dm.delete_diagram')}</button></form>`;
    return send(reply, s, shell(s, d.name, crumbs, main, 'sql'));
  }
  const { tables, placed, missing } = m;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const shown = new Set(tables.map((t) => t.name));
  const all = q ? await modelNames(m.db, d.schema_name) : [];
  const found = q ? matchNames(all.filter((o) => !shown.has(o.name)).map((o) => o.name), q).slice(0, 500) : [];
  const kindOf = new Map(all.map((o) => [o.name, o.kind]));
  const svg = diagramSvg(d.schema_name, d.name, tables, placed, { links: true, id: 'dm-svg', auto: autoLayout(d.schema_name, tables) });
  const fks = lines(d.schema_name, tables);
  const jsBtn = (act: string, ic: Raw | '', label: string, extra = '') =>
    html`<button type="button" class="btn btn-sm" data-dm="${act}" hidden title="${label}${extra ? ` (${extra})` : ''}" aria-label="${label}">${ic}<span class="dm-btn-label">${label}</span></button>`;
  const toolbar = html`<div class="dm-toolbar" role="toolbar" aria-label="${tx('dm.diagram')}">
    <form method="post" action="${M}/${d.id}/layout" class="dm-save-form">${csrf(s)}<input type="hidden" name="positions" value="">
      ${jsBtn('save', icon('save'), tx('scr.save'), 'Ctrl+S')}<span class="dm-status muted small" role="status" aria-live="polite"></span></form>
    ${jsBtn('undo', icon('undo'), tx('dm.undo'), 'Ctrl+Z')}${jsBtn('redo', icon('redo'), tx('dm.redo'), 'Ctrl+Y')}
    ${jsBtn('zoom-out', bicon('zoom-out'), tx('dm.zoom_out'))}${jsBtn('zoom-in', bicon('zoom-in'), tx('dm.zoom_in'))}${jsBtn('fit', bicon('expand'), tx('dm.fit'))}
    <form method="post" action="${M}/${d.id}/layout">${csrf(s)}<input type="hidden" name="layout" value="auto"><button class="btn btn-sm" data-dm="auto" title="${tx('dm.auto')}" aria-label="${tx('dm.auto')}">${icon('grid')}<span class="dm-btn-label">${tx('dm.auto')}</span></button></form>
    ${jsBtn('minimap', icon('map'), tx('dm.minimap'))}
    <a class="btn btn-sm" href="${M}/${d.id}/svg" data-dm="svg" title="${tx('dm.export_svg')}" aria-label="${tx('dm.export_svg')}">${icon('download')}<span class="dm-btn-label">SVG</span></a>
    ${jsBtn('png', icon('image'), 'PNG')}${jsBtn('print', icon('printer'), tx('dm.print'))}
    <a class="btn btn-sm" href="${M}/${d.id}/ddl">${icon('code')}<span class="dm-btn-label">${tx('sql.tool.ddl')}</span></a>
    <a class="btn btn-sm" href="${M}/${d.id}/dictionary">${icon('book')}<span class="dm-btn-label">${tx('dm.dictionary')}</span></a>
    <a class="btn btn-sm btn-hot" href="${M}/${d.id}#dm-add">${icon('plus')}<span class="dm-btn-label">${tx('dm.add_objects')}</span></a>
  </div>`;
  const objectList = tables.length
    ? html`<div class="table-wrap"><table class="report report-reflow" aria-label="${tx('dm.objects_in')}"><thead><tr><th>${tx('sm.col.object')}</th><th>${tx('dm.kind')}</th><th class="num">${tx('ul.columns')}</th><th>${tx('dm.references')}</th><th><span class="sr-only">${tx('sm.col.actions')}</span></th></tr></thead>
      <tbody>${tables.map((t) => html`<tr>
        <td data-label="${tx('sm.col.object')}" class="u-break"><a href="${objectHref(d.schema_name, t)}" title="${t.kind === 'table' ? tx('cl.from.table') : tx('sql.tool.objects')}">${t.name}</a>${t.comment ? html`<br><span class="muted small">${t.comment}</span>` : ''}</td>
        <td data-label="${tx('dm.kind')}">${t.kind}</td>
        <td data-label="${tx('ul.columns')}" class="num">${t.columns.length}</td>
        <td data-label="${tx('dm.references')}" class="u-break">${fks.filter((l) => l.from === t.name).map((l) => l.to).join(', ') || '-'}</td>
        <td data-label="${tx('sm.col.actions')}"><form method="post" action="${M}/${d.id}/objects">${csrf(s)}<input type="hidden" name="remove" value="${t.name}"><button class="btn btn-sm" aria-label="${tx('dm.remove_label', { name: t.name })}">${icon('minus')} ${tx('dm.remove')}</button></form></td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${tx('dm.no_objects')}</p>`;
  const add = html`<form method="get" action="${M}/${d.id}#dm-add" class="dm-search" role="search">
      <label class="label" for="f_q">${tx('dm.search_label', { schema: d.schema_name })}</label>
      <div class="dm-search-row"><input id="f_q" name="q" type="search" value="${q}" placeholder="${tx('dm.search_placeholder')}" maxlength="200"><button class="btn">${icon('search')} ${tx('common.search')}</button></div></form>
    ${q
      ? found.length
        ? html`<form method="post" action="${M}/${d.id}/objects">${csrf(s)}<fieldset class="field"><legend class="label">${found.length === 500 ? tx('dm.found_first') : tx('dm.found', { n: found.length })}</legend><div class="qb-pick">
            ${found.map((n) => html`<label class="check u-break"><input type="checkbox" name="t" value="${n}" checked> ${n}${kindOf.get(n) !== 'table' ? html` <span class="tag">${kindOf.get(n)}</span>` : ''}</label>`)}</div></fieldset>
            <div class="buttons"><button class="btn btn-hot">${icon('plus')} ${tx('dm.add_to')}</button></div></form>`
        : html`<p class="muted">${tx('dm.nothing_matches', { q })}</p>`
      : ''}`;
  const settings = html`<details class="dm-settings"><summary>${tx('dm.settings')}</summary>
    <form method="post" action="${M}/${d.id}/rename" class="dm-search-row">${csrf(s)}<label class="sr-only" for="f_rename">${tx('scr.name')}</label><input id="f_rename" name="name" value="${d.name}" maxlength="120" required><button class="btn">${icon('edit')} ${tx('cl.rename')}</button></form>
    <form method="post" action="${M}/${d.id}/delete">${csrf(s)}<button class="btn btn-danger" data-confirm="${tx('dm.delete_confirm', { name: d.name })}">${icon('trash')} ${tx('dm.delete_diagram')}</button></form></details>`;
  const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('modeler', s)}
    <div class="dm-head"><h2 class="dm-name">${d.name}</h2><span class="muted small">${tx('dm.head', { schema: d.schema_name, n: tables.length, time: when(d.updated_at), user: d.updated_by ?? d.created_by })}</span></div>
    ${missing.length ? html`<div class="alert alert-error" role="alert">${tx('dm.missing', { schema: d.schema_name, names: missing.join(', ') })}</div>` : ''}
    ${toolbar}
    <div class="dm-stage" data-dm-stage data-name="${d.name}">
      <div class="dm-canvas" tabindex="0" aria-label="${tx('dm.canvas_label', { name: d.name })}">${svg}</div>
    </div>
    <p class="muted small dm-legend">${tx.rich('dm.legend', { star: html`<strong>*</strong>` })} ${tables.some((t) => t.kind === 'table') ? tx('dm.legend_opens_table') : tx('dm.legend_opens_object')}</p>
    ${region(tx('ddl.objects'), objectList, '', 'dm-objects')}<div class="u-spacer"></div>
    ${region(tx('dm.add_title'), add, '', 'dm-add')}<div class="u-spacer"></div>
    ${settings}`;
  return send(reply, s, shell(s, d.name, crumbs, main, 'sql'));
}

/** The DDL of the diagram's objects: tables, their keys, indexes, triggers, policies, comments and grants; views. */
export function diagramDdl(schema: string, names: Set<string>, objects: DdlObject[]) {
  // a comment's or grant's target: "emp" or "emp.col" (quote_ident)
  const relOf = (target: string) => {
    const m = /^("(?:[^"]|"")*"|[^.]+)/.exec(target)?.[1] ?? '';
    return m.startsWith('"') ? m.slice(1, -1).replace(/""/g, '"') : m;
  };
  const owners = new Set(objects.filter((o) => o.kind === 'sequence owner' && names.has(relOf(o.ddl.replace(/^.* owned by /, '').replace(/;$/, '')))).map((o) => o.name));
  const keep = objects.filter((o) => {
    switch (o.kind) {
      case 'table': case 'view': case 'materialized view': return names.has(o.name);
      case 'sequence': case 'sequence owner': return owners.has(o.name);
      case 'comment': case 'grant': {
        const target = o.key.replace(/^(comment|grant):(table|view|materialized view|column|sequence) /, '');
        if (target === o.key) return false;
        return /^(comment|grant):sequence /.test(o.key) ? owners.has(relOf(target)) : names.has(relOf(target));
      }
      default: return !!o.table && names.has(o.table);
    }
  });
  return ddlScript(schema, keep).replace(/^-- DDL of schema .*$/m, `-- DDL of ${names.size} objects of schema ${schema} (a Data Modeler diagram)`);
}

const CON: Record<string, BuilderKey> = { p: 'dm.con.p', u: 'dm.con.u', f: 'dm.con.f', c: 'dm.con.c' };

/** The data dictionary: tables, columns, comments, constraints. */
function dictionary(tx: BuilderTranslate, schema: string, d: Diagram, tables: ModelTable[]): Raw {
  const fks = lines(schema, tables);
  return html`<header class="dm-dict-head"><h1>${tx('dm.dict_title', { name: d.name })}</h1>
    <p>${tx('dm.dict_head', { schema, n: tables.length, time: when(new Date().toISOString()) })}</p></header>
    <nav aria-label="${tx('ddl.objects')}"><ol class="dm-dict-toc">${tables.map((t, i) => html`<li><a href="#t${i}">${t.name}</a> <span class="muted">${t.kind}</span></li>`)}</ol></nav>
    ${tables.map((t, i) => html`<section class="dm-dict-table" id="t${i}">
      <h2>${t.name} <span class="muted small">${t.kind}</span></h2>
      ${t.comment ? html`<p>${t.comment}</p>` : ''}
      <div class="table-wrap"><table class="report" aria-label="${tx('dm.columns_of', { name: t.name })}"><thead><tr><th>#</th><th>${tx('dm.col.column')}</th><th>${tx('ch.type')}</th><th>${tx('dm.col.null')}</th><th>${tx('dm.col.default')}</th><th>${tx('dm.col.key')}</th><th>${tx('dm.col.comment')}</th></tr></thead>
        <tbody>${t.columns.map((c, k) => html`<tr><td class="num">${k + 1}</td><td class="u-break"><code>${c.name}</code></td><td class="u-break">${c.type}</td><td>${c.notNull ? 'not null' : 'null'}</td>
          <td class="u-break">${c.default ?? ''}</td><td>${markers(t, c.name)}</td><td class="u-break">${c.comment ?? ''}</td></tr>`)}</tbody></table></div>
      ${t.constraints.length ? html`<h3>${tx('dm.constraints')}</h3><div class="table-wrap"><table class="report" aria-label="${tx('dm.constraints_of', { name: t.name })}"><thead><tr><th>${tx('scr.name')}</th><th>${tx('ch.type')}</th><th>${tx('dm.definition')}</th></tr></thead>
        <tbody>${t.constraints.map((k) => html`<tr><td class="u-break"><code>${k.name}</code></td><td>${CON[k.type] ? tx(CON[k.type]) : k.type}</td><td class="u-break"><code>${k.def}</code></td></tr>`)}</tbody></table></div>` : ''}
      ${fks.some((l) => l.to === t.name) ? html`<h3>${tx('dm.referenced_by')}</h3><ul>${fks.filter((l) => l.to === t.name).map((l) => html`<li>${l.label}</li>`)}</ul>` : ''}
    </section>`)}`;
}

/** A standalone copy of the data dictionary (a downloaded file: its own small stylesheet). */
const DICT_CSS = `body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1e293b;max-width:1100px;margin:24px auto;padding:0 16px}
h1{font-size:1.6rem}h2{font-size:1.25rem;margin-top:2rem;border-bottom:1px solid #cbd5e1;padding-bottom:4px}h3{font-size:1rem}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f1f5f9}
.muted{color:#64748b}.small{font-size:.85em}.num{text-align:right}code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
.dm-dict-toc{columns:3 14rem}.table-wrap{overflow-x:auto}@media print{h2{break-after:avoid}.dm-dict-table{break-inside:avoid-page}}`;

export async function dataModelerRoutes(app: FastifyInstance) {
  app.get(M, listPage);

  app.post(M, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const name = String(req.body?.name ?? '').trim().slice(0, 120);
    const schema = String(req.body?.schema ?? '');
    const db = await workshopDb(s);
    if (!(await usableSchemas(db)).includes(schema)) return notFound(reply);
    if (!name) {
      flash(s, tr(s)('dm.err.name'), 'error');
      return back(reply, s, M);
    }
    const names = matchNames((await modelNames(db, schema)).map((o) => o.name), String(req.body?.objects ?? '').slice(0, 2000), { exact: true }).slice(0, 500);
    const tables = await readModel(db, schema, names);
    try {
      const row = await owner.one<{ id: string }>(
        `insert into meta.sql_diagram (workspace_id, name, schema_name, objects, created_by) values ($1, $2, $3, $4, $5) returning id::text`,
        [currentWorkspace(s), name, schema, JSON.stringify(autoLayout(schema, tables)), s.username]);
      flash(s, tables.length ? tr(s)('dm.created_n', { name, n: tables.length }) : tr(s)('dm.created_empty', { name }));
      return back(reply, s, `${M}/${row!.id}${tables.length ? '' : '#dm-add'}`);
    } catch (e: any) {
      if (e.code !== '23505') throw e;
      flash(s, tr(s)('dm.err.exists', { name }), 'error');
      return back(reply, s, M);
    }
  });

  app.get(`${M}/:id`, diagramPage);

  // add (t=name …) or remove (remove=name) objects
  app.post(`${M}/:id/objects`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await loadDiagram(s, req.params.id);
    if (!d) return notFound(reply);
    const m = await model(s, d);
    if (!m) return notFound(reply);
    const tv = (req.body as Record<string, unknown> | undefined)?.t;
    const wanted = (Array.isArray(tv) ? tv : tv === undefined ? [] : [tv]).map(String);
    const remove = typeof req.body?.remove === 'string' ? req.body.remove : '';
    if (remove) {
      await saveObjects(s, d.id, m.placed.filter((p) => p.name !== remove));
      flash(s, tr(s)('dm.removed', { name: remove }));
      return back(reply, s, `${M}/${d.id}`);
    }
    const existing = new Set((await modelNames(m.db, d.schema_name)).map((o) => o.name));
    const adding = [...new Set(wanted)].filter((n) => existing.has(n) && !m.placed.some((p) => p.name === n)).slice(0, Math.max(0, 500 - m.placed.length));
    if (!adding.length) {
      flash(s, tr(s)('dm.err.nothing'), 'error');
      return back(reply, s, `${M}/${d.id}#dm-add`);
    }
    const added = await readModel(m.db, d.schema_name, adding);
    await saveObjects(s, d.id, placeAll(d.schema_name, [...m.tables, ...added], m.placed));
    flash(s, tr(s)(added.length === 1 ? 'dm.added_one' : 'dm.added', { n: added.length, names: added.map((t) => t.name).join(', ') }));
    return back(reply, s, `${M}/${d.id}`);
  });

  // the positions (positions = JSON [{name, x, y}]), or the automatic layout (layout=auto)
  app.post(`${M}/:id/layout`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await loadDiagram(s, req.params.id);
    if (!d) return notFound(reply);
    const m = await model(s, d);
    if (!m) return notFound(reply);
    const json = req.body?.format === 'json';
    let next: Placed[];
    if (req.body?.layout === 'auto') next = autoLayout(d.schema_name, m.tables);
    else {
      let posted: unknown;
      try {
        posted = JSON.parse(String(req.body?.positions ?? '[]').slice(0, 100000));
      } catch {
        return reply.code(400).send(json ? { ok: false, error: 'Unreadable positions.' } : 'Unreadable positions.');
      }
      const given = new Map(cleanObjects(posted).map((p) => [p.name, p]));
      // only the diagram's own objects; one left out keeps its place
      next = m.placed.map((p) => given.get(p.name) ?? p);
    }
    await saveObjects(s, d.id, next);
    if (json) return reply.send({ ok: true, saved: next.length });
    flash(s, req.body?.layout === 'auto' ? tr(s)('dm.laid_out') : tr(s)('dm.saved'));
    return back(reply, s, `${M}/${d.id}`);
  });

  app.post(`${M}/:id/rename`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await loadDiagram(s, req.params.id);
    if (!d) return notFound(reply);
    const name = String(req.body?.name ?? '').trim().slice(0, 120);
    if (!name) {
      flash(s, tr(s)('dm.err.name'), 'error');
      return back(reply, s, `${M}/${d.id}`);
    }
    try {
      await owner.query(`update meta.sql_diagram set name = $3, updated_by = $4, updated_at = now() where id = $1 and workspace_id = $2`, [d.id, currentWorkspace(s), name, s.username]);
      flash(s, tr(s)('dm.renamed', { name }));
    } catch (e: any) {
      if (e.code !== '23505') throw e;
      flash(s, tr(s)('dm.err.exists', { name }), 'error');
    }
    return back(reply, s, `${M}/${d.id}`);
  });

  app.post(`${M}/:id/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await loadDiagram(s, req.params.id);
    if (!d) return notFound(reply);
    await owner.query('delete from meta.sql_diagram where id = $1 and workspace_id = $2', [d.id, currentWorkspace(s)]);
    flash(s, tr(s)('dm.deleted', { name: d.name }));
    return back(reply, s, M);
  });

  // Export SVG: the diagram at its saved positions, as a file
  app.get(`${M}/:id/svg`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await loadDiagram(s, req.params.id);
    const m = d && (await model(s, d));
    if (!d || !m) return notFound(reply);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${diagramSvg(d.schema_name, d.name, m.tables, m.placed)}\n`;
    return reply.header('content-disposition', `attachment; filename="${fileName(d.name)}.svg"`).header('x-content-type-options', 'nosniff').type('image/svg+xml; charset=utf-8').send(svg);
  });

  // Generate DDL for the diagram's objects
  app.get(`${M}/:id/ddl`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await loadDiagram(s, req.params.id);
    const m = d && (await model(s, d));
    if (!d || !m) return notFound(reply);
    const script = diagramDdl(d.schema_name, new Set(m.tables.map((t) => t.name)), await readSchema(m.db.pool, d.schema_name));
    if (req.query.download === '1')
      return reply.header('content-disposition', `attachment; filename="${fileName(d.name)}.sql"`).type('application/sql; charset=utf-8').send(script);
    const tx = tr(s);
    const main = html`<h1 class="u-mb1">${tx('rail.sql_workshop')}</h1>${workshopTabs('modeler', s)}
      ${region(tx('ddl.of', { schema: d.name }), html`<p class="muted u-mt0">${tx('dm.ddl_intro', { n: m.tables.length, schema: d.schema_name })}</p>
        <pre class="source" data-code-view="sql" tabindex="0" aria-label="DDL">${script}</pre>
        <form method="post" action="${BASE}/sql">${csrf(s)}<input type="hidden" name="sql" value="${script}">
          <div class="buttons"><a class="btn" href="${M}/${d.id}">${bicon('back')} ${tx('dm.back')}</a><a class="btn" href="${M}/${d.id}/ddl?download=1">${icon('download')} ${tx('scr.download')}</a>
            <button class="btn btn-hot">${icon('play')} ${tx('dm.open_worksheet')}</button></div></form>`)}`;
    return send(reply, s, shell(s, tx('ddl.of', { schema: d.name }), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.modeler'), M], [d.name, `${M}/${d.id}`], ['DDL']], main, 'sql'));
  });

  // the data dictionary report (download=1: a standalone HTML file)
  app.get(`${M}/:id/dictionary`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const d = await loadDiagram(s, req.params.id);
    const m = d && (await model(s, d));
    if (!d || !m) return notFound(reply);
    const tx = tr(s);
    const body = dictionary(tx, d.schema_name, d, m.tables);
    if (req.query.download === '1')
      return reply.header('content-disposition', `attachment; filename="${fileName(d.name)}-dictionary.html"`).type('text/html; charset=utf-8')
        .send(`<!doctype html><html lang="${tx.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(tx('dm.dict_title', { name: d.name }))}</title><style>${DICT_CSS}</style></head><body>${body}</body></html>`);
    const main = html`<div class="dm-dict-actions buttons"><a class="btn" href="${M}/${d.id}">${bicon('back')} ${tx('dm.back')}</a>
        <a class="btn" href="${M}/${d.id}/dictionary?download=1">${icon('download')} ${tx('dm.download_html')}</a>
        <button type="button" class="btn" data-dm="print" hidden>${icon('printer')} ${tx('dm.print_pdf')}</button></div>
      <article class="dm-dict">${body}</article>`;
    return send(reply, s, shell(s, tx('dm.dict_title', { name: d.name }), [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('sql.tool.modeler'), M], [d.name, `${M}/${d.id}`], [tx('dm.dictionary')]], main, 'sql'));
  });
}
