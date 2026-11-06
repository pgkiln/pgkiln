import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { root as installRoot } from '../env.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { readMultipart } from '../runtime/files.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { describeWorkspaceFile, exportWorkspace, importWorkspace, PARTS, type Part } from '../workspace-export.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Body, type Req } from './ui.ts';
import { currentWorkspace, workspaceAdmin } from './workspaces.ts';
import { scopedTx as tx, type BuilderKey } from './i18n.ts';

// Workspace utilities → Export / import (APEX: Workspace Utilities → Export):
// the current workspace's components as one file, and such a file imported
// into the current workspace (src/workspace-export.ts). For administrators and
// the workspace's administrators: the file names its developers and holds its
// SQL scripts.

const RESULT = '__WS_IMPORT_RESULT';
const page = `${BASE}/workspace-export`;
const crumbs = (): [string, string?][] => [[tx('rail.app_builder'), BASE], [tx('wu.title'), `${BASE}/utilities`], [tx('wu.export')]];
/** The kinds of component in the developer's language (PART_LABELS in English: src/workspace-export.ts). */
const PART_KEYS: Record<Part, BuilderKey> = {
  settings: 'wtr.part.settings', developers: 'wtr.part.developers', app_groups: 'wtr.part.app_groups', extension_links: 'wtr.part.extension_links',
  rest_catalogs: 'wtr.part.rest_catalogs', sql_scripts: 'wtr.part.sql_scripts', blueprints: 'wtr.part.blueprints', data_generators: 'wtr.part.data_generators',
  datasets: 'wtr.part.datasets', team: 'wtr.part.team', workspace_files: 'wtr.part.workspace_files', remote_servers: 'wtr.part.remote_servers',
  web_credentials: 'wtr.part.web_credentials',
};
const MAX_MB = 20;

let version: string | null | undefined;
const pgkilnVersion = () => {
  if (version !== undefined) return version;
  try {
    version = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')).version ?? null;
  } catch {
    version = null;
  }
  return version;
};

const chosen = (b: Body | undefined): Part[] => {
  const v = b?.part as unknown;
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  return PARTS.filter((p) => list.includes(p));
};

async function adminOr403(s: Session, reply: FastifyReply) {
  if (s.workspace && (await workspaceAdmin(s.username, s.workspace.id))) return true;
  await send(reply.code(403), s, shell(s, tx('wu.export'), crumbs(), html`<h1 class="u-mb1">${tx('wu.export')}</h1>
    <div class="alert alert-error" role="alert">${tx('wtr.admins_only')}</div>`));
  return false;
}

const partBoxes = (counts?: Partial<Record<Part, number>>) =>
  html`<fieldset class="field" data-wide><legend class="label">${tx('wtr.components')}</legend>${PARTS.map((p) =>
    counts && counts[p] === undefined
      ? ''
      : html`<label class="check"><input type="checkbox" name="part" value="${p}" checked> ${tx(PART_KEYS[p])}${counts ? html` <span class="muted">(${p === 'settings' ? tx('wtr.in_file') : p === 'team' ? tx('wtr.issues', { n: counts[p] }) : counts[p]})</span>` : ''}</label>`)}</fieldset>`;

export async function workspaceTransferRoutes(app: FastifyInstance) {
  app.get(page, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOr403(s, reply))) return;
    const result = s.state[RESULT] ? (JSON.parse(s.state[RESULT]!) as string[]) : null;
    delete s.state[RESULT];
    const name = s.workspace!.name;
    const main = html`<div class="title-row"><h1>${tx('wu.export')}</h1></div>
      <p class="muted u-mt0">${tx('wtr.intro', { name })}</p>
      ${result ? html`<div class="alert alert-success" role="status"><b>${tx('wtr.imported_into', { name })}</b><ul>${result.map((l) => html`<li>${l}</li>`)}</ul></div>` : ''}
      ${region(tx('wtr.export'), html`<form method="post" action="${page}">${csrf(s)}
        ${partBoxes()}
        <p class="muted">${tx('wtr.not_in_file')}</p>
        <div class="buttons"><button class="btn btn-hot">${icon('download')} ${tx('wtr.export')}</button></div></form>`)}
      ${region(tx('wtr.import'), html`<form method="post" action="${BASE}/workspace-import" enctype="multipart/form-data">${csrf(s)}
        <p class="muted u-mt0">${tx.rich('wtr.import_intro', { name: html`<b>${name}</b>` })}</p>
        <div class="form-grid">
          <div class="field" data-wide><label class="label" for="f_file">${tx('wtr.file')}</label><input id="f_file" type="file" name="file" accept=".json,application/json" required></div>
          ${partBoxes()}
          <div class="field" data-wide><label class="check"><input type="checkbox" name="replace" value="true"> ${tx('wtr.replace')}</label></div>
        </div>
        <div class="buttons"><button class="btn">${icon('upload')} ${tx('wtr.import')}</button></div></form>`)}`;
    return send(reply, s, shell(s, tx('wu.export'), crumbs(), main));
  });

  app.post(page, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOr403(s, reply))) return;
    const parts = chosen(req.body);
    if (!parts.length) {
      flash(s, tx('wtr.choose_part'), 'error');
      return back(reply, s, page);
    }
    const doc = await exportWorkspace(currentWorkspace(s), parts, { version: pgkilnVersion() ?? undefined, by: s.username });
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `exported workspace ${currentWorkspace(s)}: ${parts.join(', ')}` });
    const file = `${s.workspace!.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}.workspace.json`;
    return reply.type('application/json').header('content-disposition', `attachment; filename="${file}"`).send(JSON.stringify(doc, null, 2));
  });

  app.post(`${BASE}/workspace-import`, async (req: Req, reply) => {
    let text = '';
    let tooBig = false;
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, MAX_MB);
      req.body = parsed.body as Body;
      const f = parsed.files.get('file');
      tooBig = !!f?.truncated;
      if (f && !f.truncated) text = f.data.toString('utf8');
    }
    const s = await developer(req, reply);
    if (!s || !(await adminOr403(s, reply))) return;
    try {
      if (tooBig) throw new Error(tx('wtr.too_big', { n: MAX_MB }));
      if (!text.trim()) throw new Error(tx('wtr.choose_file'));
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error(tx('wtr.not_json'));
      }
      describeWorkspaceFile(doc);
      const parts = chosen(req.body);
      if (!parts.length) throw new Error(tx('wtr.choose_part'));
      const ws = currentWorkspace(s);
      const result = await owner.tx((c) => importWorkspace(c, ws, doc, parts, { replace: req.body?.replace === 'true', by: s.username }));
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `imported into workspace ${ws}: ${result.added} added, ${result.replaced} replaced, ${result.skipped} kept` });
      s.state[RESULT] = JSON.stringify(result.lines);
    } catch (e) {
      flash(s, tx('wtr.failed', { reason: friendly(e) }), 'error');
    }
    return back(reply, s, page);
  });
}

/** A database refusal in words (the transaction rolled back). */
function friendly(e: unknown) {
  const err = e as { message: string; constraint?: string; table?: string; code?: string };
  if (err.code === '23514' || err.code === '23502' || err.code === '22P02') return tx('wtr.refused_value', { detail: `${err.table ?? ''}${err.constraint ? `: ${err.constraint}` : ''}` });
  if (err.code === '23505') return tx('wtr.duplicate', { detail: err.constraint ?? err.table ?? '' });
  return err.message;
}

