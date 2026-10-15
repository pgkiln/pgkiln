// The Form Designer region (sprint 85, migration 106): administrators build data entry forms in the
// running application on the tables the developer offers. HR page 45 (examples/hr/hr_61_form_designer.sql)
// is the fixture: king is an administrator (a designer), allen and blake are not.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { checkFormDef, fdSourcesOf, formDefFromBody, type FdCol } from '../src/runtime/form-designer.ts';
import { mergeFormDesignerSettings } from '../src/builder/form-designer.ts';
import type { DbObject } from '../src/builder/reporter.ts';
import { replaceApp } from '../src/cli/replace.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let rid: number; // the Form Designer region on HR page 45
let appId: number;
const forms: Record<string, number> = {};

before(async () => {
  app = await buildApp({ logger: false });
  const r = await owner.one(`select r.id, p.app_id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                              where a.alias = 'hr' and p.page_no = 45 and r.type = 'form_designer'`);
  rid = r.id;
  appId = r.app_id;
  for (const f of (await owner.query('select id, name from meta.user_form where region_id = $1', [rid])).rows) forms[f.name] = f.id;
});

after(async () => {
  await owner.query(`delete from meta.user_form where region_id = $1 and name not in ('Departments', 'Book a meeting')`, [rid]);
  await owner.query(`delete from hr.dept where dname like 'FD %'`);
  await owner.query(`delete from hr.meeting where title like 'FD %'`);
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  return b;
}
const P = () => `fd${rid}_`;
const unescape = (s: string) => s.replace(/&amp;/g, '&');
const region = (body: string) => {
  const start = body.indexOf(`id="R${rid}"`);
  return body.slice(start, body.indexOf('</section>', start));
};
const flashOf = (body: string) => /class="alert[^"]*"[^>]*>([^<]*)</.exec(body)?.[1] ?? '';

