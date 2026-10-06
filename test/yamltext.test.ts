// The text style of the directory export (src/yamltext.ts): a strict YAML
// subset that reads back as the same JSON value. Checked on hand-picked
// awkward values, on random values, and (in appfiles tests) on a whole app.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fromText, toText } from '../src/yamltext.ts';

const round = (v: unknown) => fromText(toText(v), 'test');

describe('text (YAML subset) values', () => {
  test('scalars that look like other things are quoted; plain where safe', () => {
    const v = {
      plain: 'Employees', yes: 'yes', no: 'No', nul: 'null', tilde: '~', num: '10', date: '2026-01-01', neg: '-1', dot: '.5',
      colon: 'a: b', hash: 'a #b', trailing: 'a ', empty: '', dash: '- x', star: '*x', amp: '&x', quote: '"x"', brace: '{x}',
      ending: 'note:', unicode: 'Grüße ✓', ctrl: 'a\u0001b', cr: 'a\r\nb', ls: 'a b', tab: 'a\tb',
      n: 1, f: 1.5, e: 1e21, t: true, fl: false, z: null, arr: [], obj: {},
      'key with spaces': 1, 'a:b': 2, '': 3, 'true': 4, '#x': 5, '__proto__': 6,
    };
    const text = toText(v);
    assert.match(text, /^plain: Employees$/m);
    assert.match(text, /^"yes": "yes"$/m, 'a reserved word as a key is quoted too');
    assert.match(text, /^num: "10"$/m);
    assert.match(text, /^"a:b": 2$/m);
    assert.deepEqual(round(v), v);
    assert.equal(Object.getPrototypeOf(round(v)), Object.prototype, '__proto__ is a key, not the prototype');
  });

  test('SQL and templates are literal blocks; trailing newlines, blank and indented lines survive', () => {
    const v = {
      source: 'select ename,\n       sal\n  from hr.emp\n where deptno = :P3_DEPTNO',
      one: 'a\n', two: 'a\n\n', three: 'a\n\n\n', lead: '  indented first\nsecond', blank: 'a\n\nb', spaces: 'a\n   \nb', endspaces: 'a\n  ',
      comment: 'select 1\n# not a comment\n-- sql comment', dash: '- a\n- b', colon: 'x: y\nz: w', only: '\n', nl2: '\n\nx',
      list: ['line 1\nline 2', 'x\n'],
      nested: { deeper: { code: 'begin\n  null;\nend;' } },
    };
    const text = toText(v);
    assert.match(text, /^source: \|2-\n {2}select ename,\n {9}sal\n/m);
    assert.deepEqual(round(v), v);
  });

  test('lists of mappings, lists of lists, empty collections, a top-level list or scalar', () => {
    const v = [{ a: 1, b: [{ c: 'x', d: [] }, { e: {} }] }, [1, [2, 3], []], {}, [], 'text', null, { only: { x: [1] } }];
    assert.deepEqual(round(v), v);
    assert.deepEqual(round('multi\nline'), 'multi\nline');
    assert.deepEqual(round(42), 42);
    assert.deepEqual(round({}), {});
  });

  test('random values read back the same', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const chars = ['a', 'Z', ' ', ':', '#', '-', '\n', '\t', '"', "'", '\\', '|', '>', '{', '[', '0', '9', '.', 'é', '✓', '/', '&', '*', '!', '%', '@', '`', ','];
    const str = () => Array.from({ length: Math.floor(rnd() * 12) }, () => pick(chars)).join('');
    const value = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.5) return pick<() => unknown>([str, str, () => Math.round(rnd() * 1e6) / 100, () => rnd() < 0.5, () => null, () => 0 - Math.floor(rnd() * 99)])();
      if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [str() || 'k', value(depth + 1)]));
    };
    for (let n = 0; n < 2000; n++) {
      const v = value(0);
      assert.deepEqual(round(v), v, JSON.stringify(v));
    }
  });

  test('outside the subset: clear errors with the line', () => {
    assert.throws(() => fromText('a: 1\na: 2', 'x.yaml'), /x\.yaml, line 2: the key "a" appears twice/);
    assert.throws(() => fromText('a: [1, 2]'), /outside the subset/);
    assert.throws(() => fromText('a: *ref'), /outside the subset/);
    assert.throws(() => fromText('a: yes'), /must be in double quotes/);
    assert.throws(() => fromText('a: "unterminated'), /JSON escapes/);
    assert.throws(() => fromText('\ta: 1'), /tabs|indented/);
    assert.throws(() => fromText('  a: 1'), /must not be indented/);
    // comments and blank lines are fine
    assert.deepEqual(fromText('# a component\n\na: 1  # one\nb:\n  # inner\n  c: x\n'), { a: 1, b: { c: 'x' } });
  });
});
