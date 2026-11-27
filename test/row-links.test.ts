// Sprint 238 (MG-6, MG-14; migration 194): a report's link columns and row actions, and inline dialog regions opened by
// their static id (a link to #<static id>, a redirect button's target_region, a process's or branch's open_region, and
// again after an error inside the dialog). HR page 66 shows them. (sprint 260) A link column "after" a report column.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { linkColumnsOf, reportRowActionsOf } from '../src/runtime/link-columns.ts';
import { advise } from '../src/builder/advisor.ts';
import type { Region } from '../src/metadata.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
const P: Record<number, number> = {};
const R: Record<string, number> = {};
const alias = 'ts-s238';

const region = async (page: number, title: string, o: Record<string, unknown>) => {
  const cols = { title, type: 'static', ...o };
  const keys = Object.keys(cols);
  return (await owner.one(`insert into meta.region (page_id, seq, ${keys.join(', ')}) values ($1, (select coalesce(max(seq), 0) + 10 from meta.region where page_id = $1), ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
    [P[page], ...Object.values(cols).map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))])).id as number;
};
const reg = (config: unknown) => ({ id: 1, config } as unknown as Region);
const decode = (v: string) => v.replace(/&amp;/g, '&');
/** The element with this id, as its opening tag. */
const tagOf = (body: string, id: string) => new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(body)?.[0] ?? '';

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`delete from meta.app where alias like 'ts-s238%'`);
  appId = (await owner.one(`insert into meta.app (alias, name, authentication, db_role) values ($1, 'Row links test', 'none', 'hr_app') returning id`, [alias])).id;
  for (const [no, mode, authz] of [[1, 'normal', null], [2, 'modal', null], [3, 'normal', null], [4, 'normal', 'ADMINS']] as const)
    P[no] = (await owner.one(`insert into meta.page (app_id, page_no, name, title, requires_auth, mode, authz, protection) values ($1, $2, $3, $3, false, $4, $5, 'checksum') returning id`,
      [appId, no, `Page ${no}`, mode, authz])).id;
  await owner.query(`insert into meta.authz_scheme (app_id, name, type, value) values ($1, 'ADMINS', 'role', 'admin')`, [appId]);
  R.report = await region(1, 'Depts', {
    type: 'report', static_id: 'depts',
    source: `select d.deptno, d.dname, d.loc, d.deptno in (10, 20) as busy from hr.dept d where d.deptno in (10, 20, 30) order by d.deptno`,
    config: {
      hidden: ['busy'],
      link_columns: [
        { label: 'Edit #dname#', heading: 'Edit', page: 2, items: { P2_ID: '#deptno#' }, style: 'icon', icon: 'edit', position: 'start' },
        { label: 'Open', page: 3, items: { P3_ID: '#deptno#', P3_NAME: '#dname#' }, style: 'button', when: 'busy' },
        { label: 'Main', page: 3, items: { P3_ID: '#deptno#' }, style: 'hot' },
        { label: 'Remove', page: 3, style: 'danger' },
        { label: 'Secret', page: 4, items: { P4_ID: '#deptno#' } },
      ],
      row_actions: { edit: { page: 2, items: { P2_ID: '#deptno#' } }, links: [{ label: 'More on #dname#', page: 3, items: { P3_ID: '#deptno#' } }, { label: 'Hidden', page: 4 }] },
    },
  });
  R.classic = await region(1, 'Classic', {
    type: 'classic_report', source: `select deptno, dname from hr.dept where deptno = 10`,
    config: { link_columns: [{ label: 'Go', page: 3, items: { P3_ID: '#deptno#' } }] },
  });
  R.media = await region(1, 'Media', {
    type: 'classic_report', source: `select dname as title, loc as description, deptno from hr.dept where deptno = 10`,
    config: { report_template: 'media_list', hidden: ['deptno'], link_columns: [{ label: 'Edit', page: 3, items: { P3_ID: '#deptno#' }, style: 'button' }] },
  });
  R.mid = await region(1, 'Placed', {
    type: 'classic_report', source: `select deptno, dname, loc, 'x' as gone from hr.dept where deptno in (10, 20) order by deptno`,
    config: { hidden: ['gone'], link_columns: [
      { label: 'Last', page: 3 },
      { label: 'Qty', page: 3, items: { P3_ID: '#deptno#' }, style: 'button', after: 'DNAME' },
      { label: 'Nowhere', page: 3, after: 'no_such_column' },
      { label: 'Of hidden', page: 3, after: 'gone', position: 'start' },
    ] },
  });
  R.intro = await region(1, 'Intro', { source: '<p><a href="#note">Add a note</a></p>' });
  R.note = await region(1, 'Note', { template: 'inline_dialog', static_id: 'note', source: '<p>Write it.</p>' });
  R.kept = await region(1, 'Kept', { template: 'inline_dialog', static_id: 'kept', source: '<p>Kept: &P1_LAST.</p>' });
  R.plain = await region(1, 'Plain', { static_id: 'plain', source: '<p>plain</p>' });
  R.links = await region(1, 'Links', { type: 'list', config: { list: 'S238' } });
  await owner.query(`insert into meta.list (app_id, name, type) values ($1, 'S238', 'static')`, [appId]);
  await owner.query(`insert into meta.list_entry (app_id, list_name, seq, label, target_url) values ($1, 'S238', 10, 'Open the note', '#note'), ($1, 'S238', 20, 'Elsewhere', '#nowhere')`, [appId]);
  await owner.query(`insert into meta.item (page_id, region_id, seq, name, label, type, required) values
    ($1, $2, 10, 'P1_NOTE', 'Note', 'textarea', true), ($1, $3, 10, 'P1_LAST', null, 'hidden', false), ($1, $4, 10, 'P1_OTHER', 'Other', 'text', false)`,
  [P[1], R.note, R.intro, R.plain]);
  await owner.query(`insert into meta.item (page_id, seq, name, label, type) values ($1, 10, 'P2_ID', 'Id', 'text'), ($2, 10, 'P3_ID', 'Id', 'text'), ($2, 20, 'P3_NAME', 'Name', 'text'), ($3, 10, 'P4_ID', 'Id', 'text')`,
    [P[2], P[3], P[4]]);
  await owner.query(`insert into meta.region (page_id, seq, title, type, template, static_id, source) values ($1, 10, 'Welcome', 'static', 'inline_dialog', 'welcome', '<p>Hi</p>'),
    ($1, 20, 'Body', 'static', 'standard', null, '<p>[&P3_ID.|&P3_NAME.]</p>')`, [P[3]]);
  await owner.query(`insert into meta.button (page_id, region_id, seq, name, label, action, hot, target_region, target_page) values
    ($1, $2, 10, 'ADD', 'Add a note', 'redirect', false, 'note', null),
    ($1, $2, 20, 'WELCOME', 'Welcome', 'redirect', false, 'welcome', 3),
    ($1, $3, 30, 'SAVE_ANOTHER', 'Save and add another', 'submit', false, null, null),
    ($1, $3, 40, 'SAVE', 'Save', 'submit', true, null, null),
    ($1, $4, 50, 'PLAIN', 'Plain save', 'submit', false, null, null)`, [P[1], R.intro, R.note, R.plain]);
  await owner.query(`insert into meta.process (page_id, seq, name, type, code, point, when_button, config, open_region) values
    ($1, 10, 'Keep', 'sql', 'select :P1_NOTE as p1_last', 'submit', 'SAVE', '{}', null),
    ($1, 20, 'Another', 'clear_session_state', null, 'submit', 'SAVE_ANOTHER', '{"items": ["P1_NOTE"]}', 'note')`, [P[1]]);
  await owner.query(`insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_page, open_region) values
    ($1, 10, 'Show it', 'after_processing', 'SAVE', 'page', 1, 'kept')`, [P[1]]);
});

after(async () => {
  await owner.query(`delete from meta.app where alias like 'ts-s238%'`);
  await app.close();
  await closePools();
});

describe('link columns and row actions: the settings', () => {
  test('link_columns: checked, with defaults; entries without a label or a page are left out; at most 10', () => {
    const cols = linkColumnsOf(reg({ link_columns: [
      { label: 'Edit #name#', page: 3, items: { P3_ID: '#id#', bad: { x: 1 } } },
      { label: 'Icon only', page: '4', style: 'icon' },
      { label: 'Odd', page: 3, style: 'weird', icon: 'not-an-icon', position: 'middle', when: 'drop table x', after: 'x; drop' },
      { label: '', page: 3 }, { label: 'No page' }, { label: 'Bad page', page: 'javascript:alert(1)' }, { label: 'Zero', page: 0 }, null, 'x',
    ] }));
    assert.equal(cols.length, 3);
    assert.deepEqual(cols[0], { label: 'Edit #name#', page: 3, items: { P3_ID: '#id#' }, style: 'link', icon: null, heading: 'Edit', position: 'end', after: null, when: null });
    assert.equal(cols[1].style, 'link', 'icon style without an icon is a link');
    assert.equal(cols[1].page, 4);
    assert.deepEqual([cols[2].style, cols[2].icon, cols[2].position, cols[2].when, cols[2].after], ['link', null, 'end', null, null]);
    assert.equal(linkColumnsOf(reg({ link_columns: [{ label: 'Q', page: 1, after: 'Amount' }] }))[0].after, 'amount');
    assert.equal(linkColumnsOf(reg({ link_columns: Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, page: 1 })) })).length, 10);
    assert.deepEqual(linkColumnsOf(reg({ link_columns: { label: 'x', page: 1 } })), []);
  });

  test('row_actions of a report: edit and links (no duplicate or delete)', () => {
    assert.equal(reportRowActionsOf(reg({})), null);
    assert.equal(reportRowActionsOf(reg({ row_actions: { duplicate: true, delete: true } })), null);
    const ra = reportRowActionsOf(reg({ row_actions: { edit: { page: 3, items: { P3_ID: '#id#' } }, links: [{ label: 'A', page: 4 }, { page: 5 }, { label: 'B', page: 'x' }] } }))!;
    assert.deepEqual(ra, { edit: { label: null, page: 3, items: { P3_ID: '#id#' } }, links: [{ label: 'A', page: 4, items: {} }] });
  });
});

describe('a report with link columns', () => {
  let body = '';
  before(async () => {
    const res = await new Browser(app).get(`/a/${alias}/1`);
    assert.equal(res.statusCode, 200);
    body = res.body;
  });
  const reportHtml = () => body.slice(body.indexOf(`id="R${R.report}"`), body.indexOf(`id="R${R.classic}"`));

  test('the columns: row actions and start columns before the report\'s own, the others after', () => {
    const head = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(reportHtml())![1];
    const ths = [...head.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)].map((m) => (/class="([^"]*)"/.exec(m[1])?.[1] ?? '') + ':' + (/aria-label="([^"]*)"/.exec(m[1])?.[1] ?? m[2].replace(/<[^>]+>/g, '').replace(/[▲▼]/g, '').trim()));
    assert.deepEqual(ths.filter((x) => /row-actions|link-col/.test(x)), ['row-actions:Row actions', 'link-col:Edit', 'link-col:Open', 'link-col:Main', 'link-col:Remove']);
    assert.ok(ths.indexOf('link-col:Edit') < ths.findIndex((x) => /deptno/i.test(x)), 'the start column comes first');
    assert.ok(ths.indexOf('link-col:Open') > ths.findIndex((x) => /loc/i.test(x)), 'the end columns come last');
    assert.doesNotMatch(head, /Secret/, 'a link to a page the user may not open has no column');
  });

  test('"after": a link column right after that report column; after a hidden or unknown column it goes by position', () => {
    const html = body.slice(body.indexOf(`id="R${R.mid}"`), body.indexOf(`id="R${R.intro}"`));
    const head = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(html)![1];
    const ths = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/[▲▼]/g, '').trim().toLowerCase());
    assert.deepEqual(ths, ['of hidden', 'deptno', 'dname', 'qty', 'loc', 'last', 'nowhere']);
    const row = html.split('<tr').find((r) => /ACCOUNTING/.test(r))!;
    const cells = [...row.matchAll(/<td\b[^>]*data-label="([^"]*)"/g)].map((m) => m[1].toLowerCase());
    assert.deepEqual(cells, ['of hidden', 'deptno', 'dname', 'qty', 'loc', 'last', 'nowhere']);
    assert.match(row, /data-label="Qty"><a [^>]*class="btn btn-small"[^>]*>Qty<\/a>/);
  });

  test('each style; #column# in labels and items; signed links; a modal target opens as a dialog', () => {
    const html = reportHtml();
    const edit = /<a href="([^"]+)" data-dialog class="link-icon" aria-label="Edit ACCOUNTING" title="Edit ACCOUNTING">/.exec(html);
    assert.ok(edit, 'an icon link with its label as the accessible name, as a dialog (page 2 is modal)');
    assert.match(decode(edit[1]), new RegExp(`^/a/${alias}/2\\?P2_ID=10&cs=[0-9a-f]+$`));
    assert.match(html, /<a href="[^"]+P3_ID=10&amp;P3_NAME=ACCOUNTING[^"]*" class="btn btn-small">Open<\/a>/);
    assert.match(html, /class="btn btn-small btn-hot">Main<\/a>/);
    assert.match(html, /class="btn btn-small btn-danger">Remove<\/a>/);
    assert.doesNotMatch(html, /Secret|P4_ID/, 'no link to a page the user may not open');
  });

  test('"when": the link shows only in rows where the column is true', () => {
    const rows = reportHtml().split('<tr').filter((r) => /data-label/.test(r));
    const sales = rows.find((r) => /SALES/.test(r))!;
    const research = rows.find((r) => /RESEARCH/.test(r))!;
    assert.match(research, />Open<\/a>/);
    assert.doesNotMatch(sales, />Open<\/a>/);
    assert.match(sales, /<td class="link-col link-col-button" data-label="Open"><\/td>/, 'an empty cell keeps the columns in line');
    assert.match(sales, />Main<\/a>/);
  });

  test('row actions: the ⋮ menu with Edit and the links the user may open', () => {
    const html = reportHtml();
    assert.match(html, /<td class="row-actions" data-label="Row actions"><details class="menu row-menu">/);
    assert.match(html, /aria-label="Actions for row 1"/);
    assert.match(html, /<a href="\/a\/ts-s238\/2\?P2_ID=10&amp;cs=[0-9a-f]+" data-dialog>[\s\S]*?Edit<\/a>/);
    assert.match(html, />More on SALES<\/a>/);
    assert.doesNotMatch(html, />Hidden</);
  });

  test('a classic report: a link column in the table, and links under each row of a media list', () => {
    const classic = body.slice(body.indexOf(`id="R${R.classic}"`), body.indexOf(`id="R${R.media}"`));
    assert.match(classic, /<td class="link-col link-col-link" data-label="Go"><a href="\/a\/ts-s238\/3\?P3_ID=10&amp;cs=[0-9a-f]+">Go<\/a><\/td>/);
    const media = body.slice(body.indexOf(`id="R${R.media}"`), body.indexOf(`id="R${R.intro}"`));
    assert.match(media, /<ul class="cr-media"><li>[\s\S]*<span class="cr-links"><a href="\/a\/ts-s238\/3\?P3_ID=10&amp;cs=[0-9a-f]+" class="btn btn-small">Edit<\/a><\/span><\/li>/);
  });

  test('a classic report with value pairs: the links in each row\'s list', async () => {
    await owner.query(`update meta.region set config = config || '{"report_template": "value_pairs"}' where id = $1`, [R.classic]);
    try {
      const page = (await new Browser(app).get(`/a/${alias}/1`)).body;
      const classic = page.slice(page.indexOf(`id="R${R.classic}"`), page.indexOf(`id="R${R.media}"`));
      assert.match(classic, /<dl><dt>[\s\S]*<dd class="cr-pairs-links"><span class="cr-links"><a href="\/a\/ts-s238\/3\?P3_ID=10&amp;cs=[0-9a-f]+">Go<\/a><\/span><\/dd><\/dl>/);
    } finally {
      await owner.query(`update meta.region set config = config - 'report_template' where id = $1`, [R.classic]);
    }
  });

  test('following a link sets the target page\'s items', async () => {
    const b = new Browser(app);
    const page = (await b.get(`/a/${alias}/1`)).body;
    const href = decode(/href="(\/a\/ts-s238\/3\?P3_ID=20&amp;P3_NAME=RESEARCH[^"]*)"/.exec(page)![1]);
    const res = await b.get(href);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\[20\|RESEARCH\]/);
  });

  test('the other views and downloads have no link columns', async () => {
    const csv = await new Browser(app).get(`/a/${alias}/1?r${R.report}_csv=1`);
    assert.equal(csv.statusCode, 200);
    assert.doesNotMatch(csv.body, /Open|Main|Remove/);
  });
});

describe('inline dialogs by static id', () => {
  test('a redirect button with target_region: #R<id> on this page, the target page\'s link with #<static id> on another', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(body, new RegExp(`<a class="btn" href="#R${R.note}">Add a note</a>`));
    assert.match(body, /<a class="btn" href="\/a\/ts-s238\/3\?clear=1#welcome">Welcome<\/a>/);
    assert.match(body, /<a href="#note">Add a note<\/a>/, 'a link in static content stays as written (app.js opens it)');
  });

  test('a list entry with the URL #<static id>: the region of this page, else as written', async () => {
    const body = (await new Browser(app).get(`/a/${alias}/1`)).body;
    assert.match(body, new RegExp(`href="#R${R.note}"[^>]*>[\\s\\S]{0,200}Open the note`));
    assert.match(body, /href="#nowhere"/);
  });

  test('an error inside the dialog (a required item) shows the page again with the dialog open', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { __request: 'SAVE', P1_NOTE: '' });
    assert.equal(res.statusCode, 422);
    assert.match(tagOf(res.body, `R${R.note}`), /^<dialog [^>]*data-inline-region open data-open-region>$/);
    assert.doesNotMatch(tagOf(res.body, `R${R.kept}`), /open/);
  });

  test('an error outside any dialog leaves the dialogs closed; the pressed button inside one opens it', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    // the note is required: the error is on P1_NOTE, inside the dialog, even when a button outside was pressed
    let res = await b.submit(`/a/${alias}/1`, { __request: 'PLAIN', P1_NOTE: '', P1_OTHER: 'x' });
    assert.equal(res.statusCode, 422);
    assert.match(tagOf(res.body, `R${R.note}`), /data-open-region/);
    await owner.query(`update meta.item set required = false where page_id = $1 and name = 'P1_NOTE'`, [P[1]]);
    await owner.query(`insert into meta.validation (page_id, seq, name, type, expression, message, item_name) values ($1, 10, 'Other', 'not_null', 'P1_OTHER', 'Other is needed.', 'P1_OTHER')`, [P[1]]);
    try {
      await b.get(`/a/${alias}/1`);
      res = await b.submit(`/a/${alias}/1`, { __request: 'PLAIN', P1_NOTE: 'n', P1_OTHER: '' });
      assert.equal(res.statusCode, 422);
      assert.doesNotMatch(tagOf(res.body, `R${R.note}`), /open/, 'the error is outside the dialog');
      await b.get(`/a/${alias}/1`);
      res = await b.submit(`/a/${alias}/1`, { __request: 'SAVE', P1_NOTE: 'n', P1_OTHER: '' });
      assert.equal(res.statusCode, 422);
      assert.match(tagOf(res.body, `R${R.note}`), /data-open-region/, 'the button pressed is in the dialog');
    } finally {
      await owner.query(`delete from meta.validation where page_id = $1`, [P[1]]);
      await owner.query(`update meta.item set required = true where page_id = $1 and name = 'P1_NOTE'`, [P[1]]);
    }
  });

  test('a process with open_region: the page that comes back opens the dialog, once', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { __request: 'SAVE_ANOTHER', P1_NOTE: 'first' });
    assert.equal(res.statusCode, 303);
    const back = (await b.get(res.headers.location as string)).body;
    assert.match(tagOf(back, `R${R.note}`), /data-open-region/);
    assert.doesNotMatch(tagOf(back, `R${R.kept}`), /open/);
    assert.doesNotMatch(tagOf((await b.get(`/a/${alias}/1`)).body, `R${R.note}`), /open/, 'only the page that comes back');
  });

  test('a branch with open_region: its target page opens that dialog (the branch\'s wins)', async () => {
    const b = new Browser(app);
    await b.get(`/a/${alias}/1`);
    const res = await b.submit(`/a/${alias}/1`, { __request: 'SAVE', P1_NOTE: 'my note' });
    assert.equal(res.statusCode, 303);
    const back = (await b.get(res.headers.location as string)).body;
    assert.match(tagOf(back, `R${R.kept}`), /data-open-region/);
    assert.doesNotMatch(tagOf(back, `R${R.note}`), /open/);
    assert.match(back, /Kept: my note/);
  });

  test('open_region naming a region that is no inline dialog, or none on the page: nothing opens', async () => {
    await owner.query(`update meta.process set open_region = 'plain' where page_id = $1 and name = 'Another'`, [P[1]]);
    try {
      const b = new Browser(app);
      await b.get(`/a/${alias}/1`);
      const res = await b.submit(`/a/${alias}/1`, { __request: 'SAVE_ANOTHER', P1_NOTE: 'x' });
      const back = (await b.get(res.headers.location as string)).body;
      assert.doesNotMatch(back, /data-open-region/);
    } finally {
      await owner.query(`update meta.process set open_region = 'note' where page_id = $1 and name = 'Another'`, [P[1]]);
    }
  });
});

describe('export, import and the Advisor', () => {
  test('the export carries target_region, open_region and link_columns, and an import keeps them', async () => {
    const doc = (await owner.one(`select meta.export_app($1) as d`, [alias])).d;
    const p1 = doc.pages.find((p: any) => p.page_no === 1);
    assert.equal(p1.buttons.find((b: any) => b.name === 'ADD').target_region, 'note');
    assert.equal(p1.processes.find((p: any) => p.name === 'Another').open_region, 'note');
    assert.equal(p1.branches[0].open_region, 'kept');
    assert.equal(p1.regions.find((r: any) => r.static_id === 'depts').config.link_columns.length, 5);
    await owner.query(`delete from meta.app where alias = 'ts-s238-copy'`);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s238-copy') as id`, [JSON.stringify(doc)])).id;
    const copy = await owner.one(`select b.target_region, (select open_region from meta.branch x where x.page_id = p.id) as branch_region
      from meta.page p join meta.button b on b.page_id = p.id and b.name = 'WELCOME' where p.app_id = $1 and p.page_no = 1`, [id]);
    assert.deepEqual(copy, { target_region: 'welcome', branch_region: 'kept' });
    await owner.query(`delete from meta.app where id = $1`, [id]);
  });

  test('an export from before 194 imports (no target_region or open_region keys)', async () => {
    const doc = (await owner.one(`select meta.export_app($1) as d`, [alias])).d;
    for (const p of doc.pages) {
      for (const b of p.buttons) delete b.target_region;
      for (const x of p.processes) delete x.open_region;
      for (const x of p.branches) delete x.open_region;
    }
    await owner.query(`delete from meta.app where alias = 'ts-s238-old'`);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'ts-s238-old') as id`, [JSON.stringify(doc)])).id;
    assert.equal((await owner.one(`select count(*)::int as n from meta.button b join meta.page p on p.id = b.page_id where p.app_id = $1 and b.target_region is not null`, [id])).n, 0);
    await owner.query(`delete from meta.app where id = $1`, [id]);
  });

  test('the Advisor: a link column to a missing page, and a static id no inline dialog has', async () => {
    await owner.query(`update meta.button set target_region = 'gone' where page_id = $1 and name = 'ADD'`, [P[1]]);
    await owner.query(`update meta.region set config = config || '{"row_actions": {"edit": {"page": 99}}}' where id = $1`, [R.classic]);
    try {
      const { findings } = await advise(appId);
      assert.ok(findings.some((f) => /no inline dialog or drawer region with static ID gone/.test(f.message)), 'the button');
      assert.ok(findings.some((f) => /goes to page 99/.test(f.message)), 'the row action');
      assert.ok(!findings.some((f) => /static ID (note|kept|welcome)\b/.test(f.message)), 'the others are found (also on another page)');
    } finally {
      await owner.query(`update meta.button set target_region = 'note' where page_id = $1 and name = 'ADD'`, [P[1]]);
      await owner.query(`update meta.region set config = config - 'row_actions' where id = $1`, [R.classic]);
    }
  });
});
