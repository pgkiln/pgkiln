// (sprint 212) scripts/test-shard.ts: the CI shards, balanced by the files' durations.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { shard } from '../scripts/test-shard.ts';

describe('CI test shards', () => {
  const files = readdirSync('test').filter((f) => f.endsWith('.test.ts')).sort().map((f) => `test/${f}`);
  const weights = JSON.parse(readFileSync('test/durations.json', 'utf8')) as Record<string, number>;

  test('every test file runs in exactly one shard, and the same list splits the same way', () => {
    for (const n of [1, 2, 3, 4]) {
      const shards = shard(files, weights, n);
      assert.equal(shards.length, n);
      assert.deepEqual(shards.flat().sort(), files, `${n} shards`);
      assert.deepEqual(shard([...files].reverse(), weights, n).map((s) => [...s].sort()), shards.map((s) => [...s].sort()), 'not by the list\'s order');
    }
  });

  test('balanced: the longest shard is within the longest file of the shortest', () => {
    const w = (f: string) => weights[f] ?? 0;
    const shards = shard(files, weights, 3).map((s) => s.reduce((t, f) => t + w(f) + 2, 0));
    const longestFile = Math.max(...files.map(w)) + 2;
    assert.ok(Math.max(...shards) - Math.min(...shards) <= longestFile, shards.join(' / '));
  });

  test('a file without a weight yet weighs the median, not nothing', () => {
    const shards = shard(['a', 'b', 'c', 'new'], { a: 10, b: 10, c: 10 }, 2);
    assert.deepEqual(shards, [['a', 'c'], ['b', 'new']]);
  });
});
