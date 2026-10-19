import type { FastifyInstance, FastifyReply } from 'fastify';
import { owner, type Client } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  appIssueCounts, isLabelColor, issueHtml, LABEL_COLORS, logIssue, pageIssues, recordMentions, teamCounts, teamSetup, workspaceDevelopers,
} from '../team.ts';
import { TEAM_LANGUAGES, TEAM_SAMPLES } from '../team-samples.ts';
import { ago } from './home.ts';
import { back, BASE, csrf, designerUrl, developer, flash, region, send, shell, type Req } from './ui.ts';
import { appAllowed, appWorkspace, currentWorkspace, workspaceAdmin } from './workspaces.ts';

// (sprint 113, WS-3; migration 122) Builder → Team Development (APEX: Team Development): the current workspace's
// issues (a list with filters and saved views, and a board by label group or milestone that works without
// JavaScript), an issue's page (Markdown body, labels, milestone, assignees, application and page link, comments
// with @mentions and canned responses, history), labels in groups, milestones, templates, and the set-up wizard
// (src/team-samples.ts). Users' feedback and developer comments become issues (linked back). Every query is
// limited to the developer's current workspace; ids from the request are looked up within it.
// The data side (setup, counts, mentions, the workspace export's "team" part) is src/team.ts.

/** (a literal: ui.ts and locks.ts import this module's neighbours, so no top-level use of their constants) */
export const TEAM = '/builder/team';

type Tab = 'issues' | 'board' | 'labels' | 'milestones' | 'templates' | 'setup';
const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,15}$/.test(v);
const when = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const NAME40 = /^\S(.{0,38}\S)?$/;
/** Posted values of a multi-valued field (checkboxes): fastify's formbody gives a string or an array. */
const many = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]);

/** A developer session with a current workspace, or null (answered). */
async function teamDev(req: Req, reply: FastifyReply): Promise<{ s: Session; ws: number } | null> {
  const s = await developer(req, reply);
  if (!s) return null;
  const ws = currentWorkspace(s);
  if (ws < 0) {
    await send(reply.code(403), s, shell(s, 'Team Development', [['Team Development']],
      html`<h1>Team Development</h1><div class="alert alert-info" role="status">You are not a developer of any workspace: Team Development belongs to a workspace.</div>`, 'team'));
    return null;
  }
  return { s, ws };
}

interface Label { id: number; name: string; color: string; group_id: number | null; group_name: string | null; description: string | null; seq: number }
interface Milestone { id: number; name: string; description: string | null; due_date: string | null; status: string; open: number; closed: number }

async function lookups(ws: number) {
  const [groups, labels, milestones, apps, devs] = await Promise.all([
    owner.query<{ id: number; name: string; description: string | null; seq: number }>('select id, name, description, seq from meta.team_label_group where workspace_id = $1 order by seq, lower(name)', [ws]),
    owner.query<Label>(`select l.id, l.name, l.color, l.group_id, g.name as group_name, l.description, l.seq from meta.team_label l left join meta.team_label_group g on g.id = l.group_id
                         where l.workspace_id = $1 order by g.seq nulls last, lower(g.name), l.seq, lower(l.name)`, [ws]),
    owner.query<Milestone>(`select m.id, m.name, m.description, m.due_date::text, m.status,
                              (select count(*) from meta.team_issue i where i.milestone_id = m.id and i.status = 'open')::int as open,
                              (select count(*) from meta.team_issue i where i.milestone_id = m.id and i.status = 'closed')::int as closed
                             from meta.team_milestone m where m.workspace_id = $1 order by m.status = 'closed', m.due_date nulls last, lower(m.name)`, [ws]),
    owner.query<{ id: number; name: string; alias: string }>('select id, name, alias from meta.app a where meta.app_workspace(a.id) = $1 order by lower(name)', [ws]),
    workspaceDevelopers(ws),
  ]);
  return { groups: groups.rows, labels: labels.rows, milestones: milestones.rows, apps: apps.rows, devs };
}
type Lookups = Awaited<ReturnType<typeof lookups>>;

const chip = (l: { name: string; color: string }) => html`<span class="team-label team-label-${isLabelColor(l.color) ? l.color : 'gray'}">${l.name}</span>`;

function teamHeader(active: Tab, counts?: { open: number; mine: number; mentions: number }) {
  const tab = (key: Tab, href: string, ic: string, label: string) =>
    html`<a class="ide-tab" href="${href}"${active === key ? raw(' aria-current="page"') : ''}>${icon(ic)}<span>${label}</span></a>`;
  return html`<div class="team-head"><h1>Team Development</h1>
      ${counts ? html`<p class="muted small team-counts">${counts.open} open issue${counts.open === 1 ? '' : 's'} · <a href="${TEAM}?assignee=me">${counts.mine} assigned to you</a>${counts.mentions ? html` · <a href="${TEAM}#mentions">${counts.mentions} mention${counts.mentions === 1 ? '' : 's'} of you</a>` : ''}</p>` : ''}
      <a class="btn btn-hot btn-sm" href="${TEAM}/issues/new">${icon('plus')} New issue</a></div>
    <nav class="ide-tabs team-tabs u-mb1" aria-label="Team Development">
      ${tab('issues', TEAM, 'list', 'Issues')}${tab('board', `${TEAM}/board`, 'kanban', 'Board')}${tab('labels', `${TEAM}/labels`, 'tag', 'Labels')}
      ${tab('milestones', `${TEAM}/milestones`, 'flag', 'Milestones')}${tab('templates', `${TEAM}/templates`, 'note', 'Templates')}${tab('setup', `${TEAM}/setup`, 'settings', 'Set up')}
    </nav>`;
}

const page = (s: Session, title: string, crumbs: [string, string?][], main: Raw) => shell(s, title, [['Team Development', TEAM], ...crumbs], main, 'team');

// ------------------------------------------------------------------ filters

interface Filters { status: 'open' | 'closed' | 'all'; label: string; milestone: string; assignee: string; app: string; page: string; q: string }
function parseFilters(q: Record<string, unknown>): Filters {
  const s = (k: string) => (typeof q[k] === 'string' ? (q[k] as string).trim() : '');
  return {
    status: s('status') === 'closed' || s('status') === 'all' ? (s('status') as 'closed' | 'all') : 'open',
    label: isId(s('label')) ? s('label') : '',
    milestone: isId(s('milestone')) || s('milestone') === 'none' ? s('milestone') : '',
    assignee: s('assignee').slice(0, 100),
    app: /^\d{1,9}$/.test(s('app')) ? s('app') : '',
    page: /^\d{1,9}$/.test(s('page')) ? s('page') : '',
    q: s('q').slice(0, 100),
  };
}
const filterQuery = (f: Filters, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'status' && v === 'open')) p.set(k, v);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
};

const ISSUE_COLS = `i.id, i.title, i.status, i.page_no, i.app_id, i.created_by, i.created_at, i.updated_at, i.closed_at, i.milestone_id, m.name as milestone,
  a.name as app_name,
  (select count(*) from meta.team_issue_comment c where c.issue_id = i.id)::int as comments,
  coalesce((select json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color, 'group_id', l.group_id) order by g.seq nulls last, l.seq, lower(l.name))
              from meta.team_issue_label il join meta.team_label l on l.id = il.label_id left join meta.team_label_group g on g.id = l.group_id where il.issue_id = i.id), '[]') as labels,
  coalesce((select array_agg(x.username order by x.username) from meta.team_issue_assignee x where x.issue_id = i.id), '{}') as assignees`;
const ISSUE_FROM = `meta.team_issue i left join meta.team_milestone m on m.id = i.milestone_id
  left join meta.app a on a.id = i.app_id and meta.app_workspace(a.id) = i.workspace_id`;

interface IssueRow {
  id: number; title: string; status: string; page_no: number | null; app_id: number | null; app_name: string | null; created_by: string; created_at: string; updated_at: string;
  closed_at: string | null; milestone_id: number | null; milestone: string | null; comments: number; labels: { id: number; name: string; color: string; group_id: number | null }[]; assignees: string[];
}

async function findIssues(ws: number, f: Filters, me: string | null, limit = 500) {
  const where = ['i.workspace_id = $1'];
  const params: unknown[] = [ws];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.status !== 'all') add('i.status = ?', f.status);
  if (f.label) add('exists (select 1 from meta.team_issue_label il where il.issue_id = i.id and il.label_id = ?)', f.label);
  if (f.milestone === 'none') where.push('i.milestone_id is null');
  else if (f.milestone) add('i.milestone_id = ?', f.milestone);
  if (f.assignee === 'none') where.push('not exists (select 1 from meta.team_issue_assignee x where x.issue_id = i.id)');
  else if (f.assignee) add('exists (select 1 from meta.team_issue_assignee x where x.issue_id = i.id and x.username = ?)', f.assignee === 'me' ? me : f.assignee);
  if (f.app) add('i.app_id = ?', f.app);
  if (f.page) add('i.page_no = ?', f.page);
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, f.q.startsWith('#') ? f.q : `#${f.q}`);
    where.push(`(i.title ilike $${params.length - 1} or i.body ilike $${params.length - 1} or ('#' || i.id) = $${params.length})`);
  }
  return (await owner.query<IssueRow>(`select ${ISSUE_COLS} from ${ISSUE_FROM} where ${where.join(' and ')} order by i.status = 'closed', i.updated_at desc, i.id desc limit ${limit}`, params)).rows;
}

