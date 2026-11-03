import type { FastifyInstance } from 'fastify';
import { stableJson } from '../appfiles.ts';
import { owner } from '../db.ts';
import { recordHistory } from '../history.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { appHeader, back, BASE, csrf, designerUrl, developer, flash, region, send, shell, type Req } from './ui.ts';
import { diffHtml } from './utilities.ts';

// (sprint 138, AP-5) App Builder → Utilities → Upgrade application (APEX:
// Upgrade Application): components made before a pgkiln version that brought a
// better default, each with its reason, a preview of the change and an Upgrade
// button (or all of a kind at once). The candidates are worked out again on
// every request: a POST names a candidate's key, and only a candidate that is
// still found is changed. Each upgrade is recorded in the change history.
//
// Rules:
//  - nav_appearance: an application without a navigation appearance gets
//    Pillar Light (sprint 117), the look of new applications.
//  - date_picker: a text item of a form whose column is a date or a timestamp
//    becomes a date / date-time item with pgkiln's date picker (sprint 84).
//  - popup_lov: a select list whose list of values reads a table of more than
//    POPUP_ROWS rows (the planner's estimate) becomes a popup list of values,
//    which searches and pages on the server instead of sending every row.

export const POPUP_ROWS = 1000;

export interface Candidate {
  key: string;
  rule: Rule;
  label: string;
  page: number | null;
  url: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** the change: a statement and its parameters */
  sql: [string, unknown[]];
}

export type Rule = 'nav_appearance' | 'date_picker' | 'popup_lov';
export const RULES: Record<Rule, { title: string; since: string }> = {
  nav_appearance: { title: 'Navigation appearance', since: 'Navigation appearances (Pillar Light, Pillar Dark) came with sprint 117.' },
  date_picker: { title: 'Date picker for date columns', since: 'Date and date-time items have had pgkiln\'s date picker since sprint 84.' },
  popup_lov: { title: 'Paged list of values for large tables', since: 'Popup lists of values search and page on the server.' },
};

/** The relations a list of values query reads (FROM / JOIN names). */
export const lovTables = (sql: string) =>
  [...sql.matchAll(/\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi)].map((m) => m[1].replace(/\s+/g, ''));

/** Every upgrade candidate of an application. */
export async function upgradeCandidates(appId: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const app = await owner.one('select id, theme from meta.app where id = $1', [appId]);
  if (!app) return out;
  const theme = app.theme && typeof app.theme === 'object' ? app.theme : {};
  if (typeof theme.appearance !== 'string' || !theme.appearance) {
    out.push({
      key: 'nav_appearance:app', rule: 'nav_appearance', label: 'Application settings › Theme', page: null, url: `${BASE}/apps/${appId}/theme`,
      reason: 'The application has no navigation appearance: Pillar Light gives the header strip and the filled current page of new applications.',
      before: { appearance: theme.appearance ?? null }, after: { appearance: 'pillar_light' },
      sql: [`update meta.app set theme = coalesce(theme, '{}'::jsonb) || '{"appearance": "pillar_light"}' where id = $1 and coalesce(theme ->> 'appearance', '') = ''`, [appId]],
    });
  }
  const dates = (await owner.query(
    `select i.id, i.name, i.type, p.page_no, i.source_column, r.table_name, format_type(a.atttypid, a.atttypmod) as coltype,
            a.atttypid = 'date'::regtype as is_date
       from meta.item i join meta.page p on p.id = i.page_id join meta.region r on r.id = i.region_id
       join pg_attribute a on a.attrelid = to_regclass(r.table_name) and a.attname = i.source_column and not a.attisdropped
      where p.app_id = $1 and i.type = 'text' and r.type = 'form' and r.table_name is not null
        and a.atttypid in ('date'::regtype, 'timestamp'::regtype, 'timestamptz'::regtype)
      order by p.page_no, i.seq, i.id`, [appId])).rows;
  for (const r of dates) {
    const to = r.is_date ? 'date' : 'datetime';
    out.push({
      key: `date_picker:${r.id}`, rule: 'date_picker', label: `Page ${r.page_no} › item ${r.name}`, page: r.page_no, url: designerUrl(appId, r.page_no, `c=item-${r.id}`),
      reason: `${r.table_name}.${r.source_column} is a ${r.coltype} column shown as a text field: a ${to} item has the date picker and reads the date in the application's format.`,
      before: { type: 'text' }, after: { type: to },
      sql: [`update meta.item set type = $2 where id = $1 and type = 'text'`, [r.id, to]],
    });
  }
  const selects = (await owner.query(
    `select i.id, i.name, p.page_no, i.lov from meta.item i join meta.page p on p.id = i.page_id
      where p.app_id = $1 and i.type = 'select' and i.lov is not null and i.lov !~* '^\\s*(STATIC|LOV):'
      order by p.page_no, i.seq, i.id`, [appId])).rows;
  for (const r of selects) {
    const names = lovTables(r.lov);
    if (!names.length) continue;
    const big = (await owner.query<{ name: string; n: number }>(
      `select x as name, c.reltuples::bigint::int as n from unnest($1::text[]) x join pg_class c on c.oid = to_regclass(x) where c.reltuples > $2 order by c.reltuples desc limit 1`,
      [names, POPUP_ROWS]).catch(() => ({ rows: [] }))).rows[0];
    if (!big) continue;
    out.push({
      key: `popup_lov:${r.id}`, rule: 'popup_lov', label: `Page ${r.page_no} › item ${r.name}`, page: r.page_no, url: designerUrl(appId, r.page_no, `c=item-${r.id}`),
      reason: `Its list of values reads ${big.name} (about ${big.n} rows): a select list sends every row with the page; a popup list of values searches and pages on the server.`,
      before: { type: 'select' }, after: { type: 'popup_lov' },
      sql: [`update meta.item set type = 'popup_lov' where id = $1 and type = 'select'`, [r.id]],
    });
  }
  return out;
}

