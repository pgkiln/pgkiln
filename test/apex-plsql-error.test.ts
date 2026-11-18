// Sprint 227 (parity: APEX import, "Missing: validations of type PL/SQL Error"): APEX's PL/SQL Error validation (the
// block fails by raising) becomes a function_error validation whose body returns the error message on an exception.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/env.ts';
import { closePools, owner } from '../src/db.ts';
import { plsqlErrorBody } from '../src/apeximport.ts';

after(() => closePools());

/** The body run as the runtime runs a function_error body: a temporary function returning text. */
const run = async (body: string) => {
  const c = await owner.pool.connect();
  try {
    await c.query(`create function pg_temp.t227() returns text language plpgsql as $b$\n${body}\n$b$`);
    return (await c.query('select pg_temp.t227() as v')).rows[0].v as string | null;
  } finally {
    await c.query('drop function if exists pg_temp.t227()').catch(() => {});
    c.release();
  }
};

describe('a PL/SQL Error validation', () => {
  test('passes (null) when the block runs; fails with the message when it raises', async () => {
    assert.equal(await run(plsqlErrorBody('perform 1;', 'Failed.')), null);
    assert.equal(await run(plsqlErrorBody('perform 1 / 0;', 'Failed.')), 'Failed.');
    assert.equal(await run(plsqlErrorBody("raise exception 'credit limit reached'", '')), 'credit limit reached', 'no message: the error\'s text');
    assert.equal(await run(plsqlErrorBody("raise exception 'over'", "Check failed: #SQLERRM#. It's blocked.")), "Check failed: over. It's blocked.");
    // a declare block inside, and statements over lines
    assert.equal(await run(plsqlErrorBody("declare\n  n int := 0;\nbegin\n  n := 1 / n;\nend;", '#SQLERRM_TEXT#')), 'division by zero');
  });

  test('the message is a literal: quotes and substitutions can\'t break out', async () => {
    const body = plsqlErrorBody("raise exception 'x'", "'; drop table meta.app; --");
    assert.equal(await run(body), "'; drop table meta.app; --");
    assert.ok(await owner.one('select 1 from meta.app limit 1'));
  });
});