function filterForm(f: Filters, lk: Lookups, action: string, hidden: Record<string, string> = {}) {
  const opt = (v: string, label: string, cur: string) => html`<option value="${v}"${v === cur ? raw(' selected') : ''}>${label}</option>`;
  const sel = (name: string, label: string, cur: string, options: Raw[]) =>
    html`<div class="field"><label class="label" for="tf_${name}">${label}</label><select id="tf_${name}" name="${name}">${options}</select></div>`;
  return html`<form method="get" action="${action}" class="team-filters" role="search" aria-label="Filter the issues">
    ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    ${f.page ? html`<input type="hidden" name="page" value="${f.page}">` : ''}
    <div class="field team-q"><label class="label" for="tf_q">Search</label><input id="tf_q" name="q" type="search" value="${f.q}" maxlength="100" placeholder="Title, text or #number"></div>
    ${sel('status', 'Status', f.status, [opt('open', 'Open', f.status), opt('closed', 'Closed', f.status), opt('all', 'All', f.status)])}
    ${sel('label', 'Label', f.label, [opt('', 'Any', f.label), ...lk.labels.map((l) => opt(String(l.id), l.group_name ? `${l.group_name}: ${l.name}` : l.name, f.label))])}
    ${sel('milestone', 'Milestone', f.milestone, [opt('', 'Any', f.milestone), opt('none', 'None', f.milestone), ...lk.milestones.map((m) => opt(String(m.id), m.name, f.milestone))])}
    ${sel('assignee', 'Assignee', f.assignee, [opt('', 'Anyone', f.assignee), opt('me', 'Me', f.assignee), opt('none', 'Nobody', f.assignee), ...lk.devs.map((d) => opt(d, d, f.assignee))])}
    ${sel('app', 'Application', f.app, [opt('', 'Any', f.app), ...lk.apps.map((a) => opt(String(a.id), a.name, f.app))])}
    <div class="buttons"><button class="btn btn-sm">${icon('filter')} Show</button>${filterQuery(f) ? html`<a class="btn btn-sm" href="${action}${Object.keys(hidden).length ? `?${new URLSearchParams(hidden)}` : ''}">Clear</a>` : ''}</div>
  </form>`;
}

function issueCard(i: IssueRow, extra: Raw | '' = '') {
  return html`<li class="team-issue${i.status === 'closed' ? ' is-closed' : ''}">
    <div class="team-issue-title">${icon(i.status === 'closed' ? 'check-circle' : 'alert')}<a href="${TEAM}/issues/${i.id}">${i.title}</a> <span class="muted">#${i.id}</span></div>
    ${i.labels.length ? html`<div class="team-labels">${i.labels.map(chip)}</div>` : ''}
    <div class="team-issue-meta small muted">
      ${i.status === 'closed' ? html`<span>closed ${ago(i.closed_at ?? i.updated_at)}</span>` : html`<span>opened ${ago(i.created_at)} by ${i.created_by}</span>`}
      ${i.milestone ? html`<span>${icon('flag')}${i.milestone}</span>` : ''}
      ${i.assignees.length ? html`<span>${icon('user')}${i.assignees.join(', ')}</span>` : ''}
      ${i.app_name ? html`<span>${icon('grid')}${i.app_name}${i.page_no !== null ? ` · page ${i.page_no}` : ''}</span>` : ''}
      ${i.comments ? html`<span>${icon('chat')}${i.comments}</span>` : ''}
    </div>${extra}</li>`;
}

// ------------------------------------------------------------------ reading and validating an issue form

interface IssueInput { title: string; body: string; labels: string[]; milestone: string | null; assignees: string[]; app: number | null; page: number | null }
async function readIssue(b: Record<string, unknown>, ws: number, lk: Lookups): Promise<{ v: IssueInput; errors: string[] }> {
  const errors: string[] = [];
  const title = text(b.title, 1000).replace(/\s+/g, ' ');
  if (!title) errors.push('An issue needs a title.');
  if (title.length > 200) errors.push('The title is at most 200 characters.');
  const body = String(b.body ?? '').replace(/\r\n?/g, '\n');
  if (body.length > 20000) errors.push('The text is at most 20000 characters.');
  const labelIds = new Set(lk.labels.map((l) => String(l.id)));
  const labels = many(b.labels);
  if (labels.some((l) => !labelIds.has(l))) errors.push('Unknown label.');
  const milestone = String(b.milestone ?? '');
  if (milestone && !lk.milestones.some((m) => String(m.id) === milestone)) errors.push('Unknown milestone.');
  const assignees = many(b.assignees);
  const devs = new Set(lk.devs);
  if (assignees.some((a) => !devs.has(a))) errors.push('Assignees are developers of this workspace.');
  const appRaw = String(b.app ?? '');
  let app: number | null = null;
  if (appRaw) {
    if (!/^\d{1,9}$/.test(appRaw) || !lk.apps.some((a) => String(a.id) === appRaw) || (await appWorkspace(appRaw)) !== ws) errors.push('The application is not one of this workspace.');
    else app = Number(appRaw);
  }
  const pageRaw = String(b.page ?? '').trim();
  let pageNo: number | null = null;
  if (pageRaw) {
    if (!/^\d{1,9}$/.test(pageRaw)) errors.push('The page is a page number.');
    else if (!app) errors.push('Choose the application of the page.');
    else if (!(await owner.one('select 1 as ok from meta.page where app_id = $1 and page_no = $2', [app, pageRaw]))) errors.push(`The application has no page ${pageRaw}.`);
    else pageNo = Number(pageRaw);
  }
  return { v: { title: title.slice(0, 200), body: body.slice(0, 20000), labels: [...new Set(labels)], milestone: milestone || null, assignees: [...new Set(assignees)], app, page: pageNo }, errors };
}

function issueFields(v: Partial<IssueInput>, lk: Lookups, idp = 'f') {
  const labelSet = new Set(v.labels ?? []);
  const groups = new Map<string, Label[]>();
  for (const l of lk.labels) groups.set(l.group_name ?? 'Other labels', [...(groups.get(l.group_name ?? 'Other labels') ?? []), l]);
  const asg = new Set(v.assignees ?? []);
  return html`
    <div class="field"><label class="label" for="${idp}_title">Title</label><input id="${idp}_title" name="title" maxlength="200" required value="${v.title ?? ''}"></div>
    <div class="field"><label class="label" for="${idp}_body">Description</label>
      <textarea id="${idp}_body" name="body" rows="10" maxlength="20000">${v.body ?? ''}</textarea>
      <small class="help">Markdown: headings, lists, <code>code</code>, links. Mention a developer with @name: they see it under Team Development.</small></div>
    <div class="form-grid">
      <div class="field"><label class="label" for="${idp}_milestone">Milestone</label><select id="${idp}_milestone" name="milestone">
        <option value="">None</option>${lk.milestones.map((m) => html`<option value="${m.id}"${String(m.id) === String(v.milestone ?? '') ? raw(' selected') : ''}>${m.name}${m.status === 'closed' ? ' (closed)' : ''}</option>`)}</select></div>
      <div class="field"><label class="label" for="${idp}_app">Application</label><select id="${idp}_app" name="app">
        <option value="">None</option>${lk.apps.map((a) => html`<option value="${a.id}"${a.id === v.app ? raw(' selected') : ''}>${a.name}</option>`)}</select></div>
      <div class="field"><label class="label" for="${idp}_page">Page number</label><input id="${idp}_page" name="page" type="number" min="0" step="1" inputmode="numeric" value="${v.page ?? ''}">
        <small class="help">A page of the application.</small></div>
    </div>
    ${lk.labels.length ? html`<fieldset class="team-fieldset"><legend>Labels</legend>${[...groups].map(([g, ls]) => html`<div class="team-check-group"><span class="small muted">${g}</span>
      ${ls.map((l) => html`<label class="check"><input type="checkbox" name="labels" value="${l.id}"${labelSet.has(String(l.id)) ? raw(' checked') : ''}> ${chip(l)}</label>`)}</div>`)}</fieldset>`
      : html`<p class="muted small">No labels yet: <a href="${TEAM}/setup">set up Team Development</a> or <a href="${TEAM}/labels">add labels</a>.</p>`}
    <fieldset class="team-fieldset"><legend>Assignees</legend><div class="team-check-group">
      ${lk.devs.map((d) => html`<label class="check"><input type="checkbox" name="assignees" value="${d}"${asg.has(d) ? raw(' checked') : ''}> ${d}</label>`)}</div></fieldset>`;
}