export async function upgradeRoutes(app: FastifyInstance) {
  const appOf = async (id: string) => (/^\d{1,9}$/.test(id) ? owner.one('select * from meta.app where id = $1', [id]) : undefined);

  app.get(`${BASE}/apps/:id/utilities/upgrade`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const all = await upgradeCandidates(a.id);
    const preview = typeof req.query?.preview === 'string' ? all.find((c) => c.key === req.query.preview) : undefined;
    const u = `${BASE}/apps/${a.id}/utilities/upgrade`;
    const sections = (Object.keys(RULES) as Rule[]).map((rule) => {
      const list = all.filter((c) => c.rule === rule);
      return html`<section class="util-upgrade" aria-labelledby="up-${rule}"><h3 id="up-${rule}">${RULES[rule].title} <span class="tag">${list.length}</span></h3>
        <p class="muted small">${RULES[rule].since}</p>
        ${list.length ? html`<div class="table-wrap"><table class="table report-reflow"><thead><tr><th scope="col">Component</th><th scope="col">Why</th><th scope="col">Actions</th></tr></thead><tbody>
          ${list.map((c) => html`<tr${preview?.key === c.key ? raw(' aria-current="true"') : ''}><td data-label="Component"><a href="${c.url}">${c.label}</a></td><td data-label="Why">${c.reason}</td>
            <td data-label="Actions"><div class="buttons"><a class="btn btn-sm" href="${u}?preview=${encodeURIComponent(c.key)}#preview">Preview</a>
              <form method="post" action="${u}">${csrf(s)}<input type="hidden" name="key" value="${c.key}"><button class="btn btn-sm btn-hot">${icon('refresh')} Upgrade</button></form></div></td></tr>`)}</tbody></table></div>
          ${list.length > 1 ? html`<form method="post" action="${u}" class="u-mt075">${csrf(s)}<input type="hidden" name="rule" value="${rule}"><button class="btn btn-sm">${icon('refresh')} Upgrade all ${list.length}</button></form>` : ''}`
          : html`<p class="muted">Nothing to upgrade.</p>`}</section>`;
    });
    const main = html`${appHeader(a, 'utilities', s)}
      ${region('Upgrade application', html`<p class="muted u-mt0">Components made before a pgkiln version that brought a better default. Preview a change, then upgrade one component or all of a kind; every upgrade is in the change history (and the backups) if you want to go back.</p>${sections}`)}
      ${preview ? region(`Preview: ${preview.label}`, html`<p class="muted u-mt0">${preview.reason}</p>${diffHtml('settings', stableJson(preview.before), stableJson(preview.after), ['now', 'upgraded'])}
        <form method="post" action="${u}">${csrf(s)}<input type="hidden" name="key" value="${preview.key}"><div class="buttons"><button class="btn btn-hot">${icon('refresh')} Upgrade</button></div></form>`, '', 'preview') : ''}`;
    return send(reply, s, shell(s, `Upgrade application · ${a.name}`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Utilities', `${BASE}/apps/${a.id}/utilities`], ['Upgrade application']], main));
  });

  app.post(`${BASE}/apps/:id/utilities/upgrade`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOf(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const all = await upgradeCandidates(a.id);
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    const rule = typeof req.body?.rule === 'string' ? req.body.rule : '';
    const chosen = key ? all.filter((c) => c.key === key) : all.filter((c) => c.rule === rule);
    const to = `${BASE}/apps/${a.id}/utilities/upgrade`;
    if (!chosen.length) {
      flash(s, 'Nothing to upgrade: the component was changed or upgraded in the meantime.', 'error');
      return back(reply, s, to);
    }
    await owner.tx(async (c) => {
      for (const x of chosen) await c.query(x.sql[0], x.sql[1]);
    });
    await recordHistory(a.id, s.username, 'upgrade').catch((err) => req.log.warn({ err }, 'change history not recorded'));
    flash(s, chosen.length === 1 ? `${chosen[0].label} upgraded.` : `${chosen.length} components upgraded.`);
    return back(reply, s, to);
  });
}
