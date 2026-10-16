// Sprint 103 (Database Actions DA-16: Data Pump): SQL Workshop › Schema Export / Import with pg_dump and pg_restore.
// The script runner and its checks are tested without the programs; exports and imports skip when pg_dump and
// pg_restore of the server's major version (or newer) are not installed (PGKILN_PG_BIN can point at them).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { checkStatement, ScriptLexer, type ScriptEvent } from '../src/dumpscript.ts';
import { findTools, getJob, jobFile, parseToc, startExport, startImport, type Job } from '../src/datapump.ts';
import { Browser } from './helpers.ts';

const S = 'dp103';
let app: FastifyInstance;
const tools = await findTools(true);
const noTools = tools.ok ? false : `pg_dump / pg_restore: ${tools.reason}`;

before(async () => {
  app = await buildApp({ logger: false });
  await owner.query(`drop schema if exists ${S} cascade; drop schema if exists ${S}_copy cascade; drop schema if exists hr_copy103 cascade`);
  await owner.query(`create schema ${S};
    create table ${S}.dept (id int primary key, name text not null);
    create table ${S}."Emp" (id int generated always as identity primary key, dept int references ${S}.dept, name text, note text, tags text[]);
    create function ${S}.total() returns bigint language sql begin atomic select count(*) from ${S}."Emp"; end;
    create view ${S}.emp_v as select e.name, d.name as dept from ${S}."Emp" e join ${S}.dept d on d.id = e.dept;
    insert into ${S}.dept values (1, 'Sales'), (2, 'R&D');
    insert into ${S}."Emp" (dept, name, note, tags) values (1, 'Ann', E'tab\\there\\nnew line; and \\\\ backslash', '{a,"b c"}'), (2, 'Bob', null, '{}'), (2, 'Chloë', '\\.', null);`);
});
after(async () => {
  await owner.query(`drop schema if exists ${S} cascade; drop schema if exists ${S}_copy cascade; drop schema if exists hr_copy103 cascade`);
  await owner.query(`delete from meta.dump_job where username = 'admin' and (schema_name in ('${S}', 'hr') or original_name like 'dp103%')`);
  await app.close();
  await closePools();
});

const events = (text: string) => {
  const lx = new ScriptLexer();
  const out: ScriptEvent[] = [];
  for (const line of text.split('\n')) out.push(...lx.push(line));
  lx.end();
  return out;
};

