// (sprint 116, WS-14) pgkiln import <dir> --replace --only <path>: a file-level
// import (APEX 26.2: APEXlang file-level import). Only the named page or
// component files of a directory export change; everything else stays as it is
// in the database. How: the application is exported in the directory's style,
// the named files are taken from the directory (and removed where the directory
// no longer has them), and the merged files are imported with --replace as usual.
import type { FileMap } from '../appfiles.ts';
import { UsageError } from './apps.ts';

/**
 * What an --only argument selects: "pages/12" (or "page 12", "12") is page 12's directory, whatever its
 * name; any other path is a file or a directory of the export ("shared/lovs/jobs.yaml", "shared/lovs").
 */
export function onlyMatcher(arg: string): { label: string; test: (path: string) => boolean } {
  const a = arg.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const page = /^(?:pages?[/ ]?)?(\d{1,9})$/.exec(a);
  if (page) {
    const prefix = `pages/${String(Number(page[1])).padStart(4, '0')}-`;
    return { label: `page ${Number(page[1])}`, test: (p) => p.startsWith(prefix) && p.indexOf('/', prefix.length) > 0 };
  }
  if (!a || a.startsWith('/') || a.split('/').includes('..')) throw new UsageError(`--only ${arg}: a path inside the export directory, e.g. pages/12 or shared/lovs/jobs.yaml`);
  if (a === 'pgkiln.json') throw new UsageError('--only pgkiln.json: the marker file is not a component');
  return { label: a, test: (p) => p === a || p.startsWith(`${a}/`) };
}

/**
 * The files to import: the application's current files with the selected ones replaced by the directory's.
 * Refuses a selection that matches nothing on either side (a typo) and directories of another style.
 */
export function mergeOnly(current: FileMap, incoming: FileMap, only: string[]) {
  const style = (files: FileMap) => {
    try {
      return JSON.parse(files.get('pgkiln.json')?.toString('utf8') ?? '{}').style === 'text' ? 'text' : 'json';
    } catch {
      return 'json';
    }
  };
  if (style(current) !== style(incoming)) throw new Error('the application was exported in another style than the directory');
  const matchers = only.map(onlyMatcher);
  const selected = (p: string) => matchers.some((m) => m.test(p));
  for (const m of matchers)
    if (![...current.keys(), ...incoming.keys()].some((p) => m.test(p))) throw new UsageError(`--only ${m.label}: not in the directory or the application`);
  const merged: FileMap = new Map([...current].filter(([p]) => !selected(p)));
  const changed: string[] = [];
  for (const [p, content] of incoming)
    if (selected(p)) {
      merged.set(p, content);
      if (!current.get(p)?.equals(content)) changed.push(p);
    }
  for (const p of current.keys()) if (selected(p) && !incoming.has(p)) changed.push(p);
  return { files: merged, changed: changed.sort(), labels: matchers.map((m) => m.label) };
}
