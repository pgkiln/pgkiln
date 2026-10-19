import { esc } from './html.ts';
import { owner } from './db.ts';
import { markdownHtml } from './richtext.ts';
import { TEAM_SAMPLES, type LabelColor } from './team-samples.ts';

// (sprint 113, WS-3; migration 122) Team Development: the data side of the workspace's issue tracker
// (src/builder/team.ts has the pages). Everything here takes the workspace explicitly and only touches rows of
// that workspace: callers pass the developer's current workspace, never a workspace from the request.
//
//   workspaceDevelopers  who may be assigned or @mentioned: the workspace's members and the installation's administrators
//   issueHtml            an issue body or comment as safe HTML (src/richtext.ts) with @mentions of those developers marked
//   mentionsIn           the developers @mentioned in a text
//   teamSetup            the set-up wizard: sample label groups, labels, milestones and templates (src/team-samples.ts)
//   teamCounts           open issues, those assigned to a developer, unseen mentions (Workspace home, rail)
//   pageIssues           the open issues of an application's page (Page Designer, App Home)
//   exportTeam/importTeam  the "team" part of the workspace export (src/workspace-export.ts)

export const LABEL_COLORS: readonly LabelColor[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'];
export const isLabelColor = (v: unknown): v is LabelColor => typeof v === 'string' && (LABEL_COLORS as readonly string[]).includes(v);

type Json = Record<string, any>;
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** The developers of a workspace: its members and the installation's administrators (sorted). */
export async function workspaceDevelopers(ws: number, db: Q = owner): Promise<string[]> {
  return (await db.query(
    `select username from meta.workspace_member where workspace_id = $1
      union select username from meta.developer where is_admin
      order by 1`, [ws])).rows.map((r) => r.username as string);
}

const MENTION = /(^|[\s(>[{,;:])@([\p{L}\p{N}][\p{L}\p{N}._@+-]{0,98})/gu;
/** The developers (of `devs`, case-insensitively) @mentioned in a text: their exact user names. */
export function mentionsIn(text: string, devs: readonly string[]): string[] {
  const byLower = new Map(devs.map((d) => [d.toLowerCase(), d]));
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const name = resolve(m[2], byLower);
    if (name) found.add(name);
  }
  return [...found];
}

/** "@scott." ends a sentence: the longest prefix (dropping trailing punctuation) that is a developer. */
function resolve(word: string, byLower: Map<string, string>): string | null {
  let w = word;
  while (w) {
    const hit = byLower.get(w.toLowerCase());
    if (hit) return hit;
    if (!/[._@+-]$/.test(w)) return null;
    w = w.slice(0, -1);
  }
  return null;
}

/**
 * Markdown → safe HTML (markdownHtml: raw HTML in the source is shown as text, links are http(s)/mailto/relative only),
 * then @mentions of the workspace's developers wrapped in <span class="mention">. Only text between tags is
 * touched, never inside <code> or <pre>; the span is built from the escaped name.
 */
export function issueHtml(md: string, devs: readonly string[]): string {
  const out = markdownHtml(md);
  if (!devs.length || !out.includes('@')) return out;
  const byLower = new Map(devs.map((d) => [esc(d).toLowerCase(), d]));
  let inCode = 0;
  return out.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(part)) inCode++;
      else if (/^<\/(code|pre)>/i.test(part)) inCode = Math.max(0, inCode - 1);
      return part;
    }
    if (inCode || !part.includes('@')) return part;
    return part.replace(MENTION, (all, pre: string, word: string) => {
      const name = resolve(word, byLower);
      if (!name) return all;
      return `${pre}<span class="mention">@${esc(name)}</span>${word.slice(esc(name).length)}`;
    });
  }).join('');
}

/** Record an event in an issue's history. */
export async function logIssue(db: Q, issueId: number | string, username: string | null, action: string, detail: string | null = null) {
  await db.query('insert into meta.team_issue_event (issue_id, username, action, detail) values ($1, $2, $3, $4)',
    [issueId, username, action, detail ? detail.slice(0, 1000) : null]);
}

