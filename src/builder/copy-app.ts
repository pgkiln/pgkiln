import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { aliasFromName, createAppError } from './newapp.ts';
import { appAllowed, placeApp } from './workspaces.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 203, AX-6; APEX: Application home → Tasks → Copy this Application) A copy of an application under a new
// name and alias: its export (meta.export_app) imported again (meta.import_app), like a working copy (src/workingcopy.ts
// createCopy) but on its own: no link to the original, nothing to merge. The copy is in the original's workspace,
// runs on the same database role and tables, and the same users may run it with the same roles. Automations and
// REST data source synchronisations are switched off in the copy (the original runs them; turn them on in the copy
// when it should); web credentials keep their secrets. Users' data (sessions, saved reports, preferences) is not copied.

const ALIAS = /^[a-z][a-z0-9_-]*$/;
const appRow = async (id: string) => (/^\d{1,9}$/.test(id) ? owner.one('select id, name, alias from meta.app where id = $1', [id]) : undefined);

export class CopyAppError extends Error {}

/** Copy an application under a new name and alias; returns the copy's id. */
export async function copyApplication(fromId: number, name: string, alias: string): Promise<number> {
  name = name.trim();
  alias = alias.trim().toLowerCase();
  if (!name || name.length > 100) throw new CopyAppError(tx('cpa.bad_name'));
  if (!ALIAS.test(alias) || alias.length > 50) throw new CopyAppError(tx('cpa.bad_alias'));
  return owner.tx(async (c) => {
    const from = (await c.query<{ alias: string }>('select alias from meta.app where id = $1', [fromId])).rows[0];
    if (!from) throw new CopyAppError(tx('cpa.not_found'));
    if ((await c.query('select 1 from meta.app where alias = $1', [alias])).rowCount) throw new CopyAppError(tx('cpa.alias_taken', { alias }));
    const doc = (await c.query('select meta.export_app($1) as d', [from.alias])).rows[0].d;
    let id: number;
    try {
      id = (await c.query<{ id: number }>('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), alias])).rows[0].id;
    } catch (e) {
      throw new CopyAppError(createAppError(e, alias));
    }
    await c.query('update meta.app set name = $2 where id = $1', [id, name]);
    await placeApp(c, id, (await c.query<{ ws: number }>('select meta.app_workspace($1::int) as ws', [fromId])).rows[0].ws);
    // the same people may run the copy, with the same roles
    await c.query('insert into meta.app_access (app_id, account_id, roles) select $1, account_id, roles from meta.app_access where app_id = $2 on conflict do nothing', [id, fromId]);
    // web credentials work in the copy too (an export carries no secrets)
    await c.query(
      `update meta.web_credential n set secret_enc = o.secret_enc, password_enc = o.password_enc,
              refresh_token_enc = o.refresh_token_enc, token_refreshed_at = o.token_refreshed_at
         from meta.web_credential o where o.app_id = $2 and n.app_id = $1 and n.name = o.name`,
      [id, fromId],
    );
    // the original runs the automations and synchronisations, not (yet) the copy
    await c.query('update meta.automation set enabled = false where app_id = $1', [id]);
    await c.query('update meta.rest_source set sync_enabled = false where app_id = $1', [id]);
    return id;
  });
}

export async function copyAppRoutes(app: FastifyInstance) {
  app.get(`${BASE}/apps/:id/copy`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await owner.one('select * from meta.app where id = $1', [/^\d{1,9}$/.test(req.params.id) ? req.params.id : '0']);
    if (!a) return reply.code(404).send('Not found');
    const name = tx('cpa.default_name', { name: a.name }).slice(0, 100);
    const alias = await aliasFromName(name);
    const main = html`${appHeader(a, 'pages', s)}
      ${region(tx('cpa.title'), html`<p class="muted u-mt0">${tx('cpa.intro', { name: a.name })}</p>
        <form method="post" action="${BASE}/copy-app">${csrf(s)}<input type="hidden" name="from" value="${a.id}">
          <div class="form-grid">
            <div class="field"><label class="label" for="f_name">${tx('cpa.name')}</label>
              <input id="f_name" name="name" value="${name}" required maxlength="100" autocomplete="off"></div>
            <div class="field"><label class="label" for="f_alias">${tx('cpa.alias')}</label>
              <input id="f_alias" name="alias" value="${alias}" required pattern="[a-z][a-z0-9_\\-]*" maxlength="50" autocomplete="off" aria-describedby="f_alias_help">
              <small class="help" id="f_alias_help">${tx('cpa.alias_help')}</small></div>
          </div>
          <p class="muted">${tx('cpa.what')}</p>
          <div class="buttons"><button class="btn btn-hot">${icon('copy')} ${tx('cpa.copy')}</button>
            <a class="btn" href="${BASE}/apps/${a.id}">${tx('cpa.cancel')}</a></div>
        </form>`)}`;
    return send(reply, s, shell(s, tx('cpa.title'), [[tx('util.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('cpa.title')]], main));
  });

  // not under /apps/:id: copying reads the application, so a locked application can still be copied
  app.post(`${BASE}/copy-app`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appRow(String(req.body?.from ?? ''));
    if (!a || !(await appAllowed(s, a.id))) return reply.code(404).send('Not found');
    const name = String(req.body?.name ?? '').trim();
    try {
      const id = await copyApplication(a.id, name, String(req.body?.alias ?? ''));
      await logActivity({ appId: id, username: s.username, event: 'app_copied', ip: clientIp(req), detail: `copy of ${a.alias} (application ${a.id})` });
      flash(s, tx('cpa.done', { name, from: a.name }));
      return back(reply, s, `${BASE}/apps/${id}`);
    } catch (e) {
      if (!(e instanceof CopyAppError)) throw e;
      flash(s, e.message, 'error');
      return back(reply, s, `${BASE}/apps/${a.id}/copy`);
    }
  });
}
