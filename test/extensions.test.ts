// The examples in docs/guide/15-extensions.md work (contrib extensions that
// ship with PostgreSQL). Everything runs in a transaction that is rolled back.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/env.ts';
import { closePools, owner } from '../src/db.ts';
import { publicError } from '../src/runtime/context.ts';
import type { App } from '../src/metadata.ts';

after(async () => closePools());

class Rollback extends Error {}

async function inRolledBackTx(fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<void>) {
  await assert.rejects(
    owner.tx(async (c) => {
      await fn(async (sql, params = []) => (await c.query(sql, params)).rows);
      throw new Rollback();
    }),
    Rollback,
  );
}

test('btree_gist: an exclusion constraint stops overlapping leave, with a friendly message', async () => {
  await inRolledBackTx(async (q) => {
    await q('create extension if not exists btree_gist');
    await q(`alter table hr.leave_request add constraint leave_no_overlap
               exclude using gist (empno with =, daterange(start_date, end_date, '[]') with &&)
               where (status in ('PENDING', 'APPROVED'))`);
    await q(`insert into hr.leave_request (empno, start_date, end_date, days) values (7369, date '2031-03-03', date '2031-03-07', 5)`);
    let error: unknown;
    await q('savepoint s');
    try {
      await q(`insert into hr.leave_request (empno, start_date, end_date, days) values (7369, date '2031-03-06', date '2031-03-10', 3)`);
    } catch (e) {
      error = e;
    }
    await q('rollback to savepoint s');
    assert.equal((error as { code?: string })?.code, '23P01', 'exclusion violation');
    const message = await publicError({ app: { id: 0, debug: false } as App, page: undefined as never, user: 'test', ip: '' }, error, 'test');
    assert.equal(message, 'The values violate a rule (leave_no_overlap).');
    // a different employee may take the same days
    await q(`insert into hr.leave_request (empno, start_date, end_date, days) values (7499, date '2031-03-06', date '2031-03-10', 3)`);
  });
});

test('pg_trgm: a trigram index serves ilike searches', async () => {
  await inRolledBackTx(async (q) => {
    await q('create extension if not exists pg_trgm');
    await q('create index emp_ename_trgm on hr.emp using gin (ename gin_trgm_ops)');
    await q('set local enable_seqscan = off'); // the sample table is tiny; force the planner to show the index
    const plan = (await q(`explain select * from hr.emp where ename ilike '%lak%'`)).map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /emp_ename_trgm/);
  });
});

test('unaccent and citext are available for multilingual search and case-insensitive columns', async () => {
  await inRolledBackTx(async (q) => {
    await q('create extension if not exists unaccent');
    await q('create extension if not exists citext');
    assert.equal((await q(`select unaccent('Café Crème') as v`))[0].v, 'Cafe Creme');
    assert.equal((await q(`select 'King@Example.com'::citext = 'king@example.com'::citext as v`))[0].v, true);
  });
});
