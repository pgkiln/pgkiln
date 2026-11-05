import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { applicationRoles, applyRemote, disconnect, dropRemote, fdwStatus, MAX_TABLES, remoteDbProblems, serverNameOf, type RemoteDb } from '../remote-db.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import { administrator, back, BASE, csrf, flash, input, region, send, shell, type Req } from './ui.ts';

// (sprint 150, AP-7 leftover; APEX: REST Enabled SQL services) Workspace utilities → Remote databases
// (administrators): another PostgreSQL database's tables as foreign tables in a local schema (src/remote-db.ts).
//
//   GET  /builder/remote-databases                 postgres_fdw's state, the remote databases, the form (?edit=<id>, ?new=1)
//   POST /builder/remote-databases                 save and import (mode=test: import in a transaction that is rolled back)
//   POST /builder/remote-databases/:rid/refresh    import the tables again (new or changed remote tables)
//   POST /builder/remote-databases/:rid/delete     drop the local schema and the server
//   POST /builder/remote-databases/extension       create extension postgres_fdw (a superuser connection)

const PAGE = `${BASE}/remote-databases`;
const TITLE = 'Remote databases';
const crumbs: [string, string?][] = [['App Builder', BASE], ['Workspace utilities', `${BASE}/utilities`], [TITLE]];
const rid = (v: unknown) => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : null);
const when = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

interface Row extends RemoteDb { id: number; imported_at: Date | null; imported: number | null; error: string | null; updated_by: string }

const rows = async () => (await owner.query<Row>('select * from meta.remote_database order by name')).rows;

function fromBody(b: Record<string, unknown>): RemoteDb {
  const text = (k: string) => String(b[k] ?? '').trim();
  return {
    name: text('name').toUpperCase(), description: text('description') || null, host: text('host'), port: Number(text('port') || '5432'),
    dbname: text('dbname'), user_name: text('user_name'), remote_schema: text('remote_schema') || 'public', local_schema: text('local_schema').toLowerCase(),
    tables: text('tables').split(/[,\n]/).map((t) => t.trim()).filter(Boolean), grant_roles: list(b.grant_roles), writable: b.writable === 'true',
  };
}

