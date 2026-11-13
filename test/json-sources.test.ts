// Sprint 142 (AP-8): JSON sources and document views (migration 142).
// A data profile proposed from sample documents; the views a source makes (typed columns, arrays as rows);
// writing through them changes only the changed paths, so unknown keys stay; arrays keep their element keys while
// other elements change; a document view writes a row and its children; JSON path columns in reports; the builder's
// pages (Shared Components → JSON sources, Table Properties › Document view), HR page 51 and the export.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import {
  documentViewDdl, jsonColumnsText, jsonSourceDdl, jsonSourceProblems, parseJsonColumns, proposeProfile, withJsonColumns, type JsonSource,
} from '../src/json-sources.ts';
import { Browser, formFields, gridForm } from './helpers.ts';

let app: FastifyInstance;
let hr: number;
const sectionOf = (body: string, id: number) => {
  const i = body.indexOf(`id="R${id}"`);
  return i < 0 ? '' : body.slice(i, body.indexOf('</section>', i) + 10);
};

async function builder() {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' })).statusCode, 303);
  await b.ownerConnection(); // (sprint 185) the owner's schemas: the Owner connection
  await b.get('/builder/home');
  return b;
}

const SOURCE: JsonSource = {
  name: 'T142_DOCS', schema: 'hr', table: 't142_doc', key: ['id'], column: 'doc', view: 't142_doc_v', rows: true,
  columns: [{ name: 'title', path: ['title'], type: 'text' }, { name: 'n', path: ['a', 'n'], type: 'integer' }],
  arrays: [{ name: 'tags', path: ['tags'], view: 't142_doc_tags', columns: [{ name: 'tag', path: [], type: 'text' }] }],
};

async function cleanup() {
  await owner.query('drop table if exists hr.t142_doc, hr.t142_child, hr.t142_parent cascade');
  await owner.query(`update meta.app set json_sources = coalesce((select jsonb_agg(e) from jsonb_array_elements(json_sources) e where e->>'name' like 'T142%' is not true), '[]') where id = $1`, [hr]);
  await owner.query(`delete from meta.page where app_id = $1 and page_no in (9142, 9143)`, [hr]);
}

before(async () => {
  app = await buildApp({ logger: false });
  hr = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  await cleanup();
});

after(async () => {
  await cleanup();
  await app.close();
  await closePools();
});