/** Store an issue's labels and assignees; returns the history lines of what changed. */
async function setLinks(c: (sql: string, params?: unknown[]) => Promise<unknown>, id: number, v: IssueInput, lk: Lookups, before: { labels: string[]; assignees: string[] }) {
  const lines: [string, string][] = [];
  const name = (lid: string) => lk.labels.find((l) => String(l.id) === lid)?.name ?? lid;
  const addL = v.labels.filter((x) => !before.labels.includes(x));
  const delL = before.labels.filter((x) => !v.labels.includes(x));
  if (delL.length) await c('delete from meta.team_issue_label where issue_id = $1 and label_id = any($2::bigint[])', [id, delL]);
  for (const l of addL) await c('insert into meta.team_issue_label (issue_id, label_id) values ($1, $2) on conflict do nothing', [id, l]);
  if (addL.length || delL.length) lines.push(['labels', [...addL.map((x) => `+${name(x)}`), ...delL.map((x) => `-${name(x)}`)].join(' ')]);
  const addA = v.assignees.filter((x) => !before.assignees.includes(x));
  const delA = before.assignees.filter((x) => !v.assignees.includes(x));
  if (delA.length) await c('delete from meta.team_issue_assignee where issue_id = $1 and username = any($2::text[])', [id, delA]);
  for (const a of addA) await c('insert into meta.team_issue_assignee (issue_id, username) values ($1, $2) on conflict do nothing', [id, a]);
  if (addA.length || delA.length) lines.push(['assignees', [...addA.map((x) => `+${x}`), ...delA.map((x) => `-${x}`)].join(' ')]);
  return lines;
}

const issueOf = async (ws: number, id: string) =>
  isId(id) ? owner.one(`select i.*, m.name as milestone from meta.team_issue i left join meta.team_milestone m on m.id = i.milestone_id where i.id = $1 and i.workspace_id = $2`, [id, ws]) : undefined;

const EVENT_TEXT: Record<string, string> = {
  created: 'created the issue', closed: 'closed the issue', reopened: 'reopened the issue', title: 'changed the title', body: 'edited the description',
  labels: 'changed the labels', assignees: 'changed the assignees', milestone: 'set the milestone', link: 'linked', commented: 'commented',
};

