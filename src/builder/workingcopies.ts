import type { FastifyInstance } from 'fastify';
import { unifiedDiff } from '../cli/diff.ts';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import {
  compare, copiesOf, copyOf, createCopy, deleteCopy, fingerprint, mergeCopy, WorkingCopyError, type Change,
} from '../workingcopy.ts';
import { lockText, type Lock } from './locks.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';

// Working copies (APEX 24.1+): App → Working copies lists an application's
// copies and makes new ones; a copy's page compares it with its main
// application (three ways, per component, src/workingcopy.ts), shows the
// differences and merges it back, or refreshes it with the main
// application's changes. Conflicts (a component changed on both sides) need a
// choice. A merge is refused while another developer has locked the target
// application or a page the merge changes (sprint 31 locks).

const appRow = async (id: string) => (/^\d{1,9}$/.test(id) ? owner.one('select id, name, alias from meta.app where id = $1', [id]) : undefined);

const SIDE: Record<string, string> = { added: 'added', deleted: 'deleted', changed: 'changed' };
const STATUS: Record<Change['status'], string> = { copy: 'Changed in the copy', main: 'Changed in the main application', conflict: 'Conflict: changed on both sides' };

/** Another developer's lock on the target application or one of the pages a merge changes. */
const lockedFor = (username: string) => async (appId: number, pages: Set<number>) => {
  const l = await owner.one<Lock>(
    `select app_id, page_no, locked_by, locked_at::text, note from meta.builder_lock
      where app_id = $1 and locked_by <> $2 and (page_no = 0 or page_no = any($3::int[])) order by page_no limit 1`,
    [appId, username, [...pages]],
  );
  return l ? `${lockText(l)} The change is refused until it is unlocked.` : null;
};

function diffPanel(ch: Change) {
  const paths = [...new Set([...(ch.main?.keys() ?? []), ...(ch.copy?.keys() ?? [])])].sort();
  return html`<div id="diff">
    <p class="muted u-mt0">Lines with <code>-</code> are the main application's, lines with <code>+</code> the working copy's.</p>
    ${paths.map((p) => {
      const a = ch.main?.get(p), b = ch.copy?.get(p);
      if (a && b && a.equals(b)) return '';
      return html`<pre class="code-block diff">${unifiedDiff(p, a, b, ['main', 'copy'])}</pre>`;
    })}</div>`;
}