describe('the import script runner', () => {
  test('statements split like psql: quotes, dollar quotes, comments, SQL-standard bodies; COPY data up to \\.', () => {
    const ev = events(`-- a comment; not a statement
\\restrict AbC123
SET statement_timeout = 0;
CREATE FUNCTION s.f() RETURNS text LANGUAGE plpgsql AS $_$ begin return 'a;b'; end $_$;
CREATE FUNCTION s.g() RETURNS integer LANGUAGE sql
BEGIN ATOMIC
 SELECT CASE WHEN true THEN 1 ELSE 2 END;
 SELECT 3;
END;
COMMENT ON TABLE s."t;x" IS 'it''s; /* not */ a comment';
SELECT E'\\';' ;
/* a block /* nested; */ comment */ CREATE VIEW s.v AS SELECT 1; CREATE VIEW s.w AS SELECT 2;
COPY s.t (a, "b c") FROM stdin;
1\tx;y
\\N\t'quoted'
\\.
\\unrestrict AbC123
`);
    assert.deepEqual(ev.map((e) => e.type), ['sql', 'sql', 'sql', 'sql', 'sql', 'sql', 'sql', 'copy', 'data', 'data', 'copyEnd']);
    const sql = ev.filter((e): e is Extract<ScriptEvent, { sql: string }> => 'sql' in e).map((e) => e.sql);
    assert.equal(sql[1], `CREATE FUNCTION s.f() RETURNS text LANGUAGE plpgsql AS $_$ begin return 'a;b'; end $_$;`);
    assert.match(sql[2], /^CREATE FUNCTION s\.g\(\)[\s\S]*SELECT 3;\nEND;$/);
    assert.equal(sql[3], `COMMENT ON TABLE s."t;x" IS 'it''s; /* not */ a comment';`);
    assert.equal(sql[4], `SELECT E'\\';' ;`);
    assert.equal(sql[5].trim(), 'CREATE VIEW s.v AS SELECT 1;');
    assert.equal(ev[8].type === 'data' && ev[8].text, '1\tx;y\n');
  });

  test('psql meta-commands other than \\restrict are refused; a script cut off is an error', () => {
    assert.throws(() => events('SELECT 1;\n\\! touch /tmp/x\n'), /meta-commands are not run/);
    assert.throws(() => events('SELECT 1 \\gexec\n'), /meta-commands are not run/);
    assert.throws(() => events('COPY s.t (a) FROM stdin;\n1\n'), /inside COPY data/);
    assert.throws(() => events("SELECT 'open\n"), /inside a quoted string/);
    assert.throws(() => events('SELECT 1\n'), /without a semicolon/);
  });

  test('statements of a dump of the schema pass; others and other schemas are refused', () => {
    for (const ok of [
      `SET client_min_messages = warning;`, `SELECT pg_catalog.set_config('search_path', '', false);`, `SET search_path = '';`,
      `CREATE SCHEMA s;`, `CREATE TABLE s.t (id integer);`, `CREATE TABLE s."Odd ""name""" (id integer);`, `ALTER TABLE ONLY s.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);`,
      `ALTER TABLE s.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME s.t_id_seq START WITH 1);`,
      `CREATE UNIQUE INDEX t_i ON s.t USING btree (id);`, `CREATE TRIGGER trg AFTER INSERT OR UPDATE OF id ON s.t FOR EACH ROW EXECUTE FUNCTION s.f();`,
      `CREATE POLICY p ON s.t USING ((owner = meta.app_user()));`, `ALTER TABLE s.t ENABLE ROW LEVEL SECURITY;`, `COMMENT ON COLUMN s.t.id IS 'x';`,
      `COMMENT ON CONSTRAINT c ON s.t IS 'x';`, `GRANT SELECT ON TABLE s.t TO hr_app;`, `REVOKE ALL ON SCHEMA s FROM PUBLIC;`, `GRANT USAGE ON SCHEMA s TO hr_app;`,
      `SELECT pg_catalog.setval('s.t_id_seq', 14, true);`, `COPY s.t (id, "b c") FROM stdin;`, `CREATE OR REPLACE FUNCTION s.f() RETURNS trigger LANGUAGE plpgsql AS $$ begin end $$;`,
      `DROP TABLE IF EXISTS s.t;`, `DROP TRIGGER IF EXISTS trg ON s.t;`, `DROP SCHEMA IF EXISTS s;`, `CREATE MATERIALIZED VIEW s.m AS SELECT 1 WITH NO DATA;`,
      `REFRESH MATERIALIZED VIEW s.m;`, `ALTER SEQUENCE s.q OWNED BY s.t.id;`, `CREATE TYPE s.mood AS ENUM ('a');`, `ALTER TABLE ONLY s.t ADD CONSTRAINT fk FOREIGN KEY (d) REFERENCES other.x(id);`,
    ]) assert.equal(checkStatement(ok, 's'), null, ok);
    for (const [bad, why] of [
      [`CREATE TABLE meta.t (id integer);`, /outside the dump's schema s/], [`ALTER TABLE meta.account DISABLE ROW LEVEL SECURITY;`, /outside/],
      [`DROP TABLE IF EXISTS meta.app;`, /outside/], [`CREATE SCHEMA meta2;`, /outside/], [`COPY meta.account FROM stdin;`, /outside/],
      [`COPY s.t FROM '/etc/passwd';`, /only COPY … FROM stdin/], [`COPY s.t FROM PROGRAM 'id' ;`, /only COPY/], [`COPY s.t TO stdout;`, /only COPY/],
      [`SET ROLE postgres;`, /not something pg_dump writes/], [`SET work_mem = '1GB';`, /not something a dump sets/], [`SET SESSION AUTHORIZATION postgres;`, /not something pg_dump writes/], [`SET search_path = meta;`, /empty search_path/],
      [`ALTER SYSTEM SET log_statement = 'none';`, /not something pg_dump writes/], [`CREATE ROLE x SUPERUSER;`, /not something pg_dump writes/],
      [`DO $$ begin perform 1; end $$;`, /not something pg_dump writes/], [`GRANT pg_execute_server_program TO hr_app;`, /role memberships/],
      [`ALTER TABLE s.t OWNER TO postgres;`, /OWNER TO/], [`ALTER TABLE s.t SET SCHEMA meta;`, /SET SCHEMA/], [`SELECT pg_catalog.setval('meta.app_id_seq', 1, true);`, /outside/],
      [`SELECT meta.drop_everything();`, /not something pg_dump writes/], [`CREATE TEMP TABLE s.t (id int);`, /temporary/], [`CREATE TABLE t (id int);`, /not something pg_dump writes/],
      [`CREATE EXTENSION dblink;`, /not something pg_dump writes/], [`GRANT ALL ON SCHEMA meta TO PUBLIC;`, /outside/],
    ] as [string, RegExp][]) assert.match(checkStatement(bad, 's') ?? 'passed', why, bad);
  });

  test('an archive\'s table of contents', () => {
    const toc = parseToc(`;
; Archive created at 2026-10-16 12:00:00 UTC
;     dbname: pgkiln
;     Format: CUSTOM
;     Dumped from database version: 17.6
;
5; 2615 16385 SCHEMA - hr pgkiln
215; 1259 16390 TABLE hr emp pgkiln
216; 1255 16391 FUNCTION hr total(integer, text) pgkiln
3412; 0 16390 TABLE DATA hr emp pgkiln
3413; 2606 16400 FK CONSTRAINT hr emp emp_dept_fkey pgkiln
`);
    assert.deepEqual(toc.schemas, ['hr']);
    assert.equal(toc.schemaEntry, true);
    assert.deepEqual(toc.entries.map((e) => [e.desc, e.name]), [['SCHEMA', 'hr'], ['TABLE', 'emp'], ['FUNCTION', 'total(integer, text)'], ['TABLE DATA', 'emp'], ['FK CONSTRAINT', 'emp emp_dept_fkey']]);
    assert.ok(toc.header.some(([k, v]) => k === 'Format' && v === 'CUSTOM'));
  });
});

const done = async (id: number): Promise<Job> => {
  for (let i = 0; i < 1200; i++) {
    const j = (await getJob(id))!;
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the job did not finish');
};
const counts = async (schema: string) =>
  Object.fromEntries(await Promise.all((await owner.query<{ t: string }>(
    `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = 'r' order by 1`, [schema])).rows
    .map(async ({ t }) => [t, Number((await owner.one(`select count(*) as n from "${schema}"."${t.replace(/"/g, '""')}"`))!.n)])));
const all = { format: 'custom' as const, content: 'all' as const, tables: [], exclude: [], privileges: true };

describe('schema export and import', { skip: noTools }, () => {
  test('Done when: hr exported as a custom dump and imported as hr_copy103 has the same row counts; hr is untouched', async () => {
    const before = await counts('hr');
    const e = await done(await startExport('admin', 'hr', all));
    assert.equal(e.status, 'succeeded', e.error ?? e.log);
    assert.ok(e.bytes! > 1000);
    assert.match(e.log, /dumping contents of table "hr\.emp"/);
    const i = await done(await startImport('admin', e, { target: 'hr_copy103', content: 'all', clean: false, privileges: true }));
    assert.equal(i.status, 'succeeded', i.error ?? i.log);
    assert.match(i.log, /renamed to pgkiln_dump_\d+ for the import/);
    assert.deepEqual(await counts('hr_copy103'), before);
    assert.deepEqual(await counts('hr'), before);
    assert.equal((await owner.one(`select count(*)::int as n from pg_namespace where nspname like 'pgkiln_dump_%'`))!.n, 0);
    // the copy's defaults and views point at its own objects
    const dflt = (await owner.one(`select pg_get_expr(d.adbin, d.adrelid) as e from pg_attrdef d join pg_class c on c.oid = d.adrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'hr_copy103' and pg_get_expr(d.adbin, d.adrelid) like 'nextval%' limit 1`))?.e;
    if (dflt) assert.match(dflt, /hr_copy103\./);
  });

  test('a schema with quoted names, identity, SQL-standard functions and odd data; into an existing schema with Drop first; data only', async () => {
    const e = await done(await startExport('admin', S, all));
    assert.equal(e.status, 'succeeded', e.error ?? e.log);
    const i = await done(await startImport('admin', e, { target: `${S}_copy`, content: 'all', clean: false, privileges: true }));
    assert.equal(i.status, 'succeeded', i.error ?? i.log);
    const rows = async (schema: string) => (await owner.query(`select id, dept, name, note, tags from ${schema}."Emp" order by id`)).rows;
    assert.deepEqual(await rows(`${S}_copy`), await rows(S));
    assert.equal(Number((await owner.one(`select ${S}_copy.total() as n`))!.n), 3);
    assert.equal((await owner.query(`select * from ${S}_copy.emp_v`)).rowCount, 3);
    // the identity goes on from the copied rows
    await owner.query(`insert into ${S}_copy."Emp" (name) values ('Dan')`);
    assert.equal((await owner.one(`select max(id)::int as n from ${S}_copy."Emp"`))!.n, 4);

    // again into the existing copy: the objects exist, so it fails and changes nothing
    const again = await done(await startImport('admin', e, { target: `${S}_copy`, content: 'all', clean: false, privileges: true }));
    assert.equal(again.status, 'failed');
    assert.match(again.log, /already exists[\s\S]*Rolled back/);
    assert.equal((await owner.one(`select count(*)::int as n from ${S}_copy."Emp"`))!.n, 4);
    // with Drop first it replaces them
    const clean = await done(await startImport('admin', e, { target: `${S}_copy`, content: 'all', clean: true, privileges: true }));
    assert.equal(clean.status, 'succeeded', clean.error ?? clean.log);
    assert.equal((await owner.one(`select count(*)::int as n from ${S}_copy."Emp"`))!.n, 3);
    // data only into the existing tables, after emptying them
    await owner.query(`truncate ${S}_copy."Emp", ${S}_copy.dept`);
    const data = await done(await startImport('admin', e, { target: `${S}_copy`, content: 'data', clean: false, privileges: true }));
    assert.equal(data.status, 'succeeded', data.error ?? data.log);
    assert.deepEqual(await rows(`${S}_copy`), await rows(S));
    // the same rows again: COPY fails on the keys, the job ends (no connection left waiting) and nothing changes
    const twice = await done(await startImport('admin', e, { target: `${S}_copy`, content: 'data', clean: false, privileges: true }));
    assert.equal(twice.status, 'failed');
    assert.match(twice.error!, /duplicate key/);
    assert.deepEqual(await rows(`${S}_copy`), await rows(S));
    assert.equal((await owner.one(`select count(*)::int as n from pg_stat_activity where application_name = 'pgkiln schema import'`))!.n, 0);
  });

  test('some tables, definitions only, plain format', async () => {
    const e = await done(await startExport('admin', S, { ...all, format: 'plain', content: 'definitions', tables: ['dept'], privileges: false }));
    assert.equal(e.status, 'succeeded', e.error ?? e.log);
    const sql = await readFile(jobFile(e)!, 'utf8');
    assert.match(sql, /CREATE TABLE dp103\.dept/);
    assert.doesNotMatch(sql, /Emp|COPY|CREATE SCHEMA|OWNER TO/);
    // a plain dump is not imported here
    await assert.rejects(startImport('admin', e, { target: 'x103', content: 'all', clean: false, privileges: true }), /plain SQL dump/);
    // tables of another schema, or unknown ones, are refused
    await assert.rejects(startExport('admin', S, { ...all, tables: ['nope'] }), /Not in dp103: nope/);
    await assert.rejects(startExport('admin', 'meta', all), /no schema "meta"/);
  });

  test('the pages: export, job, download, upload, import form', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
    const list = await b.get('/builder/sql/data-pump');
    assert.equal(list.statusCode, 200);
    assert.match(list.body, /Schema Export \/ Import/);
    assert.match((await b.get(`/builder/sql/data-pump/export?schema=${S}`)).body, /name="t" value="dept"/);
    const res = await b.submit('/builder/sql/data-pump/export', { schema: S, format: 'custom', content: 'all', privileges: '1', mode: 'all' });
    assert.equal(res.statusCode, 303);
    const id = Number(/job\/(\d+)$/.exec(res.headers.location as string)![1]);
    const j = await done(id);
    assert.equal(j.status, 'succeeded');
    const page = (await b.get(`/builder/sql/data-pump/job/${id}`)).body;
    assert.match(page, /Download/);
    const dl = await b.get(`/builder/sql/data-pump/job/${id}/download`);
    assert.equal(dl.statusCode, 200);
    assert.match(String(dl.headers['content-disposition']), /dp103-\d{4}-\d\d-\d\d\.dump/);
    assert.equal(dl.rawPayload.subarray(0, 5).toString(), 'PGDMP');
    // the downloaded file uploaded again: the preview, then the import
    await b.get('/builder/sql/data-pump/import');
    const up = await b.upload('/builder/sql/data-pump/upload', {}, { file: { name: 'dp103.dump', type: 'application/octet-stream', data: dl.rawPayload } });
    assert.equal(up.statusCode, 303, up.body);
    const form = (await b.get(up.headers.location as string)).body;
    assert.match(form, /What dp103\.dump holds/);
    assert.match(form, /value="dp103"/);
    const upId = Number(/job\/(\d+)\/import/.exec(up.headers.location as string)![1]);
    await owner.query(`drop schema if exists ${S}_copy cascade`);
    const go = await b.submit(`/builder/sql/data-pump/job/${upId}/import`, { target: `${S}_copy`, content: 'all', privileges: '1' });
    assert.equal(go.statusCode, 303, go.body);
    assert.equal((await done(upId)).status, 'succeeded');
    assert.equal((await owner.one(`select count(*)::int as n from ${S}_copy."Emp"`))!.n, 3);
    // something that is not an archive
    await b.get('/builder/sql/data-pump/import');
    const junk = await b.upload('/builder/sql/data-pump/upload', {}, { file: { name: 'dp103-junk.sql', type: 'text/plain', data: Buffer.from('select 1;\n') } });
    assert.match((await b.get(junk.headers.location as string)).body, /can(&#39;|')t read this file|plain SQL dump/);
  });
});
