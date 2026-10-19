// Sprint 113 (WS-3; migration 122): Builder → Team Development: the set-up wizard, issues with labels, a milestone,
// assignees, an application and page link, comments with @mentions and history; the list's filters and saved views,
// the board (moves without JavaScript), issues from feedback and developer comments, the Page Designer's and App
// Home's open issues, the Workspace home's count, and the "team" part of the workspace export.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { exportWorkspace, importWorkspace } from '../src/workspace-export.ts';
import { issueHtml, mentionsIn } from '../src/team.ts';
import { TEAM_SAMPLES } from '../src/team-samples.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let ws: number;
let ws2: number;
let appId: number;
let hrId: number;
const DEV = 'team113dev';
const OUTSIDER = 'team113out';
const ALIAS = 'team113';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
  await owner.query(`delete from meta.workspace where name in ('Team113 test', 'Team113 copy')`);
  for (const u of [DEV, OUTSIDER])
    await owner.query(`insert into meta.developer (username, password_hash, is_admin) values ($1, meta.hash_password($1), false) on conflict do nothing`, [u]);
  ws = (await owner.one(`insert into meta.workspace (name) values ('Team113 test') returning id`)).id;
  ws2 = (await owner.one(`insert into meta.workspace (name) values ('Team113 copy') returning id`)).id;
  await owner.query('delete from meta.workspace_member where username = any($1::text[])', [[DEV, OUTSIDER]]);
  await owner.query('insert into meta.workspace_member (workspace_id, username) values ($1, $2), ($3, $2)', [ws, DEV, ws2]);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication) values ($1, 'Team 113 app', 'none') returning id`, [ALIAS])).id;
  await owner.query('insert into meta.workspace_app (app_id, workspace_id) values ($1, $2)', [appId, ws]);
  await owner.query(`insert into meta.page (app_id, page_no, name, title) values ($1, 1, 'Home', 'Home'), ($1, 12, 'Twelve', 'Twelve')`, [appId]);
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});
after(async () => {
  await owner.query(`delete from meta.team_issue where workspace_id = 1 and created_by = 'admin' and title like 'T113 %'`);
  await owner.query('delete from meta.app where id = $1', [appId]);
  await owner.query('delete from meta.workspace where id = any($1::int[])', [[ws, ws2]]);
  await owner.query('delete from meta.developer where username = any($1::text[])', [[DEV, OUTSIDER]]);
  await app.close();
  await closePools();
});

const signIn = async (username = 'admin', workspace: number | null = ws) => {
  const b = new Browser(app);
  await b.get('/builder/login');
  const res = await b.submit('/builder/login', { username, password: username === 'admin' ? 'admin' : username });
  assert.equal(res.statusCode, 303);
  await b.get('/builder/home');
  if (workspace !== null) assert.equal((await b.submit('/builder/workspace', { workspace: String(workspace) })).statusCode, 303);
  await b.get('/builder/team');
  return b;
};
const labelId = async (w: number, name: string) => (await owner.one('select id from meta.team_label where workspace_id = $1 and name = $2', [w, name]))?.id as string;
const milestoneId = async (w: number, name: string) => (await owner.one('select id from meta.team_milestone where workspace_id = $1 and name = $2', [w, name]))?.id as string;
const created = (res: { headers: Record<string, unknown> }) => Number(/\/builder\/team\/issues\/(\d+)$/.exec(String(res.headers.location))?.[1]);

describe('Team Development', () => {
  test('the rail and the Workspace home lead there; the set-up wizard installs labels, templates and milestones once', async () => {
    const b = await signIn();
    const home = (await b.get('/builder/home')).body;
    assert.match(home, /<a href="\/builder\/team" class="rail-link" title="Team Development">/);
    assert.match(home, /<h2 id="wh-team-h">Team Development<\/h2>/);
    assert.match(home, /Set up Team Development/);
    const list = (await b.get('/builder/team')).body;
    assert.match(list, /New here\? <a href="\/builder\/team\/setup">Set up Team Development<\/a>/);
    const setup = await b.get('/builder/team/setup');
    assert.equal(setup.statusCode, 200);
    assert.match(setup.body, /<option value="en">English<\/option>/);
    const res = await b.submit('/builder/team/setup', { lang: 'en', labels: 'true', templates: 'true', milestones: 'true' });
    assert.equal(res.statusCode, 303);
    const count = async (t: string) => (await owner.one(`select count(*)::int as n from meta.${t} where workspace_id = $1`, [ws])).n;
    const en = TEAM_SAMPLES.en;
    assert.equal(await count('team_label_group'), 2);
    assert.equal(await count('team_label'), en.groups.reduce((a, g) => a + g.labels.length, 0));
    assert.equal(await count('team_milestone'), en.milestones.length);
    assert.equal(await count('team_template'), en.issueTemplates.length + en.responses.length);
    const bug = await owner.one(`select l.color, g.name as grp from meta.team_label l join meta.team_label_group g on g.id = l.group_id where l.workspace_id = $1 and l.name = 'Bug'`, [ws]);
    assert.deepEqual(bug, { color: 'red', grp: 'Type' });
    assert.ok(await labelId(ws, 'High') && await labelId(ws, 'Medium') && await labelId(ws, 'Low'));
    // again: nothing new
    await b.get('/builder/team/setup');
    await b.submit('/builder/team/setup', { lang: 'en', labels: 'true', templates: 'true', milestones: 'true' });
    assert.equal(await count('team_label'), 6);
    assert.doesNotMatch((await b.get('/builder/home')).body, /Set up Team Development/);
  });

  test('done when: "Salary rounding on page 12" (Bug, milestone 1.1) shows on HR page 12 in the Page Designer; closing it updates the Workspace home', async () => {
    const b = await signIn('admin', 1);
    await b.get('/builder/team/setup');
    await b.submit('/builder/team/setup', { lang: 'en', labels: 'true', templates: 'true', milestones: 'true' });
    const openCount = async () => Number(/Open issues <b class="wh-team-n">(\d+)<\/b>/.exec((await b.get('/builder/home')).body)?.[1]);
    const before = await openCount();
    await b.get('/builder/team/issues/new');
    const res = await b.submit('/builder/team/issues', {
      title: 'T113 Salary rounding on page 12', body: 'Rounds to **euros**.', labels: [await labelId(1, 'Bug')], milestone: await milestoneId(1, '1.1'), app: String(hrId), page: '12',
    });
    assert.equal(res.statusCode, 303);
    const id = created(res);
    assert.ok(id);
    assert.equal(await openCount(), before + 1);
    const designer = (await b.get(`/builder/apps/${hrId}/pages/12`)).body;
    assert.match(designer, new RegExp(`<a href="/builder/team/issues/${id}">T113 Salary rounding on page 12</a>`));
    assert.match(designer, /class="team-page-issues small"/);
    // App Home: the page's tag and the Tasks entry
    const appHome = (await b.get(`/builder/apps/${hrId}`)).body;
    assert.match(appHome, new RegExp(`href="/builder/team\\?app=${hrId}&amp;page=12" title="Open issues of this page">\\d+ issues?</a>`));
    assert.match(appHome, /Open issues \(\d+\)/);
    const issue = (await b.get(`/builder/team/issues/${id}`)).body;
    assert.match(issue, /<span class="team-label team-label-red">Bug<\/span>/);
    assert.match(issue, /<strong>euros<\/strong>/);
    assert.match(issue, />1\.1<\/a>/);
    assert.equal((await b.submit(`/builder/team/issues/${id}/status`, { status: 'closed' })).statusCode, 303);
    assert.equal(await openCount(), before);
    assert.doesNotMatch((await b.get(`/builder/apps/${hrId}/pages/12`)).body, /T113 Salary rounding/);
    const row = await owner.one('select status, closed_by from meta.team_issue where id = $1', [id]);
    assert.deepEqual(row, { status: 'closed', closed_by: 'admin' });
    assert.match((await b.get(`/builder/team/issues/${id}`)).body, /admin<\/b> closed the issue/);
  });

  test('issues: edit with history, comments with @mentions, filters, saved views and the board', async () => {
    const b = await signIn();
    await b.get('/builder/team/issues/new');
    const bug = await labelId(ws, 'Bug');
    const feature = await labelId(ws, 'Feature');
    const high = await labelId(ws, 'High');
    const res = await b.submit('/builder/team/issues', { title: 'Filter me', body: 'Hello @team113dev and @nobody', labels: [bug, high], assignees: [DEV], app: String(appId), page: '1' });
    const id = created(res);
    assert.ok(id);
    await b.submit('/builder/team/issues', { title: 'Another one', body: '', labels: [feature] });
    // the body's mention of a developer of the workspace is recorded, the unknown name is not
    assert.deepEqual((await owner.query('select username, by_user from meta.team_mention where issue_id = $1', [id])).rows, [{ username: DEV, by_user: 'admin' }]);
    const page = (await b.get(`/builder/team/issues/${id}`)).body;
    assert.match(page, /Hello <span class="mention">@team113dev<\/span> and @nobody/);
    // filters
    const titles = async (q: string) => [...(await b.get(`/builder/team?${q}`)).body.matchAll(/<a href="\/builder\/team\/issues\/\d+">([^<]+)<\/a> <span class="muted">#/g)].map((m) => m[1]).sort();
    assert.deepEqual(await titles(''), ['Another one', 'Filter me']);
    assert.deepEqual(await titles(`label=${bug}`), ['Filter me']);
    assert.deepEqual(await titles(`assignee=${DEV}`), ['Filter me']);
    assert.deepEqual(await titles('assignee=none'), ['Another one']);
    assert.deepEqual(await titles(`app=${appId}&page=1`), ['Filter me']);
    assert.deepEqual(await titles('q=anoth'), ['Another one']);
    assert.deepEqual(await titles(`q=%23${id}`), ['Filter me']);
    assert.deepEqual(await titles('status=closed'), []);
    // a saved view, per developer
    await b.get(`/builder/team?label=${bug}`);
    assert.equal((await b.submit('/builder/team/views', { name: 'My bugs', query: `label=${bug}&bogus=1` })).statusCode, 303);
    assert.equal((await owner.one(`select query from meta.team_view where workspace_id = $1 and username = 'admin' and name = 'My bugs'`, [ws])).query, `label=${bug}`);
    assert.match((await b.get('/builder/team')).body, new RegExp(`<a href="/builder/team\\?label=${bug}">My bugs</a>`));
    // edit: labels, milestone, assignees; the history says so
    await b.get(`/builder/team/issues/${id}`);
    const m10 = await milestoneId(ws, '1.0');
    assert.equal((await b.submit(`/builder/team/issues/${id}`, { title: 'Filter me twice', body: 'Hello @team113dev and @nobody', labels: [feature, high], milestone: m10, assignees: [], app: String(appId), page: '12' })).statusCode, 303);
    const hist = (await owner.query('select action, detail from meta.team_issue_event where issue_id = $1 order by id', [id])).rows;
    assert.deepEqual(hist.map((h) => h.action), ['created', 'title', 'milestone', 'link', 'labels', 'assignees']);
    assert.equal(hist.find((h) => h.action === 'labels').detail, '+Feature -Bug');
    assert.equal(hist.find((h) => h.action === 'assignees').detail, `-${DEV}`);
    assert.equal(hist.find((h) => h.action === 'link').detail, 'Team 113 app, page 12');
    // a comment with a mention, and comment-and-close
    await b.get(`/builder/team/issues/${id}`);
    assert.equal((await b.submit(`/builder/team/issues/${id}/comments`, { body: 'Ping @Team113Dev.', and: 'close' })).statusCode, 303);
    assert.equal((await owner.one('select status from meta.team_issue where id = $1', [id])).status, 'closed');
    assert.equal((await owner.one('select count(*)::int as n from meta.team_mention where issue_id = $1 and comment_id is not null', [id])).n, 1);
    // the developer sees the mentions in the builder (and the Workspace home), and marks them seen
    const d = await signIn(DEV);
    const list = (await d.get('/builder/team')).body;
    assert.match(list, /2 mentions of you/);
    assert.match((await d.get('/builder/home')).body, /Mentions of you <b class="wh-team-n">2<\/b>/);
    await d.get('/builder/team');
    await d.submit('/builder/team/mentions/seen', {});
    assert.match((await d.get('/builder/team')).body, /Nobody mentioned you/);
    // the board: by label (group Type), and by milestone; moving a card replaces the group's label / sets the milestone
    await b.submit(`/builder/team/issues/${id}/status`, { status: 'open' });
    const board = (await b.get('/builder/team/board')).body;
    assert.match(board, /<h2 class="team-col-head"><span class="team-label team-label-red">Bug<\/span>/);
    assert.match(board, /None of these/);
    const typeGroup = (await owner.one(`select id from meta.team_label_group where workspace_id = $1 and name = 'Type'`, [ws])).id;
    assert.equal((await b.submit(`/builder/team/issues/${id}/move`, { by: 'label', group: String(typeGroup), from: feature, to: bug, back: '/builder/team/board?group=1' })).statusCode, 303);
    const labels = (await owner.query('select l.name from meta.team_issue_label il join meta.team_label l on l.id = il.label_id where il.issue_id = $1 order by 1', [id])).rows.map((r) => r.name);
    assert.deepEqual(labels, ['Bug', 'High'], 'the Type label replaced, the priority kept');
    const byMs = (await b.get('/builder/team/board?by=milestone')).body;
    assert.match(byMs, /No milestone/);
    const m11 = await milestoneId(ws, '1.1');
    const mv = await b.submit(`/builder/team/issues/${id}/move`, { by: 'milestone', to: m11, back: 'https://evil.example/' });
    assert.equal(mv.headers.location, '/builder/team/board', 'never back to another site');
    assert.equal(String((await owner.one('select milestone_id from meta.team_issue where id = $1', [id])).milestone_id), String(m11));
  });

  test('templates prefill a new issue; canned responses prefill a comment; labels and milestones are managed', async () => {
    const b = await signIn();
    const tpl = (await owner.one(`select id from meta.team_template where workspace_id = $1 and kind = 'issue' and name = 'Bug report'`, [ws])).id;
    const form = (await b.get(`/builder/team/issues/new?template=${tpl}&app=${appId}&page=12`)).body;
    assert.match(form, /<input id="f_title" name="title" maxlength="200" required value="Bug: ">/);
    assert.match(form, /## What happens/);
    assert.match(form, new RegExp(`name="labels" value="${await labelId(ws, 'Bug')}" checked`));
    assert.match(form, new RegExp(`<option value="${appId}" selected>Team 113 app</option>`));
    const issue = (await owner.one(`select id from meta.team_issue where workspace_id = $1 limit 1`, [ws])).id;
    const resp = (await owner.one(`select id from meta.team_template where workspace_id = $1 and kind = 'response' and name = 'Fixed'`, [ws])).id;
    assert.match((await b.get(`/builder/team/issues/${issue}?response=${resp}`)).body, /<textarea id="f_comment" name="body" rows="4" maxlength="20000" required>This is fixed/);
    // labels: add, rename, colour from the palette only
    await b.get('/builder/team/labels');
    assert.equal((await b.submit('/builder/team/labels', { name: 'Docs', color: 'purple', group: '', description: 'Documentation' })).statusCode, 303);
    const docs = await labelId(ws, 'Docs');
    assert.ok(docs);
    assert.match((await b.get('/builder/team/labels')).body, /<span class="team-label team-label-purple">Docs<\/span>/);
    assert.equal((await b.submit(`/builder/team/labels/${docs}`, { name: 'Docs', color: 'chartreuse', group: '' })).statusCode, 400);
    await b.submit(`/builder/team/labels/${docs}/delete`, {});
    assert.equal(await labelId(ws, 'Docs'), undefined);
    // milestones
    await b.get('/builder/team/milestones');
    assert.equal((await b.submit('/builder/team/milestones', { name: '2.0', due_date: '2027-01-31', status: 'open' })).statusCode, 303);
    assert.equal((await owner.one(`select due_date::text from meta.team_milestone where workspace_id = $1 and name = '2.0'`, [ws])).due_date, '2027-01-31');
    assert.match((await b.get('/builder/team/milestones')).body, /due 2027-01-31/);
    // templates page
    assert.match((await b.get('/builder/team/templates')).body, /Canned responses/);
  });

  test('feedback and developer comments become issues, linked both ways', async () => {
    const b = await signIn();
    const fb = (await owner.one(`insert into meta.feedback (app_id, page_no, username, kind, body) values ($1, 12, 'some_user', 'problem', $2) returning id`, [appId, 'The total is wrong\nIt shows 10 instead of 12'])).id;
    await b.get(`/builder/apps/${appId}/feedback`);
    const res = await b.submit('/builder/team/from-feedback', { feedback: String(fb) });
    const id = created(res);
    assert.ok(id);
    const i = await owner.one('select title, app_id, page_no, feedback_id, body from meta.team_issue where id = $1', [id]);
    assert.equal(i.title, 'Problem: The total is wrong');
    assert.equal(i.page_no, 12);
    assert.match(i.body, /^Feedback of \*\*some\\_user\*\*/);
    assert.equal((await owner.one(`select l.name from meta.team_issue_label il join meta.team_label l on l.id = il.label_id where il.issue_id = $1`, [id])).name, 'Bug');
    assert.equal((await owner.one('select status from meta.feedback where id = $1', [fb])).status, 'in_progress');
    assert.match((await b.get(`/builder/apps/${appId}/feedback`)).body, new RegExp(`href="/builder/team/issues/${id}">.*Issue #${id}</a>`, 's'));
    assert.match((await b.get(`/builder/team/issues/${id}`)).body, /From feedback/);
    // again: the same issue
    assert.equal(created(await b.submit('/builder/team/from-feedback', { feedback: String(fb) })), id);
    // a developer comment on page 12
    const cm = (await owner.one(`insert into meta.dev_comment (app_id, page_no, author, body) values ($1, 12, $2, 'Refactor the totals') returning id`, [appId, DEV])).id;
    const designer = (await b.get(`/builder/apps/${appId}/pages/12`)).body;
    assert.match(designer, new RegExp(`name="comment" value="${cm}"><button class="link-button">Make an issue</button>`));
    const cid = created(await b.submit('/builder/team/from-comment', { comment: String(cm) }));
    assert.equal((await owner.one('select title, dev_comment_id from meta.team_issue where id = $1', [cid])).title, 'Refactor the totals');
    assert.match((await b.get(`/builder/apps/${appId}/pages/12`)).body, new RegExp(`Issue #${cid}</a>`));
  });

  test('the workspace export carries labels, milestones, templates and issues; an import into another workspace recreates them', async () => {
    const doc = await exportWorkspace(ws, ['team']);
    assert.ok(doc.team.labels.some((l: any) => l.name === 'Bug' && l.group === 'Type' && l.color === 'red'));
    const filter = doc.team.issues.find((x: any) => x.title === 'Filter me twice');
    assert.ok(filter);
    assert.equal(filter.app, ALIAS);
    assert.equal(filter.milestone, '1.1');
    assert.ok(filter.comments.length >= 1 && filter.history.length >= 3);
    // into the other workspace: the app link only when that workspace has the app (it doesn't), assignees only its developers
    doc.team.issues[0].assignees = [DEV, OUTSIDER];
    const r = await owner.tx((c) => importWorkspace(c, ws2, doc, ['team'], { replace: false, by: 'admin' }));
    assert.match(r.lines.join(' '), /Team Development: .*added/);
    const n = async (t: string, w: number) => (await owner.one(`select count(*)::int as n from meta.${t} where workspace_id = $1`, [w])).n;
    for (const t of ['team_label_group', 'team_label', 'team_milestone', 'team_template', 'team_issue']) assert.equal(await n(t, ws2), await n(t, ws), t);
    const copy = await owner.one(`select id, app_id, milestone_id from meta.team_issue where workspace_id = $1 and title = 'Filter me twice'`, [ws2]);
    assert.equal(copy.app_id, null, 'no link to an application of another workspace');
    assert.equal(String(copy.milestone_id), String(await milestoneId(ws2, '1.1')));
    const first = await owner.one(`select id from meta.team_issue where workspace_id = $1 and title = $2`, [ws2, doc.team.issues[0].title]);
    assert.deepEqual((await owner.query('select username from meta.team_issue_assignee where issue_id = $1', [first.id])).rows.map((x) => x.username), [DEV]);
    // again without replace: everything kept
    const again = await owner.tx((c) => importWorkspace(c, ws2, doc, ['team'], { replace: false, by: 'admin' }));
    assert.match(again.lines.join(' '), /kept/);
    assert.equal(await n('team_issue', ws2), await n('team_issue', ws));
  });

  test('mentions: only developers of the workspace, never inside code; Markdown is escaped', () => {
    assert.deepEqual(mentionsIn('hi @Scott, @king. and a@b and @nobody', ['scott', 'king']), ['scott', 'king']);
    const h = issueHtml('Hi @scott `@scott` <b>x</b> [a](javascript:alert(1))', ['scott']);
    assert.match(h, /<span class="mention">@scott<\/span>/);
    assert.match(h, /<code>@scott<\/code>/);
    assert.doesNotMatch(h, /<b>|href="javascript:/);
  });
});
