import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { onClosePools, owner, type Db } from './db.ts';
import { onSessionEnd } from './session.ts';
import { isSchemaDdl } from './changelog.ts';

// (sprint 107, DA-2) Transaction mode of the SQL Worksheet. Database Actions autocommits every statement;
// in transaction mode a worksheet tab keeps one connection of its own with an open transaction between
// runs, until Commit, Rollback, a COMMIT / ROLLBACK typed in the editor, or an idle timeout.
//
// The registry lives in this process only (no table): a transaction is a live connection, so it can't
// outlive the server anyway. Each open transaction is bound to the builder session that started it, its
// developer, workspace and worksheet tab, and has a random id; a lookup always starts from the caller's own
// session id, so one developer can never reach another one's connection. Limits: a few per developer and
// per instance (each holds a database connection outside the pools), an idle timeout (rolled back by a
// sweeper) and the connection's idle_in_transaction_session_timeout a little later as the backstop. The
// connection is a plain pg.Client made from the workshop's (or the "Run as" application's) pool settings,
// never a pooled one: SET ROLE and settings typed by the developer die with it.

const intEnv = (name: string, dflt: number, min: number, max: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt;
};
/** Seconds without a run before an open transaction is rolled back (WORKSHEET_TXN_IDLE_SECONDS, default 5 minutes). */
export const txnIdleSeconds = () => intEnv('WORKSHEET_TXN_IDLE_SECONDS', 300, 10, 86_400);
/** Open transactions per developer (WORKSHEET_TXN_MAX_PER_DEVELOPER, default 3) and per server (WORKSHEET_TXN_MAX, default 20). */
export const txnMaxPerDeveloper = () => intEnv('WORKSHEET_TXN_MAX_PER_DEVELOPER', 3, 1, 100);
export const txnMax = () => intEnv('WORKSHEET_TXN_MAX', 20, 1, 1000);
/** The database's own backstop: this much after the idle timeout it ends the connection itself. */
const BACKSTOP_SECONDS = 60;
/** How long the note of a transaction the server ended (timeout, workspace switch) stays for the worksheet. */
const NOTE_MS = 60 * 60 * 1000;

export interface WorksheetTxn {
  /** random handle (shown to the page, never trusted for a lookup on its own) */
  id: string;
  sessionId: string;
  username: string;
  workspaceId: number;
  tab: string;
  client: pg.Client;
  /** the application whose role the transaction runs as (Run as), or null */
  asAppId: number | null;
  /** who it runs as, for the badge */
  runsAs: string;
  startedMs: number;
  lastMs: number;
  /** statements run in the current transaction */
  statements: number;
  /** a run (or commit / rollback) is going on */
  busy: boolean;
  /** DDL that succeeded in the transaction: it goes into the Change Log at COMMIT, not before */
  pendingDdl: string[];
  defaultSchema: string;
}

export type TxnState = 'open' | 'aborted' | 'none';

const open = new Map<string, WorksheetTxn>();
const notes = new Map<string, { message: string; at: number }>();
const keyOf = (sessionId: string, tab: string) => `${sessionId}\u0000${tab}`;

/** A worksheet tab's key as the page sends it (src/builder/worksheet.ts uses the same rule). */
export const validTab = (tab: unknown) => typeof tab === 'string' && /^[a-z0-9]{1,20}$/.test(tab);

/** The open transaction of this session's worksheet tab. */
export function findTxn(sessionId: string, tab: string): WorksheetTxn | undefined {
  return validTab(tab) ? open.get(keyOf(sessionId, tab)) : undefined;
}

/** Open, aborted (a statement failed: only ROLLBACK helps) or none (committed or rolled back by a typed statement). */
export function txnState(t: WorksheetTxn | undefined): TxnState {
  const s = t?.client.getTransactionStatus();
  return s === 'T' ? 'open' : s === 'E' ? 'aborted' : 'none';
}

/** Why the server ended this tab's last transaction (idle timeout, …), if it did. */
export function txnNote(sessionId: string, tab: string): string | null {
  const n = notes.get(keyOf(sessionId, tab));
  if (!n) return null;
  if (Date.now() - n.at > NOTE_MS) {
    notes.delete(keyOf(sessionId, tab));
    return null;
  }
  return n.message;
}
export const clearTxnNote = (sessionId: string, tab: string) => notes.delete(keyOf(sessionId, tab));

