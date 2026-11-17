// (sprint 212) A node:test reporter that sums each test file's top-level durations (seconds) and prints them as JSON:
// the weights of scripts/test-shard.ts. Refresh test/durations.json now and then (the shards stay balanced without it,
// just less evenly):
//   npm run pretest && npx tsx --test --test-concurrency=1 --test-reporter=./scripts/test-times.mjs test/*.test.ts > test/durations.json
// A test is counted under the file that defines it: the four test/e2e/responsive-<width>.test.ts only call
// test/e2e/responsive.ts, whose time goes to them by hand (the suites "phone (390px)", … per width).
import { relative } from 'node:path';

export default async function* testTimes(source) {
  const times = {};
  for await (const { type, data } of source) {
    if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0 && data.file) {
      const file = relative(process.cwd(), data.file).replaceAll('\\', '/');
      times[file] = (times[file] ?? 0) + (data.details?.duration_ms ?? 0) / 1000;
    }
  }
  const sorted = Object.fromEntries(Object.entries(times).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, s]) => [f, Math.round(s * 10) / 10]));
  yield `${JSON.stringify(sorted, null, 2)}\n`;
}