describe('form designer definitions', () => {
  const source = fdSourcesOf({ config: { sources: [
    { id: 'dept', schema: 'hr', table: 'dept', key: 'deptno', columns: [{ name: 'dname' }, { name: 'loc', lov: 'select 1' }], update: true, delete: false },
    { id: 'sneaky', schema: 'meta', table: 'app', columns: [{ name: 'alias' }] },
    { id: 'Bad Id', schema: 'hr', table: 'dept', columns: [] },
  ] } });
  test('sources: never pgkiln\'s schema, valid ids only; a list of values is LOV:NAME or STATIC:…; changing and deleting need a key', () => {
    assert.deepEqual(source.map((s) => s.id), ['dept']);
    assert.equal(source[0].columns[1].lov, undefined, 'SQL is not a list of values here');
    assert.deepEqual([source[0].insert, source[0].update, source[0].delete], [true, true, false]);
    const nokey = fdSourcesOf({ config: { sources: [{ id: 'v', schema: 'hr', table: 'staff_v', columns: [{ name: 'ename' }], update: true, delete: true }] } })[0];
    assert.deepEqual([nokey.update, nokey.delete], [false, false]);
  });
  test('a definition keeps only offered columns, allowed displays and the source\'s actions', () => {
    const cols = new Map<string, FdCol>([
      ['dname', { name: 'dname', label: 'Dname', type: 25 }],
      ['job', { name: 'job', label: 'Job', type: 25, lov: 'LOV:JOBS' }],
      ['sal', { name: 'sal', label: 'Sal', type: 1700 }],
    ]);
    const def = checkFormDef({
      fields: [{ column: 'dname', display: 'textarea', required: true, label: 'x'.repeat(200) }, { column: 'job', display: 'textarea' }, { column: 'sal', display: 'radio' },
        { column: 'secret' }, { column: 'dname' }],
      list: ['dname', 'secret', 'sal'], actions: { insert: true, update: true, delete: true },
    }, source[0], cols, 'deptno');
    assert.deepEqual(def.fields.map((f) => [f.column, f.display]), [['dname', 'textarea'], ['job', 'select'], ['sal', 'auto']]);
    assert.equal(def.fields[0].label.length, 80);
    assert.deepEqual(def.list, ['dname', 'sal']);
    assert.deepEqual(def.actions, { insert: true, update: true, delete: false }, 'not more than the source allows');
    assert.deepEqual(checkFormDef(def, source[0], cols, null).actions, { insert: true, update: false, delete: false }, 'no key: only adding');
    assert.deepEqual(checkFormDef(def, source[0], cols, null).list, []);
  });
  test('the designer\'s form: the ticked columns in their order', () => {
    const d = formDefFromBody({ col_0: 'a', on_0: 'true', seq_0: '30', col_1: 'b', on_1: 'true', seq_1: '10', list_1: 'true', col_2: 'c', seq_2: '20', allow_insert: 'true' }, 's');
    assert.deepEqual(d.fields.map((f) => f.column), ['b', 'a']);
    assert.deepEqual(d.list, ['b']);
    assert.deepEqual(d.actions, { insert: true, update: false, delete: false });
  });
  test('the builder\'s settings: a new table with its primary key, adding and changing at first; lists of values of the application', async () => {
    const obj: DbObject = { oid: 1, schema: 'sales', table: 'orders', columns: [{ name: 'id', type: 'integer' }, { name: 'customer', type: 'text' }, { name: 'doc', type: 'jsonb' }] };
    const lookup = { byName: async () => obj, byOid: async () => obj, key: async () => 'id' };
    const a = { authz: new Set(['ADMIN']), lovs: new Set(['STATUS']) };
    const first = await mergeFormDesignerSettings({}, { new_object: '1', design_authz: 'ADMIN' }, a, lookup);
    assert.deepEqual(first.errors, []);
    assert.equal(first.config.design_authz, 'ADMIN');
    assert.deepEqual(first.config.sources, [{ id: 'orders', label: 'Orders', schema: 'sales', table: 'orders', key: 'id', insert: true, update: true, delete: false,
      columns: [{ name: 'id', label: 'Id' }, { name: 'customer', label: 'Customer' }] }]);
    const second = await mergeFormDesignerSettings(first.config, {
      s0_key: 'orders', s0_keycol: 'id', s0_insert: 'true', s0_delete: 'true',
      s0_col_0: 'id', s0_col_1: 'customer', s0_on_1: 'true', s0_lov_1: 'LOV:STATUS', s0_col_2: 'doc', s0_on_2: 'true', s0_lov_2: 'LOV:NOPE', design_authz: 'NOBODY',
    }, a, lookup);
    assert.equal(second.config.sources[0].columns[0].lov, 'LOV:STATUS');
    assert.deepEqual([second.config.sources[0].update, second.config.sources[0].delete], [false, true]);
    assert.match(second.errors.join(' '), /LOV:NOPE/);
    assert.match(second.errors.join(' '), /no authorization scheme NOBODY/);
    assert.equal(second.config.design_authz, undefined);
  });
});