/** Open transactions (tests and the instance's monitor). */
export const openTxnCount = (username?: string) => [...open.values()].filter((t) => username === undefined || t.username === username).length;

/** Statements PostgreSQL refuses inside a transaction block: refused before they abort the transaction. */
export const outsideTxnOnly = (sql: string) => {
  const s = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').toLowerCase();
  return /^(vacuum|alter\s+system|(create|drop)\s+(database|tablespace)|(create|drop)\s+(unique\s+)?index\s+concurrently|reindex\b[^;]*\bconcurrently|alter\s+table\b[^;]*\bdetach\s+partition\b[^;]*\bconcurrently|prepare\s+transaction|commit\s+prepared|rollback\s+prepared)\b/.test(s);
};

export interface BeginOptions {
  sessionId: string;
  username: string;
  workspaceId: number;
  tab: string;
  /** the pool whose login the connection uses (the workshop's, or the Run as application's) */
  db: Db;
  asApp?: { id: number; db_role: string } | null;
  runsAs: string;
  searchSchema: string | null;
}

/** Start a transaction for a worksheet tab: a connection of its own, BEGIN. A string is a refusal. */
export async function beginTxn(o: BeginOptions): Promise<WorksheetTxn | string> {
  if (!validTab(o.tab)) return 'Transaction mode needs the worksheet tab (JavaScript).';
  const key = keyOf(o.sessionId, o.tab);
  if (open.has(key)) return 'This worksheet already has an open transaction.';
  const mine = openTxnCount(o.username);
  if (mine >= txnMaxPerDeveloper())
    return `You have ${mine} worksheets with an open transaction, the most allowed: commit or roll back one of them first.`;
  if (open.size >= txnMax()) return 'The server has as many open worksheet transactions as it allows: try again later, or use Autocommit.';
  const idle = txnIdleSeconds();
  const opts = o.db.pool.options;
  const client = new pg.Client({
    connectionString: opts.connectionString,
    password: opts.password,
    ssl: opts.ssl,
    application_name: 'pgkiln-worksheet-txn',
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: (idle + BACKSTOP_SECONDS) * 1000,
  });
  const now = Date.now();
  const t: WorksheetTxn = {
    id: randomBytes(16).toString('hex'), sessionId: o.sessionId, username: o.username, workspaceId: o.workspaceId, tab: o.tab, client,
    asAppId: o.asApp?.id ?? null, runsAs: o.runsAs, startedMs: now, lastMs: now, statements: 0, busy: true, pendingDdl: [], defaultSchema: o.searchSchema ?? 'public',
  };
  open.set(key, t); // before the first await: the limits count it at once
  notes.delete(key);
  // the database ended the connection (its backstop timeout, a restart, pg_terminate_backend)
  const gone = () => {
    if (open.get(key) !== t) return;
    open.delete(key);
    notes.set(key, { message: 'The database ended the transaction\'s connection: its changes were rolled back.', at: Date.now() });
  };
  client.on('error', gone);
  client.on('end', gone);
  try {
    await client.connect();
    if (o.searchSchema) await client.query(`select set_config('search_path', $1, false)`, [`${pg.escapeIdentifier(o.searchSchema)}, public`]);
    if (o.asApp) {
      await client.query(`select set_config('pgkiln.app_id', $1, false)`, [String(o.asApp.id)]);
      await client.query(`set role ${pg.escapeIdentifier(o.asApp.db_role)}`);
    }
    await client.query('begin');
  } catch (e) {
    open.delete(key);
    await client.end().catch(() => {});
    return `The transaction could not start: ${(e as Error).message}`;
  } finally {
    t.busy = false;
  }
  startSweeper();
  return t;
}

/** BEGIN again on the transaction's connection after a COMMIT / ROLLBACK typed in the editor. */
export async function beginAgain(t: WorksheetTxn) {
  await t.client.query('begin');
  t.startedMs = Date.now();
  t.statements = 0;
  t.pendingDdl = [];
}

/**
 * End a transaction: COMMIT or ROLLBACK, then close its connection. The tag is what the database answered
 * (COMMIT of a failed transaction answers ROLLBACK). `note` is kept for the worksheet (the server ended it).
 */