export async function teamRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ the issue list
  app.get(TEAM, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const f = parseFilters(req.query ?? {});
    const [lk, counts, rows, views, mentions] = await Promise.all([
      lookups(ws), teamCounts(ws, s.username), findIssues(ws, f, s.username),
      owner.query('select id, name, query from meta.team_view where workspace_id = $1 and username = $2 order by lower(name)', [ws, s.username]),
      owner.query(`select m.id, m.issue_id, m.by_user, m.created_at, i.title from meta.team_mention m join meta.team_issue i on i.id = m.issue_id
                    where i.workspace_id = $1 and m.username = $2 and m.seen_at is null order by m.created_at desc limit 20`, [ws, s.username]),
    ]);
    const current = filterQuery(f);
    const main = html`${teamHeader('issues', counts)}
      ${!counts.set_up ? html`<div class="alert alert-info" role="status">${icon('lightbulb')} <span>New here? <a href="${TEAM}/setup">Set up Team Development</a>: sample labels (Bug, Feature, Task; priorities), templates and milestones.</span></div>` : ''}
      <div class="team-layout">
        <div class="team-main">
          ${filterForm(f, lk, TEAM)}
          ${f.app && f.page ? html`<p class="small muted">Issues of page ${f.page} of ${lk.apps.find((a) => String(a.id) === f.app)?.name ?? 'the application'}.</p>` : ''}
          <p class="small muted" role="status">${rows.length} issue${rows.length === 1 ? '' : 's'}${rows.length === 500 ? ' (the first 500)' : ''}.</p>
          ${rows.length ? html`<ul class="team-issues">${rows.map((i) => issueCard(i))}</ul>` : html`<p class="muted">No issues${current ? ' with these filters' : ' yet'}.</p>`}
        </div>
        <aside class="team-side">
          <section id="mentions" aria-labelledby="team-mentions-h"><h2 id="team-mentions-h">Mentions of you</h2>
            ${mentions.rows.length ? html`<ul class="team-mentions">${mentions.rows.map((m) => html`<li><a href="${TEAM}/issues/${m.issue_id}">${m.title}</a> <span class="small muted">${m.by_user ?? ''} · ${ago(m.created_at)}</span></li>`)}</ul>
              <form method="post" action="${TEAM}/mentions/seen">${csrf(s)}<button class="btn btn-sm">${icon('check')} Mark all as seen</button></form>`
              : html`<p class="muted small">Nobody mentioned you in an unseen comment.</p>`}</section>
          <section aria-labelledby="team-views-h"><h2 id="team-views-h">Saved views</h2>
            ${views.rows.length ? html`<ul class="team-views">${views.rows.map((v) => html`<li><a href="${TEAM}${v.query ? `?${v.query}` : ''}"${v.query === current ? raw(' aria-current="true"') : ''}>${v.name}</a>
                <form method="post" action="${TEAM}/views/${v.id}/delete" class="u-inline">${csrf(s)}<button class="link-button" title="Delete the view ${v.name}" data-confirm="Delete the view ${v.name}?">${icon('trash')}<span class="sr-only">Delete ${v.name}</span></button></form></li>`)}</ul>`
              : html`<p class="muted small">Save the filters you use often.</p>`}
            <form method="post" action="${TEAM}/views" class="team-save-view">${csrf(s)}<input type="hidden" name="query" value="${current}">
              <label class="sr-only" for="tv_name">Name of the view</label><input id="tv_name" name="name" maxlength="40" required placeholder="Name of this view">
              <button class="btn btn-sm">${icon('bookmark')} Save view</button></form></section>
          <section aria-labelledby="team-quick-h"><h2 id="team-quick-h">Quick filters</h2><ul class="ab-links ab-tasks">
            <li><a href="${TEAM}?assignee=me">Assigned to me</a></li>
            <li><a href="${TEAM}?assignee=none">Not assigned</a></li>
            <li><a href="${TEAM}?status=closed">Closed</a></li>
            <li><a href="${TEAM}/board">Board by label</a></li>
            <li><a href="${TEAM}/board?by=milestone">Board by milestone</a></li></ul></section>
        </aside>
      </div>`;
    return send(reply, s, page(s, 'Team Development', [], main));
  });

  // ------------------------------------------------------------------ the board
  app.get(`${TEAM}/board`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const f = parseFilters(req.query ?? {});
    const by = req.query?.by === 'milestone' ? 'milestone' : 'label';
    const [lk, counts, rows] = await Promise.all([lookups(ws), teamCounts(ws, s.username), findIssues(ws, f, s.username)]);
    // by label: the labels of one group (or the labels without a group: "0")
    const groupIds = [...lk.groups.map((g) => String(g.id)), ...(lk.labels.some((l) => l.group_id === null) ? ['0'] : [])];
    const group = by === 'label' ? (groupIds.includes(String(req.query?.group ?? '')) ? String(req.query.group) : groupIds[0] ?? '0') : '';
    type Col = { key: string; title: string; chip?: Raw; items: IssueRow[] };
    let cols: Col[];
    if (by === 'milestone') {
      const ms = lk.milestones.filter((m) => m.status === 'open' || rows.some((r) => r.milestone_id === m.id));
      cols = [...ms.map((m) => ({ key: String(m.id), title: m.name, items: rows.filter((r) => r.milestone_id === m.id) })),
        { key: '', title: 'No milestone', items: rows.filter((r) => r.milestone_id === null) }];
    } else {
      const ls = lk.labels.filter((l) => String(l.group_id ?? 0) === group);
      const ids = new Set(ls.map((l) => l.id));
      cols = [...ls.map((l) => ({ key: String(l.id), title: l.name, chip: chip(l), items: rows.filter((r) => r.labels.some((x) => x.id === l.id)) })),
        { key: '', title: 'None of these', items: rows.filter((r) => !r.labels.some((x) => ids.has(x.id))) }];
    }
    const back = `${TEAM}/board?${filterQuery(f, { by: by === 'milestone' ? 'milestone' : '', group: by === 'label' ? group : '' })}`;
    const move = (i: IssueRow, from: string) => {
      const others = cols.filter((c) => c.key !== from);
      return html`<form method="post" action="${TEAM}/issues/${i.id}/move" class="team-move">${csrf(s)}
        <input type="hidden" name="by" value="${by}"><input type="hidden" name="group" value="${group}"><input type="hidden" name="from" value="${from}"><input type="hidden" name="back" value="${back}">
        <label class="sr-only" for="mv_${i.id}_${from}">Move #${i.id} to</label>
        <select id="mv_${i.id}_${from}" name="to">${others.map((c) => html`<option value="${c.key}">${c.title}</option>`)}</select>
        <button class="btn btn-sm">Move</button></form>`;
    };
    const groupNav = by === 'label' && groupIds.length > 1
      ? html`<nav class="seg team-groups" aria-label="Label group">${groupIds.map((g) => html`<a href="${TEAM}/board?${filterQuery(f, { group: g })}"${g === group ? raw(' aria-current="true"') : ''}>${g === '0' ? 'Other labels' : lk.groups.find((x) => String(x.id) === g)?.name}</a>`)}</nav>` : '';
    const main = html`${teamHeader('board', counts)}
      <div class="team-board-bar">
        <nav class="seg" aria-label="Group the board by"><a href="${TEAM}/board?${filterQuery(f)}"${by === 'label' ? raw(' aria-current="true"') : ''}>${icon('tag')} Label</a><a href="${TEAM}/board?${filterQuery(f, { by: 'milestone' })}"${by === 'milestone' ? raw(' aria-current="true"') : ''}>${icon('flag')} Milestone</a></nav>
        ${groupNav}
      </div>
      <details class="team-board-filters"><summary>${icon('filter')} Filters${filterQuery(f) ? ' (on)' : ''}</summary>${filterForm(f, lk, `${TEAM}/board`, { ...(by === 'milestone' ? { by } : {}), ...(by === 'label' ? { group } : {}) })}</details>
      ${by === 'label' && !lk.labels.length ? html`<p class="muted">No labels yet: <a href="${TEAM}/setup">set up Team Development</a>.</p>` : ''}
      <div class="team-board">${cols.map((c) => html`<section class="team-col" aria-label="${c.title}">
        <h2 class="team-col-head">${c.chip ?? c.title} <span class="muted small">${c.items.length}</span></h2>
        ${c.items.length ? html`<ul class="team-issues">${c.items.map((i) => issueCard(i, move(i, c.key)))}</ul>` : html`<p class="muted small">No issues.</p>`}
      </section>`)}</div>`;
    return send(reply, s, page(s, 'Board', [['Board']], main));
  });

  // move a card: by milestone sets the milestone; by label replaces the issue's labels of that group with the target label
  app.post(`${TEAM}/issues/:id/move`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const i = await issueOf(ws, req.params.id);
    if (!i) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    const to = String(b.to ?? '');
    const lk = await lookups(ws);
    const backTo = typeof b.back === 'string' && b.back.startsWith(`${TEAM}/board`) && !/[\r\n]/.test(b.back) ? b.back : `${TEAM}/board`;
    if (b.by === 'milestone') {
      const m = to ? lk.milestones.find((x) => String(x.id) === to) : null;
      if (to && !m) return reply.code(400).send('Unknown milestone');
      await owner.tx(async (c) => {
        await c.query('update meta.team_issue set milestone_id = $2, updated_at = now() where id = $1', [i.id, m?.id ?? null]);
        await logIssue(c, i.id, s.username, 'milestone', m ? m.name : 'none');
      });
    } else {
      const group = String(b.group ?? '');
      const inGroup = lk.labels.filter((l) => String(l.group_id ?? 0) === group);
      const target = to ? inGroup.find((l) => String(l.id) === to) : null;
      if (!inGroup.length || (to && !target)) return reply.code(400).send('Unknown label');
      await owner.tx(async (c) => {
        const del = (await c.query('delete from meta.team_issue_label where issue_id = $1 and label_id = any($2::bigint[]) and label_id <> $3 returning label_id',
          [i.id, inGroup.map((l) => l.id), target?.id ?? 0])).rows.map((r) => lk.labels.find((l) => Number(l.id) === Number(r.label_id))?.name);
        const add = target ? (await c.query('insert into meta.team_issue_label (issue_id, label_id) values ($1, $2) on conflict do nothing', [i.id, target.id])).rowCount : 0;
        await c.query('update meta.team_issue set updated_at = now() where id = $1', [i.id]);
        if (del.length || add) await logIssue(c, i.id, s.username, 'labels', [...(add ? [`+${target!.name}`] : []), ...del.map((x) => `-${x}`)].join(' '));
      });
    }
    flash(s, `#${i.id} moved.`);
    return back(reply, s, backTo);
  });

  // ------------------------------------------------------------------ a new issue
  app.get(`${TEAM}/issues/new`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const lk = await lookups(ws);
    const templates = (await owner.query(`select id, name, title, body, labels from meta.team_template where workspace_id = $1 and kind = 'issue' order by seq, lower(name)`, [ws])).rows;
    const tpl = isId(req.query?.template) ? templates.find((x) => String(x.id) === req.query.template) : undefined;
    const appQ = lk.apps.find((a) => String(a.id) === req.query?.app);
    const v: Partial<IssueInput> = {
      title: tpl?.title ?? '', body: tpl?.body ?? '',
      labels: tpl ? lk.labels.filter((l) => (tpl.labels as string[]).some((n) => n.toLowerCase() === l.name.toLowerCase())).map((l) => String(l.id)) : [],
      app: appQ?.id ?? null, page: appQ && /^\d{1,9}$/.test(req.query?.page ?? '') ? Number(req.query.page) : null,
    };
    const main = html`${teamHeader('issues')}
      ${templates.length ? html`<form method="get" class="team-template-pick">${appQ ? html`<input type="hidden" name="app" value="${appQ.id}">` : ''}${v.page !== null && v.page !== undefined ? html`<input type="hidden" name="page" value="${v.page}">` : ''}
        <div class="field"><label class="label" for="f_template">Start from a template</label><select id="f_template" name="template" data-autosubmit>
          <option value="">Blank issue</option>${templates.map((x) => html`<option value="${x.id}"${x.id === tpl?.id ? raw(' selected') : ''}>${x.name}</option>`)}</select></div>
        <button class="btn btn-sm">Use template</button></form>` : ''}
      ${region('New issue', html`<form method="post" action="${TEAM}/issues">${csrf(s)}${issueFields(v, lk)}
        <div class="buttons"><button class="btn btn-hot">Create issue</button><a class="btn" href="${TEAM}">Cancel</a></div></form>`)}`;
    return send(reply, s, page(s, 'New issue', [['New issue']], main));
  });

  app.post(`${TEAM}/issues`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const lk = await lookups(ws);
    const { v, errors } = await readIssue(req.body ?? {}, ws, lk);
    if (errors.length) {
      flash(s, errors.join(' '), 'error');
      return back(reply, s, `${TEAM}/issues/new${v.app ? `?app=${v.app}${v.page !== null ? `&page=${v.page}` : ''}` : ''}`);
    }
    const id = await owner.tx(async (c) => {
      const id = Number((await c.query(`insert into meta.team_issue (workspace_id, title, body, milestone_id, app_id, page_no, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [ws, v.title, v.body, v.milestone, v.app, v.page, s.username])).rows[0].id);
      await setLinks((sql, p) => c.query(sql, p), id, v, lk, { labels: [], assignees: [] });
      await logIssue(c, id, s.username, 'created');
      await recordMentions(c, ws, id, null, v.body, s.username);
      return id;
    });
    flash(s, `Issue #${id} created.`);
    return back(reply, s, `${TEAM}/issues/${id}`);
  });

  // ------------------------------------------------------------------ an issue
  app.get(`${TEAM}/issues/:id`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const i = await issueOf(ws, req.params.id);
    if (!i) return reply.code(404).send('Not found');
    const [lk, labels, assignees, comments, events, responses, admin] = await Promise.all([
      lookups(ws),
      owner.query('select l.id, l.name, l.color from meta.team_issue_label il join meta.team_label l on l.id = il.label_id where il.issue_id = $1 order by lower(l.name)', [i.id]),
      owner.query('select username from meta.team_issue_assignee where issue_id = $1 order by username', [i.id]),
      owner.query('select id, author, body, created_at from meta.team_issue_comment where issue_id = $1 order by created_at, id', [i.id]),
      owner.query(`select at, username, action, detail from meta.team_issue_event where issue_id = $1 and action <> 'commented' order by at, id`, [i.id]),
      owner.query(`select id, name, body from meta.team_template where workspace_id = $1 and kind = 'response' order by seq, lower(name)`, [ws]),
      workspaceAdmin(s.username, ws),
    ]);
    // the issue's own mentions of this developer are seen now
    await owner.query('update meta.team_mention set seen_at = now() where issue_id = $1 and username = $2 and seen_at is null', [i.id, s.username]);
    const appRow = i.app_id ? lk.apps.find((a) => a.id === i.app_id) : undefined;
    const source = i.feedback_id
      ? await owner.one('select f.id, f.app_id, f.username, a.name from meta.feedback f join meta.app a on a.id = f.app_id where f.id = $1 and meta.app_workspace(f.app_id) = $2', [i.feedback_id, ws])
      : null;
    const comment = i.dev_comment_id
      ? await owner.one('select c.id, c.app_id, c.page_no, c.author, a.name from meta.dev_comment c join meta.app a on a.id = c.app_id where c.id = $1 and meta.app_workspace(c.app_id) = $2', [i.dev_comment_id, ws])
      : null;
    const response = isId(req.query?.response) ? responses.rows.find((r) => String(r.id) === req.query.response) : undefined;
    const timeline = [
      ...comments.rows.map((c) => ({ at: new Date(c.created_at).getTime(), r: html`<li class="team-comment" id="comment-${c.id}">
          <div class="team-comment-head"><b>${c.author}</b> <span class="muted small">${when(c.created_at)}</span></div>
          <div class="rich-text team-md">${raw(issueHtml(c.body, lk.devs))}</div></li>` })),
      ...events.rows.map((e) => ({ at: new Date(e.at).getTime(), r: html`<li class="team-event small muted">${icon('history')}<span><b>${e.username ?? 'someone'}</b> ${EVENT_TEXT[e.action] ?? e.action}${e.detail ? html`: ${e.detail}` : ''} · ${when(e.at)}</span></li>` })),
    ].sort((a, b) => a.at - b.at);
    const v: IssueInput = { title: i.title, body: i.body, labels: labels.rows.map((l) => String(l.id)), milestone: i.milestone_id ? String(i.milestone_id) : null,
      assignees: assignees.rows.map((a) => a.username), app: appRow?.id ?? null, page: appRow ? i.page_no : null };
    const main = html`${teamHeader('issues')}
      <article class="team-issue-page">
        <header class="team-issue-header">
          <h2 class="team-issue-h">${i.title} <span class="muted">#${i.id}</span></h2>
          <p><span class="team-status team-status-${i.status === 'closed' ? 'closed' : 'open'}">${i.status === 'closed' ? 'Closed' : 'Open'}</span>
            <span class="muted small">opened by ${i.created_by}, ${when(i.created_at)}${i.closed_at ? `; closed by ${i.closed_by ?? '?'}, ${when(i.closed_at)}` : ''}</span></p>
        </header>
        <div class="team-layout">
          <div class="team-main">
            <div class="rich-text team-md team-body">${i.body.trim() ? raw(issueHtml(i.body, lk.devs)) : html`<p class="muted">No description.</p>`}</div>
            <h3>Activity</h3>
            <ul class="team-timeline">${timeline.map((x) => x.r)}</ul>
            <form method="get" class="team-response-pick">${responses.rows.length ? html`
              <div class="field"><label class="label" for="f_response">Canned response</label><select id="f_response" name="response" data-autosubmit>
                <option value="">None</option>${responses.rows.map((r) => html`<option value="${r.id}"${r.id === response?.id ? raw(' selected') : ''}>${r.name}</option>`)}</select></div>
              <button class="btn btn-sm">Insert</button>` : ''}</form>
            <form method="post" action="${TEAM}/issues/${i.id}/comments" id="add-comment">${csrf(s)}
              <div class="field"><label class="label" for="f_comment">Add a comment</label>
                <textarea id="f_comment" name="body" rows="4" maxlength="20000" required>${response?.body ?? ''}</textarea>
                <small class="help">Markdown; @name mentions a developer of this workspace.</small></div>
              <div class="buttons"><button class="btn btn-hot">Comment</button>
                <button class="btn" name="and" value="${i.status === 'closed' ? 'reopen' : 'close'}">${i.status === 'closed' ? 'Comment and reopen' : 'Comment and close'}</button></div></form>
          </div>
          <aside class="team-side">
            <section><h2>Status</h2><form method="post" action="${TEAM}/issues/${i.id}/status">${csrf(s)}
              <button class="btn btn-sm" name="status" value="${i.status === 'closed' ? 'open' : 'closed'}">${icon(i.status === 'closed' ? 'refresh' : 'check-circle')} ${i.status === 'closed' ? 'Reopen issue' : 'Close issue'}</button></form></section>
            <section><h2>Labels</h2>${labels.rows.length ? html`<div class="team-labels">${labels.rows.map(chip)}</div>` : html`<p class="muted small">None</p>`}</section>
            <section><h2>Milestone</h2><p>${i.milestone ? html`<a href="${TEAM}?milestone=${i.milestone_id}">${i.milestone}</a>` : html`<span class="muted small">None</span>`}</p></section>
            <section><h2>Assignees</h2><p>${assignees.rows.length ? assignees.rows.map((a) => a.username).join(', ') : html`<span class="muted small">Nobody</span>`}</p></section>
            <section><h2>Application</h2><p>${appRow
              ? html`<a href="${BASE}/apps/${appRow.id}">${appRow.name}</a>${i.page_no !== null ? html` · <a href="${designerUrl(appRow.id, i.page_no)}">page ${i.page_no}</a>` : ''}`
              : html`<span class="muted small">None</span>`}</p></section>
            ${source ? html`<section><h2>From feedback</h2><p><a href="${BASE}/apps/${source.app_id}/feedback#feedback-${source.id}">Feedback of ${source.username}</a> <span class="small muted">(${source.name})</span></p></section>` : ''}
            ${comment ? html`<section><h2>From a developer comment</h2><p><a href="${comment.page_no ? designerUrl(comment.app_id, comment.page_no) : `${BASE}/apps/${comment.app_id}#app-lock`}">${comment.author}'s comment</a> <span class="small muted">(${comment.name}${comment.page_no ? `, page ${comment.page_no}` : ''})</span></p></section>` : ''}
            ${i.created_by === s.username || admin ? html`<section><h2>Delete</h2><form method="post" action="${TEAM}/issues/${i.id}/delete">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="Delete issue #${i.id} with its comments and history?">${icon('trash')} Delete issue</button></form></section>` : ''}
          </aside>
        </div>
        <details class="team-edit" id="edit"><summary class="btn btn-sm">${icon('edit')} Edit the issue</summary>
          <form method="post" action="${TEAM}/issues/${i.id}">${csrf(s)}${issueFields(v, lk, 'e')}
            <div class="buttons"><button class="btn btn-hot">Save</button></div></form></details>
      </article>`;
    return send(reply, s, page(s, `#${i.id} ${i.title}`, [[`#${i.id}`]], main));
  });

  app.post(`${TEAM}/issues/:id`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const i = await issueOf(ws, req.params.id);
    if (!i) return reply.code(404).send('Not found');
    const lk = await lookups(ws);
    const { v, errors } = await readIssue(req.body ?? {}, ws, lk);
    if (errors.length) {
      flash(s, errors.join(' '), 'error');
      return back(reply, s, `${TEAM}/issues/${i.id}#edit`);
    }
    await owner.tx(async (c) => {
      const before = {
        labels: (await c.query('select label_id::text as id from meta.team_issue_label where issue_id = $1', [i.id])).rows.map((r) => r.id),
        assignees: (await c.query('select username from meta.team_issue_assignee where issue_id = $1', [i.id])).rows.map((r) => r.username),
      };
      await c.query('update meta.team_issue set title = $2, body = $3, milestone_id = $4, app_id = $5, page_no = $6, updated_at = now() where id = $1',
        [i.id, v.title, v.body, v.milestone, v.app, v.page]);
      if (v.title !== i.title) await logIssue(c, i.id, s.username, 'title', `${i.title} → ${v.title}`);
      if (v.body !== i.body) await logIssue(c, i.id, s.username, 'body');
      if (String(v.milestone ?? '') !== String(i.milestone_id ?? '')) await logIssue(c, i.id, s.username, 'milestone', lk.milestones.find((m) => String(m.id) === v.milestone)?.name ?? 'none');
      if (v.app !== i.app_id || v.page !== i.page_no)
        await logIssue(c, i.id, s.username, 'link', v.app ? `${lk.apps.find((a) => a.id === v.app)?.name}${v.page !== null ? `, page ${v.page}` : ''}` : 'no application');
      for (const [action, detail] of await setLinks((sql, p) => c.query(sql, p), i.id, v, lk, before)) await logIssue(c, i.id, s.username, action, detail);
      await recordMentions(c, ws, i.id, null, v.body, s.username);
    });
    flash(s, 'Issue saved.');
    return back(reply, s, `${TEAM}/issues/${i.id}`);
  });

  const setStatus = async (c: Client, id: number, status: 'open' | 'closed', by: string | null) => {
    await c.query(`update meta.team_issue set status = $2, updated_at = now(), closed_at = case when $2 = 'closed' then now() end, closed_by = case when $2 = 'closed' then $3 end where id = $1`, [id, status, by]);
    await logIssue(c, id, by, status === 'closed' ? 'closed' : 'reopened');
  };

  app.post(`${TEAM}/issues/:id/status`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const i = await issueOf(ws, req.params.id);
    if (!i) return reply.code(404).send('Not found');
    const status = req.body?.status;
    if (status !== 'open' && status !== 'closed') return reply.code(400).send('Unknown status');
    if (status !== i.status) await owner.tx((c) => setStatus(c, i.id, status, s.username));
    flash(s, status === 'closed' ? `Issue #${i.id} closed.` : `Issue #${i.id} reopened.`);
    return back(reply, s, `${TEAM}/issues/${i.id}`);
  });

  app.post(`${TEAM}/issues/:id/comments`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const i = await issueOf(ws, req.params.id);
    if (!i) return reply.code(404).send('Not found');
    const body = String(req.body?.body ?? '').replace(/\r\n?/g, '\n');
    if (!body.trim() || body.length > 20000) {
      flash(s, 'A comment has 1 to 20000 characters.', 'error');
      return back(reply, s, `${TEAM}/issues/${i.id}#add-comment`);
    }
    const and = req.body?.and;
    const cid = await owner.tx(async (c) => {
      const cid = (await c.query('insert into meta.team_issue_comment (issue_id, author, body) values ($1, $2, $3) returning id', [i.id, s.username, body])).rows[0].id;
      await c.query('update meta.team_issue set updated_at = now() where id = $1', [i.id]);
      await logIssue(c, i.id, s.username, 'commented');
      await recordMentions(c, ws, i.id, cid, body, s.username);
      if (and === 'close' && i.status === 'open') await setStatus(c, i.id, 'closed', s.username);
      if (and === 'reopen' && i.status === 'closed') await setStatus(c, i.id, 'open', s.username);
      return cid;
    });
    flash(s, 'Comment added.');
    return back(reply, s, `${TEAM}/issues/${i.id}#comment-${cid}`);
  });

  app.post(`${TEAM}/issues/:id/delete`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const i = await issueOf(ws, req.params.id);
    if (!i) return reply.code(404).send('Not found');
    if (i.created_by !== s.username && !(await workspaceAdmin(s.username, ws))) return reply.code(403).send('Only its author or a workspace administrator deletes an issue.');
    await owner.query('delete from meta.team_issue where id = $1', [i.id]);
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `team: issue ${i.id} deleted` });
    flash(s, `Issue #${i.id} deleted.`);
    return back(reply, s, TEAM);
  });

  // ------------------------------------------------------------------ saved views and mentions
  app.post(`${TEAM}/views`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const name = text(req.body?.name, 100);
    if (!NAME40.test(name)) {
      flash(s, 'A view has a name of 1 to 40 characters.', 'error');
      return back(reply, s, TEAM);
    }
    // only the known filters, re-checked
    const query = filterQuery(parseFilters(Object.fromEntries(new URLSearchParams(String(req.body?.query ?? '').slice(0, 1000)))));
    await owner.query(`insert into meta.team_view (workspace_id, username, name, query) values ($1, $2, $3, $4)
                       on conflict (workspace_id, username, lower(name)) do update set query = excluded.query`, [ws, s.username, name, query]);
    flash(s, `View ${name} saved.`);
    return back(reply, s, `${TEAM}${query ? `?${query}` : ''}`);
  });

  app.post(`${TEAM}/views/:id/delete`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    if (!isId(req.params.id)) return reply.code(404).send('Not found');
    const r = await owner.query('delete from meta.team_view where id = $1 and workspace_id = $2 and username = $3', [req.params.id, ws, s.username]);
    if (!r.rowCount) return reply.code(404).send('Not found');
    flash(s, 'View deleted.');
    return back(reply, s, TEAM);
  });

  app.post(`${TEAM}/mentions/seen`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    await owner.query(`update meta.team_mention m set seen_at = now() from meta.team_issue i
                        where i.id = m.issue_id and i.workspace_id = $1 and m.username = $2 and m.seen_at is null`, [ws, s.username]);
    flash(s, 'Mentions marked as seen.');
    return back(reply, s, TEAM);
  });

  // ------------------------------------------------------------------ labels and label groups
  app.get(`${TEAM}/labels`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const [lk, admin, used] = await Promise.all([lookups(ws), workspaceAdmin(s.username, ws),
      owner.query('select il.label_id, count(*)::int as n from meta.team_issue_label il join meta.team_issue i on i.id = il.issue_id where i.workspace_id = $1 and i.status = $2 group by 1', [ws, 'open'])]);
    const n = new Map(used.rows.map((r) => [Number(r.label_id), r.n]));
    const colorSel = (id: string, cur: string) => html`<select id="${id}" name="color">${LABEL_COLORS.map((c) => html`<option value="${c}"${c === cur ? raw(' selected') : ''}>${c}</option>`)}</select>`;
    const groupSel = (id: string, cur: number | null) => html`<select id="${id}" name="group"><option value="">No group</option>${lk.groups.map((g) => html`<option value="${g.id}"${g.id === cur ? raw(' selected') : ''}>${g.name}</option>`)}</select>`;
    const labelForm = (l: Partial<Label> & { id?: number }, p: string) => html`<form method="post" action="${TEAM}/labels${l.id ? `/${l.id}` : ''}">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="${p}_name">Name</label><input id="${p}_name" name="name" maxlength="40" required value="${l.name ?? ''}"></div>
        <div class="field"><label class="label" for="${p}_color">Colour</label>${colorSel(`${p}_color`, l.color ?? 'gray')}</div>
        <div class="field"><label class="label" for="${p}_group">Group</label>${groupSel(`${p}_group`, l.group_id ?? null)}</div>
        <div class="field"><label class="label" for="${p}_desc">Description</label><input id="${p}_desc" name="description" maxlength="500" value="${l.description ?? ''}"></div>
      </div><div class="buttons"><button class="btn btn-sm btn-hot">${l.id ? 'Save' : 'Add label'}</button></div></form>`;
    const byGroup = [...lk.groups.map((g) => ({ g, ls: lk.labels.filter((l) => l.group_id === g.id) })), { g: null, ls: lk.labels.filter((l) => l.group_id === null) }];
    const main = html`${teamHeader('labels')}
      ${byGroup.filter((x) => x.g || x.ls.length).map(({ g, ls }) => region(g ? g.name : 'Labels without a group', html`
        ${g?.description ? html`<p class="muted small u-mt0">${g.description}</p>` : ''}
        ${ls.length ? html`<ul class="team-label-list">${ls.map((l) => html`<li>${chip(l)} <span class="small muted">${l.description ?? ''}</span>
            <a class="small" href="${TEAM}?label=${l.id}">${n.get(l.id) ?? 0} open</a>
            <details class="team-inline-edit"><summary class="link-button">Edit</summary>${labelForm(l, `l${l.id}`)}
              ${admin ? html`<form method="post" action="${TEAM}/labels/${l.id}/delete">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="Delete the label ${l.name}? Issues lose it.">${icon('trash')} Delete label</button></form>` : ''}</details></li>`)}</ul>`
          : html`<p class="muted small">No labels in this group.</p>`}
        ${g && admin ? html`<form method="post" action="${TEAM}/groups/${g.id}/delete" class="u-mt1">${csrf(s)}<button class="btn btn-sm" data-confirm="Delete the group ${g.name}? Its labels stay, without a group.">Delete group</button></form>` : ''}`))}
      <div class="columns">
        ${region('Add a label', labelForm({}, 'nl'))}
        ${region('Add a label group', html`<form method="post" action="${TEAM}/groups">${csrf(s)}
          <div class="field"><label class="label" for="ng_name">Name</label><input id="ng_name" name="name" maxlength="40" required placeholder="e.g. Area"></div>
          <div class="field"><label class="label" for="ng_desc">Description</label><input id="ng_desc" name="description" maxlength="500"></div>
          <div class="buttons"><button class="btn btn-sm btn-hot">Add group</button></div></form>
          <p class="small muted">The board groups issues by the labels of one group. Only workspace administrators delete labels and groups.</p>`)}
      </div>`;
    return send(reply, s, page(s, 'Labels', [['Labels']], main));
  });

  const saveLabel = async (req: Req, reply: FastifyReply, id: string | null) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const b = req.body ?? {};
    const name = text(b.name, 100);
    const color = b.color;
    const group = String(b.group ?? '');
    const desc = text(b.description, 500) || null;
    if (!isLabelColor(color)) return reply.code(400).send('Unknown colour');
    if (group && !(await owner.one('select 1 as ok from meta.team_label_group where id = $1 and workspace_id = $2', [isId(group) ? group : 0, ws]))) return reply.code(400).send('Unknown group');
    if (!NAME40.test(name)) {
      flash(s, 'A label has a name of 1 to 40 characters.', 'error');
      return back(reply, s, `${TEAM}/labels`);
    }
    try {
      if (id) {
        if (!isId(id)) return reply.code(404).send('Not found');
        const r = await owner.query('update meta.team_label set name = $3, color = $4, group_id = $5, description = $6 where id = $1 and workspace_id = $2', [id, ws, name, color, group || null, desc]);
        if (!r.rowCount) return reply.code(404).send('Not found');
      } else await owner.query('insert into meta.team_label (workspace_id, name, color, group_id, description) values ($1, $2, $3, $4, $5)', [ws, name, color, group || null, desc]);
      flash(s, `Label ${name} saved.`);
    } catch (e) {
      flash(s, /team_label_name/.test((e as Error).message) ? `A label ${name} exists already.` : (e as Error).message, 'error');
    }
    return back(reply, s, `${TEAM}/labels`);
  };
  app.post(`${TEAM}/labels`, (req: Req, reply) => saveLabel(req, reply, null));
  app.post(`${TEAM}/labels/:id`, (req: Req, reply) => saveLabel(req, reply, req.params.id));

  app.post(`${TEAM}/groups`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const name = text(req.body?.name, 100);
    if (!NAME40.test(name)) {
      flash(s, 'A group has a name of 1 to 40 characters.', 'error');
      return back(reply, s, `${TEAM}/labels`);
    }
    const r = await owner.query(`insert into meta.team_label_group (workspace_id, name, description, seq)
      values ($1, $2, $3, (select coalesce(max(seq), 0) + 10 from meta.team_label_group where workspace_id = $1)) on conflict (workspace_id, lower(name)) do nothing`,
      [ws, name, text(req.body?.description, 500) || null]);
    flash(s, r.rowCount ? `Group ${name} added.` : `A group ${name} exists already.`, r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${TEAM}/labels`);
  });

  const adminDelete = (path: string, table: string, what: string, to: string) =>
    app.post(`${TEAM}/${path}/:id/delete`, async (req: Req, reply) => {
      const t = await teamDev(req, reply);
      if (!t) return;
      const { s, ws } = t;
      if (!isId(req.params.id)) return reply.code(404).send('Not found');
      if (!(await workspaceAdmin(s.username, ws))) return reply.code(403).send(`Only the workspace's administrators delete ${what}s.`);
      const r = await owner.query(`delete from meta.${table} where id = $1 and workspace_id = $2`, [req.params.id, ws]);
      if (!r.rowCount) return reply.code(404).send('Not found');
      flash(s, `The ${what} is deleted.`);
      return back(reply, s, to);
    });
  adminDelete('labels', 'team_label', 'label', `${TEAM}/labels`);
  adminDelete('groups', 'team_label_group', 'label group', `${TEAM}/labels`);
  adminDelete('milestones', 'team_milestone', 'milestone', `${TEAM}/milestones`);

  // ------------------------------------------------------------------ milestones
  app.get(`${TEAM}/milestones`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const [lk, admin] = await Promise.all([lookups(ws), workspaceAdmin(s.username, ws)]);
    const form = (m: Partial<Milestone>, p: string) => html`<form method="post" action="${TEAM}/milestones${m.id ? `/${m.id}` : ''}">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="${p}_name">Name</label><input id="${p}_name" name="name" maxlength="40" required value="${m.name ?? ''}"></div>
        <div class="field"><label class="label" for="${p}_due">Due</label><input id="${p}_due" name="due_date" type="date" value="${m.due_date ?? ''}"></div>
        <div class="field"><label class="label" for="${p}_status">Status</label><select id="${p}_status" name="status">
          <option value="open"${m.status !== 'closed' ? raw(' selected') : ''}>Open</option><option value="closed"${m.status === 'closed' ? raw(' selected') : ''}>Closed</option></select></div>
        <div class="field"><label class="label" for="${p}_desc">Description</label><input id="${p}_desc" name="description" maxlength="500" value="${m.description ?? ''}"></div>
      </div><div class="buttons"><button class="btn btn-sm btn-hot">${m.id ? 'Save' : 'Add milestone'}</button></div></form>`;
    const main = html`${teamHeader('milestones')}
      ${region('Milestones', lk.milestones.length ? html`<ul class="team-milestones">${lk.milestones.map((m) => {
        const total = m.open + m.closed;
        return html`<li class="team-milestone${m.status === 'closed' ? ' is-closed' : ''}">
          <div class="team-milestone-head"><b>${icon('flag')}${m.name}</b>${m.status === 'closed' ? html` <span class="tag">closed</span>` : ''}
            <span class="small muted">${m.due_date ? `due ${m.due_date}` : 'no due date'}</span></div>
          ${m.description ? html`<p class="small muted">${m.description}</p>` : ''}
          <progress class="team-progress" max="${total || 1}" value="${m.closed}" aria-label="${m.closed} of ${total} issues closed"></progress>
          <p class="small"><a href="${TEAM}?milestone=${m.id}">${m.open} open</a> · <a href="${TEAM}?milestone=${m.id}&amp;status=closed">${m.closed} closed</a></p>
          <details class="team-inline-edit"><summary class="link-button">Edit</summary>${form(m, `m${m.id}`)}
            ${admin ? html`<form method="post" action="${TEAM}/milestones/${m.id}/delete">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="Delete the milestone ${m.name}? Its issues keep no milestone.">${icon('trash')} Delete milestone</button></form>` : ''}</details>
        </li>`;
      })}</ul>` : html`<p class="muted">No milestones yet.</p>`)}
      ${region('Add a milestone', form({}, 'nm'))}`;
    return send(reply, s, page(s, 'Milestones', [['Milestones']], main));
  });

  const saveMilestone = async (req: Req, reply: FastifyReply, id: string | null) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const b = req.body ?? {};
    const name = text(b.name, 100);
    const due = String(b.due_date ?? '');
    if (!NAME40.test(name) || (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))))) {
      flash(s, 'A milestone has a name of 1 to 40 characters and an optional date.', 'error');
      return back(reply, s, `${TEAM}/milestones`);
    }
    const vals = [name, text(b.description, 500) || null, due || null, b.status === 'closed' ? 'closed' : 'open'];
    try {
      if (id) {
        if (!isId(id)) return reply.code(404).send('Not found');
        const r = await owner.query('update meta.team_milestone set name = $3, description = $4, due_date = $5, status = $6 where id = $1 and workspace_id = $2', [id, ws, ...vals]);
        if (!r.rowCount) return reply.code(404).send('Not found');
      } else await owner.query('insert into meta.team_milestone (workspace_id, name, description, due_date, status) values ($1, $2, $3, $4, $5)', [ws, ...vals]);
      flash(s, `Milestone ${name} saved.`);
    } catch (e) {
      flash(s, /team_milestone_name/.test((e as Error).message) ? `A milestone ${name} exists already.` : (e as Error).message, 'error');
    }
    return back(reply, s, `${TEAM}/milestones`);
  };
  app.post(`${TEAM}/milestones`, (req: Req, reply) => saveMilestone(req, reply, null));
  app.post(`${TEAM}/milestones/:id`, (req: Req, reply) => saveMilestone(req, reply, req.params.id));

  // ------------------------------------------------------------------ templates (issue templates and canned responses)
  app.get(`${TEAM}/templates`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const rows = (await owner.query('select id, kind, name, title, body, labels from meta.team_template where workspace_id = $1 order by kind, seq, lower(name)', [ws])).rows;
    const form = (x: { id?: number; kind?: string; name?: string; title?: string | null; body?: string; labels?: string[] }, p: string) => html`<form method="post" action="${TEAM}/templates${x.id ? `/${x.id}` : ''}">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="${p}_name">Name</label><input id="${p}_name" name="name" maxlength="60" required value="${x.name ?? ''}"></div>
        <div class="field"><label class="label" for="${p}_kind">Kind</label><select id="${p}_kind" name="kind">
          <option value="issue"${x.kind !== 'response' ? raw(' selected') : ''}>Issue template</option><option value="response"${x.kind === 'response' ? raw(' selected') : ''}>Canned response</option></select></div>
        <div class="field"><label class="label" for="${p}_title">Issue title</label><input id="${p}_title" name="title" maxlength="200" value="${x.title ?? ''}"><small class="help">Issue templates only.</small></div>
        <div class="field"><label class="label" for="${p}_labels">Labels</label><input id="${p}_labels" name="labels" maxlength="500" value="${(x.labels ?? []).join(', ')}"><small class="help">Issue templates: label names, separated by commas.</small></div>
      </div>
      <div class="field"><label class="label" for="${p}_body">Text</label><textarea id="${p}_body" name="body" rows="6" maxlength="20000">${x.body ?? ''}</textarea><small class="help">Markdown.</small></div>
      <div class="buttons"><button class="btn btn-sm btn-hot">${x.id ? 'Save' : 'Add template'}</button></div></form>`;
    const list = (kind: string) => {
      const xs = rows.filter((r) => r.kind === kind);
      return xs.length ? html`<ul class="team-template-list">${xs.map((x) => html`<li><b>${x.name}</b>
          ${kind === 'issue' ? html` <a class="small" href="${TEAM}/issues/new?template=${x.id}">Use</a>` : ''}
          <details class="team-inline-edit"><summary class="link-button">Edit</summary>${form(x, `t${x.id}`)}
            <form method="post" action="${TEAM}/templates/${x.id}/delete">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="Delete the template ${x.name}?">${icon('trash')} Delete template</button></form></details></li>`)}</ul>`
        : html`<p class="muted small">None yet.</p>`;
    };
    const main = html`${teamHeader('templates')}
      <div class="columns">${region('Issue templates', list('issue'))}${region('Canned responses', list('response'))}</div>
      ${region('Add a template', form({}, 'nt'))}`;
    return send(reply, s, page(s, 'Templates', [['Templates']], main));
  });

  const saveTemplate = async (req: Req, reply: FastifyReply, id: string | null) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const b = req.body ?? {};
    const name = text(b.name, 100);
    const kind = b.kind === 'response' ? 'response' : 'issue';
    const body = String(b.body ?? '').replace(/\r\n?/g, '\n');
    const labels = String(b.labels ?? '').split(',').map((x) => x.trim()).filter((x) => NAME40.test(x)).slice(0, 20);
    if (!/^\S(.{0,58}\S)?$/.test(name) || body.length > 20000) {
      flash(s, 'A template has a name of 1 to 60 characters and up to 20000 characters of text.', 'error');
      return back(reply, s, `${TEAM}/templates`);
    }
    const vals = [kind, name, kind === 'issue' ? text(b.title, 200) || null : null, body, kind === 'issue' ? labels : []];
    try {
      if (id) {
        if (!isId(id)) return reply.code(404).send('Not found');
        const r = await owner.query('update meta.team_template set kind = $3, name = $4, title = $5, body = $6, labels = $7 where id = $1 and workspace_id = $2', [id, ws, ...vals]);
        if (!r.rowCount) return reply.code(404).send('Not found');
      } else await owner.query('insert into meta.team_template (workspace_id, kind, name, title, body, labels) values ($1, $2, $3, $4, $5, $6)', [ws, ...vals]);
      flash(s, `Template ${name} saved.`);
    } catch (e) {
      flash(s, /team_template_name/.test((e as Error).message) ? `A template ${name} exists already.` : (e as Error).message, 'error');
    }
    return back(reply, s, `${TEAM}/templates`);
  };
  app.post(`${TEAM}/templates`, (req: Req, reply) => saveTemplate(req, reply, null));
  app.post(`${TEAM}/templates/:id`, (req: Req, reply) => saveTemplate(req, reply, req.params.id));
  app.post(`${TEAM}/templates/:id/delete`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    if (!isId(req.params.id)) return reply.code(404).send('Not found');
    const r = await owner.query('delete from meta.team_template where id = $1 and workspace_id = $2', [req.params.id, ws]);
    if (!r.rowCount) return reply.code(404).send('Not found');
    flash(s, 'Template deleted.');
    return back(reply, s, `${TEAM}/templates`);
  });

  // ------------------------------------------------------------------ the set-up wizard
  app.get(`${TEAM}/setup`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s } = t;
    const en = TEAM_SAMPLES.en;
    const main = html`${teamHeader('setup')}
      ${region('Set up Team Development', html`
        <p class="u-mt0">Installs sample data for ${s.workspace?.name ?? 'this workspace'}; what exists already (by name) is kept, so you can run it again.</p>
        <form method="post" action="${TEAM}/setup">${csrf(s)}
          <div class="field"><label class="label" for="f_lang">Language</label><select id="f_lang" name="lang">${TEAM_LANGUAGES.map((l) => html`<option value="${l}">${TEAM_SAMPLES[l].language}</option>`)}</select></div>
          <fieldset class="team-fieldset"><legend>Install</legend>
            <label class="check"><input type="checkbox" name="labels" value="true" checked> Label groups and labels: ${en.groups.map((g) => `${g.name} (${g.labels.map((l) => l.name).join(', ')})`).join('; ')}</label>
            <label class="check"><input type="checkbox" name="templates" value="true" checked> Templates: ${en.issueTemplates.map((x) => x.name).join(', ')}; canned responses (${en.responses.length})</label>
            <label class="check"><input type="checkbox" name="milestones" value="true" checked> Milestones: ${en.milestones.map((m) => m.name).join(', ')}</label>
          </fieldset>
          <div class="buttons"><button class="btn btn-hot">Set up</button></div></form>`)}`;
    return send(reply, s, page(s, 'Set up', [['Set up']], main));
  });

  app.post(`${TEAM}/setup`, async (req: Req, reply) => {
    const t = await teamDev(req, reply);
    if (!t) return;
    const { s, ws } = t;
    const lang = String(req.body?.lang ?? 'en');
    if (!TEAM_LANGUAGES.includes(lang)) return reply.code(400).send('Unknown language');
    const b = req.body ?? {};
    const n = await owner.tx((c) => teamSetup(c, ws, lang, { labels: b.labels === 'true', templates: b.templates === 'true', milestones: b.milestones === 'true' }));
    await logActivity({ appId: null, username: s.username, event: 'workspace', ip: clientIp(req), detail: `team: set up (${lang})` });
    flash(s, `Set up: ${n.groups} label group(s), ${n.labels} label(s), ${n.templates} template(s) and ${n.milestones} milestone(s) added.`);
    return back(reply, s, TEAM);
  });

  // ------------------------------------------------------------------ issues from feedback and developer comments
  app.post(`${TEAM}/from-feedback`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const fid = String(req.body?.feedback ?? '');
    const f = isId(fid) ? await owner.one('select f.*, a.name as app_name from meta.feedback f join meta.app a on a.id = f.app_id where f.id = $1', [fid]) : undefined;
    // the feedback's application must be one the developer may open (that makes its workspace the current one)
    if (!f || !(await appAllowed(s, f.app_id))) return reply.code(404).send('Not found');
    const ws = (await appWorkspace(f.app_id))!;
    const existing = await owner.one('select id from meta.team_issue where feedback_id = $1 and workspace_id = $2', [f.id, ws]);
    if (existing) return back(reply, s, `${TEAM}/issues/${existing.id}`);
    const kindLabel = f.kind === 'problem' ? 'bug' : f.kind === 'idea' ? 'feature' : null;
    const title = `${f.kind === 'problem' ? 'Problem' : f.kind === 'idea' ? 'Idea' : 'Feedback'}: ${firstLine(f.body)}`;
    const body = `Feedback of **${mdEscape(f.username)}** (${f.kind}${f.rating ? `, ${f.rating} of 5` : ''}) on ${f.page_no ? `page ${f.page_no} of ` : ''}${mdEscape(f.app_name)}:\n\n${quote(f.body)}`;
    const id = await owner.tx(async (c) => {
      const id = Number((await c.query(`insert into meta.team_issue (workspace_id, title, body, app_id, page_no, feedback_id, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [ws, title, body, f.app_id, f.page_no && (await c.query('select 1 from meta.page where app_id = $1 and page_no = $2', [f.app_id, f.page_no])).rowCount ? f.page_no : null, f.id, s.username])).rows[0].id);
      if (kindLabel) await c.query(`insert into meta.team_issue_label (issue_id, label_id) select $1, id from meta.team_label where workspace_id = $2 and lower(name) = $3`, [id, ws, kindLabel]);
      await logIssue(c, id, s.username, 'created', `from feedback of ${f.username}`);
      if (f.status === 'open') await c.query(`update meta.feedback set status = 'in_progress' where id = $1`, [f.id]);
      return id;
    });
    flash(s, `Issue #${id} created from the feedback.`);
    return back(reply, s, `${TEAM}/issues/${id}`);
  });

  app.post(`${TEAM}/from-comment`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const cid = String(req.body?.comment ?? '');
    const c0 = /^\d{1,9}$/.test(cid) ? await owner.one('select c.*, a.name as app_name from meta.dev_comment c join meta.app a on a.id = c.app_id where c.id = $1', [cid]) : undefined;
    if (!c0 || !(await appAllowed(s, c0.app_id))) return reply.code(404).send('Not found');
    const ws = (await appWorkspace(c0.app_id))!;
    const existing = await owner.one('select id from meta.team_issue where dev_comment_id = $1 and workspace_id = $2', [c0.id, ws]);
    if (existing) return back(reply, s, `${TEAM}/issues/${existing.id}`);
    const body = `Developer comment of **${mdEscape(c0.author)}** on ${c0.page_no ? `page ${c0.page_no} of ` : ''}${mdEscape(c0.app_name)}:\n\n${quote(c0.body)}`;
    const id = await owner.tx(async (c) => {
      const id = Number((await c.query(`insert into meta.team_issue (workspace_id, title, body, app_id, page_no, dev_comment_id, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [ws, firstLine(c0.body), body, c0.app_id, c0.page_no || null, c0.id, s.username])).rows[0].id);
      await logIssue(c, id, s.username, 'created', `from a comment of ${c0.author}`);
      await recordMentions(c, ws, id, null, c0.body, s.username);
      return id;
    });
    flash(s, `Issue #${id} created from the comment.`);
    return back(reply, s, `${TEAM}/issues/${id}`);
  });
}

const firstLine = (t: string) => {
  const l = String(t).split('\n').map((x) => x.trim()).find(Boolean) ?? 'Untitled';
  return l.length > 80 ? `${l.slice(0, 79)}…` : l;
};
const mdEscape = (t: string) => String(t).replace(/[\\`*_[\]<>#]/g, (c) => `\\${c}`);
const quote = (t: string) => String(t).split('\n').map((l) => `> ${l}`).join('\n');

// ------------------------------------------------------------------ pieces for other pages

/** (Page Designer) the open issues of a page: a line with links, or nothing. */
export async function pageIssuesNote(appId: number, pageNo: number): Promise<Raw | ''> {
  const rows = await pageIssues(appId, pageNo);
  if (!rows.length) return '';
  const all = `${TEAM}?app=${appId}&page=${pageNo}`;
  return html`<div class="team-page-issues small" role="note">${icon('kanban')}<span>${rows.length} open issue${rows.length === 1 ? '' : 's'}:
    ${rows.slice(0, 3).map((r, i) => html`${i ? ', ' : ''}<a href="${TEAM}/issues/${r.id}">${r.title}</a>`)}${rows.length > 3 ? html`, <a href="${all}">all ${rows.length}</a>` : ''}
    · <a href="${TEAM}/issues/new?app=${appId}&amp;page=${pageNo}">New issue</a></span></div>`;
}

/** (App Home) open issues per page, and the Tasks entry. */
export async function appIssues(appId: number) {
  const c = await appIssueCounts(appId);
  return {
    tag: (pageNo: number) => {
      const n = c.perPage.get(pageNo);
      return n ? html` <a class="tag tag-warning" href="${TEAM}?app=${appId}&amp;page=${pageNo}" title="Open issues of this page">${n} issue${n === 1 ? '' : 's'}</a>` : '';
    },
    task: html`<li><a href="${TEAM}?app=${appId}">${icon('kanban')} Open issues (${c.total})</a></li>`,
  };
}

/** (Workspace home) the side column's Team Development block. */
export async function teamHomeBlock(s: Session) {
  const ws = currentWorkspace(s);
  if (ws < 0) return '';
  const c = await teamCounts(ws, s.username);
  return html`<section class="wh-team" aria-labelledby="wh-team-h"><h2 id="wh-team-h">Team Development</h2>
    <ul class="ab-links ab-tasks">
      <li><a href="${TEAM}">${icon('kanban')} Open issues <b class="wh-team-n">${c.open}</b></a></li>
      <li><a href="${TEAM}?assignee=me">${icon('user')} Assigned to you <b class="wh-team-n">${c.mine}</b></a></li>
      ${c.mentions ? html`<li><a href="${TEAM}#mentions">${icon('at')} Mentions of you <b class="wh-team-n">${c.mentions}</b></a></li>` : ''}
      ${c.set_up ? '' : html`<li><a href="${TEAM}/setup">${icon('settings')} Set up Team Development</a></li>`}
    </ul></section>`;
}

/** (Feedback, developer comments) a button that turns the entry into an issue, or the link to its issue. */
export function toIssueButton(s: Session, kind: 'feedback' | 'comment', id: number, issue: number | undefined) {
  if (issue) return html`<a class="small team-issue-link" href="${TEAM}/issues/${issue}">${icon('kanban')} Issue #${issue}</a>`;
  return html`<form method="post" action="${TEAM}/from-${kind}" class="u-inline">${csrf(s)}<input type="hidden" name="${kind}" value="${id}"><button class="link-button">Make an issue</button></form>`;
}
