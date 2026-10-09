// Zip archives and Excel files for SQL (migration 070). PostgreSQL can't
// decompress, so when pgkiln receives a .zip or .xlsx file (a file item's
// upload, a meta.web_request() response) it unpacks it into
// meta.unpacked_file / meta.unpacked_entry, keyed by the SHA-256 of the
// file, for 24 hours. meta.zip_entries / meta.zip_entry and meta.parse_data
// then find the entries and sheets of the content they are given.
//
// Limits keep a "zip bomb" out: at most MAX_ENTRIES files and MAX_TOTAL
// bytes unpacked (checked against the sizes the archive declares and again
// against what inflating produced). A file over the limits, or not a valid
// archive, is simply not unpacked: the SQL functions then say so.
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import readXlsxFile from 'read-excel-file/node';
import { owner } from './db.ts';
import { cellText } from './dataload.ts';

const MAX_ENTRIES = 2000;
const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_ROWS = 200_000;
const KEEP = '24 hours';

const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Unpack a .zip or .xlsx file for SQL (nothing happens for other files). Never throws. */
export async function unpackForSql(data: Buffer | null | undefined) {
  if (!data || !isZip(data)) return false;
  try {
    const digest = createHash('sha256').update(data).digest();
    // seen before: keep it another 24 hours
    const seen = await owner.query('update meta.unpacked_file set created_at = now() where digest = $1', [digest]);
    if (seen.rowCount) return true;
    let count = 0;
    let declared = 0;
    const files = unzipSync(new Uint8Array(data), {
      filter: (f) => {
        count++;
        declared += f.originalSize;
        if (count > MAX_ENTRIES || declared > MAX_TOTAL) throw new Error('too large');
        return true;
      },
    });
    const entries = Object.entries(files);
    if (entries.reduce((n, [, b]) => n + b.length, 0) > MAX_TOTAL) return false;
    let sheets: { name: string; rows: (string | null)[][] }[] | null = null;
    if (files['xl/workbook.xml']) {
      const book = await readXlsxFile<string>(data, { parseNumber: (s: string) => s, trim: true } as never);
      sheets = book.map((s) => ({ name: s.sheet, rows: s.data.slice(0, MAX_ROWS).map((r) => r.map(cellText)) }));
    }
    await owner.tx(async (c) => {
      await c.query(`insert into meta.unpacked_file (digest, kind, sheets) values ($1, $2, $3::jsonb) on conflict (digest) do nothing`,
        [digest, sheets ? 'xlsx' : 'zip', sheets ? JSON.stringify(sheets) : null]);
      let seq = 0;
      for (const [name, content] of entries)
        await c.query('insert into meta.unpacked_entry (digest, seq, name, content) values ($1, $2, $3, $4) on conflict do nothing', [digest, ++seq, name, Buffer.from(content)]);
    });
    return true;
  } catch {
    return false;
  }
}

let lastPurge = 0;

/** Forget unpacked files after 24 hours (at most every 10 minutes). */
export async function purgeUnpacked(force = false) {
  if (!force && Date.now() - lastPurge < 10 * 60_000) return;
  lastPurge = Date.now();
  await owner.query(`delete from meta.unpacked_file where created_at < now() - interval '${KEEP}'`);
}
