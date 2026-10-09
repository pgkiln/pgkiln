// The database pools under load. A request that already holds a runtime
// connection (its transaction) must never wait for a second one from the same
// pool: with every connection held by such requests the server froze for good
// (found with 20 users at the default pool size of 10). Here the pool has only
// two connections and many pages render at once.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

process.env.DB_POOL_SIZE = '2';
process.env.DB_ACQUIRE_TIMEOUT_MS = '20000';
const { buildApp } = await import('../src/app.ts');
const { closePools, runtime } = await import('../src/db.ts');
const { Browser } = await import('./helpers.ts');

let app: FastifyInstance;
before(async () => {
  app = await buildApp({ logger: false });
});
after(async () => {
  // a deadlocked pool never closes: end the process with an error instead of hanging CI
  let closed = false;
  setTimeout(() => {
    if (closed) return;
    console.error('database pools did not close: connections are still held');
    process.exit(1);
  }, 5_000).unref();
  await app.close();
  await closePools();
  closed = true;
});

describe('database pools', () => {
  test('many pages at once with a pool of two connections: none waits forever', async () => {
    const users = await Promise.all(['king', 'blake', 'jones', 'scott'].map(async (u) => {
      const b = new Browser(app);
      await b.login(u);
      return b;
    }));
    // the dashboard (navigation lists), the departments page (a map region) and a report
    const pages = ['/a/hr/1', '/a/hr/4', '/a/hr/2'];
    const started = Date.now();
    const results = await Promise.race([
      Promise.all(users.flatMap((b) => [...pages, ...pages].map((p) => b.get(p)))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pages still waiting after 15 s: the pool deadlocked')), 15_000)),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode), Array(results.length).fill(200));
    assert.ok(Date.now() - started < 15_000);
    assert.equal(runtime.pool.totalCount <= 2, true, 'the main pool stays within DB_POOL_SIZE');
  });
});