function form(s: Session, x: Partial<Row>, roles: string[]) {
  const editing = !!x.id;
  return region(editing ? `Edit ${x.name}` : 'Add a remote database', html`<form method="post" action="${PAGE}" id="rdb-form">${csrf(s)}
    ${editing ? html`<input type="hidden" name="id" value="${x.id}">` : ''}
    <div class="form-grid">
      ${input('name', 'Name', x.name ?? '', { help: 'A static id, e.g. CRM. The server is pgkiln_rdb_<name>.', required: true })}
      ${input('description', 'Description', x.description ?? '')}
      ${input('host', 'Host', x.host ?? '', { help: 'As the database server reaches it (it makes the connection, not pgkiln).', required: true })}
      ${input('port', 'Port', String(x.port ?? 5432), { type: 'number' })}
      ${input('dbname', 'Database', x.dbname ?? '', { required: true })}
      ${input('user_name', 'User', x.user_name ?? '', { required: true, help: 'A user of the remote database: what it may read or change there is what the applications may.' })}
      ${input('password', 'Password', '', { type: 'password', auto: 'new-password', help: editing ? 'Kept by PostgreSQL in the user mapping and never shown; type a new one to replace it.' : 'Kept by PostgreSQL in the user mapping (pgkiln never stores it).' })}
      ${input('remote_schema', 'Remote schema', x.remote_schema ?? 'public')}
      ${input('local_schema', 'Local schema', x.local_schema ?? '', { required: true, help: 'A new schema here for the foreign tables, e.g. crm: regions query crm.<table>.' })}
      ${input('tables', 'Tables', (x.tables ?? []).join(', '), { help: `Remote tables and views to import, separated by commas (at most ${MAX_TABLES}); empty: all of the remote schema's.` })}
    </div>
    <fieldset class="prop-group u-mt1"><legend>Grant to the applications' database roles</legend>
      ${roles.length
        ? html`<div class="check-list">${roles.map((r) => html`<label><input type="checkbox" name="grant_roles" value="${r}"${(x.grant_roles ?? []).includes(r) ? raw(' checked') : ''}> ${r}</label>`)}</div>`
        : html`<p class="muted">No application has a database role yet (Application settings → Database role).</p>`}
      <label class="u-mt1"><input type="checkbox" name="writable" value="true"${x.writable ? raw(' checked') : ''}> Also INSERT, UPDATE and DELETE (else SELECT only)</label>
    </fieldset>
    <div class="buttons u-mt1">
      <button class="btn btn-hot" name="mode" value="save">${editing ? 'Save and import again' : 'Add and import'}</button>
      <button class="btn" name="mode" value="test">Test the connection</button>
      <a class="btn" href="${PAGE}">Cancel</a>
    </div></form>`);
}

export async function remoteDatabaseRoutes(app: FastifyInstance) {
  app.get(PAGE, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (!s) return;
    const q = (req.query ?? {}) as Record<string, string>;
    const st = await fdwStatus(owner);
    const all = await rows();
    const roles = await applicationRoles(owner);
    const edit = rid(q.edit) ? all.find((r) => r.id === rid(q.edit)) : undefined;
    const main = html`<h1 class="u-mb1">${TITLE}</h1>
      <p class="muted u-mt0">Another PostgreSQL database's tables as foreign tables (postgres_fdw) in a local schema: regions, reports, forms and lists
        of values use them like the application's own tables, as its database role, with the grants given here.</p>
      ${st.installed
        ? html`<p class="muted">${icon('check')} postgres_fdw is installed.</p>`
        : html`<div class="alert alert-info" role="status"><p><strong>postgres_fdw is not installed in this database.</strong></p>
            ${st.available && st.canCreate
              ? html`<form method="post" action="${PAGE}/extension">${csrf(s)}<button class="btn">Create extension postgres_fdw</button></form>`
              : html`<p>${st.available ? 'A superuser runs' : 'The server needs PostgreSQL\'s contrib package, then a superuser runs'} <code>create extension postgres_fdw;</code>
                  and <code>grant usage on foreign data wrapper postgres_fdw to</code> pgkiln's owner role.</p>`}</div>`}
      ${region('Remote databases', html`<div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Name</th><th>Connection</th><th>Local schema</th>
          <th class="num">Tables</th><th>Granted to</th><th>Imported</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${all.length ? all.map((r) => html`<tr>
            <td data-label="Name"><strong>${r.name}</strong>${r.description ? html`<br><small class="muted">${r.description}</small>` : ''}</td>
            <td data-label="Connection"><code>${r.user_name}@${r.host}:${r.port}/${r.dbname}</code> (${r.remote_schema})</td>
            <td data-label="Local schema"><code>${r.local_schema}</code></td>
            <td class="num" data-label="Tables">${r.imported ?? '—'}</td>
            <td data-label="Granted to">${r.grant_roles.join(', ') || '—'}${r.writable ? ' (read and write)' : ''}</td>
            <td data-label="Imported">${when(r.imported_at)}${r.error ? html`<br><span class="wf-problem">${r.error}</span>` : ''}</td>
            <td data-label="Actions"><a class="btn btn-sm" href="${PAGE}?edit=${r.id}#rdb-form">Edit</a>
              <form method="post" action="${`${PAGE}/${r.id}/refresh`}" class="inline">${csrf(s)}<button class="btn btn-sm">Import again</button></form>
              <form method="post" action="${`${PAGE}/${r.id}/delete`}" class="inline">${csrf(s)}<button class="btn btn-sm btn-danger" data-confirm="${`Delete ${r.name}? Its schema ${r.local_schema} and its foreign tables are dropped.`}">Delete</button></form></td>
          </tr>`) : html`<tr><td colspan="7" class="empty">No remote databases yet.</td></tr>`}
        </tbody></table></div>`)}
      ${st.installed ? form(s, edit ?? {}, roles) : ''}`;
    return send(reply, s, shell(s, TITLE, crumbs, main));
  });

  app.post(PAGE, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const x = fromBody(b);
    const editId = rid(b.id);
    const password = typeof b.password === 'string' && b.password ? b.password : null;
    const retry = editId ? `${PAGE}?edit=${editId}#rdb-form` : `${PAGE}#rdb-form`;
    const problems = remoteDbProblems(x, await applicationRoles(owner));
    if (password && password.length > 1000) problems.push('The password has at most 1000 characters.');
    if (problems.length) {
      flash(s, problems.join(' '), 'error');
      return back(reply, s, retry);
    }
    const test = b.mode === 'test';
    try {
      const count = await owner.tx(async (c) => {
        const old = editId ? (await c.query<Row>('select * from meta.remote_database where id = $1 for update', [editId])).rows[0] : undefined;
        if (editId && !old) throw new Error('No such remote database.');
        // a renamed one, or a new local schema: the old server and schema go first
        if (old && (old.name !== x.name || old.local_schema !== x.local_schema)) {
          if (!password) throw new Error('Renaming it, or moving it to another local schema, needs the password again.');
          await dropRemote(c, old);
        }
        const n = await applyRemote(c, x, password, old && old.name === x.name && old.local_schema === x.local_schema ? old.grant_roles : []);
        if (test) throw Object.assign(new Error('rolled back'), { tested: n });
        if (old)
          await c.query(
            `update meta.remote_database set name = $2, description = $3, host = $4, port = $5, dbname = $6, user_name = $7, remote_schema = $8, local_schema = $9,
                    tables = $10, grant_roles = $11, writable = $12, server_name = $13, imported_at = now(), imported = $14, error = null, updated_by = $15, updated_at = now()
              where id = $1`,
            [editId, x.name, x.description, x.host, x.port, x.dbname, x.user_name, x.remote_schema, x.local_schema, x.tables, x.grant_roles, x.writable, serverNameOf(x.name), n, s.username]);
        else
          await c.query(
            `insert into meta.remote_database (name, description, host, port, dbname, user_name, remote_schema, local_schema, tables, grant_roles, writable, server_name,
                                               imported_at, imported, created_by, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13, $14, $14)`,
            [x.name, x.description, x.host, x.port, x.dbname, x.user_name, x.remote_schema, x.local_schema, x.tables, x.grant_roles, x.writable, serverNameOf(x.name), n, s.username]);
        return n;
      });
      await disconnect(owner);
      await logActivity({ username: s.username, event: 'workspace', ip: clientIp(req),
        detail: `remote database ${x.name} ${editId ? 'changed' : 'added'}: ${x.user_name}@${x.host}:${x.port}/${x.dbname} into ${x.local_schema} (${count} tables)`.slice(0, 1000) });
      flash(s, `${x.name}: ${count} table(s) imported into ${x.local_schema}.`);
      return back(reply, s, PAGE);
    } catch (e) {
      const tested = (e as { tested?: number }).tested;
      if (tested !== undefined) {
        flash(s, `The connection works: ${tested} table(s) would be imported into ${x.local_schema}. Nothing was saved.`);
      } else {
        const msg = (e as Error).message.includes('remote_database_name_key') ? `There is a remote database ${x.name} already.`
          : (e as Error).message.includes('remote_database_local_schema_key') ? `Another remote database uses schema ${x.local_schema}.` : (e as Error).message;
        flash(s, `${test ? 'The test failed' : 'Nothing was changed'}: ${msg}`, 'error');
      }
      return back(reply, s, retry);
    }
  });

  app.post(`${PAGE}/:rid/refresh`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (!s) return;
    const r = (await rows()).find((x) => x.id === rid(req.params.rid));
    if (!r) {
      flash(s, 'No such remote database.', 'error');
      return back(reply, s, PAGE);
    }
    try {
      const n = await owner.tx(async (c) => applyRemote(c, r, null, r.grant_roles));
      await owner.query('update meta.remote_database set imported_at = now(), imported = $2, error = null, updated_by = $3, updated_at = now() where id = $1', [r.id, n, s.username]);
      await logActivity({ username: s.username, event: 'workspace', ip: clientIp(req), detail: `remote database ${r.name} imported again (${n} tables)` });
      flash(s, `${r.name}: ${n} table(s) imported into ${r.local_schema}.`);
    } catch (e) {
      await owner.query('update meta.remote_database set error = $2 where id = $1', [r.id, (e as Error).message.slice(0, 1000)]);
      flash(s, `${r.name}: nothing was changed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, PAGE);
  });

  app.post(`${PAGE}/:rid/delete`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (!s) return;
    const r = (await rows()).find((x) => x.id === rid(req.params.rid));
    if (!r) {
      flash(s, 'No such remote database.', 'error');
      return back(reply, s, PAGE);
    }
    try {
      await owner.tx(async (c) => {
        await dropRemote(c, r);
        await c.query('delete from meta.remote_database where id = $1', [r.id]);
      });
      await logActivity({ username: s.username, event: 'workspace', ip: clientIp(req), detail: `remote database ${r.name} deleted (schema ${r.local_schema})` });
      flash(s, `${r.name} deleted with its schema ${r.local_schema}.`);
    } catch (e) {
      flash(s, `${r.name} was not deleted: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, PAGE);
  });

  app.post(`${PAGE}/extension`, async (req: Req, reply) => {
    const s = await administrator(req, reply, TITLE);
    if (!s) return;
    try {
      await owner.query('create extension if not exists postgres_fdw');
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: 'create extension if not exists postgres_fdw' });
      flash(s, 'The postgres_fdw extension is installed.');
    } catch (e) {
      flash(s, `create extension postgres_fdw failed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, PAGE);
  });
}