describe('form designer at run time', () => {
  test('users see the published forms; designers also drafts, Design links and New form', async () => {
    const allen = region((await (await as('allen')).get('/a/hr/45')).body);
    assert.match(allen, />Book a meeting</);
    assert.match(allen, />Departments</);
    assert.doesNotMatch(allen, /New form|Design form/);
    await owner.query(`insert into meta.user_form (app_id, region_id, name, published, definition, created_by, updated_by)
                       values ($1, $2, 'FD draft', false, '{"source": "departments", "fields": [{"column": "dname"}]}', 'king', 'king')`, [appId, rid]);
    assert.doesNotMatch(region((await (await as('allen')).get('/a/hr/45')).body), /FD draft/);
    const king = region((await (await as('king')).get('/a/hr/45')).body);
    assert.match(king, /FD draft <span class="tag">Draft</);
    assert.match(king, /New form/);
    assert.match(king, new RegExp(`${P()}design=${forms.Departments}`));
    const draftId = (await owner.one(`select id from meta.user_form where region_id = $1 and name = 'FD draft'`, [rid])).id;
    assert.match(region((await (await as('allen')).get(`/a/hr/45?${P()}form=${draftId}`)).body), /does not exist/, 'a draft is not opened by its id');
  });

  test('a form with a list: add a row, edit it, a stale version is refused and the typed values come back', async () => {
    const b = await as('allen');
    const list = region((await b.get(`/a/hr/45?${P()}form=${forms.Departments}`)).body);
    assert.match(list, /<table class="report report-reflow fd-rows"/);
    assert.match(list, /ACCOUNTING/);
    const addHref = unescape(/href="([^"]*row=new[^"]*)"/.exec(list)![1]);
    const add = region((await b.get(addHref)).body);
    assert.match(add, /<input type="text" id="fdr\d+_0" name="c:dname" form="fdr\d+" value="" maxlength="4000" required>/);
    assert.match(add, /<small class="help" id="fdr\d+_1_help">The city.<\/small>/);
    // required: refused, the typed values come back
    let res = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(forms.Departments), row: '', version: '', mode: 'save', 'c:dname': '', 'c:loc': 'FD Delft' });
    assert.equal(res.statusCode, 303);
    let page = await b.get(res.headers.location as string);
    assert.match(region(page.body), /Department is required\./);
    assert.match(region(page.body), /name="c:loc" form="fdr\d+" value="FD Delft"/);
    // saved; back to the list
    res = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(forms.Departments), row: '', version: '', mode: 'save', 'c:dname': 'FD Research', 'c:loc': 'FD Delft', 'c:lat': '1' });
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.location as string, new RegExp(`${P()}form=${forms.Departments}$`));
    const row = await owner.one(`select deptno, loc, lat from hr.dept where dname = 'FD Research'`);
    assert.equal(row.loc, 'FD Delft');
    assert.equal(row.lat, null, 'a column that is not on the form is not written');
    page = await b.get(res.headers.location as string);
    assert.match(page.body, /Saved\./);
    assert.match(region(page.body), /FD Research/);
    // edit: the form shows the row; a save with its version changes it
    const editPage = (await b.get(`/a/hr/45?${P()}form=${forms.Departments}&${P()}row=${row.deptno}`)).body;
    const edit = region(editPage);
    // the version is in the row's (detached) form, outside the region
    const version = /name="version" value="([0-9a-f]{32})"/.exec(editPage)![1];
    assert.match(edit, /value="FD Research"/);
    assert.doesNotMatch(edit, /value="delete"/, 'the form does not delete');
    await owner.query(`update hr.dept set loc = 'FD Leiden' where deptno = $1`, [row.deptno]);
    res = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(forms.Departments), row: String(row.deptno), version, mode: 'save', 'c:dname': 'FD Research 2', 'c:loc': 'FD Delft' });
    page = await b.get(res.headers.location as string);
    assert.match(region(page.body), /Someone else changed this row in the meantime/);
    assert.match(region(page.body), /value="FD Research 2"/, 'what was typed is kept');
    assert.equal((await owner.one('select dname from hr.dept where deptno = $1', [row.deptno])).dname, 'FD Research');
    const fresh = /name="version" value="([0-9a-f]{32})"/.exec((await b.get(`/a/hr/45?${P()}form=${forms.Departments}&${P()}row=${row.deptno}`)).body)![1];
    res = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(forms.Departments), row: String(row.deptno), version: fresh, mode: 'save', 'c:dname': 'FD Research 2', 'c:loc': '' });
    assert.equal(res.statusCode, 303);
    const changed = await owner.one('select dname, loc from hr.dept where deptno = $1', [row.deptno]);
    assert.deepEqual([changed.dname, changed.loc], ['FD Research 2', null]);
    // deleting is not allowed by the form
    res = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(forms.Departments), row: String(row.deptno), mode: 'delete' });
    page = await b.get(res.headers.location as string);
    assert.match(page.body, /You may not do that with this row/);
    assert.ok(await owner.one('select 1 from hr.dept where deptno = $1', [row.deptno]));
  });

  test('a form without a list only adds rows: a timestamp, a checkbox; row level security still applies', async () => {
    const b = await as('allen');
    const page = region((await b.get(`/a/hr/45?${P()}form=${forms['Book a meeting']}`)).body);
    assert.match(page, /<input type="datetime-local" id="fdr\d+_1" name="c:starts_at"/);
    assert.match(page, /<input type="checkbox" id="fdr\d+_3" name="c:private" value="true" form="fdr\d+">/);
    const res = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(forms['Book a meeting']), row: '', mode: 'save', 'c:title': 'FD standup', 'c:starts_at': '2026-11-02T09:30', 'c:ends_at': '', 'c:private': 'true' });
    assert.match(res.headers.location as string, /row=new$/, 'back to an empty form for the next one');
    const m = await owner.one(`select id, organizer, starts_at::text as s, ends_at, private from hr.meeting where title = 'FD standup'`);
    assert.deepEqual([m.organizer, m.s, m.ends_at, m.private], ['allen', '2026-11-02 09:30:00', null, true]);
    // a designer's form that changes meetings: allen can't change king's meeting (row level security)
    await owner.query(`insert into hr.meeting (title, starts_at, organizer) values ('FD kings meeting', '2026-11-03 10:00', 'king')`);
    const kings = (await owner.one(`select id from hr.meeting where title = 'FD kings meeting'`)).id;
    const f = (await owner.one(`insert into meta.user_form (app_id, region_id, name, published, definition, created_by, updated_by)
      values ($1, $2, 'FD meetings', true, '{"source": "meetings", "fields": [{"column": "title"}], "list": ["title"], "actions": {"update": true, "delete": true}}', 'king', 'king') returning id`, [appId, rid])).id;
    const form = (await b.get(`/a/hr/45?${P()}form=${f}&${P()}row=${kings}`)).body;
    const version = /name="version" value="([0-9a-f]{32})"/.exec(form)![1];
    let r = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(f), row: String(kings), version, mode: 'save', 'c:title': 'FD taken over' });
    assert.match((await b.get(r.headers.location as string)).body, /You may not do that with this row/);
    r = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(f), row: String(kings), mode: 'delete' });
    assert.match((await b.get(r.headers.location as string)).body, /does not exist, or you may not see it/);
    assert.equal((await owner.one('select title from hr.meeting where id = $1', [kings])).title, 'FD kings meeting');
    // allen's own meeting: deleted
    r = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(f), row: String(m.id), mode: 'delete' });
    assert.match((await b.get(r.headers.location as string)).body, /Deleted\./);
    assert.equal(await owner.one('select 1 from hr.meeting where id = $1', [m.id]), undefined);
  });

  test('lists of values: a select list from the shared list; a value outside it is refused; dates in the date format', async () => {
    const f = (await owner.one(`insert into meta.user_form (app_id, region_id, name, published, definition, created_by, updated_by)
      values ($1, $2, 'FD employees', true, '{"source": "employees", "fields": [{"column": "job", "display": "radio"}, {"column": "deptno"}, {"column": "hiredate"}], "list": ["job"], "actions": {"insert": true, "update": true}}', 'king', 'king') returning id`, [appId, rid])).id;
    const b = await as('king');
    const scott = (await owner.one(`select empno, job, deptno, hiredate::text as h from hr.emp where ename = 'SCOTT'`));
    const form = region((await b.get(`/a/hr/45?${P()}form=${f}&${P()}row=${scott.empno}`)).body);
    assert.doesNotMatch((await b.get(`/a/hr/45?${P()}form=${f}`)).body, /row=new/, 'the source does not add employees');
    assert.match(form, /<input type="radio" id="fdr\d+_0_2" name="c:job" value="ANALYST" form="fdr\d+" checked>/);
    assert.match(form, /<select id="fdr\d+_1" name="c:deptno" form="fdr\d+"><option value="">- Choose -<\/option><option value="10">ACCOUNTING<\/option>/);
    assert.match(form, /data-date-pick="fdr\d+_2"/);
    const version = /name="version" value="([0-9a-f]{32})"/.exec((await b.get(`/a/hr/45?${P()}form=${f}&${P()}row=${scott.empno}`)).body)![1];
    let r = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(f), row: String(scott.empno), version, mode: 'save', 'c:job': 'CEO', 'c:deptno': '20', 'c:hiredate': scott.h });
    assert.match((await b.get(r.headers.location as string)).body, /Job: choose a value from the list/);
    const saved = (await owner.one(`select date_format from meta.app where id = $1`, [appId])).date_format;
    await owner.query(`update meta.app set date_format = 'DD-MM-YYYY' where id = $1`, [appId]);
    try {
      r = await b.submit(`/a/hr/45/formdesigner/${rid}/row`, { form: String(f), row: String(scott.empno), version, mode: 'save', 'c:job': 'ANALYST', 'c:deptno': '30', 'c:hiredate': '09-12-1982' });
      assert.match((await b.get(r.headers.location as string)).body, /Saved\./);
      const now = await owner.one(`select deptno, hiredate::text as h from hr.emp where empno = $1`, [scott.empno]);
      assert.deepEqual([now.deptno, now.h], [30, '1982-12-09']);
    } finally {
      await owner.query(`update meta.app set date_format = $2 where id = $1`, [appId, saved]);
      await owner.query(`update hr.emp set deptno = $2, hiredate = $3 where empno = $1`, [scott.empno, scott.deptno, scott.h]);
    }
  });

  test('designers save forms: a new one, a change, a delete; others may not', async () => {
    const king = await as('king');
    const design = region((await king.get(`/a/hr/45?${P()}design=new&${P()}src=departments`)).body);
    assert.match(design, /<table class="report report-reflow fd-fields">/);
    assert.match(design, /name="col_0" value="dname"/);
    let r = await king.submit(`/a/hr/45/formdesigner/${rid}/design`, {
      src: 'departments', name: 'FD Locations', description: 'Where we are', published: 'true', allow_insert: 'true', allow_delete: 'true',
      col_0: 'dname', seq_0: '20', on_0: 'true', col_1: 'loc', on_1: 'true', seq_1: '10', label_1: 'City', req_1: 'true', list_1: 'true', col_2: 'lat', on_2: 'true',
    });
    assert.equal(r.statusCode, 303);
    const row = await owner.one(`select id, published, definition, created_by from meta.user_form where region_id = $1 and name = 'FD Locations'`, [rid]);
    assert.equal(row.created_by, 'king');
    assert.equal(row.published, true);
    assert.deepEqual(row.definition.fields.map((f: any) => [f.column, f.label, f.required]), [['loc', 'City', true], ['dname', '', false]], 'lat is not offered');
    assert.deepEqual(row.definition.actions, { insert: true, update: false, delete: false }, 'the source does not delete');
    assert.match(r.headers.location as string, new RegExp(`${P()}form=${row.id}$`));
    // a name taken by another form
    r = await king.submit(`/a/hr/45/formdesigner/${rid}/design`, { src: 'departments', form: String(row.id), name: 'Departments', col_0: 'dname', on_0: 'true' });
    assert.match((await king.get(r.headers.location as string)).body, /There is already a form named &quot;Departments&quot;|There is already a form named "Departments"/);
    // allen may not design
    const allen = await as('allen');
    await allen.get('/a/hr/45');
    r = await allen.submit(`/a/hr/45/formdesigner/${rid}/design`, { src: 'departments', name: 'FD sneaky', col_0: 'dname', on_0: 'true' });
    assert.equal(r.statusCode, 403);
    r = await allen.submit(`/a/hr/45/formdesigner/${rid}/delete`, { form: String(row.id) });
    assert.equal(r.statusCode, 403);
    assert.doesNotMatch(region((await allen.get(`/a/hr/45?${P()}design=${row.id}`)).body), /fd-fields/, 'no designer for allen');
    // king deletes it
    await king.get('/a/hr/45');
    r = await king.submit(`/a/hr/45/formdesigner/${rid}/delete`, { form: String(row.id) });
    assert.match((await king.get(r.headers.location as string)).body, /Form deleted\./);
    assert.equal(await owner.one('select 1 from meta.user_form where id = $1', [row.id]), undefined);
  });
});