export async function workingCopyRoutes(app: FastifyInstance) {
  // an application's working copies, or (for a copy) what it is a copy of
  app.get(`${BASE}/apps/:id/working-copies`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const wc = await copyOf(a.id);
    let body;
    if (wc) {
      const main = await owner.one('select id, name, alias from meta.app where id = $1', [wc.main_app_id]);
      body = region('Working copy', html`
        <p class="u-mt0">This application is the working copy <b>${wc.name}</b> of
          <a href="${BASE}/apps/${main.id}">${main.name}</a> (<code>/a/${main.alias}</code>), made by ${wc.created_by}
          on ${wc.created_at.slice(0, 16)}.${wc.refreshed_at ? ` Last refreshed ${wc.refreshed_at.slice(0, 16)}.` : ''}${wc.merged_at ? ` Last merged ${wc.merged_at.slice(0, 16)} by ${wc.merged_by}.` : ''}</p>
        <p class="muted">Change it like any application: it runs against the main application's schema and data, with
          its automations and synchronisations switched off. Then compare it with the main application and merge it back.</p>
        <div class="buttons">
          <a class="btn btn-hot" href="${BASE}/apps/${a.id}/compare">${icon('layers')} Compare and merge</a>
          <form method="post" action="${BASE}/apps/${a.id}/working-copy/delete" class="u-inline">${csrf(s)}
            <button class="btn btn-danger" data-confirm="Delete the working copy ${wc.name} and its changes that are not merged?">Delete working copy</button></form>
        </div>`);
    } else {
      const copies = await copiesOf(a.id);
      body = html`${region('Working copies', html`
          <p class="muted u-mt0">A working copy is a second application made from this one, for changes in isolation
            (APEX: working copies). Compare it with this application and merge it back component by component;
            components changed on both sides are shown as conflicts to resolve.</p>
          ${copies.length
            ? html`<div class="table-wrap"><table class="report"><thead><tr><th>Name</th><th>Application</th><th>Made by</th><th>Made</th><th>Last merged</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
                ${copies.map((c) => html`<tr><td>${c.name}</td><td><a href="${BASE}/apps/${c.app_id}">${c.app_id}</a> <code>/a/${c.alias}</code></td>
                  <td>${c.created_by}</td><td>${c.created_at.slice(0, 16)}</td><td>${c.merged_at ? c.merged_at.slice(0, 16) : html`<span class="muted">never</span>`}</td>
                  <td><a class="btn btn-sm" href="${BASE}/apps/${c.app_id}/compare">${icon('layers')} Compare and merge</a></td></tr>`)}
              </tbody></table></div>`
            : html`<p class="muted">No working copies.</p>`}`)}
        ${region('Create a working copy', html`<form method="post" action="${BASE}/working-copies">${csrf(s)}
            <input type="hidden" name="main_app_id" value="${a.id}">
            <div class="form-grid">${input('name', 'Name', '', { required: true, placeholder: 'e.g. new-dashboard', help: `1–40 letters, digits, spaces, - or _. The copy runs at /a/${a.alias}-<name>.` })}</div>
            <div class="buttons"><button class="btn btn-hot">${icon('plus')} Create working copy</button></div>
          </form>`)}`;
    }
    const main = html`${appHeader(a, 'pages')}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, `${a.name} working copies`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Working copies']], main));
  });

  // create a working copy (not under /apps/:id, so a locked main application can still be copied)
  app.post(`${BASE}/working-copies`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.body?.main_app_id ?? '');
    if (!a) return reply.code(404).send('Not found');
    const name = String(req.body?.name ?? '').trim();
    try {
      const id = await createCopy(a.id, name, s.username!);
      await logActivity({ appId: a.id, username: s.username, event: 'working_copy', ip: clientIp(req), detail: `created ${name} (application ${id})` });
      flash(s, `Working copy ${name} created: change it, then compare and merge it back.`);
      return back(reply, s, `${BASE}/apps/${id}/working-copies`);
    } catch (e) {
      if (!(e instanceof WorkingCopyError)) throw e;
      flash(s, e.message, 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/working-copies`);
    }
  });

  // compare a working copy with its main application
  app.get(`${BASE}/apps/:id/compare`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const l = await compare(a.id);
    if (!l) {
      flash(s, 'This application is not a working copy.', 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/working-copies`);
    }
    const main = await owner.one('select id, name, alias from meta.app where id = $1', [l.copy.main_app_id]);
    const shown = typeof req.query.c === 'string' ? l.changes.find((ch) => ch.id === req.query.c) : undefined;
    const conflicts = l.changes.filter((ch) => ch.status === 'conflict').length;
    const count = (st: Change['status']) => l.changes.filter((ch) => ch.status === st).length;
    const side = (v: Change['inMain']) => (v ? SIDE[v] : html`<span class="muted">unchanged</span>`);
    const body = l.changes.length
      ? html`<p class="u-mt0">${count('copy')} changed in the copy, ${count('main')} changed in the main application, ${conflicts} conflict${conflicts === 1 ? '' : 's'}.</p>
        <form method="post" action="${BASE}/apps/${a.id}/merge">${csrf(s)}<input type="hidden" name="state" value="${fingerprint(l.changes)}">
          <div class="table-wrap"><table class="report"><caption class="sr-only">Changed components</caption>
            <thead><tr><th>Component</th><th>Main application</th><th>Working copy</th><th>Result</th><th><span class="sr-only">Differences</span></th></tr></thead><tbody>
            ${l.changes.map((ch, i) => html`<tr${ch.status === 'conflict' ? raw(' class="row-conflict"') : ''}><td>${ch.label}<br><small class="muted">${STATUS[ch.status]}</small></td>
              <td>${side(ch.inMain)}</td><td>${side(ch.inCopy)}</td>
              <td>${ch.status === 'conflict'
                ? html`<fieldset class="u-mt0"><legend class="sr-only">Keep for ${ch.label}</legend>
                    <label class="check"><input type="radio" name="r_${i}" value="main" required> Main</label>
                    <label class="check"><input type="radio" name="r_${i}" value="copy" required> Copy</label></fieldset>`
                : ch.status === 'copy' ? 'Copy' : 'Main'}</td>
              <td><a class="btn btn-sm" href="${BASE}/apps/${a.id}/compare?c=${encodeURIComponent(ch.id)}#diff">Differences</a></td></tr>`)}
          </tbody></table></div>
          <p class="muted">Merging writes the result into the main application and the working copy. Refreshing writes it into
            the working copy only (bringing the main application's changes in). Users, sessions, saved reports, secrets and
            the main application's automation switches stay as they are.</p>
          <div class="buttons">
            <button class="btn btn-hot" name="direction" value="merge" data-confirm="Merge the working copy into ${main.name}?">Merge into ${main.name}</button>
            <button class="btn" name="direction" value="refresh">Refresh the copy from ${main.name}</button>
          </div>
        </form>`
      : html`<p class="u-mt0">The working copy and the main application are the same: nothing to merge.</p>`;
    const page = html`${appHeader(a, 'pages')}<div class="ide-body">
      ${region(`Compare with ${main.name}`, html`<p class="muted u-mt0">Working copy <b>${l.copy.name}</b> of
          <a href="${BASE}/apps/${main.id}">${main.name}</a>, compared per component with the main application as it was
          when the copy was made${l.copy.refreshed_at || l.copy.merged_at ? ', refreshed or merged' : ''}.</p>${body}`)}
      ${shown ? region(`Differences: ${shown.label}`, diffPanel(shown)) : ''}
    </div>`;
    return send(reply, s, shell(s, `${a.name} compare`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Working copies', `${BASE}/apps/${a.id}/working-copies`], ['Compare']], page));
  });

  // merge into the main application, or refresh the copy from it
  app.post(`${BASE}/apps/:id/merge`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    const direction = b.direction === 'refresh' ? 'refresh' : b.direction === 'merge' ? 'merge' : null;
    const target = `${BASE}/apps/${a.id}/compare`;
    if (!direction) return reply.code(400).send('Bad request');
    const l = await compare(a.id);
    if (!l) return reply.code(404).send('Not a working copy');
    // conflicts: every one needs a choice (the fingerprint checks they are the ones shown)
    const takeCopy = new Set<string>();
    for (const [i, ch] of l.changes.entries()) {
      if (ch.status !== 'conflict') continue;
      const v = b[`r_${i}`];
      if (v !== 'main' && v !== 'copy') {
        flash(s, 'Choose main or copy for every conflict.', 'error');
        return back(reply, s, target);
      }
      if (v === 'copy') takeCopy.add(ch.id);
    }
    try {
      const r = await mergeCopy(a.id, { direction, takeCopy, state: String(b.state ?? ''), username: s.username!, lockedBy: lockedFor(s.username!) });
      await logActivity({ appId: direction === 'merge' ? r.mainId : a.id, username: s.username, event: 'working_copy', ip: clientIp(req), detail: `${direction === 'merge' ? 'merged' : 'refreshed'} ${l.copy.name} (${r.changes} components)` });
      flash(s, direction === 'merge' ? `Working copy ${l.copy.name} merged (${r.changes} components).` : `Working copy ${l.copy.name} refreshed from the main application.`);
      return back(reply, s, direction === 'merge' ? `${BASE}/apps/${r.mainId}` : target);
    } catch (e) {
      if (!(e instanceof WorkingCopyError)) throw e;
      flash(s, e.message, 'error');
      return back(reply, s, target);
    }
  });

  app.post(`${BASE}/apps/:id/working-copy/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const wc = await copyOf(a.id);
    if (!wc || !(await deleteCopy(a.id))) {
      flash(s, 'This application is not a working copy.', 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/working-copies`);
    }
    await logActivity({ appId: wc.main_app_id, username: s.username, event: 'working_copy', ip: clientIp(req), detail: `deleted ${wc.name}` });
    flash(s, `Working copy ${wc.name} deleted.`);
    return back(reply, s, `${BASE}/apps/${wc.main_app_id}/working-copies`);
  });
}
