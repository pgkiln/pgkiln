// Reading and writing application directories (and .zip files of them).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { MARKER, type FileMap } from '../appfiles.ts';

const hidden = (name: string) => name.startsWith('.');

/** Every file under dir (posix paths), skipping dot files and dot directories (.git). */
export function readDir(dir: string): FileMap {
  const files: FileMap = new Map();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (hidden(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.set(relative(dir, p).split(sep).join('/'), readFileSync(p));
    }
  };
  walk(dir);
  return files;
}

/** The application inside a zip file: the folder holding pgapex.json (or the root). */
export function readZip(buf: Uint8Array): FileMap {
  const entries = unzipSync(buf);
  const marker = Object.keys(entries).filter((p) => p === MARKER || p.endsWith('/' + MARKER)).sort((a, b) => a.length - b.length)[0];
  if (!marker) throw new Error(`no ${MARKER} in the zip file: not a pgkiln application directory`);
  const prefix = marker.slice(0, -MARKER.length);
  const files: FileMap = new Map();
  for (const [p, data] of Object.entries(entries))
    if (p.startsWith(prefix) && !p.endsWith('/') && !p.slice(prefix.length).split('/').some(hidden)) files.set(p.slice(prefix.length), Buffer.from(data));
  return files;
}

/**
 * Write files into dir so that it holds exactly them: changed files are
 * rewritten, files no longer exported are removed (dot files such as .git are
 * left alone). Refuses a non-empty directory that is not an application export.
 * Returns the number of files written and removed.
 */
export function writeDir(target: string, files: FileMap) {
  const dir = resolve(target);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
    const present = readDir(dir);
    if (present.size && !present.has(MARKER)) throw new Error(`${dir} is not empty and holds no ${MARKER}: refusing to write into it`);
  }
  let written = 0, removed = 0;
  const old = existsSync(dir) ? readDir(dir) : new Map();
  for (const [p, data] of files) {
    if (old.get(p)?.equals(data)) continue;
    const full = join(dir, ...p.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    written++;
  }
  for (const p of old.keys()) {
    if (files.has(p)) continue;
    unlinkSync(join(dir, ...p.split('/')));
    removed++;
    // remove directories left empty
    for (let d = dirname(join(dir, ...p.split('/'))); d.length > dir.length && d.startsWith(dir); d = dirname(d)) {
      if (readdirSync(d).length) break;
      rmdirSync(d);
    }
  }
  return { written, removed };
}
