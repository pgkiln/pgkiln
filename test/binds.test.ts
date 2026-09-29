import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBinds, bindNames } from '../src/binds.ts';

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
