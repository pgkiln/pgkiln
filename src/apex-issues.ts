import type { ApexReport, ReportEntry } from './apeximport.ts';

// (sprint 187, NX-F1) After an APEX import, the components that need a person become Team Development issues of the
// workspace (src/builder/team.ts), each linked to the application and its page, with the label "APEX import": what
// was not mapped, and what has PL/SQL or Oracle SQL left to port. The report is then a list to work through, close
// by close, instead of a page that is gone once read.

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const APEX_LABEL = 'APEX import';
/** Issues at most per import (a large application lists the rest in one more issue). */
export const MAX_ISSUES = 300;

/** The components of a report that need hand work. */
export const handWork = (report: ApexReport) => report.entries.filter((e) => e.status === 'not_mapped' || e.port || e.missing?.length);

const KIND: Record<ReportEntry['kind'], string> = {
  application: 'Application', page: 'Page', region: 'Region', item: 'Item', button: 'Button', validation: 'Validation',
  process: 'Process', computation: 'Computation', branch: 'Branch', dynamic_action: 'Dynamic action', lov: 'List of values',
  authorization: 'Authorization scheme', navigation: 'Navigation',
};

const title = (e: ReportEntry) =>
  `${e.status === 'not_mapped' ? 'Not mapped' : e.port ? 'Port' : 'Missing objects'}: ${KIND[e.kind]} ${e.name}${e.page !== null ? ` (page ${e.page})` : ''}`.slice(0, 200);

const body = (e: ReportEntry, alias: string) =>
  [
    `From the APEX import of ${alias}.`,
    '',
    `- APEX type: ${e.apexType}`,
    `- Became: ${e.target ?? 'nothing (not mapped)'}`,
    ...e.notes.map((n) => `- ${n}`),
    ...(e.missing?.length ? ['', `Missing in PostgreSQL: ${e.missing.join(', ')}`] : []),
  ].join('\n').slice(0, 20000);

/**
 * One open issue per component that needs hand work, in the application's workspace, labelled "APEX import".
 * Inside the import's transaction. Returns how many were made.
 */
export async function apexIssues(c: Queryable, report: ApexReport, o: { appId: number; alias: string; by: string }): Promise<number> {
  const work = handWork(report);
  if (!work.length) return 0;
  const ws = (await c.query('select meta.app_workspace($1::int) as ws', [o.appId])).rows[0]?.ws as number | undefined;
  if (!ws) return 0;
  const label = (await c.query(
    `insert into meta.team_label (workspace_id, name, color, description) values ($1, $2, 'orange', 'Components of an imported APEX application that need hand work')
     on conflict (workspace_id, lower(name)) do update set name = meta.team_label.name returning id`, [ws, APEX_LABEL])).rows[0].id;
  const add = async (t: string, b: string, page: number | null) => {
    const id = (await c.query(
      `insert into meta.team_issue (workspace_id, title, body, app_id, page_no, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [ws, t, b, o.appId, page, o.by])).rows[0].id;
    await c.query('insert into meta.team_issue_label (issue_id, label_id) values ($1, $2)', [id, label]);
  };
  for (const e of work.slice(0, MAX_ISSUES)) await add(title(e), body(e, o.alias), e.page !== null && e.page >= 0 ? e.page : null);
  if (work.length > MAX_ISSUES) {
    const rest = work.slice(MAX_ISSUES);
    await add(`APEX import: ${rest.length} more components need hand work`,
      [`From the APEX import of ${o.alias}. One issue each was made for the first ${MAX_ISSUES}; these are the rest:`, '',
        ...rest.map((e) => `- ${title(e)}: ${e.notes.join('; ')}`)].join('\n').slice(0, 20000), null);
  }
  return Math.min(work.length, MAX_ISSUES) + (work.length > MAX_ISSUES ? 1 : 0);
}