describe('form designer settings in the builder', () => {
  test('the region\'s Settings show the sources with their key, actions and lists of values; saving them as shown changes nothing', async () => {
    const pageId = (await owner.one('select page_id from meta.region where id = $1', [rid])).page_id;
    const before = (await owner.one('select config from meta.region where id = $1', [rid])).config;
    const dev = new Browser(app);
    await dev.get('/builder/login');
    await dev.submit('/builder/login', { username: 'admin', password: 'admin' });
    const page = (await dev.get(`/builder/pages/${pageId}?c=region-${rid}`)).body;
    assert.match(page, /Form Designer settings/);
    assert.match(page, /<option value="ADMIN" selected>Authorization: ADMIN<\/option>/);
    assert.match(page, /<option value="deptno" selected>deptno<\/option>/);
    assert.match(page, /name="s2_lov_\d+" maxlength="2000" value="LOV:JOBS"/);
    assert.match(page, /<datalist id="fds_\d+_lovs"><option value="LOV:DEPARTMENTS">/);
    // post the form as the page shows it
    const form = /<form method="post" action="[^"]*\/form-designer" class="component-form">([\s\S]*?)<\/form>/.exec(page)![1];
    const body: Record<string, string> = {};
    for (const m of form.matchAll(/<input(?=[^>]*\bname="([^"]+)")([^>]*)>/g)) {
      const type = /type="([^"]+)"/.exec(m[2])?.[1];
      if ((type === 'checkbox') && !/\bchecked\b/.test(m[2])) continue;
      body[m[1]] = (/value="([^"]*)"/.exec(m[2])?.[1] ?? '').replace(/&amp;/g, '&');
    }
    for (const m of form.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) body[m[1]] = /<option value="([^"]*)" selected>/.exec(m[2])?.[1] ?? '';
    delete body.__csrf;
    const res = await dev.submit(`/builder/pages/${pageId}/region/${rid}/form-designer`, body);
    assert.equal(res.statusCode, 303);
    try {
      // the offered columns come back in the table's order (their order means nothing: forms order their own fields)
      const byName = (cfg: any) => ({ ...cfg, sources: cfg.sources.map((s: any) => ({ ...s, columns: [...s.columns].sort((x: any, y: any) => x.name.localeCompare(y.name)) })) });
      assert.deepEqual(byName((await owner.one('select config from meta.region where id = $1', [rid])).config), byName(before));
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [rid, JSON.stringify(before)]);
    }
  });
});