describe('data profiles and DDL', () => {
  test('a profile proposed from documents: types, nested objects flattened, arrays of objects and of values', () => {
    const p = proposeProfile([
      { title: 'A', since: '2020-01-02', office: { city: 'X', floor: 3 }, score: 1.5, remote: true, skills: [{ name: 'sql', level: 3 }], langs: ['en'] },
      { title: 'B', since: '2021-02-03', office: { city: 'Y', floor: 4 }, score: 2, remote: false, at: '2024-01-02T10:00:00Z', skills: [{ name: 'ts', level: 2, extra: 'x' }] },
      { title: 'C', mixed: 1 }, { mixed: 'one' },
    ], { key: ['id'], view: 'p_v' });
    const types = Object.fromEntries(p.columns.map((c) => [c.name, [c.path.join('.'), c.type]]));
    assert.deepEqual(types.title, ['title', 'text']);
    assert.deepEqual(types.since, ['since', 'date']);
    assert.deepEqual(types.office_city, ['office.city', 'text']);
    assert.deepEqual(types.office_floor, ['office.floor', 'integer']);
    assert.deepEqual(types.score, ['score', 'numeric']);
    assert.deepEqual(types.remote, ['remote', 'boolean']);
    assert.deepEqual(types.at, ['at', 'timestamptz']);
    assert.deepEqual(types.mixed, ['mixed', 'text']);
    const skills = p.arrays.find((a) => a.name === 'skills')!;
    assert.equal(skills.view, 'p_v_skills');
    assert.deepEqual(skills.columns.map((c) => `${c.name}:${c.type}`), ['name:text', 'level:integer', 'extra:text']);
    assert.deepEqual(p.arrays.find((a) => a.name === 'langs')!.columns, [{ name: 'value', path: [], type: 'text' }]);
    // the proposal passes the checks
    assert.deepEqual(jsonSourceProblems({ name: 'P', schema: 's', table: 't', key: ['id'], column: 'd', view: 'p_v', ...p }), []);
  });

  test('the checks: names, paths, types, keys, the columns a view adds itself', () => {
    const bad = jsonSourceProblems({
      ...SOURCE, name: 'lower', view: 'Bad View', key: [],
      columns: [{ name: 'id', path: ['x'], type: 'text' }, { name: 'x"y', path: [], type: 'text' }, { name: 'z', path: ['z'], type: 'money' as never }],
      arrays: [{ name: 'tags', path: ['tags'], view: 'tv', columns: [{ name: 'row_key', path: [], type: 'text' }] }, { name: 'more', path: ['more'], view: 'tv', columns: [] }],
    });
    for (const re of [/static ID/, /view name/, /primary key/, /column name "x"y"/, /at least one key/, /the type is one of/, /used twice/, /row_key/])
      assert.ok(bad.some((p) => re.test(p)), `${re}: ${bad.join(' | ')}`);
    assert.deepEqual(jsonSourceProblems(SOURCE), []);
  });

  test('the DDL: security_invoker views, the INSTEAD OF triggers with the description, the table\'s grants, literals quoted', () => {
    const ddl = jsonSourceDdl({ ...SOURCE, columns: [...SOURCE.columns, { name: 'odd', path: ["it's"], type: 'date' }] }, { app: 'hr', grants: [{ grantee: 'hr_app', privileges: ['select', 'update'] }, { grantee: 'PUBLIC', privileges: ['select'] }], replace: true });
    assert.match(ddl[0], /^drop view if exists hr\.t142_doc_tags/);
    const view = ddl.find((d) => d.startsWith('create view hr.t142_doc_v '))!;
    assert.match(view, /with \(security_invoker = true\)/);
    assert.match(view, /case when meta\.input_ok\(t\.doc #>> array\['a', 'n'\], 'integer'\) then \(t\.doc #>> array\['a', 'n'\]\)::integer end as n/);
    assert.match(view, /array\['it''s'\]/);
    assert.ok(ddl.some((d) => /instead of insert or update or delete on hr\.t142_doc_v\s+for each row execute function meta\.json_source_write\('\{"name":"T142_DOCS"/.test(d)));
    assert.ok(ddl.some((d) => /meta\.json_array_write\('\{.*"array":\["tags"\]/.test(d)));
    assert.ok(ddl.includes('grant select, update on hr.t142_doc_v to "hr_app"'));
    assert.ok(ddl.includes('grant select on hr.t142_doc_tags to public'));
  });

  test('JSON path columns: parsed from the settings, added to the report source, paths as literals', () => {
    const cols = parseJsonColumns(`city=profile:office.city; first=profile:skills.0.name:text; since = profile : since : date; bad name=x:y; x=profile:a:money`);
    assert.deepEqual(cols.map((c) => `${c.name}/${c.column}/${c.path}/${c.type}`), ['city/profile/office.city/text', 'first/profile/skills.0.name/text', 'since/profile/since/date', 'x/profile/a/text']);
    assert.equal(jsonColumnsText(cols), 'city=profile:office.city; first=profile:skills.0.name; since=profile:since:date; x=profile:a');
    const sql = withJsonColumns({ config: { json_columns: [...cols, { name: 'evil', column: 'profile', path: "a'); drop table hr.emp; --" }, { name: 'Bad-Name', column: 'p', path: 'a' }] } }, 'select * from t');
    assert.match(sql, /^select "__j"\.\*, "__j"\."profile"::jsonb #>> array\['office', 'city'\] as "city"/);
    assert.match(sql, /array\['a''\); drop table hr', ' drop table hr'|array\['a''\); drop table hr', 'emp; --'\]/);
    assert.doesNotMatch(sql, /Bad-Name/);
    assert.equal(withJsonColumns({ config: {} }, 'select 1'), 'select 1');
  });

  test('a document view: the row with its children, without their foreign key and full-text columns', () => {
    const ddl = documentViewDdl({ schema: 'hr', table: 'dept', key: ['deptno'], view: 'dept_doc', document: 'doc', omit: ['search'],
      children: [{ name: 'emp', schema: 'hr', table: 'emp', key: ['empno'], fk: [['deptno', 'deptno']], omit: ['photo'] }], grants: [] });
    assert.match(ddl[0], /\(to_jsonb\(t\) - 'search'\) \|\| jsonb_build_object\(\s+'emp', coalesce\(\(select jsonb_agg\(to_jsonb\(c1\) - 'deptno' - 'photo' order by c1\.empno\) from hr\.emp c1 where c1\.deptno = t\.deptno\), '\[\]'::jsonb\)\) as doc/);
    assert.match(ddl[2], /meta\.json_document_write\('\{"schema":"hr","table":"dept","key":\["deptno"\],"document":"doc","children":\[\{"name":"emp"/);
  });
});

describe('writing through the views (migration 142)', () => {
  before(async () => {
    await owner.query('create table hr.t142_doc (id int generated by default as identity primary key, doc jsonb)');
    await owner.query(`insert into hr.t142_doc (id, doc) overriding system value values
      (1, '{"title": "one", "a": {"n": 1, "keep": true}, "tags": ["x", "y", "x"], "secret": 42}'), (2, null), (3, '{"a": {"n": "not a number"}}')`);
    await owner.query(`select setval(pg_get_serial_sequence('hr.t142_doc', 'id'), 10)`);
    for (const d of jsonSourceDdl(SOURCE, { app: 'hr', grants: [], replace: false })) await owner.query(d);
  });

  test('reads: typed columns, a value of another type is NULL, arrays as rows with stable keys', async () => {
    const rows = (await owner.query('select id, title, n from hr.t142_doc_v order by id')).rows;
    assert.deepEqual(rows, [{ id: 1, title: 'one', n: 1 }, { id: 2, title: null, n: null }, { id: 3, title: null, n: null }]);
    const tags = (await owner.query('select id, position, tag, row_key from hr.t142_doc_tags order by position')).rows;
    assert.deepEqual(tags.map((t) => `${t.position}:${t.tag}`), ['1:x', '2:y', '3:x']);
    assert.match(tags[0].row_key, /^[0-9a-f]{32}\.1$/);
    assert.equal(tags[2].row_key, tags[0].row_key.replace(/\.1$/, '.2'), 'equal elements count their occurrences');
  });

  test('an update changes only the changed paths: unknown keys stay; NULL removes a key; nested objects are made', async () => {
    await owner.query(`update hr.t142_doc_v set title = 'One', n = 5 where id = 1`);
    assert.deepEqual((await owner.one('select doc from hr.t142_doc where id = 1')).doc, { title: 'One', a: { n: 5, keep: true }, tags: ['x', 'y', 'x'], secret: 42 });
    await owner.query(`update hr.t142_doc_v set title = null where id = 1`);
    assert.equal((await owner.one('select doc ? $1 as has from hr.t142_doc where id = 1', ['title'])).has, false);
    await owner.query(`update hr.t142_doc_v set n = 7 where id = 2`);
    assert.deepEqual((await owner.one('select doc from hr.t142_doc where id = 2')).doc, { a: { n: 7 } });
    // a column left alone keeps a value the view can't read
    await owner.query(`update hr.t142_doc_v set title = 'three' where id = 3`);
    assert.deepEqual((await owner.one('select doc from hr.t142_doc where id = 3')).doc, { a: { n: 'not a number' }, title: 'three' });
    await assert.rejects(owner.query('update hr.t142_doc_v set id = 9 where id = 3'), /key column id is not changed/);
  });

  test('a table of documents (rows on): insert and delete rows; a source without it refuses both', async () => {
    const r = (await owner.query(`insert into hr.t142_doc_v (title, n) values ('new', 3) returning id`)).rows[0];
    assert.deepEqual((await owner.one('select doc from hr.t142_doc where id = $1', [r.id])).doc, { title: 'new', a: { n: 3 } });
    await owner.query('delete from hr.t142_doc_v where id = $1', [r.id]);
    assert.equal((await owner.query('select 1 from hr.t142_doc where id = $1', [r.id])).rows.length, 0);
    await assert.rejects(owner.query(`insert into hr.emp_profile (empno, title) values (1, 'x')`), /changes the documents of existing rows/);
    await assert.rejects(owner.query(`delete from hr.emp_profile where empno = 7839`), /not allowed/);
  });

  test('arrays: insert appends, update and delete find their element by key, also after other elements changed', async () => {
    const keys = (await owner.query(`select tag, row_key from hr.t142_doc_tags where id = 1 order by position`)).rows;
    // delete the first x and y in two statements: the keys read before still find them
    await owner.query('delete from hr.t142_doc_tags where row_key = $1', [keys[0].row_key]);
    await owner.query('delete from hr.t142_doc_tags where row_key = $1', [keys[1].row_key]);
    assert.deepEqual((await owner.one(`select doc->'tags' as t from hr.t142_doc where id = 1`)).t, ['x']);
    const added = (await owner.query(`insert into hr.t142_doc_tags (id, tag) values (1, 'z') returning row_key, position`)).rows[0];
    assert.equal(added.position, 2);
    assert.match(added.row_key, /\.1$/);
    await owner.query(`update hr.t142_doc_tags set tag = 'zz' where row_key = $1`, [added.row_key]);
    assert.deepEqual((await owner.one(`select doc->'tags' as t from hr.t142_doc where id = 1`)).t, ['x', 'zz']);
    // a key that is no longer there: the statement fails, nothing is overwritten
    await assert.rejects(owner.query(`update hr.t142_doc_tags set tag = 'q' where row_key = $1 and id = 1`, [added.row_key]).then(async () => {
      // the view row is gone, so nothing matched; change the document under a remembered key directly
      await owner.query(`select meta.jsonb_array_change(doc, '{tags}', 'update', $1, '[]') from hr.t142_doc where id = 1`, [added.row_key]);
    }), /no longer there/);
    await assert.rejects(owner.query(`insert into hr.t142_doc_tags (tag) values ('orphan')`), /needs the row it belongs to/);
    // the other columns of the document stay
    assert.equal((await owner.one(`select doc->>'secret' as s from hr.t142_doc where id = 1`)).s, '42');
  });

  test('a document view writes the row, upserts the children it lists and deletes the ones it leaves out', async () => {
    await owner.query('create table hr.t142_parent (id int generated by default as identity primary key, name text not null, note text)');
    await owner.query('create table hr.t142_child (cid int generated by default as identity primary key, pid int not null references hr.t142_parent, label text, qty int default 1)');
    await owner.query(`insert into hr.t142_parent (id, name) overriding system value values (1, 'p')`);
    await owner.query(`select setval(pg_get_serial_sequence('hr.t142_parent', 'id'), 10)`);
    await owner.query(`insert into hr.t142_child (cid, pid, label) overriding system value values (1, 1, 'a'), (2, 1, 'b')`);
    await owner.query(`select setval(pg_get_serial_sequence('hr.t142_child', 'cid'), 10)`);
    for (const d of documentViewDdl({ schema: 'hr', table: 't142_parent', key: ['id'], view: 't142_parent_doc', document: 'doc', omit: [],
      children: [{ name: 'items', schema: 'hr', table: 't142_child', key: ['cid'], fk: [['pid', 'id']] }], grants: [] })) await owner.query(d);
    assert.deepEqual((await owner.one('select doc from hr.t142_parent_doc where id = 1')).doc,
      { id: 1, name: 'p', note: null, items: [{ cid: 1, label: 'a', qty: 1 }, { cid: 2, label: 'b', qty: 1 }] });
    await owner.query(`update hr.t142_parent_doc set doc = '{"note": "n", "items": [{"cid": 1, "label": "a2"}, {"label": "c", "qty": 3}]}' where id = 1`);
    assert.deepEqual((await owner.one('select doc from hr.t142_parent_doc where id = 1')).doc,
      { id: 1, name: 'p', note: 'n', items: [{ cid: 1, label: 'a2', qty: 1 }, { cid: 11, label: 'c', qty: 3 }] });
    const ins = (await owner.query(`insert into hr.t142_parent_doc (doc) values ('{"name": "q", "items": [{"label": "d"}]}') returning id`)).rows[0];
    assert.equal((await owner.one('select count(*)::int as n from hr.t142_child where pid = $1', [ins.id])).n, 1);
    await owner.query('delete from hr.t142_parent_doc where id = $1', [ins.id]);
    assert.equal((await owner.query('select 1 from hr.t142_parent where id = $1', [ins.id])).rows.length, 0);
    // a document without the list leaves the children alone; a list that isn't an array is refused
    await owner.query(`update hr.t142_parent_doc set doc = '{"name": "p2"}' where id = 1`);
    assert.equal((await owner.one('select count(*)::int as n from hr.t142_child where pid = 1')).n, 2);
    await assert.rejects(owner.query(`update hr.t142_parent_doc set doc = '{"items": {"cid": 1}}' where id = 1`), /is an array/);
    await assert.rejects(owner.query(`update hr.t142_parent_doc set doc = '{"id": 5}' where id = 1`), /key column id/);
  });
});

describe('HR example, part 77: EMP_PROFILE on page 51', () => {
  let saved: unknown;
  before(async () => {
    saved = (await owner.one('select profile from hr.emp where empno = 7839')).profile;
  });
  after(async () => {
    await owner.query('update hr.emp set profile = $1 where empno = 7839', [JSON.stringify(saved)]);
  });

  test('the report shows JSON path columns; the form and the skills grid save, keeping keys the form does not know', async () => {
    const king = new Browser(app);
    await king.login('king');
    const list = (await king.get('/a/hr/51')).body;
    assert.match(list, /Chief executive/, 'title read from the document');
    assert.match(list, /Strategy/, 'first skill: skills.0.name');
    const ids = Object.fromEntries((await owner.query(`select r.title, r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 51`, [hr])).rows.map((r) => [r.title, r.id]));
    // the report's link to the form (with the page's checksum)
    const href = /href="(\/a\/hr\/51\?[^"]*P51_EMPNO=7839[^"]*)"/.exec(list)![1].replace(/&amp;/g, '&');
    const page = (await king.get(href)).body;
    const fields = formFields(page);
    assert.equal(fields.P51_TITLE, 'Chief executive');
    assert.equal(fields.P51_OFFICE_FLOOR, '30');
    // the form: a new title and floor
    const res = await king.submit('/a/hr/51', { ...fields, P51_TITLE: 'CEO', P51_OFFICE_FLOOR: '31', __request: 'SAVE' });
    assert.equal(res.statusCode, 303, res.body.match(/alert-error[\s\S]{0,300}/)?.[0] ?? '');
    let doc = (await owner.one('select profile from hr.emp where empno = 7839')).profile;
    assert.equal(doc.title, 'CEO');
    assert.deepEqual(doc.office, { city: 'New York', floor: 31 });
    assert.deepEqual(doc.badge, { color: 'gold', printed: '2024-01-08' }, 'a key the form does not know stays');
    // the skills grid: change a level, add a skill
    const skills = sectionOf((await king.get(href)).body, ids.Skills);
    const g = `g${ids.Skills}`;
    const form = gridForm(skills, g);
    const row = Object.keys(form).find((k) => form[k] === 'Negotiation')!.replace(/_c\d+$/, '');
    const levelCol = Object.keys(form).find((k) => k.startsWith(`${row}_c`) && form[k] === '4')!;
    const skillCol = row.length ? Object.keys(form).find((k) => k.startsWith(`${row}_c`) && form[k] === 'Negotiation')!.slice(row.length + 1) : '';
    const saved2 = await king.submit('/a/hr/51', { ...formFields(sectionOf(page, ids.Profile)), ...form, __request: `GRID_SAVE_${ids.Skills}`,
      [levelCol]: '5', [`${g}_n0_${skillCol}`]: 'Mentoring', [`${g}_n0_${levelCol.slice(row.length + 1)}`]: '2' });
    assert.equal(saved2.statusCode, 303, saved2.body.match(/alert-error[\s\S]{0,300}/)?.[0] ?? '');
    doc = (await owner.one('select profile from hr.emp where empno = 7839')).profile;
    assert.deepEqual(doc.skills, [{ name: 'Strategy', level: 5 }, { name: 'Negotiation', level: 5 }, { name: 'Mentoring', level: 2 }]);
    assert.deepEqual(doc.languages, ['en', 'fr']);
    assert.equal(doc.badge.color, 'gold');
  });

  test('the views keep the row level security and grants of hr.emp (security_invoker; the trigger writes as the caller)', async () => {
    const r = (await owner.one(`select c.reloptions from pg_class c where c.oid = 'hr.emp_profile'::regclass`)).reloptions;
    assert.ok(r.includes('security_invoker=true'));
    const fn = (await owner.one(`select prosecdef from pg_proc where oid = 'meta.json_source_write'::regproc`)).prosecdef;
    assert.equal(fn, false);
  });
});

describe('builder: Shared Components → JSON sources, Table Properties › Document view', () => {
  test('Shared Components lists JSON sources; HR\'s EMP_PROFILE and its views', async () => {
    const b = await builder();
    assert.match((await b.get(`/builder/apps/${hr}/shared`)).body, new RegExp(`/builder/apps/${hr}/json-sources"[^>]*>[\\s\\S]*?JSON Sources`));
    const list = (await b.get(`/builder/apps/${hr}/json-sources`)).body;
    assert.match(list, /EMP_PROFILE/);
    assert.match(list, /<code>hr\.emp\.profile<\/code>/);
    assert.doesNotMatch(list, /not made/);
    const one = (await b.get(`/builder/apps/${hr}/json-sources/source?name=EMP_PROFILE`)).body;
    assert.match(one, /The views exist/);
    assert.match(one, /name="c\.0\.name" value="title"/);
    assert.match(one, /Array skills/);
  });

  test('a new source: proposed from the data, saved, its views made (Change Log), a page with a detail grid', async () => {
    await owner.query('create table if not exists hr.t142_doc (id int generated by default as identity primary key, doc jsonb)');
    await owner.query(`insert into hr.t142_doc (doc) values ('{"title": "p", "tags": ["a"], "parts": [{"no": 1, "ok": true}]}')`);
    await owner.query('drop view if exists hr.t142_docs_parts, hr.t142_docs_tags, hr.t142_docs');
    const b = await builder();
    await b.get(`/builder/apps/${hr}/json-sources/source`);
    const proposed = (await b.submit(`/builder/apps/${hr}/json-sources/source`, { mode: 'propose', name: 'T142_NEW', source: 'hr.t142_doc.doc', view: 't142_docs' })).body;
    assert.match(proposed, /Proposed from up to 200 documents/);
    assert.match(proposed, /name="c\.\d+\.name" value="title"/);
    assert.match(proposed, /Array parts/);
    const form = formFieldsOf(proposed);
    const saved = await b.submit(`/builder/apps/${hr}/json-sources/source`, { ...form, mode: 'save' });
    assert.equal(saved.statusCode, 303, saved.body.match(/alert-error[\s\S]{0,400}/)?.[0] ?? '');
    const def = ((await owner.one('select json_sources from meta.app where id = $1', [hr])).json_sources as JsonSource[]).find((x) => x.name === 'T142_NEW')!;
    assert.deepEqual(def.key, ['id']);
    assert.deepEqual(def.arrays.map((a) => a.view).sort(), ['t142_docs_parts', 't142_docs_tags']);
    await b.get(`/builder/apps/${hr}/json-sources/source?name=T142_NEW`);
    const made = await b.submit(`/builder/apps/${hr}/json-sources/views`, { name: 'T142_NEW', mode: 'apply' });
    assert.equal(made.statusCode, 303);
    assert.match((await b.get(`/builder/apps/${hr}/json-sources/source?name=T142_NEW`)).body, /The views exist/);
    assert.deepEqual((await owner.query('select no, ok from hr.t142_docs_parts')).rows, [{ no: 1, ok: true }]);
    assert.ok((await owner.one(`select count(*)::int as n from meta.change_set where sql like '%create view hr.t142_docs %'`)).n >= 1, 'in the Change Log');
    // again: the views are dropped and made again
    assert.equal((await b.submit(`/builder/apps/${hr}/json-sources/views`, { name: 'T142_NEW', mode: 'apply' })).statusCode, 303);
    // a page: a form and a detail grid per array
    await b.get(`/builder/apps/${hr}/json-sources/source?name=T142_NEW`);
    assert.equal((await b.submit(`/builder/apps/${hr}/json-sources/page`, { name: 'T142_NEW', page_no: '9142', title: 'Docs' })).statusCode, 303);
    const regions = (await owner.query(`select r.type, r.table_name, r.pk_column, r.config from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 9142 order by r.seq`, [hr])).rows;
    assert.deepEqual(regions.map((r) => `${r.type}:${r.table_name}:${r.pk_column}`), ['form:hr.t142_docs:id', 'grid:hr.t142_docs_tags:row_key', 'grid:hr.t142_docs_parts:row_key']);
    assert.deepEqual(regions[1].config.master, { item: 'P9142_ID', column: 'id' });
    const king = new Browser(app);
    await king.login('king');
    await owner.query('grant select, insert, update, delete on hr.t142_doc to hr_app');
    // made before the grant: make the views again so they get it
    await b.submit(`/builder/apps/${hr}/json-sources/views`, { name: 'T142_NEW', mode: 'apply' });
    const id = (await owner.one(`select id from hr.t142_doc where doc->>'title' = 'p'`)).id;
    // the page opens with the key through a checksummed URL, as a report link makes it
    const { urlChecksum } = await import('../src/security.ts');
    const items = { P9142_ID: String(id) };
    const page = await king.get(`/a/hr/9142?P9142_ID=${id}&cs=${urlChecksum(hr, 9142, 'king', items)}`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /name="P9142_TITLE"[^>]*value="p"|value="p"[^>]*name="P9142_TITLE"/);
  });

  test('a source must name a json column the workshop connection may use; another source\'s view is refused', async () => {
    const b = await builder();
    await b.get(`/builder/apps/${hr}/json-sources/source`);
    const r = await b.submit(`/builder/apps/${hr}/json-sources/source`, { mode: 'save', name: 'T142_BAD', source: 'meta.app.json_sources', view: 'x' });
    assert.equal(r.statusCode, 422);
    assert.match(r.body, /Choose a table and its json or jsonb column/);
    const taken = await b.submit(`/builder/apps/${hr}/json-sources/source`, { mode: 'save', name: 'T142_TAKEN', source: 'hr.emp.profile', view: 'emp_profile', 'c.0.name': 'title', 'c.0.path': 'title', 'c.0.type': 'text' });
    assert.equal(taken.statusCode, 422);
    assert.match(taken.body, /belongs to JSON source EMP_PROFILE/);
  });

  test('Table Properties › Document view: children by foreign key, Preview, Apply', async () => {
    await owner.query('drop view if exists hr.t142_parent_doc, hr.t142_parent_doc2');
    const b = await builder();
    const o = 'hr.t142_parent';
    const form = (await b.get(`/builder/sql/objects/document?o=${o}`)).body;
    assert.match(form, /hr\.t142_child/);
    assert.match(form, /<code>pid → id<\/code>/);
    assert.match((await b.get(`/builder/sql/objects/table?o=${o}`)).body, /\/builder\/sql\/objects\/document\?o=hr\.t142_parent/);
    const preview = await b.submit('/builder/sql/objects/document', { o, view: 't142_parent_doc2', document: 'doc', mode: 'preview', 'c.0.name': 'hr.t142_child', 'c.0.use': 'on' });
    assert.match(preview.body, /create view hr\.t142_parent_doc2 with \(security_invoker = true\)/);
    const applied = await b.submit('/builder/sql/objects/document', { o, view: 't142_parent_doc2', document: 'doc', mode: 'apply', 'c.0.name': 'hr.t142_child', 'c.0.use': 'on' });
    assert.equal(applied.statusCode, 303, applied.body.match(/alert-error[\s\S]{0,300}/)?.[0] ?? '');
    assert.equal((await owner.one(`select jsonb_array_length(doc->'t142_child') as n from hr.t142_parent_doc2 where id = 1`)).n, 2);
    const bad = await b.submit('/builder/sql/objects/document', { o, view: 't142_parent_doc2', document: 'id', mode: 'preview' });
    assert.match(bad.body, /exists already|already exists|may not have the name of a key column/);
  });

  test('the export carries json_sources; an export without them imports with none', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.ok(doc.app.json_sources.some((x: JsonSource) => x.name === 'EMP_PROFILE'));
    const { docToFiles, filesToDoc } = await import('../src/appfiles.ts');
    const back = filesToDoc(docToFiles(doc)) as any;
    assert.deepEqual(back.app.json_sources, doc.app.json_sources);
    delete doc.app.json_sources;
    doc.app.alias = 't142imp';
    doc.app.name = 't142imp';
    await owner.query(`delete from meta.app where alias = 't142imp'`);
    try {
      const id = (await owner.one('select meta.import_app($1::jsonb) as id', [JSON.stringify(doc)])).id;
      assert.deepEqual((await owner.one('select json_sources from meta.app where id = $1', [id])).json_sources, []);
    } finally {
      await owner.query(`delete from meta.app where alias = 't142imp'`);
    }
  });
});

/** All posted fields of the builder's JSON source form (inputs, checked boxes, selected options). */
function formFieldsOf(body: string) {
  const f = /<form method="post" action="[^"]*json-sources\/source">[\s\S]*?<\/form>/.exec(body)?.[0] ?? '';
  const out: Record<string, string> = {};
  for (const [tag] of f.matchAll(/<input\b[^>]*>/g)) {
    const name = /\sname="([^"]+)"/.exec(tag)?.[1];
    if (!name || name === '__csrf' || (/type="checkbox"/.test(tag) && !/\schecked/.test(tag))) continue;
    out[name] = (/\svalue="([^"]*)"/.exec(tag)?.[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  for (const m of f.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option[^>]*selected[^>]*>([^<]*)</.exec(m[2]) ?? /<option[^>]*>([^<]*)</.exec(m[2]);
    out[m[1]] = sel?.[1] ?? '';
  }
  return out;
}
