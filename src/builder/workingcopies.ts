import type { FastifyInstance } from 'fastify';
import { unifiedDiff } from '../cli/diff.ts';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import {
  compare, copiesOf, copyOf, createCopy, deleteCopy, fingerprint, mergeCopy, WorkingCopyError, type Change,
} from '../workingcopy.ts';
import { lockedFor } from '../cli/working-copy.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Req } from './ui.ts';
import { appAllowed } from './workspaces.ts';
import { scopedTx as tx } from './i18n.ts';

// Working copies (APEX 24.1+): App → Working copies lists an application's
// copies and makes new ones; a copy's page compares it with its main
// application (three ways, per component, src/workingcopy.ts), shows the
// differences and merges it back, or refreshes it with the main
// application's changes. Conflicts (a component changed on both sides) need a
// choice. A merge is refused while another developer has locked the target
// application or a page the merge changes (sprint 31 locks).

const appRow = async (id: string) => (/^\d{1,9}$/.test(id) ? owner.one('select id, name, alias from meta.app where id = $1', [id]) : undefined);

const SIDE: Record<string, string> = { added: 'added', deleted: 'deleted', changed: 'changed' };
const STATUS = (): Record<Change['status'], string> => ({ copy: tx('wcp.changed_in_the_copy'), main: tx('wcp.changed_in_the_main_application'), conflict: tx('wcp.conflict_changed_on_both_sides') });

