// The App Gallery's shipped applications, for the tests that install them
// (test/gallery.test.ts, test/security.test.ts, test/e2e/gallery.test.ts):
// the sample apps of examples/gallery/samples/ with the schema and role each
// script creates, and the starter and utility blueprints.
import { readFileSync } from 'node:fs';
import { owner } from '../src/db.ts';

const dir = new URL('../examples/gallery/', import.meta.url);
const gallery = JSON.parse(readFileSync(new URL('gallery.json', dir), 'utf8'));

export interface GallerySample { key: string; alias: string; title: string; file: string; schema: string; role: string }
export interface GalleryBlueprint { key: string; file: string; alias: string; schema: string; kind: 'starters' | 'utilities' }

/** The single-file sample apps of examples/gallery/samples/ (HR and Tasks are installed otherwise). */
export const SAMPLES: GallerySample[] = (gallery.samples as { key: string; alias: string; title: string; file?: string }[])
  .filter((x) => x.file?.startsWith('samples/'))
  .map((x) => {
    const sql = readFileSync(new URL(x.file!, dir), 'utf8');
    return { key: x.key, alias: x.alias, title: x.title, file: x.file!, schema: /create schema (\w+);/.exec(sql)![1], role: /create role (\w+) nologin/.exec(sql)![1] };
  });

export const BLUEPRINTS: GalleryBlueprint[] = (['starters', 'utilities'] as const).flatMap((kind) =>
  (gallery[kind] as { key: string; file: string }[]).map((x) => {
    const spec = JSON.parse(readFileSync(new URL(x.file, dir), 'utf8'));
    return { key: x.key, file: x.file, alias: spec.alias, schema: spec.schema, kind };
  }));

async function dropRole(role: string) {
  if ((await owner.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) {
    await owner.query(`drop owned by ${role} cascade`).catch(() => {});
    await owner.query(`drop role ${role}`);
  }
}

/** Removes a sample app with its schema and role (as an administrator would). */
export async function dropSample(x: GallerySample) {
  await owner.query('delete from meta.app where alias = $1', [x.alias]);
  await owner.query(`drop schema if exists ${x.schema} cascade`);
  await dropRole(x.role);
}

/** Removes an application made from a starter or utility blueprint, with its schema and role. */
export async function dropBlueprintApp(x: GalleryBlueprint) {
  await owner.query('delete from meta.app where alias = $1', [x.alias]);
  await owner.query(`drop schema if exists ${x.schema} cascade`);
  await dropRole(`app_${x.alias.replace(/-/g, '_')}`);
}

/** The SQL of a sample, run in one transaction as the owner (what the gallery's Install does). */
export async function installSample(x: GallerySample) {
  const sql = readFileSync(new URL(x.file, dir), 'utf8');
  await owner.tx(async (c) => {
    await c.query(sql);
  });
}
