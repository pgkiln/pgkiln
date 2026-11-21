// (sprint 251, MG-28) Writes src/import-schema.json: what an import checks a document against (column types, allowed
// values, conditions, unique keys of meta's exported tables), from the catalog of the database in .env, so
// `pgkiln advise --offline` can check application files without a database. Run it after a migration that changes
// such a constraint; test/import-errors.test.ts fails while the file differs from the catalog.
//   npx tsx scripts/import-schema.ts
import '../src/env.ts';
import { writeFileSync } from 'node:fs';
import { withDb } from '../src/cli/apps.ts';
import { loadImportSchema } from '../src/import-errors.ts';
import { closePools } from '../src/db.ts';

const schema = await withDb((db) => loadImportSchema(db));
const out = new URL('../src/import-schema.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(schema, null, 1)}\n`);
console.log(`wrote ${out.pathname}: ${Object.values(schema.types).reduce((n, t) => n + Object.keys(t).length, 0)} typed columns, ` +
  `${schema.enums.length} allowed-value checks, ${schema.conditions.length} conditions, ${schema.uniques.length} unique keys`);
await closePools().catch(() => {});