function diffPanel(ch: Change) {
  const paths = [...new Set([...(ch.main?.keys() ?? []), ...(ch.copy?.keys() ?? [])])].sort();
  return html`<div id="diff">
    <p class="muted u-mt0">${tx.code('wcp.lines_with_are_the_main')}</p>
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
      body = region(tx('wcp.working_copy'), html`
        <p class="u-mt0">${tx.rich('wcp.is_copy', { name: html`<b>${wc.name}</b>`, main: html`<a href="${BASE}/apps/${main.id}">${main.name}</a>`, path: html`<code>/a/${main.alias}</code>`, by: wc.created_by, at: wc.created_at.slice(0, 16) })}${wc.refreshed_at ? ` ${tx('wcp.last_refreshed', { at: wc.refreshed_at.slice(0, 16) })}` : ''}${wc.merged_at ? ` ${tx('wcp.last_merged_by', { at: wc.merged_at.slice(0, 16), by: wc.merged_by })}` : ''}</p>
        <p class="muted">${tx('wcp.change_it_like_any_application')}</p>
        <div class="buttons">
          <a class="btn btn-hot" href="${BASE}/apps/${a.id}/compare">${icon('layers')} ${tx('wcp.compare_and_merge')}</a>
          <form method="post" action="${BASE}/apps/${a.id}/working-copy/delete" class="u-inline">${csrf(s)}
            <button class="btn btn-danger" data-confirm="${tx('wcp.delete_confirm', { name: wc.name })}">${tx('wcp.delete_working_copy')}</button></form>
        </div>`);
    } else {
      const copies = await copiesOf(a.id);
      body = html`${region(tx('wcp.working_copies'), html`
          <p class="muted u-mt0">${tx('wcp.a_working_copy_is_a')}</p>
          ${copies.length
            ? html`<div class="table-wrap"><table class="report"><thead><tr><th>${tx('wcp.name')}</th><th>${tx('wcp.application')}</th><th>${tx('wcp.made_by')}</th><th>${tx('wcp.made')}</th><th>${tx('wcp.last_merged')}</th><th>${tx('wcp.actions')}</th></tr></thead><tbody>
                ${copies.map((c) => html`<tr><td>${c.name}</td><td><a href="${BASE}/apps/${c.app_id}">${c.app_id}</a> <code>/a/${c.alias}</code></td>
                  <td>${c.created_by}</td><td>${c.created_at.slice(0, 16)}</td><td>${c.merged_at ? c.merged_at.slice(0, 16) : html`<span class="muted">never</span>`}</td>
                  <td><a class="btn btn-sm" href="${BASE}/apps/${c.app_id}/compare">${icon('layers')} ${tx('wcp.compare_and_merge')}</a></td></tr>`)}
              </tbody></table></div>`
            : html`<p class="muted">${tx('wcp.no_working_copies')}</p>`}`)}
        ${region(tx('wcp.create_a_working_copy'), html`<form method="post" action="${BASE}/working-copies">${csrf(s)}
            <input type="hidden" name="main_app_id" value="${a.id}">
            <div class="form-grid">${input('name', tx('wcp.name'), '', { required: true, placeholder: tx('wcp.e_g_new_dashboard'), help: `1–40 letters, digits, spaces, - or _. The copy runs at /a/${a.alias}-<name>.` })}</div>
            <div class="buttons"><button class="btn btn-hot">${icon('plus')} ${tx('wcp.create_working_copy')}</button></div>
          </form>`)}`;
    }
    const main = html`${appHeader(a, 'pages', s)}<div class="ide-body">${body}</div>`;
    return send(reply, s, shell(s, `${a.name} working copies`, [[tx('wcp.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('wcp.working_copies')]], main));
  });

  // create a working copy (not under /apps/:id, so a locked main application can still be copied)
  app.post(`${BASE}/working-copies`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(req.body?.main_app_id ?? '');
    if (!a || !(await appAllowed(s, a.id))) return reply.code(404).send('Not found');
    const name = String(req.body?.name ?? '').trim();
    try {
      const id = await createCopy(a.id, name, s.username!);
      await logActivity({ appId: a.id, username: s.username, event: 'working_copy', ip: clientIp(req), detail: `created ${name} (application ${id})` });
      flash(s, tx('wcp.created', { name }));
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
      flash(s, tx('wcp.this_application_is_not_a'), 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/working-copies`);
    }
    const main = await owner.one('select id, name, alias from meta.app where id = $1', [l.copy.main_app_id]);
    const shown = typeof req.query.c === 'string' ? l.changes.find((ch) => ch.id === req.query.c) : undefined;
    const conflicts = l.changes.filter((ch) => ch.status === 'conflict').length;
    const count = (st: Change['status']) => l.changes.filter((ch) => ch.status === st).length;
    const side = (v: Change['inMain']) => (v ? tx.dyn(`wcp.side.${v}`, SIDE[v]) : html`<span class="muted">${tx('wcp.unchanged')}</span>`);
    const body = l.changes.length
      ? html`<p class="u-mt0">${tx(conflicts === 1 ? 'wcp.counts_1' : 'wcp.counts', { copy: count('copy'), main: count('main'), conflicts })}</p>
        <form method="post" action="${BASE}/apps/${a.id}/merge">${csrf(s)}<input type="hidden" name="state" value="${fingerprint(l.changes)}">
          <div class="table-wrap"><table class="report" aria-label="${tx('wcp.changed_components')}">
            <thead><tr><th>${tx('wcp.component')}</th><th>${tx('wcp.main_application')}</th><th>${tx('wcp.working_copy')}</th><th>${tx('wcp.result')}</th><th>${tx('wcp.differences')}</th></tr></thead><tbody>
            ${l.changes.map((ch, i) => html`<tr${ch.status === 'conflict' ? raw(' class="row-conflict"') : ''}><td>${ch.label}<br><small class="muted">${STATUS()[ch.status]}</small></td>
              <td>${side(ch.inMain)}</td><td>${side(ch.inCopy)}</td>
              <td>${ch.status === 'conflict'
                ? html`<fieldset class="u-mt0"><legend class="sr-only">${tx('wcp.keep_for', { label: ch.label })}</legend>
                    <label class="check"><input type="radio" name="r_${i}" value="main" required> ${tx('wcp.main')}</label>
                    <label class="check"><input type="radio" name="r_${i}" value="copy" required> ${tx('wcp.copy')}</label></fieldset>`
                : ch.status === 'copy' ? tx('wcp.copy') : tx('wcp.main')}</td>
              <td><a class="btn btn-sm" href="${BASE}/apps/${a.id}/compare?c=${encodeURIComponent(ch.id)}#diff">${tx('wcp.show')}</a></td></tr>`)}
          </tbody></table></div>
          <p class="muted">${tx('wcp.merging_writes_the_result_into')}</p>
          <div class="buttons">
            <button class="btn btn-hot" name="direction" value="merge" data-confirm="${tx('wcp.merge_confirm', { main: main.name })}">${tx('wcp.merge_into', { main: main.name })}</button>
            <button class="btn" name="direction" value="refresh">${tx('wcp.refresh_from', { main: main.name })}</button>
          </div>
        </form>`
      : html`<p class="u-mt0">${tx('wcp.the_working_copy_and_the')}</p>`;
    const page = html`${appHeader(a, 'pages', s)}<div class="ide-body">
      ${region(tx('wcp.compare_title', { main: main.name }), html`<p class="muted u-mt0">${tx.rich(l.copy.refreshed_at || l.copy.merged_at ? 'wcp.compare_intro_since' : 'wcp.compare_intro', { copy: html`<b>${l.copy.name}</b>`, main: html`<a href="${BASE}/apps/${main.id}">${main.name}</a>` })}</p>${body}`)}
      ${shown ? region(tx('wcp.diff_title', { label: shown.label }), diffPanel(shown)) : ''}
    </div>`;
    return send(reply, s, shell(s, `${a.name} compare`, [[tx('wcp.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('wcp.working_copies'), `${BASE}/apps/${a.id}/working-copies`], [tx('wcp.compare')]], page));
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
    if (!l) return reply.code(404).send(tx('wcp.not_a_copy'));
    // conflicts: every one needs a choice (the fingerprint checks they are the ones shown)
    const takeCopy = new Set<string>();
    for (const [i, ch] of l.changes.entries()) {
      if (ch.status !== 'conflict') continue;
      const v = b[`r_${i}`];
      if (v !== 'main' && v !== 'copy') {
        flash(s, tx('wcp.choose_main_or_copy_for'), 'error');
        return back(reply, s, target);
      }
      if (v === 'copy') takeCopy.add(ch.id);
    }
    try {
      const r = await mergeCopy(a.id, { direction, takeCopy, state: String(b.state ?? ''), username: s.username!, lockedBy: lockedFor(s.username!) });
      await logActivity({ appId: direction === 'merge' ? r.mainId : a.id, username: s.username, event: 'working_copy', ip: clientIp(req), detail: `${direction === 'merge' ? 'merged' : 'refreshed'} ${l.copy.name} (${r.changes} components)` });
      flash(s, direction === 'merge' ? tx('wcp.merged', { name: l.copy.name, n: r.changes }) : tx('wcp.refreshed', { name: l.copy.name }));
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
      flash(s, tx('wcp.this_application_is_not_a'), 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/working-copies`);
    }
    await logActivity({ appId: wc.main_app_id, username: s.username, event: 'working_copy', ip: clientIp(req), detail: `deleted ${wc.name}` });
    flash(s, tx('wcp.deleted', { name: wc.name }));
    return back(reply, s, `${BASE}/apps/${wc.main_app_id}/working-copies`);
  });
}
