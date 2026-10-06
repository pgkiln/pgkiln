// Comparing two sets of application files, and a small line diff for the output.
import { stableJson, type FileMap } from '../appfiles.ts';
import { fromText, toText } from '../yamltext.ts';

export interface FileChange {
  path: string;
  /** A: only in the directory, D: only in the database, M: different */
  status: 'A' | 'D' | 'M';
}

/** JSON and YAML files compare by content (key order and spacing don't matter), others byte by byte. */
function canonical(path: string, buf: Buffer) {
  if (path.endsWith('.yaml'))
    try {
      return Buffer.from(toText(fromText(buf.toString('utf8'), path)));
    } catch {
      return buf;
    }
  if (!path.endsWith('.json')) return buf;
  try {
    return Buffer.from(stableJson(JSON.parse(buf.toString('utf8'))));
  } catch {
    return buf;
  }
}

export function compareFiles(database: FileMap, directory: FileMap): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of [...new Set([...database.keys(), ...directory.keys()])].sort()) {
    const a = database.get(path), b = directory.get(path);
    if (!a) changes.push({ path, status: 'A' });
    else if (!b) changes.push({ path, status: 'D' });
    else if (!canonical(path, a).equals(canonical(path, b))) changes.push({ path, status: 'M' });
  }
  return changes;
}

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

/** Unified diff of two texts (3 lines of context), or a note for binary files. */
export function unifiedDiff(path: string, a: Buffer | undefined, b: Buffer | undefined, names: [string, string] = ['database', 'directory']) {
  if ((a && !isText(a)) || (b && !isText(b))) return `Binary file ${path} differs\n`;
  const split = (buf?: Buffer) => (buf ? canonical(path, buf).toString('utf8').replace(/\n$/, '').split('\n') : []);
  const x = split(a), y = split(b);
  // longest common subsequence table (files are small)
  const n = x.length, m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: [' ' | '-' | '+', string, number, number][] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push([' ', x[i], i++, j++]);
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(['-', x[i], i++, j]);
    else ops.push(['+', y[j], i, j++]);
  }
  const out = [`--- ${names[0]}/${path}`, `+++ ${names[1]}/${path}`];
  const CONTEXT = 3;
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] === ' ') {
      k++;
      continue;
    }
    // a hunk: from CONTEXT lines before this change to CONTEXT lines after the last nearby change
    let start = Math.max(0, k - CONTEXT), end = k;
    while (end < ops.length) {
      let next = end;
      while (next < ops.length && ops[next][0] === ' ') next++;
      if (next >= ops.length || next - end > 2 * CONTEXT) break;
      end = next + 1;
    }
    end = Math.min(ops.length, end + CONTEXT);
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o[0] !== '+').length, bLen = hunk.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${hunk[0][2] + (aLen ? 1 : 0)},${aLen} +${hunk[0][3] + (bLen ? 1 : 0)},${bLen} @@`);
    for (const o of hunk) out.push(o[0] + o[1]);
    k = end;
  }
  return out.join('\n') + '\n';
}