/** Record @mentions (of the workspace's developers, not the writer) of an issue body or comment; returns them. */
export async function recordMentions(db: Q, ws: number, issueId: number | string, commentId: number | string | null, text: string, by: string | null) {
  const devs = await workspaceDevelopers(ws, db);
  const names = mentionsIn(text, devs).filter((n) => n !== by);
  if (!names.length) return [];
  // a body edited again mentions only those it didn't mention before
  const already = commentId === null
    ? new Set((await db.query('select username from meta.team_mention where issue_id = $1 and comment_id is null', [issueId])).rows.map((r) => r.username))
    : new Set<string>();
  const fresh = names.filter((n) => !already.has(n));
  for (const n of fresh)
    await db.query('insert into meta.team_mention (issue_id, comment_id, username, by_user) values ($1, $2, $3, $4)', [issueId, commentId, n, by]);
  return fresh;
}

export interface SetupParts { labels: boolean; templates: boolean; milestones: boolean }
/** The set-up wizard: install the language's samples into a workspace; what exists already (by name) is kept. */
export async function teamSetup(db: Q, ws: number, lang: string, parts: SetupParts) {
  const sample = TEAM_SAMPLES[lang];
  if (!sample) throw new Error('Unknown language');
  const n = { groups: 0, labels: 0, milestones: 0, templates: 0 };
  if (parts.labels) {
    let gseq = 0;
    for (const g of sample.groups) {
      gseq += 10;
      const r = await db.query(
        `insert into meta.team_label_group (workspace_id, name, description, seq) values ($1, $2, $3, $4)
         on conflict (workspace_id, lower(name)) do nothing returning id`, [ws, g.name, g.description, gseq]);
      n.groups += r.rowCount ?? 0;
      const gid = (await db.query('select id from meta.team_label_group where workspace_id = $1 and lower(name) = lower($2)', [ws, g.name])).rows[0].id;
      let seq = 0;
      for (const l of g.labels) {
        seq += 10;
        const x = await db.query(
          `insert into meta.team_label (workspace_id, group_id, name, color, description, seq) values ($1, $2, $3, $4, $5, $6)
           on conflict (workspace_id, lower(name)) do nothing`, [ws, gid, l.name, l.color, l.description, seq]);
        n.labels += x.rowCount ?? 0;
      }
    }
  }
  if (parts.milestones)
    for (const m of sample.milestones) {
      const r = await db.query(
        `insert into meta.team_milestone (workspace_id, name, description, due_date) values ($1, $2, $3, current_date + $4::int)
         on conflict (workspace_id, lower(name)) do nothing`, [ws, m.name, m.description, m.dueInDays]);
      n.milestones += r.rowCount ?? 0;
    }
  if (parts.templates) {
    let seq = 0;
    for (const t of sample.issueTemplates) {
      seq += 10;
      const r = await db.query(
        `insert into meta.team_template (workspace_id, kind, name, title, body, labels, seq) values ($1, 'issue', $2, $3, $4, $5, $6)
         on conflict (workspace_id, kind, lower(name)) do nothing`, [ws, t.name, t.title, t.body, t.labels, seq]);
      n.templates += r.rowCount ?? 0;
    }
    seq = 0;
    for (const t of sample.responses) {
      seq += 10;
      const r = await db.query(
        `insert into meta.team_template (workspace_id, kind, name, body, seq) values ($1, 'response', $2, $3, $4)
         on conflict (workspace_id, kind, lower(name)) do nothing`, [ws, t.name, t.body, seq]);
      n.templates += r.rowCount ?? 0;
    }
  }
  return n;
}

/** Open issues of a workspace, those assigned to the developer, and the developer's unseen mentions. */
export async function teamCounts(ws: number, username: string | null) {
  const r = await owner.query(
    `select (select count(*) from meta.team_issue i where i.workspace_id = $1 and i.status = 'open')::int as open,
            (select count(*) from meta.team_issue i where i.workspace_id = $1 and i.status = 'open'
                and exists (select 1 from meta.team_issue_assignee a where a.issue_id = i.id and a.username = $2))::int as mine,
            (select count(*) from meta.team_mention m join meta.team_issue i on i.id = m.issue_id
              where i.workspace_id = $1 and m.username = $2 and m.seen_at is null)::int as mentions,
            exists (select 1 from meta.team_label l where l.workspace_id = $1) as set_up`,
    [ws, username]);
  return r.rows[0] as { open: number; mine: number; mentions: number; set_up: boolean };
}