export async function endTxn(t: WorksheetTxn, action: 'commit' | 'rollback', note?: string): Promise<{ tag: string; error?: string; ddl: string[] }> {
  const key = keyOf(t.sessionId, t.tab);
  if (open.get(key) === t) open.delete(key);
  if (note) notes.set(key, { message: note, at: Date.now() });
  let tag = action.toUpperCase();
  let error: string | undefined;
  try {
    if (t.client.getTransactionStatus() !== 'I') {
      const r = await t.client.query(action);
      tag = (r.command ?? tag).toUpperCase();
    }
  } catch (e) {
    error = (e as Error).message;
    tag = 'ROLLBACK';
  } finally {
    await t.client.end().catch(() => {});
  }
  return { tag, error, ddl: action === 'commit' && tag === 'COMMIT' ? t.pendingDdl : [] };
}

/**
 * Count a run's statements in the transaction and keep its DDL for the Change Log until COMMIT. A COMMIT
 * (or END) typed in the editor hands back the DDL it committed; a ROLLBACK (or ABORT, or COMMIT of a failed
 * transaction, which answers ROLLBACK) drops it.
 */
export function accountRun(t: WorksheetTxn, results: { status: string; sql: string; tag?: string }[]): string[] {
  const committed: string[] = [];
  for (const r of results) {
    if (r.status !== 'ok') continue;
    const tag = (r.tag ?? '').toUpperCase();
    if (tag === 'COMMIT') {
      committed.push(...t.pendingDdl);
      t.pendingDdl = [];
      t.statements = 0;
    } else if (tag === 'ROLLBACK' && !/^\s*rollback\s+(work\s+|transaction\s+)?to\b/i.test(r.sql)) {
      t.pendingDdl = [];
      t.statements = 0;
    } else if (tag !== 'BEGIN' && tag !== 'START') {
      t.statements++;
      if (isSchemaDdl(r.sql)) t.pendingDdl.push(r.sql);
    }
  }
  return committed;
}

/** Roll back and close every transaction of a session (it ended: sign-out, a new sign-in). */
export async function endSessionTxns(sessionId: string, note: string) {
  await Promise.all([...open.values()].filter((t) => t.sessionId === sessionId).map((t) => endTxn(t, 'rollback', note)));
}

/** The idle timeout and ended sessions: roll back. `now` lets tests move the clock. */
export async function sweepTxns(now = Date.now()) {
  const idleMs = txnIdleSeconds() * 1000;
  const minutes = Math.round(txnIdleSeconds() / 6) / 10;
  const ended: Promise<unknown>[] = [];
  for (const t of open.values())
    if (!t.busy && now - t.lastMs > idleMs)
      ended.push(endTxn(t, 'rollback', `The transaction was rolled back after ${minutes} minute${minutes === 1 ? '' : 's'} without a run (${t.statements} statement${t.statements === 1 ? '' : 's'} undone).`));
  await Promise.all(ended);
  const sessions = [...new Set([...open.values()].map((t) => t.sessionId))];
  if (sessions.length) {
    const alive = new Set((await owner.query<{ id: string }>('select id::text as id from meta.session where id::text = any ($1)', [sessions]).catch(() => ({ rows: sessions.map((id) => ({ id })) }))).rows.map((r) => r.id));
    await Promise.all(sessions.filter((id) => !alive.has(id)).map((id) => endSessionTxns(id, 'The builder session ended: the transaction was rolled back.')));
  }
  for (const [k, n] of notes) if (now - n.at > NOTE_MS) notes.delete(k);
  if (!open.size) stopSweeper();
}

let sweeper: NodeJS.Timeout | null = null;
function startSweeper() {
  if (sweeper) return;
  const every = Math.max(1000, Math.min(15_000, (txnIdleSeconds() * 1000) / 4));
  sweeper = setInterval(() => void sweepTxns().catch((e) => console.error('worksheet transactions:', (e as Error).message)), every);
  sweeper.unref();
}
function stopSweeper() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/** Everything rolled back (the server stops). */
export async function endAllTxns(note = 'The server stopped: the transaction was rolled back.') {
  stopSweeper();
  await Promise.all([...open.values()].map((t) => endTxn(t, 'rollback', note)));
}

onClosePools(() => endAllTxns());
onSessionEnd((sessionId) => endSessionTxns(sessionId, 'You signed out: the transaction was rolled back.'));
