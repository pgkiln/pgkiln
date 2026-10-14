import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner } from '../db.ts';
import { root as installRoot } from '../env.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { readMultipart } from '../runtime/files.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { describeWorkspaceFile, exportWorkspace, importWorkspace, PART_LABELS, PARTS, type Part } from '../workspace-export.ts';
import { back, BASE, csrf, developer, flash, region, send, shell, type Body, type Req } from './ui.ts';
import { currentWorkspace, workspaceAdmin } from './workspaces.ts';

// Workspace utilities → Export / import (APEX: Workspace Utilities → Export):
// the current workspace's components as one file, and such a file imported
// into the current workspace (src/workspace-export.ts). For administrators and
// the workspace's administrators: the file names its developers and holds its
// SQL scripts.

const RESULT = '__WS_IMPORT_RESULT';
const page = `${BASE}/workspace-export`;
const crumbs: [string, string?][] = [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], ['Export and import']];
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
  await send(reply.code(403), s, shell(s, 'Export and import', crumbs, html`<h1 class="u-mb1">Export and import</h1>
    <div class="alert alert-error" role="alert">Only administrators and the workspace's administrators export or import a workspace's components.</div>`));
  return false;
}

const partBoxes = (counts?: Partial<Record<Part, number>>) =>
  html`<fieldset class="field" data-wide><legend class="label">Components</legend>${PARTS.map((p) =>
    counts && counts[p] === undefined
      ? ''
      : html`<label class="check"><input type="checkbox" name="part" value="${p}" checked> ${PART_LABELS[p]}${counts ? html` <span class="muted">(${p === 'settings' ? 'in the file' : counts[p]})</span>` : ''}</label>`)}</fieldset>`;

export async function workspaceTransferRoutes(app: FastifyInstance) {
  app.get(page, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOr403(s, reply))) return;
    const result = s.state[RESULT] ? (JSON.parse(s.state[RESULT]!) as string[]) : null;
    delete s.state[RESULT];
    const name = s.workspace!.name;
    const main = html`<div class="title-row"><h1>Export and import</h1></div>
      <p class="muted u-mt0">The components of the workspace ${name} as one file: to copy them to another workspace or installation, or to keep them with your applications' files. Applications are exported on their own (App Builder → an application → Export).</p>
      ${result ? html`<div class="alert alert-success" role="status"><b>Imported into ${name}:</b><ul>${result.map((l) => html`<li>${l}</li>`)}</ul></div>` : ''}
      ${region('Export', html`<form method="post" action="${page}">${csrf(s)}
        ${partBoxes()}
        <p class="muted">Not in the file: the workspace's name, its isolation and database roles, passwords and secrets, script runs and other history.</p>
        <div class="buttons"><button class="btn btn-hot">${icon('download')} Export</button></div></form>`)}
      ${region('Import', html`<form method="post" action="${BASE}/workspace-import" enctype="multipart/form-data">${csrf(s)}
        <p class="muted u-mt0">A file exported from a workspace, imported into <b>${name}</b>. Nothing is deleted; developers are added only when this installation has a developer of that name.</p>
        <div class="form-grid">
          <div class="field" data-wide><label class="label" for="f_file">Workspace file</label><input id="f_file" type="file" name="file" accept=".json,application/json" required></div>
          ${partBoxes()}
          <div class="field" data-wide><label class="check"><input type="checkbox" name="replace" value="true"> Replace components with the same name (otherwise this workspace's own are kept)</label></div>
        </div>
        <div class="buttons"><button class="btn">${icon('upload')} Import</button></div></form>`)}`;
    return send(reply, s, shell(s, 'Export and import', crumbs, main));
  });

  app.post(page, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s || !(await adminOr403(s, reply))) return;
    const parts = chosen(req.body);
    if (!parts.length) {
      flash(s, 'Choose at least one kind of component.', 'error');
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
      if (tooBig) throw new Error(`The file is larger than ${MAX_MB} MB.`);
      if (!text.trim()) throw new Error('Choose a workspace file.');
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error('The file is not valid JSON.');
      }
      describeWorkspaceFile(doc);
      const parts = chosen(req.body);
      if (!parts.length) throw new Error('Choose at least one kind of component.');
      const ws = currentWorkspace(s);
      const result = await owner.tx((c) => importWorkspace(c, ws, doc, parts, { replace: req.body?.replace === 'true', by: s.username }));
      await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `imported into workspace ${ws}: ${result.added} added, ${result.replaced} replaced, ${result.skipped} kept` });
      s.state[RESULT] = JSON.stringify(result.lines);
    } catch (e) {
      flash(s, `Import failed, nothing was changed: ${friendly(e)}`, 'error');
    }
    return back(reply, s, page);
  });
}

/** A database refusal in words (the transaction rolled back). */
function friendly(e: unknown) {
  const err = e as { message: string; constraint?: string; table?: string; code?: string };
  if (err.code === '23514' || err.code === '23502' || err.code === '22P02') return `the file has a value this installation refuses (${err.table ?? ''}${err.constraint ? `: ${err.constraint}` : ''}).`;
  if (err.code === '23505') return `the file has two components with the same name (${err.constraint ?? err.table ?? ''}).`;
  return err.message;
}