/** The open issues of a page of an application (of the application's own workspace). */
export async function pageIssues(appId: number, pageNo: number) {
  return (await owner.query<{ id: number; title: string }>(
    `select i.id, i.title from meta.team_issue i
      where i.app_id = $1 and i.page_no = $2 and i.status = 'open' and i.workspace_id = meta.app_workspace($1)
      order by i.updated_at desc limit 50`, [appId, pageNo])).rows;
}

/** Open issues of an application per page (page_no; null: about the application, no page). */
export async function appIssueCounts(appId: number) {
  const rows = (await owner.query<{ page_no: number | null; n: number }>(
    `select i.page_no, count(*)::int as n from meta.team_issue i
      where i.app_id = $1 and i.status = 'open' and i.workspace_id = meta.app_workspace($1) group by 1`, [appId])).rows;
  return { total: rows.reduce((a, r) => a + r.n, 0), perPage: new Map(rows.filter((r) => r.page_no !== null).map((r) => [r.page_no!, r.n])) };
}

/** The issues made from these feedback entries or developer comments (for the links back). */
export async function issuesFrom(kind: 'feedback' | 'comment', ids: number[]) {
  if (!ids.length) return new Map<number, number>();
  const col = kind === 'feedback' ? 'feedback_id' : 'dev_comment_id';
  const rows = (await owner.query(`select ${col} as src, min(id) as id from meta.team_issue where ${col} = any($1::bigint[]) group by 1`, [ids])).rows;
  return new Map(rows.map((r) => [Number(r.src), Number(r.id)]));
}

// ------------------------------------------------------------------ workspace export: the "team" part

/** The workspace's label groups, labels, milestones, templates and issues (with comments and history). */
export async function exportTeam(ws: number) {
  const q = async (sql: string) => (await owner.query(sql, [ws])).rows;
  const issues = await q(
    `select i.id, i.title, i.body, i.status, m.name as milestone, a.alias as app, i.page_no, i.created_by, i.created_at, i.updated_at, i.closed_by, i.closed_at,
            coalesce((select json_agg(l.name order by lower(l.name)) from meta.team_issue_label il join meta.team_label l on l.id = il.label_id where il.issue_id = i.id), '[]') as labels,
            coalesce((select json_agg(x.username order by x.username) from meta.team_issue_assignee x where x.issue_id = i.id), '[]') as assignees,
            coalesce((select json_agg(json_build_object('author', c.author, 'body', c.body, 'created_at', c.created_at) order by c.created_at, c.id)
                        from meta.team_issue_comment c where c.issue_id = i.id), '[]') as comments,
            coalesce((select json_agg(json_build_object('at', e.at, 'username', e.username, 'action', e.action, 'detail', e.detail) order by e.at, e.id)
                        from meta.team_issue_event e where e.issue_id = i.id), '[]') as history
       from meta.team_issue i
       left join meta.team_milestone m on m.id = i.milestone_id
       left join meta.app a on a.id = i.app_id and meta.app_workspace(a.id) = i.workspace_id
      where i.workspace_id = $1 order by i.id`);
  return {
    label_groups: await q('select name, description, seq from meta.team_label_group where workspace_id = $1 order by seq, lower(name)'),
    labels: await q(`select l.name, g.name as "group", l.color, l.description, l.seq from meta.team_label l left join meta.team_label_group g on g.id = l.group_id
                      where l.workspace_id = $1 order by l.seq, lower(l.name)`),
    milestones: (await q('select name, description, due_date::text, status from meta.team_milestone where workspace_id = $1 order by due_date nulls last, lower(name)')),
    templates: await q('select kind, name, title, body, labels, seq from meta.team_template where workspace_id = $1 order by kind, seq, lower(name)'),
    issues: issues.map(({ id: _id, ...i }) => ({ ...i, page_no: i.page_no ?? null })),
  };
}

const MAX = 5000;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max).trim() : null);
const name40 = (v: unknown) => {
  const s = str(v, 40);
  return s && /^\S(.{0,38}\S)?$/.test(s) ? s : null;
};
const when = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

/** Is this a "team" part at all (for describeWorkspaceFile)? The number of issues, or an error. */
export function describeTeam(v: unknown): number {
  if (!isObj(v)) throw new Error('The file\'s "team" is not an object.');
  for (const k of ['label_groups', 'labels', 'milestones', 'templates', 'issues']) {
    if (v[k] === undefined) continue;
    if (!Array.isArray(v[k])) throw new Error(`The file's team ${k} is not a list.`);
    if (v[k].length > MAX) throw new Error(`The file has more than ${MAX} team ${k}.`);
  }
  return Array.isArray(v.issues) ? v.issues.length : 0;
}

