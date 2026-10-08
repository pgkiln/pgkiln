import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBinds, bindNames, splitStatements } from '../src/binds.ts';

test('replaces binds with escaped literals', () => {
  assert.equal(
    applyBinds('select * from t where a = :p1_x and b = :APP_USER', { P1_X: "O'Brien", APP_USER: 'demo' }),
    "select * from t where a = 'O''Brien' and b = 'demo'",
  );
});

test('unset and empty binds become NULL', () => {
  assert.equal(applyBinds(':A is null or c = :B', { B: '' }), 'NULL is null or c = NULL');
});

test('leaves casts, strings, identifiers, comments and dollar quotes alone', () => {
  const sql = `select :X::int, ':Y', ":Z", E'\\':W', $$ :V $$, $f$ :U $f$ -- :T
/* :S /* nested :R */ */ x`;
  assert.equal(
    applyBinds(sql, { X: '1' }),
    `select '1'::int, ':Y', ":Z", E'\\':W', $$ :V $$, $f$ :U $f$ -- :T
/* :S /* nested :R */ */ x`,
  );
});

test('backslashes are escaped safely', () => {
  assert.equal(applyBinds(':A', { A: "a\\' or 1=1 --" }), " E'a\\\\'' or 1=1 --'");
});

test('bindNames lists distinct upper-cased names', () => {
  assert.deepEqual(bindNames(':p1_a = :P1_A or :b'), ['P1_A', 'B']);
});

test('splitStatements splits at semicolons outside strings, comments and dollar quotes', () => {
  assert.deepEqual(splitStatements(`update t set a = ';'; -- x;y\ndo $$ begin perform 1; end $$;; /* a; b */ select 1;`), [
    `update t set a = ';'`,
    'do $$ begin perform 1; end $$',
    'select 1',
  ]);
  assert.deepEqual(splitStatements('  ;  -- only a comment\n'), []);
});

test('reads SQL the way PostgreSQL does: non-ASCII dollar tags, $ in identifiers, \\r ending a comment, E only as a prefix', () => {
  // a dollar-quoted body with a non-ASCII tag is text: a value can't end it
  assert.equal(applyBinds('select $ä$ :A $ä$, :A', { A: '$ä$ x' }), "select $ä$ :A $ä$, '$ä$ x'");
  // foo$bar$ is one identifier, not the start of a dollar quote
  assert.equal(applyBinds('select 1 as a$b$, :A', { A: 'v' }), "select 1 as a$b$, 'v'");
  // a line comment ends at a carriage return
  assert.equal(applyBinds('select 1 -- note\r, :A', { A: 'v' }), "select 1 -- note\r, 'v'");
  // WHERE'…' is the keyword and a plain string (a backslash in it escapes nothing)
  assert.equal(applyBinds("select 1 where'\\' <> :A", { A: 'v' }), "select 1 where'\\' <> 'v'");
  // a real E'' string still escapes
  assert.equal(applyBinds("select E'\\' :B', :A", { A: 'v' }), "select E'\\' :B', 'v'");
});
