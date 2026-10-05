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
  authentication: 'none' | 'app_users' | 'header' | 'database' | 'custom';
  /** header authentication: the user-name header, automatic accounts, sign-out URL */
  header_name: string | null;
  header_auto_create: boolean | null;
  /** database authentication: the roles that may sign in, or the members of db_auth_member_of */
  db_auth_roles: string[] | null;
  db_auth_member_of: string | null;
  /** custom authentication: a named function or a PL/pgSQL body checking p_username and p_password, and post-authentication code */
  custom_auth_function: string | null;
  custom_auth_code: string | null;
  custom_auth_post_code: string | null;
  /** lists (meta.list) shown as the navigation menu and the navigation bar */
  nav_list: string | null;
  navbar_list: string | null;
  logout_url: string | null;
  /** 'assigned': only accounts granted access; 'any_user': any active account */
  access_control: 'assigned' | 'any_user';
  /** identity providers offered on the login page, and whether passwords are allowed */
  sso_providers: string[];
  local_login: boolean;
  /** days a "Remember me" sign-in lasts; null = off */
  remember_me_days: number | null;
  /** LDAP directories the password form checks after local accounts */
  ldap_directories: string[];
  /** Progressive Web App: installable, offline pages, offline form queue */
  pwa: boolean;
  pwa_short_name: string | null;
  pwa_has_icon: boolean;
  pwa_offline_pages: boolean;
  pwa_offline_submit: boolean;
  db_role: string | null;
  debug: boolean;
  /** debug messages: 0 off, else the APEX level 1–9 of what requests record (src/debug.ts) */
  debug_level: number;
  pages: PageSummary[];
  nav: NavEntry[];
  authz_schemes: AuthzScheme[];
  app_items: string[];
  app_processes: AppProcess[];
  lovs: { name: string; query: string; rest_source?: string | null }[];
  theme: {
    accent?: string; header?: string; nav?: 'side' | 'top'; mode?: 'auto' | 'light' | 'dark'; user_choice?: boolean;
    /** (053) Theme Roller style variants, the default one, and whether users may choose (src/runtime/styles.ts) */
    styles?: unknown[]; style?: string; style_choice?: boolean;
  };
  /** primary language, translated languages, and how the language is chosen */
  language: string;
  languages: string[];
  language_from: 'primary' | 'browser' | 'user';
  date_format: string | null;
  timestamp_format: string | null;
  /** the app's time zone (IANA name), automatic time zone per user, ISO currency for number masks */
  time_zone: string | null;
  time_zone_auto: boolean | null;
  currency: string | null;
}

export interface Region {
  id: number;
  seq: number;
  title: string | null;
  type: 'report' | 'form' | 'chart' | 'cards' | 'static' | 'grid' | 'calendar' | 'dynamic' | 'facets' | 'tasks' | 'workflows' | 'map' | 'tree' | 'template_component' | 'smart_filters' | 'display_selector' | 'list' | 'data_reporter';
  source: string | null;
  table_name: string | null;
  pk_column: string | null;
  pk_item: string | null;
  columns: number;
  template: 'standard' | 'plain' | 'collapsible';
  condition: string | null;
  authz: string | null;
  config: Record<string, any>;
  /** a REST data source the region reads (its source, if any, is SQL over the CTE "rest") */
  rest_source?: string | null;
  /** (053) template options: CSS classes from REGION_OPTIONS (others are ignored) */
  template_options?: string[];
}

export type ItemType =
  | 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'radio'
  | 'checkbox' | 'switch' | 'hidden' | 'display' | 'password'
  | 'checkbox_group' | 'multiselect' | 'popup_lov' | 'email' | 'tel' | 'url' | 'color' | 'file' | 'location'
  | 'richtext' | 'markdown' | 'rating' | 'combobox' | 'daterange' | 'qrcode';

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
  action: 'submit' | 'redirect' | 'da' | 'document' | 'menu';
  target_page: number | null;
  /** action = document: the document template to download */
  document?: string | null;
  target_items: Record<string, string>;
  condition: string | null;
  authz: string | null;
  hot: boolean;
  confirm: string | null;
  /** action = menu: links ({label, page, items}) and submit requests ({label, request}) */
  menu?: MenuEntry[] | null;
  /** a badge: static text with &ITEM. substitutions, or a query's first value (badge_query wins) */
  badge?: string | null;
  badge_query?: string | null;
  /** (053) template options: CSS classes from BUTTON_OPTIONS (others are ignored) */
  template_options?: string[];
}

export interface MenuEntry {
  label: string;
  page?: number;
  items?: Record<string, string>;
  request?: string;
  confirm?: string;
  authz?: string;
  icon?: string;
}

/** A condition of a computation or branch (see migration 029). */
export interface Condition {
  condition_type: 'sql' | 'exists' | 'not_exists' | 'item_null' | 'item_not_null' | 'item_equals' | 'item_not_equals' | 'request_in' | null;
  condition_expr: string | null;
  condition_value: string | null;
}

export interface Computation extends Condition {
  id: number;
  seq: number;
  item_name: string;
  point: 'before_header' | 'after_submit';
  type: 'static' | 'item' | 'sql_query' | 'sql_expression' | 'function_body';
  expression: string | null;
  authz: string | null;
}