/**
 * Import the "team" part into a workspace (in the caller's transaction). Groups, labels, milestones and templates match by
 * name (kind and name for templates): added, or replaced / kept as `replace` says. An issue matches one with the same title
 * and creation time. Assignees are kept only when they are developers of this workspace, application links only to an
 * application of this workspace with that alias; colours outside the palette become gray.
 */
export async function importTeam(c: Q, ws: number, v: unknown, opts: { replace: boolean; by: string | null }) {
  describeTeam(v);
  const d = v as Json;
  const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).filter(isObj) : []);
  const n = { added: 0, replaced: 0, skipped: 0 };
  const count = (r: 'added' | 'replaced' | 'skipped') => n[r]++;
  const upsert = async (existing: { id: number } | undefined, insert: () => Promise<unknown>, update: (id: number) => Promise<unknown>) => {
    if (!existing) return (await insert(), 'added' as const);
    if (!opts.replace) return 'skipped' as const;
    return (await update(existing.id), 'replaced' as const);
  };
  const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0] as { id: number } | undefined;

  for (const g of list('label_groups')) {
    const name = name40(g.name);
    if (!name) throw new Error(`Team label group "${String(g.name ?? '')}": a name of 1 to 40 characters.`);
    const vals = [str(g.description, 500), Number.isInteger(g.seq) ? g.seq : 10];
    count(await upsert(await one('select id from meta.team_label_group where workspace_id = $1 and lower(name) = lower($2)', [ws, name]),
      () => c.query('insert into meta.team_label_group (workspace_id, name, description, seq) values ($1, $2, $3, $4)', [ws, name, ...vals]),
      (id) => c.query('update meta.team_label_group set description = $2, seq = $3 where id = $1', [id, ...vals])));
  }
  for (const l of list('labels')) {
    const name = name40(l.name);
    if (!name) throw new Error(`Team label "${String(l.name ?? '')}": a name of 1 to 40 characters.`);
    const group = typeof l.group === 'string' ? (await one('select id from meta.team_label_group where workspace_id = $1 and lower(name) = lower($2)', [ws, l.group]))?.id ?? null : null;
    const vals = [group, isLabelColor(l.color) ? l.color : 'gray', str(l.description, 500), Number.isInteger(l.seq) ? l.seq : 10];
    count(await upsert(await one('select id from meta.team_label where workspace_id = $1 and lower(name) = lower($2)', [ws, name]),
      () => c.query('insert into meta.team_label (workspace_id, name, group_id, color, description, seq) values ($1, $2, $3, $4, $5, $6)', [ws, name, ...vals]),
      (id) => c.query('update meta.team_label set group_id = $2, color = $3, description = $4, seq = $5 where id = $1', [id, ...vals])));
  }
  for (const m of list('milestones')) {
    const name = name40(m.name);
    if (!name) throw new Error(`Team milestone "${String(m.name ?? '')}": a name of 1 to 40 characters.`);
    const vals = [str(m.description, 500), day(m.due_date), m.status === 'closed' ? 'closed' : 'open'];
    count(await upsert(await one('select id from meta.team_milestone where workspace_id = $1 and lower(name) = lower($2)', [ws, name]),
      () => c.query('insert into meta.team_milestone (workspace_id, name, description, due_date, status) values ($1, $2, $3, $4, $5)', [ws, name, ...vals]),
      (id) => c.query('update meta.team_milestone set description = $2, due_date = $3, status = $4 where id = $1', [id, ...vals])));
  }
  for (const t of list('templates')) {
    const name = str(t.name, 60);
    const kind = t.kind === 'response' ? 'response' : 'issue';
    if (!name || !/^\S(.{0,58}\S)?$/.test(name)) throw new Error(`Team template "${String(t.name ?? '')}": a name of 1 to 60 characters.`);
    const labels = Array.isArray(t.labels) ? t.labels.filter((x: unknown) => typeof x === 'string').slice(0, 20).map((x: string) => x.slice(0, 40)) : [];
    const vals = [kind === 'issue' ? str(t.title, 200) : null, typeof t.body === 'string' ? t.body.slice(0, 20000) : '', labels, Number.isInteger(t.seq) ? t.seq : 10];
    count(await upsert(await one('select id from meta.team_template where workspace_id = $1 and kind = $2 and lower(name) = lower($3)', [ws, kind, name]),
      () => c.query('insert into meta.team_template (workspace_id, kind, name, title, body, labels, seq) values ($1, $2, $3, $4, $5, $6, $7)', [ws, kind, name, ...vals]),
      (id) => c.query('update meta.team_template set title = $2, body = $3, labels = $4, seq = $5 where id = $1', [id, ...vals])));
  }

  const devs = new Set(await workspaceDevelopers(ws, c));
  let issues = 0;
  for (const i of list('issues')) {
    const title = str(i.title, 200);
    if (!title) throw new Error('Team issue without a title.');
    const created = when(i.created_at) ?? new Date().toISOString();
    const milestone = typeof i.milestone === 'string' ? (await one('select id from meta.team_milestone where workspace_id = $1 and lower(name) = lower($2)', [ws, i.milestone]))?.id ?? null : null;
    const app = typeof i.app === 'string' ? (await one('select id from meta.app where alias = $1 and meta.app_workspace(id) = $2', [i.app, ws]))?.id ?? null : null;
    const pageNo = app && Number.isInteger(i.page_no) && i.page_no >= 0 ? i.page_no : null;
    const status = i.status === 'closed' ? 'closed' : 'open';
    const vals = [str(i.title, 200), typeof i.body === 'string' ? i.body.slice(0, 20000) : '', status, milestone, app, pageNo,
      str(i.created_by, 100) ?? opts.by ?? 'import', created, when(i.updated_at) ?? created,
      status === 'closed' ? str(i.closed_by, 100) : null, status === 'closed' ? when(i.closed_at) : null];
    const existing = await one('select id from meta.team_issue where workspace_id = $1 and title = $2 and created_at = $3', [ws, title, created]);
    let id: number | null = null;
    const what = await upsert(existing,
      async () => {
        id = (await c.query(`insert into meta.team_issue (workspace_id, title, body, status, milestone_id, app_id, page_no, created_by, created_at, updated_at, closed_by, closed_at)
                             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`, [ws, ...vals])).rows[0].id;
      },
      async (x) => {
        id = x;
        await c.query(`update meta.team_issue set title = $2, body = $3, status = $4, milestone_id = $5, app_id = $6, page_no = $7, created_by = $8,
                         created_at = $9, updated_at = $10, closed_by = $11, closed_at = $12 where id = $1`, [x, ...vals]);
        for (const t of ['team_issue_label', 'team_issue_assignee', 'team_issue_comment', 'team_issue_event']) await c.query(`delete from meta.${t} where issue_id = $1`, [x]);
      });
    count(what);
    if (id === null) continue;
    issues++;
    const names = Array.isArray(i.labels) ? i.labels.filter((x: unknown) => typeof x === 'string') : [];
    if (names.length)
      await c.query(`insert into meta.team_issue_label (issue_id, label_id) select $1, id from meta.team_label where workspace_id = $2 and lower(name) = any($3::text[]) on conflict do nothing`,
        [id, ws, names.map((x: string) => x.toLowerCase())]);
    for (const u of Array.isArray(i.assignees) ? i.assignees : [])
      if (typeof u === 'string' && devs.has(u)) await c.query('insert into meta.team_issue_assignee (issue_id, username) values ($1, $2) on conflict do nothing', [id, u]);
    for (const x of (Array.isArray(i.comments) ? i.comments : []).filter(isObj).slice(0, MAX)) {
      const body = typeof x.body === 'string' ? x.body.slice(0, 20000) : '';
      if (!body.trim()) continue;
      await c.query('insert into meta.team_issue_comment (issue_id, author, body, created_at) values ($1, $2, $3, $4)', [id, str(x.author, 100) ?? 'import', body, when(x.created_at) ?? created]);
    }
    for (const x of (Array.isArray(i.history) ? i.history : []).filter(isObj).slice(0, MAX)) {
      if (typeof x.action !== 'string' || !/^[a-z_]{1,30}$/.test(x.action)) continue;
      await c.query('insert into meta.team_issue_event (issue_id, at, username, action, detail) values ($1, $2, $3, $4, $5)',
        [id, when(x.at) ?? created, str(x.username, 100), x.action, str(x.detail, 1000)]);
    }
  }
  return { ...n, issues };
}
