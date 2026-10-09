// Applies db/migrations/*.sql in order (each once, in a transaction): the
// framework. Uses DATABASE_URL (the owner role). Same as `pgkiln migrate`.
//   --example <name>  then installs the example application in examples/<name>/
//                     (e.g. --example hr: the HR sample the tests use)
//   --seed            releases up to 0.9 kept the HR sample in db/seed/; with --root
//                     it installs that, otherwise it means --example hr
//   --root <dir>      reads db/ (and db/seed/) from another directory, e.g. an older
//                     release for the upgrade test: git archive v0.8.0 db | tar -x -C
//                     /tmp/old; migrate.ts --seed --root /tmp/old; migrate.ts --example hr
import '../src/env.ts';
import { root as appRoot } from '../src/env.ts';
import { migrate } from '../src/migrate.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? '') : null;
};

await migrate({ root: arg('--root') ?? appRoot, example: arg('--example'), seed: process.argv.includes('--seed') });
