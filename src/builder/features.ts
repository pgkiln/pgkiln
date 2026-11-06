import type { FastifyInstance } from 'fastify';
import { owner, type Client } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { appPublicKey } from '../push.ts';
import { secretKeyConfigured } from '../secrets.ts';
import { appOr404 } from './forms.ts';
import { createLoginPage } from './login-page.ts';
import { ABOUT_PAGE, ACTIVITY_PAGE, addAboutPage, addAccessSchemes, addActivityPage, ensureAdminScheme } from './newapp.ts';
import { appHeader, back, BASE, csrf, developer, flash, region, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// (sprint 137, AP-3) Add feature (APEX: Create a Page → Feature, and App home → Tasks → Add Feature Page):
// the Create Application wizard's features (newapp.ts) and a few more, added to an existing application.
// Each says what it adds before it creates anything, refuses to install twice, and shows as installed
// (greyed out) on the Create page grid's Feature tab afterwards. Everything is a plain form.

/** The page number of the Configuration page (Configuration options). */
export const CONFIG_PAGE = 9020;

interface AppRow {
  id: number;
  alias: string;
  name: string;
  authentication: string;
  feedback: boolean;
  pwa: boolean;
  pwa_push: boolean;
  login_page: number | null;
  theme: Record<string, unknown> | null;
}

export interface Feature {
  key: string;
  label: string;
  icon: string;
  help: string;
  /** what installing adds, in words */
  adds: (a: AppRow) => string[];
  /** installed already */
  installed: (c: Client, a: AppRow) => Promise<boolean>;
  /** why it can't be installed (when not installed), or null */
  blocked?: (c: Client, a: AppRow) => Promise<string | null>;
  /** fields of the review form */
  fields?: (a: AppRow) => Promise<Raw | string>;
  /** install (in the caller's transaction); returns the page to open, if any */
  install: (c: Client, a: AppRow, b: Record<string, unknown>) => Promise<number | null>;
}

const pageExists = async (c: Client, appId: number, no: number) => !!(await c.query('select 1 from meta.page where app_id = $1 and page_no = $2', [appId, no])).rowCount;
const pageId = async (c: Client, appId: number, no: number) => (await c.query<{ id: number }>('select id from meta.page where app_id = $1 and page_no = $2', [appId, no])).rows[0]?.id ?? null;
/** a page of the feature: the page number holds a component whose code mentions the marker */
const pageHas = async (c: Client, appId: number, no: number, marker: string) =>
  !!(await c.query(
    `select 1 from meta.page p where p.app_id = $1 and p.page_no = $2
        and (exists (select 1 from meta.region r where r.page_id = p.id and r.source like '%' || $3 || '%')
          or exists (select 1 from meta.item i where i.page_id = p.id and i.lov like '%' || $3 || '%')
          or exists (select 1 from meta.process x where x.page_id = p.id and x.code like '%' || $3 || '%'))`,
    [appId, no, marker],
  )).rowCount;

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export const FEATURE_LIST: Feature[] = [
  {
    key: 'access',
    label: 'Access control',
    icon: 'lock',
    help: 'Authorization schemes for the roles admin, contributor and reader, to put on pages, regions and buttons.',
    adds: () => [
      tx('feat.a.access_1'),
      tx('feat.a.access_2'),
    ],
    installed: async (c, a) => (await c.query(`select count(*)::int as n from meta.authz_scheme where app_id = $1 and name in ('CONTRIBUTOR', 'READER')`, [a.id])).rows[0].n === 2,
    install: async (c, a) => {
      await addAccessSchemes(c, a.id);
      return null;
    },
  },
  {
    key: 'activity',
    label: 'Activity reporting',
    icon: 'activity',
    help: 'A page for administrators with the page views per day and the latest activity.',
    adds: () => [
      tx('feat.a.activity_1', { page: ACTIVITY_PAGE }),
      tx('feat.a.activity_2'),
      tx('feat.a.activity_3'),
    ],
    installed: (c, a) => pageHas(c, a.id, ACTIVITY_PAGE, 'meta.app_activity'),
    blocked: async (c, a) => ((await pageExists(c, a.id, ACTIVITY_PAGE)) ? tx('feat.page_in_use', { page: ACTIVITY_PAGE }) : null),
    install: async (c, a) => {
      await addActivityPage(c, a.id);
      return pageId(c, a.id, ACTIVITY_PAGE);
    },
  },
  {
    key: 'config',
    label: 'Configuration options',
    icon: 'sliders',
    help: 'A page where the application\'s administrators switch build options on and off while it runs.',
    adds: () => [
      tx('feat.a.config_1', { page: CONFIG_PAGE }),
      tx('feat.a.config_2'),
      tx('feat.a.config_3'),
    ],
    installed: (c, a) => pageHas(c, a.id, CONFIG_PAGE, 'meta.set_configurable_options'),
    blocked: async (c, a) => ((await pageExists(c, a.id, CONFIG_PAGE)) ? tx('feat.page_in_use', { page: CONFIG_PAGE }) : null),
    fields: async (a) => {
      const opts = (await owner.query<{ name: string; description: string | null; status: string; configurable: boolean }>(
        'select name, description, status, configurable from meta.build_option where app_id = $1 order by name', [a.id])).rows;
      return opts.length
        ? html`<fieldset class="prop-group"><legend>${tx('feat.cbo')}</legend><div class="qb-pick">${opts.map((o) =>
            html`<label class="check"><input type="checkbox" name="options" value="${o.name}"${o.configurable ? raw(' checked') : ''}> ${o.name} <span class="muted small">${o.status}${o.description ? `, ${o.description}` : ''}</span></label>`)}</div></fieldset>`
        : html`<p class="muted">${tx.rich('feat.no_build_options', { configurable: html`<em>${tx('feat.configurable')}</em>` })}</p>`;
    },
    install: async (c, a, b) => {
      const chosen = ([] as unknown[]).concat(b.options ?? []).map(String);
      await c.query('update meta.build_option set configurable = (name = any($2)) where app_id = $1', [a.id, chosen]);
      await ensureAdminScheme(c, a.id);
      const home = (await c.query('select home_page from meta.app where id = $1', [a.id])).rows[0].home_page;
      const page = (await c.query(`insert into meta.page (app_id, page_no, name, title, parent_page, authz) values ($1, $2, 'Configuration', 'Configuration', $3, 'ADMIN') returning id`, [a.id, CONFIG_PAGE, home])).rows[0].id;
      const regionId = (await c.query(`insert into meta.region (page_id, seq, title, type) values ($1, 10, 'Configuration options', 'form') returning id`, [page])).rows[0].id;
      const item = `P${CONFIG_PAGE}_OPTIONS`;
      await c.query(
        `insert into meta.item (page_id, region_id, seq, name, label, type, lov, config, help) values ($1, $2, 10, $3, 'Options', 'checkbox_group',
           'select description as d, name as r from meta.configurable_options()', '{"switches": true}', 'Switched on: the parts of the application that belong to the option are shown.')`,
        [page, regionId, item],
      );
      await c.query(
        `insert into meta.computation (page_id, seq, item_name, point, type, expression) values ($1, 10, $2, 'before_header', 'sql_query',
           'select string_agg(name, '':'' order by name) from meta.configurable_options() where enabled')`,
        [page, item],
      );
      await c.query(`insert into meta.button (page_id, region_id, seq, name, label, action, hot) values ($1, $2, 10, 'SAVE', 'Save', 'submit', true)`, [page, regionId]);
      await c.query(
        `insert into meta.process (page_id, seq, name, type, code, when_button, success_message) values ($1, 10, 'Save the configuration', 'sql', $2, 'SAVE', 'Configuration saved.')`,
        [page, `select meta.set_configurable_options(:${item})`],
      );
      await c.query(`insert into meta.nav_entry (app_id, seq, label, icon, target_page, authz) values ($1, 9020, 'Configuration', 'sliders', $2, 'ADMIN')`, [a.id, CONFIG_PAGE]);
      return page;
    },
  },
  {
    key: 'email',
    label: 'E-mail reporting',
    icon: 'mail',
    help: 'A weekly e-mail to the administrators with the application\'s activity, the rows as a CSV file.',
    adds: () => [
      tx('feat.a.email_1'),
      tx('feat.a.email_2'),
      tx('feat.a.email_3'),
    ],
    installed: async (c, a) => !!(await c.query(`select 1 from meta.automation where app_id = $1 and name = 'EMAIL_REPORTING'`, [a.id])).rowCount,
    fields: async () => html`<div class="field"><label class="label" for="f_report_to">${tx('feat.send_to')}</label>
        <input id="f_report_to" name="report_to" type="text" placeholder="admin@example.com, boss@example.com" autocomplete="off">
        <small class="help">${tx('feat.send_to_help')}</small></div>`,
    install: async (c, a, b) => {
      const to = String(b.report_to ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const bad = to.find((x) => !EMAIL.test(x));
      if (bad) throw new Error(tx('feat.not_email', { address: bad.slice(0, 100) }));
      if (to.join(', ').length > 4000) throw new Error(tx('feat.too_many'));
      await c.query(
        `insert into meta.app_setting (app_id, name, value, description) values ($1, 'EMAIL_REPORT_TO', $2, 'E-mail reporting: the addresses of the weekly activity report (comma separated)')
         on conflict (app_id, name) do nothing`,
        [a.id, to.join(', ') || null],
      );
      await c.query(
        `insert into meta.automation (app_id, name, description, schedule, time_zone) values ($1, 'EMAIL_REPORTING', 'E-mail reporting: the activity of the last 7 days to EMAIL_REPORT_TO', '0 7 * * 1', 'UTC')`,
        [a.id],
      );
      await c.query(`insert into meta.automation_action (app_id, automation_name, seq, name, code) values ($1, 'EMAIL_REPORTING', 10, 'Send the activity report', $2)`, [a.id, CODE_EMAIL]);
      return null;
    },
  },
  {
    key: 'feedback',
    label: 'Feedback',
    icon: 'message-square',
    help: 'Users send feedback from the header; you read it under the application\'s Activity → Feedback.',
    adds: () => [tx('feat.a.feedback_1'), tx('feat.a.feedback_2')],
    installed: async (_c, a) => a.feedback,
    install: async (c, a) => {
      await c.query('update meta.app set feedback = true, updated_at = now() where id = $1', [a.id]);
      return null;
    },
  },
  {
    key: 'about',
    label: 'About page',
    icon: 'info',
    help: 'An About page in a Help menu of the header.',
    adds: () => [tx('feat.a.about_1', { page: ABOUT_PAGE }), tx('feat.a.about_2')],
    installed: (c, a) => pageExists(c, a.id, ABOUT_PAGE),
    install: async (c, a) => {
      await addAboutPage(c, a.id);
      return pageId(c, a.id, ABOUT_PAGE);
    },
  },
  {
    key: 'login',
    label: 'Login page',
    icon: 'log-in',
    help: 'The application\'s own login page instead of the built-in sign-in page, editable in the Page Designer.',
    adds: () => [tx('feat.a.login_1'), tx('feat.a.login_2')],
    installed: async (_c, a) => a.login_page !== null,
    blocked: async (_c, a) => (a.authentication === 'none' ? tx('feat.no_signin') : null),
    install: async (c, a) => (await createLoginPage(c, a)).page,
  },
  {
    key: 'theme',
    label: 'Theme style selection',
    icon: 'palette',
    help: 'Users choose the light or the dark theme in their user menu (Appearance).',
    adds: () => [tx('feat.a.theme_1')],
    installed: async (_c, a) => a.theme?.user_choice !== false,
    install: async (c, a) => {
      await c.query(`update meta.app set theme = coalesce(theme, '{}') - 'user_choice', updated_at = now() where id = $1`, [a.id]);
      return null;
    },
  },
  {
    key: 'push',
    label: 'Push notifications',
    icon: 'bell',
    help: 'Notifications to the users\' devices, from processes and SQL (meta.send_push); the application becomes installable.',
    adds: () => [tx('feat.a.push_1'), tx('feat.a.push_2'), tx('feat.a.push_3')],
    installed: async (_c, a) => a.pwa_push,
    blocked: async () => (secretKeyConfigured() ? null : tx('feat.push_needs_key')),
    install: async (c, a) => {
      await c.query('update meta.app set pwa = true, pwa_push = true, updated_at = now() where id = $1', [a.id]);
      return null;
    },
  },
];

const CODE_EMAIL = `select meta.send_activity_report(meta.get_app_setting('EMAIL_REPORT_TO'), 7)`;

/** A feature's label and help in the builder language (FEATURE_LIST stays English). */
export const featLabel = (f: Feature) => tx.dyn(`feat.f.${f.key}`, f.label);
export const featHelp = (f: Feature) => tx.dyn(`feat.h.${f.key}`, f.help);
const FEATURES_BY_KEY = new Map(FEATURE_LIST.map((f) => [f.key, f]));

async function appRow(id: string | number, c?: Client): Promise<AppRow | null> {
  const q = 'select id, alias, name, authentication, feedback, pwa, pwa_push, login_page, theme from meta.app where id = $1';
  return c ? ((await c.query<AppRow>(q, [id])).rows[0] ?? null) : ((await owner.one<AppRow>(q, [id])) ?? null);
}

/** Each feature with whether it is installed or blocked, for the Feature tab. */
export async function featureStates(appId: number) {
  return owner.tx(async (c) => {
    const a = (await appRow(appId, c))!;
    const out: { f: Feature; installed: boolean; blocked: string | null }[] = [];
    for (const f of FEATURE_LIST) {
      const installed = await f.installed(c, a);
      out.push({ f, installed, blocked: installed ? null : ((await f.blocked?.(c, a)) ?? null) });
    }
    return out;
  });
}

export async function featureRoutes(app: FastifyInstance) {
  // the review: what the feature adds, and Install (or why not)
  app.get(`${BASE}/apps/:id/features/:key`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a0 = await appOr404(req.params.id);
    const f = FEATURES_BY_KEY.get(String(req.params.key));
    if (!a0 || !f) return reply.code(404).send('Not found');
    const a = (await appRow(a0.id))!;
    const { installed, blocked } = await owner.tx(async (c) => {
      const installed = await f.installed(c, a);
      return { installed, blocked: installed ? null : ((await f.blocked?.(c, a)) ?? null) };
    });
    const main = html`${appHeader(a0, 'pages', s)}
      ${region(featLabel(f), html`
        <p class="muted u-mt0">${icon(f.icon)} ${featHelp(f)}</p>
        ${installed
          ? html`<p class="alert alert-info" role="status">${tx('feat.installed_already', { feature: featLabel(f) })}</p>`
          : blocked ? html`<p class="alert alert-error" role="status">${blocked}</p>` : ''}
        <h3>${installed ? tx('feat.it_added') : tx('feat.it_adds')}</h3>
        <ul class="cp-adds">${f.adds(a).map((x) => html`<li>${x}</li>`)}</ul>
        ${installed || blocked
          ? html`<div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}/create-page?tab=feature">${tx('feat.back_to_the_features')}</a></div>`
          : html`<form method="post" action="${BASE}/apps/${a.id}/features/${f.key}">${csrf(s)}
              ${f.fields ? await f.fields(a) : ''}
              <div class="buttons"><a class="btn" href="${BASE}/apps/${a.id}/create-page?tab=feature">${tx('feat.cancel')}</a><button class="btn btn-hot">${tx('feat.add', { feature: featLabel(f).toLowerCase() })}</button></div>
            </form>`}`)}`;
    return send(reply, s, shell(s, tx('feat.title', { feature: featLabel(f), app: a.name }), [[tx('feat.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('feat.create_page'), `${BASE}/apps/${a.id}/create-page?tab=feature`], [featLabel(f)]], main));
  });

  app.post(`${BASE}/apps/:id/features/:key`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const f = FEATURES_BY_KEY.get(String(req.params.key));
    if (!f || !(await appRow(req.params.id))) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const page = await owner.tx(async (c) => {
        // one at a time per application, and never twice
        await c.query('select 1 from meta.app where id = $1 for update', [req.params.id]);
        const a = (await appRow(req.params.id, c))!;
        if (await f.installed(c, a)) throw new Error(tx('feat.installed_already', { feature: featLabel(f) }));
        const blocked = await f.blocked?.(c, a);
        if (blocked) throw new Error(blocked);
        return f.install(c, a, b);
      });
      // the push key pair after the commit (as the Create Application wizard does)
      if (f.key === 'push') await appPublicKey(Number(req.params.id)).catch(() => undefined);
      flash(s, tx('feat.added', { feature: featLabel(f) }));
      return back(reply, s, page ? `${BASE}/pages/${page}` : `${BASE}/apps/${req.params.id}/create-page?tab=feature`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, `${BASE}/apps/${req.params.id}/features/${f.key}`);
    }
  });
}
