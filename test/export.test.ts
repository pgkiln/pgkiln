// Application export/import (format pgapex/2): round trip and coverage of
// every metadata table.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/env.ts';
import { closePools, owner } from '../src/db.ts';

after(closePools);

/** Tables that belong to an app or page but are deliberately not exported. */
const NOT_EXPORTED = new Set([
  'app_access', // who may sign in: accounts are per installation
  'api_client', // OAuth clients carry secrets
  'session',
  'activity_log',
  'sso_pending',
  'saved_report', // users' saved interactive reports
  'persistent_login', // "Remember me" tokens of this installation's accounts
  'task', // task instances are data, not application definition
  'workflow', // workflow instances likewise
]);

/** Where each exported table appears in the document. */
const SECTIONS: Record<string, string> = {
  authz_scheme: 'authz_schemes',
  app_item: 'app_items',
  app_process: 'app_processes',
  lov: 'lovs',
  app_group_role: 'group_roles',
  text_message: 'text_messages',
  translation: 'translations',
  report_layout: 'report_layouts',
  automation: 'automations',
  document_template: 'document_templates',
  task_definition: 'task_definitions',
  workflow_definition: 'workflow_definitions',
  rest_module: 'rest_modules',
  template_component: 'template_components',
  build_option: 'build_options',
  nav_entry: 'nav',
  page: 'pages',
  region: 'pages[].regions',
  item: 'pages[].items',
  button: 'pages[].buttons',
  dynamic_action: 'pages[].dynamic_actions',
  validation: 'pages[].validations',
  process: 'pages[].processes',
  computation: 'pages[].computations',
  branch: 'pages[].branches',
};

/** A document without ids and the references between them (they change on import). */
function normalise(doc: any) {
  const strip = (x: any) => {
    const { id, parent_id, region_id, affected_region_id, ...rest } = x;
    if (rest.config?.report !== undefined) rest.config = { ...rest.config, report: '(region)' };
    return rest;
  };
  return {
    ...doc,
    app: { ...doc.app, alias: '(alias)' },
    // imported automations are switched off on purpose
    automations: doc.automations.map((a: any) => ({ ...a, enabled: '(any)' })),
    nav: doc.nav.map(strip),
    pages: doc.pages.map((p: any) => ({
      ...p,
      regions: p.regions.map(strip),
      items: p.items.map(strip),
      buttons: p.buttons.map(strip),
      dynamic_actions: p.dynamic_actions.map(strip),
      validations: p.validations.map(strip),
      processes: p.processes.map(strip),
    })),
  };
}

describe('application export', () => {
  test('every table of an app or page is exported, or listed as not exported', async () => {
    const tables = (
      await owner.query(
        `select distinct c.relname as name
           from pg_constraint k
           join pg_class c on c.oid = k.conrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'meta' and k.contype = 'f' and c.relkind = 'r'
            and k.confrelid in ('meta.app'::regclass, 'meta.page'::regclass)
          order by 1`,
      )
    ).rows.map((r) => r.name as string);
    const missing = tables.filter((t) => !SECTIONS[t] && !NOT_EXPORTED.has(t));
    assert.deepEqual(missing, [], 'add the table to export_app/import_app (and SECTIONS here), or to NOT_EXPORTED with a reason');
  });

  test('export → import → export gives the same document', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.equal(doc.format, 'pgapex/2');
    for (const key of ['app', 'authz_schemes', 'app_items', 'app_processes', 'lovs', 'group_roles', 'text_messages', 'translations', 'report_layouts', 'automations', 'document_templates', 'task_definitions', 'workflow_definitions', 'rest_modules', 'template_components', 'build_options', 'nav', 'pages'])
      assert.ok(key in doc, `section ${key}`);
    assert.ok(doc.report_layouts.length && doc.pages.some((p: any) => p.regions.some((r: any) => r.type === 'facets')), 'the HR sample covers layouts and facets');
    assert.ok(doc.template_components.length >= 3, 'the HR sample covers template components');
    assert.ok(doc.build_options.length >= 1, 'the HR sample covers build options');
    assert.ok(doc.pages.some((p: any) => p.computations.length && p.branches.length), 'the HR sample covers computations and branches');
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_roundtrip') as id`, [JSON.stringify(doc)])).id;
    try {
      const again = (await owner.one(`select meta.export_app('hr_roundtrip') as d`)).d;
      assert.deepEqual(normalise(again), normalise(doc));
      // references point inside the copy
      const facets = await owner.query(
        `select r.config->>'report' as report,
                (select p2.app_id from meta.region r2 join meta.page p2 on p2.id = r2.page_id where r2.id = (r.config->>'report')::int) as report_app
           from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.type in ('facets', 'map') and r.config ? 'report'`,
        [id],
      );
      assert.ok(facets.rows.length >= 2, 'the HR sample has facets and a map that filters a report');
      for (const f of facets.rows) assert.equal(f.report_app, id, 'facets and maps point at the copied report');
      const parents = await owner.one(
        `select count(*)::int as n from meta.nav_entry c join meta.nav_entry p on p.id = c.parent_id where c.app_id = $1 and p.app_id <> $1`,
        [id],
      );
      assert.equal(parents.n, 0, 'navigation parents inside the copy');
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });

  test('older files without the newer sections still import', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    // as exported by 0.2.0: no LOVs, group roles, texts, translations or layouts
    for (const k of ['lovs', 'group_roles', 'text_messages', 'translations', 'report_layouts', 'automations']) delete doc[k];
    const id = (await owner.one(`select meta.import_app($1::jsonb, 'hr_old_format') as id`, [JSON.stringify(doc)])).id;
    try {
      assert.ok((await owner.one('select count(*)::int as n from meta.page where app_id = $1', [id])).n > 5);
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });

  test('unknown formats and accounts are refused or left out', async () => {
    await assert.rejects(owner.query(`select meta.import_app('{"format": "pgapex/9"}'::jsonb, 'x')`), /unsupported export format pgapex\/9/);
    await assert.rejects(owner.query(`select meta.import_app('{}'::jsonb, 'x')`), /unsupported export format \(none\)/);
    const text = JSON.stringify((await owner.one(`select meta.export_app('hr') as d`)).d);
    for (const secret of ['password_hash', 'secret_hash', 'client_secret']) assert.ok(!text.includes(secret), `no ${secret}`);
  });
});
