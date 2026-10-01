import { runtime } from './db.ts';

export interface AuthzScheme {
  name: string;
  type: 'role' | 'sql';
  value: string;
  error_message: string;
}

export interface NavEntry {
  id: number;
  parent_id: number | null;
  seq: number;
  label: string;
  icon: string | null;
  target_page: number | null;
  authz: string | null;
}

export interface PageSummary {
  page_no: number;
  name: string;
  title: string | null;
  parent_page: number | null;
  mode: 'normal' | 'modal';
  authz: string | null;
  requires_auth: boolean;
}

export interface AppProcess {
  id: number;
  name: string;
  point: 'after_login' | 'before_page';
  code: string;
  authz: string | null;
}

export interface App {
  id: number;
  alias: string;
  name: string;
  home_page: number;
  authentication: 'none' | 'app_users';
  /** 'assigned': only accounts granted access; 'any_user': any active account */
  access_control: 'assigned' | 'any_user';
  /** identity providers offered on the login page, and whether passwords are allowed */
  sso_providers: string[];
  local_login: boolean;
  /** days a "Remember me" sign-in lasts; null = off */
  remember_me_days: number | null;
  /** LDAP directories the password form checks after local accounts */
  ldap_directories: string[];
  db_role: string | null;
  debug: boolean;
  pages: PageSummary[];
  nav: NavEntry[];
  authz_schemes: AuthzScheme[];
  app_items: string[];
  app_processes: AppProcess[];
  lovs: { name: string; query: string }[];
  theme: { accent?: string; header?: string; nav?: 'side' | 'top'; mode?: 'auto' | 'light' | 'dark'; user_choice?: boolean };
  /** primary language, translated languages, and how the language is chosen */
  language: string;
  languages: string[];
  language_from: 'primary' | 'browser' | 'user';
  date_format: string | null;
  timestamp_format: string | null;
}

export interface Region {
  id: number;
  seq: number;
  title: string | null;
  type: 'report' | 'form' | 'chart' | 'cards' | 'static' | 'grid' | 'calendar' | 'dynamic' | 'facets';
  source: string | null;
  table_name: string | null;
  pk_column: string | null;
  pk_item: string | null;
  columns: number;
  template: 'standard' | 'plain' | 'collapsible';
  condition: string | null;
  authz: string | null;
  config: Record<string, any>;
}

export type ItemType =
  | 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'radio'
  | 'checkbox' | 'switch' | 'hidden' | 'display' | 'password'
  | 'checkbox_group' | 'multiselect' | 'popup_lov' | 'email' | 'tel' | 'url' | 'color' | 'file';

export interface Item {
  id: number;
  region_id: number | null;
  seq: number;
  name: string;
  label: string | null;
  type: ItemType;
  lov: string | null;
  source_column: string | null;
  default_value: string | null;
  required: boolean;
  help: string | null;
  readonly_condition: string | null;
  authz: string | null;
  config: Record<string, any>;
}

export interface Button {
  id: number;
  region_id: number | null;
  seq: number;
  name: string;
  label: string;
  action: 'submit' | 'redirect' | 'da';
  target_page: number | null;
  target_items: Record<string, string>;
  condition: string | null;
  authz: string | null;
  hot: boolean;
  confirm: string | null;
}

export interface DynamicAction {
  id: number;
  seq: number;
  name: string;
  event: 'change' | 'click' | 'load';
  trigger_element: string | null;
  condition_type: 'equals' | 'not_equals' | 'in_list' | 'is_null' | 'is_not_null' | null;
  condition_value: string | null;
  action: 'show' | 'hide' | 'enable' | 'disable' | 'set_value' | 'execute_sql' | 'refresh_region' | 'refresh_item' | 'alert' | 'submit';
  affected_items: string | null;
  affected_region_id: number | null;
  code: string | null;
  items_to_submit: string | null;
  message: string | null;
  authz: string | null;
}

export interface Validation {
  id: number;
  name: string;
  item_name: string | null;
  type: 'not_null' | 'sql' | 'regex';
  expression: string | null;
  message: string;
  when_button: string | null;
}

export interface Process {
  id: number;
  name: string;
  type: 'form_dml' | 'grid_dml' | 'sql' | 'data_load';
  region_id: number | null;
  code: string | null;
  config: Record<string, unknown> | null;
  point: 'submit' | 'load';
  when_button: string | null;
  authz: string | null;
  success_message: string | null;
}

export interface Page extends PageSummary {
  id: number;
  app_id: number;
  protection: 'unrestricted' | 'checksum';
  regions: Region[];
  items: Item[];
  buttons: Button[];
  dynamic_actions: DynamicAction[];
  validations: Validation[];
  processes: Process[];
}

const agg = (table: string, fk: string, parent: string, order = 'x.seq, x.id') =>
  `coalesce((select jsonb_agg(to_jsonb(x) order by ${order}) from ${table} x where x.${fk} = ${parent}.id), '[]')`;

// No caching on purpose: edits made in the builder show up on the next request.
export async function loadApp(alias: string) {
  return runtime.one<App>(
    `select a.id, a.alias, a.name, a.home_page, a.authentication, a.access_control, a.sso_providers, a.local_login, a.remember_me_days, a.ldap_directories, a.db_role, a.debug, a.theme,
            a.language, a.languages, a.language_from, a.date_format, a.timestamp_format,
            coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'query', l.query)) from meta.lov l where l.app_id = a.id), '[]') as lovs,
            coalesce((select jsonb_agg(jsonb_build_object('page_no', p.page_no, 'name', p.name, 'title', p.title,
                       'parent_page', p.parent_page, 'mode', p.mode, 'authz', p.authz, 'requires_auth', p.requires_auth))
                        from meta.page p where p.app_id = a.id), '[]') as pages,
            ${agg('meta.nav_entry', 'app_id', 'a')} as nav,
            coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'type', s.type, 'value', s.value, 'error_message', s.error_message))
                        from meta.authz_scheme s where s.app_id = a.id), '[]') as authz_schemes,
            coalesce((select jsonb_agg(i.name) from meta.app_item i where i.app_id = a.id), '[]') as app_items,
            ${agg('meta.app_process', 'app_id', 'a')} as app_processes
       from meta.app a
      where a.alias = $1`,
    [alias],
  );
}

export async function loadPage(appId: number, pageNo: number) {
  return runtime.one<Page>(
    `select p.id, p.app_id, p.page_no, p.name, p.title, p.requires_auth, p.parent_page, p.mode,
            p.protection, p.authz,
            ${agg('meta.region', 'page_id', 'p')} as regions,
            ${agg('meta.item', 'page_id', 'p')} as items,
            ${agg('meta.button', 'page_id', 'p')} as buttons,
            ${agg('meta.dynamic_action', 'page_id', 'p')} as dynamic_actions,
            ${agg('meta.validation', 'page_id', 'p')} as validations,
            ${agg('meta.process', 'page_id', 'p')} as processes
       from meta.page p
      where p.app_id = $1 and p.page_no = $2`,
    [appId, pageNo],
  );
}

/** The roles an account has in an application (resolved once, at sign-in). */
export async function accountRoles(appId: number, username: string) {
  const r = await runtime.one<{ roles: string[] }>('select meta.account_roles($1, $2) as roles', [appId, username]);
  return r?.roles ?? [];
}