describe('form designer export and replace', () => {
  test('the sources travel in the region\'s settings; forms stay with their region on replace', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    const reg = doc.pages.find((p: any) => p.page_no === 45).regions.find((r: any) => r.type === 'form_designer');
    assert.deepEqual(reg.config.sources.map((s: any) => s.id), ['departments', 'meetings', 'employees']);
    assert.doesNotMatch(JSON.stringify(doc), /Book a meeting/, 'forms are not exported');
    await owner.query(`delete from meta.app where alias = 'hr_fd_copy'`);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_fd_copy') as id`, [JSON.stringify(doc)])).id;
    try {
      const regionOf = async () => (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 45 and r.type = 'form_designer'`, [id])).id;
      const before = await regionOf();
      await owner.query(`insert into meta.user_form (app_id, region_id, name, definition, created_by, updated_by) values ($1, $2, 'Kept', '{"source": "departments"}', 'king', 'king')`, [id, before]);
      const c = await owner.pool.connect();
      try {
        await c.query('begin');
        await replaceApp(c, doc, 'hr_fd_copy');
        await c.query('commit');
      } finally {
        c.release();
      }
      const after = await regionOf();
      assert.notEqual(after, before);
      assert.equal((await owner.one(`select region_id from meta.user_form where app_id = $1 and name = 'Kept'`, [id])).region_id, after);
    } finally {
      await owner.query(`delete from meta.app where id = $1`, [id]);
    }
  });
});