export interface Branch extends Condition {
  id: number;
  seq: number;
  name: string;
  point: 'before_header' | 'after_processing';
  when_button: string | null;
  target_type: 'page' | 'url' | 'function' | 'app';
  target_page: number | null;
  target_items: Record<string, string> | null;
  target_url: string | null;
  /** function: a PL/pgSQL body returning a path inside the application (migration 039) */
  target_function?: string | null;
  /** app: the alias of another application of this installation */
  target_app?: string | null;
  authz: string | null;
}

export interface DynamicAction {
  id: number;
  seq: number;
  name: string;
  event: 'change' | 'click' | 'load' | 'dialog_closed';
  trigger_element: string | null;
  condition_type: 'equals' | 'not_equals' | 'in_list' | 'is_null' | 'is_not_null' | null;
  condition_value: string | null;
  action: 'show' | 'hide' | 'enable' | 'disable' | 'set_value' | 'execute_sql' | 'refresh_region' | 'refresh_item' | 'alert' | 'submit'
    | 'set_focus' | 'add_class' | 'remove_class' | 'show_success' | 'show_error' | 'clear_errors';
  affected_items: string | null;
  affected_region_id: number | null;
  code: string | null;
  items_to_submit: string | null;
  message: string | null;
  /** add_class / remove_class: space separated class names (checked by the database) */
  css_classes?: string | null;
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
  type: 'form_dml' | 'grid_dml' | 'sql' | 'data_load' | 'invoke_api' | 'download' | 'chain' | 'workflow';
  region_id: number | null;
  code: string | null;
  config: Record<string, unknown> | null;
  point: 'submit' | 'load';
  when_button: string | null;
  authz: string | null;
  success_message: string | null;
  /** a child of the chain process of this name: runs only inside that chain (migration 039) */
  parent_process?: string | null;
  condition_type?: Condition['condition_type'];
  condition_expr?: string | null;
  condition_value?: string | null;
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
  computations: Computation[];
  branches: Branch[];
}

// Components whose build option is excluded are left out here, so the runtime
// neither renders nor runs them (meta.build_option_on, migration 029).
const agg = (table: string, fk: string, parent: string, appId: string) =>
  `coalesce((select jsonb_agg(to_jsonb(x) order by x.seq, x.id) from ${table} x where x.${fk} = ${parent}.id and meta.build_option_on(${appId}, x.build_option)), '[]')`;

// No caching on purpose: edits made in the builder show up on the next request.
export async function loadApp(alias: string) {
  return runtime.one<App>(
    `select a.id, a.alias, a.name, a.home_page, a.authentication, a.access_control, a.sso_providers, a.local_login, a.remember_me_days, a.ldap_directories, a.header_name, a.header_auto_create, a.logout_url, a.db_auth_roles, a.db_auth_member_of, a.custom_auth_function, a.custom_auth_code, a.custom_auth_post_code, a.nav_list, a.navbar_list, a.pwa, a.pwa_short_name, a.pwa_icon is not null as pwa_has_icon, a.pwa_offline_pages, a.pwa_offline_submit, a.db_role, a.debug, a.debug_level, a.theme,
            a.language, a.languages, a.language_from, a.date_format, a.timestamp_format, a.time_zone, a.time_zone_auto, a.currency,
            coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'query', l.query, 'rest_source', l.rest_source)) from meta.lov l where l.app_id = a.id), '[]') as lovs,
            coalesce((select jsonb_agg(jsonb_build_object('page_no', p.page_no, 'name', p.name, 'title', p.title,
                       'parent_page', p.parent_page, 'mode', p.mode, 'authz', p.authz, 'requires_auth', p.requires_auth))
                        from meta.page p where p.app_id = a.id and meta.build_option_on(a.id, p.build_option)), '[]') as pages,
            ${agg('meta.nav_entry', 'app_id', 'a', 'a.id')} as nav,
            coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'type', s.type, 'value', s.value, 'error_message', s.error_message))
                        from meta.authz_scheme s where s.app_id = a.id), '[]') as authz_schemes,
            coalesce((select jsonb_agg(i.name) from meta.app_item i where i.app_id = a.id), '[]') as app_items,
            ${agg('meta.app_process', 'app_id', 'a', 'a.id')} as app_processes
       from meta.app a
      where a.alias = $1`,
    [alias],
  );
}

export async function loadPage(appId: number, pageNo: number) {
  return runtime.one<Page>(
    `select p.id, p.app_id, p.page_no, p.name, p.title, p.requires_auth, p.parent_page, p.mode,
            p.protection, p.authz,
            ${agg('meta.region', 'page_id', 'p', 'p.app_id')} as regions,
            ${agg('meta.item', 'page_id', 'p', 'p.app_id')} as items,
            ${agg('meta.button', 'page_id', 'p', 'p.app_id')} as buttons,
            ${agg('meta.dynamic_action', 'page_id', 'p', 'p.app_id')} as dynamic_actions,
            ${agg('meta.validation', 'page_id', 'p', 'p.app_id')} as validations,
            ${agg('meta.process', 'page_id', 'p', 'p.app_id')} as processes,
            ${agg('meta.computation', 'page_id', 'p', 'p.app_id')} as computations,
            ${agg('meta.branch', 'page_id', 'p', 'p.app_id')} as branches
       from meta.page p
      where p.app_id = $1 and p.page_no = $2 and meta.build_option_on(p.app_id, p.build_option)`,
    [appId, pageNo],
  );
}

/** The roles an account has in an application (resolved once, at sign-in). */
export async function accountRoles(appId: number, username: string) {
  const r = await runtime.one<{ roles: string[] }>('select meta.account_roles($1, $2) as roles', [appId, username]);
  return r?.roles ?? [];
}
