// (sprint 212) The test files of one CI shard, balanced by duration: node's --test-shard=i/n deals files out by
// their place in the list, so one shard got security.test.ts and others and took twice as long as the next.
//
//   npx tsx --test --test-concurrency=1 $(npx tsx scripts/test-shard.ts 1/3 test/*.test.ts)
//
// The weights are the seconds in <the files' directory>/durations.json (scripts/test-times.mjs writes it); a file
// that isn't there yet weighs the median. Longest first, each to the shard with the least so far (ties: the lower
// shard): every file lands in exactly one shard, and the same list always splits the same way. A shard's files keep
// the order of the list.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// a node process, the server and its pools for each file: a few seconds the durations don't count
const PER_FILE = 2;

export function shard(files: string[], weights: Record<string, number>, n: number): string[][] {
  const known = files.map((f) => weights[f]).filter((w): w is number => typeof w === 'number').sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (f: string) => (weights[f] ?? median) + PER_FILE;
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = Array<number>(n).fill(0);
  const of = new Map<string, number>();
  for (const f of order) {
    const i = load.indexOf(Math.min(...load));
    of.set(f, i);
    load[i] += weight(f);
  }
  return Array.from({ length: n }, (_, i) => files.filter((f) => of.get(f) === i));
}

const main = () => {
  const [spec, ...files] = process.argv.slice(2);
  const m = /^(\d+)\/(\d+)$/.exec(spec ?? '');
  if (!m || +m[1] < 1 || +m[1] > +m[2] || !files.length) {
    console.error('usage: tsx scripts/test-shard.ts <i>/<n> <test files…>');
    process.exit(2);
  }
  const at = join(dirname(files[0]), 'durations.json');
  const weights = existsSync(at) ? (JSON.parse(readFileSync(at, 'utf8')) as Record<string, number>) : {};
  const unique = [...new Set(files)];
  const shards = shard(unique, weights, +m[2]);
  const mine = shards[+m[1] - 1];
  const secs = (fs: string[]) => Math.round(fs.reduce((s, f) => s + (weights[f] ?? 0) + PER_FILE, 0));
  console.error(`shard ${spec}: ${mine.length} of ${unique.length} files, ~${secs(mine)} s (shards: ${shards.map(secs).join(' / ')} s)`);
  console.log(mine.join('\n'));
};

if (process.argv[1]?.endsWith('test-shard.ts')) main();
