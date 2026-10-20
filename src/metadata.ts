import { runtime } from './db.ts';
import type { Plugin } from './runtime/plugins.ts';

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
  /** (065) modal pages: a centred dialog or a drawer from an edge, and its size */
  dialog_position?: 'center' | 'left' | 'right' | 'top' | 'bottom';
  dialog_size?: 'small' | 'medium' | 'large';
}

/** (068) a static application file a page loads: its name and a version (for the browser cache) */
export interface StaticInclude {
  name: string;
  v: number;
}

export interface AppProcess {
  id: number;
  name: string;
  point: 'after_login' | 'before_page' | 'ajax';
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
  /** (087) the page that replaces the built-in sign-in page */
  login_page: number | null;
  /** (087) offer "Forgot password?" (with an enabled mail service) */
  password_reset: boolean;
  /** (067) session sharing group (src/sharedlogin.ts) */
  session_group: string | null;
  /** LDAP directories the password form checks after local accounts */
  ldap_directories: string[];
  /** Progressive Web App: installable, offline pages, offline form queue */
  pwa: boolean;
  pwa_short_name: string | null;
  pwa_has_icon: boolean;
  pwa_offline_pages: boolean;
  pwa_offline_submit: boolean;
  /** (074) users may turn on push notifications (src/push.ts) */
  pwa_push: boolean;
  db_role: string | null;
  debug: boolean;
  /** debug messages: 0 off, else the APEX level 1–9 of what requests record (src/debug.ts) */
  debug_level: number;
  /** (083) who may use the application, and the message when it is unavailable */
  availability: import('./runtime/availability.ts').Availability;
  availability_message: string | null;
  availability_users: string[];
  /** (084) users can send feedback from the navigation bar */
  feedback: boolean;
  /** (107) the application's version (Release 1.0), shown in its pages' footer */
  version: string | null;
  /** (085) schema.function(jsonb) returns jsonb that rewrites error messages; seconds of the session timeout warning */
  error_function: string | null;
  session_warning_seconds: number;
  pages: PageSummary[];
  nav: NavEntry[];
  authz_schemes: AuthzScheme[];
  app_items: string[];
  app_processes: AppProcess[];
  /** (102) application computations: run for every page at their point, before the page's own */
  app_computations: AppComputation[];
  /** (105) defaults of the built-in component types (runtime/component-settings.ts) */
  component_settings: import('./runtime/component-settings.ts').ComponentSettings;
  /** (103) shortcuts: "NAME" in static content, help texts and confirm messages (runtime/shortcuts.ts) */
  shortcuts?: { name: string; type: 'text' | 'html' | 'function_body'; value: string }[];
  lovs: { name: string; query: string; rest_source?: string | null }[];
  theme: {
    accent?: string; header?: string; nav?: 'side' | 'top'; mode?: 'auto' | 'light' | 'dark'; user_choice?: boolean;
    /** (053) Theme Roller style variants, the default one, and whether users may choose (src/runtime/styles.ts) */
    styles?: unknown[]; style?: string; style_choice?: boolean;
    /** (0.29) the base style: 'iris' or Standard (src/runtime/styles.ts) */
    base?: string;
    /** (0.29) the accent and header colours in dark mode */
    accent_dark?: string; header_dark?: string;
    /** (sprint 117) the navigation appearance (Pillar Light / Dark) and the header pillar strip's colours */
    appearance?: string; strip?: string; strip_dark?: string;
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
  /** (068) static files (.js, .css) every page loads, in order; missing files are left out */
  static_includes: StaticInclude[];
  /** (069) plug-ins (src/runtime/plugins.ts); install_sql is not loaded */
  plugins: Plugin[];
  /** (069) every static file's version, for plug-ins' files */
  static_files: StaticInclude[];
}

export interface Region {
  id: number;
  seq: number;
  title: string | null;
  /** (0.31, 073) optional, unique on the page */
  static_id?: string | null;
  type: 'login' | 'report' | 'form' | 'chart' | 'cards' | 'static' | 'grid' | 'calendar' | 'dynamic' | 'facets' | 'tasks' | 'workflows' | 'map' | 'tree' | 'template_component' | 'smart_filters' | 'display_selector' | 'list' | 'data_reporter' | 'ai_assistant' | 'plugin' | 'url' | 'search' | 'form_designer';
  source: string | null;
  table_name: string | null;
  pk_column: string | null;
  pk_item: string | null;
  columns: number;
  template: 'standard' | 'plain' | 'collapsible' | 'hero' | 'title_bar' | 'buttons_container' | 'inline_dialog' | 'inline_drawer' | 'wizard';
  condition: string | null;
  authz: string | null;
  config: Record<string, any>;
  /** a REST data source the region reads (its source, if any, is SQL over the CTE "rest") */
  rest_source?: string | null;
  /** (053) template options: CSS classes from REGION_OPTIONS (others are ignored) */
  template_options?: string[];
  /** (099) where the region shows: banner, breadcrumb, left, body (null), right or footer */
  position?: 'banner' | 'breadcrumb' | 'left' | 'body' | 'right' | 'footer' | null;
}

export type ItemType =
  | 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'radio'
  | 'checkbox' | 'switch' | 'hidden' | 'display' | 'password'
  | 'checkbox_group' | 'multiselect' | 'popup_lov' | 'email' | 'tel' | 'url' | 'color' | 'file' | 'location'
  | 'richtext' | 'markdown' | 'rating' | 'combobox' | 'daterange' | 'qrcode' | 'plugin'
  // (086) display image, geocoded address
  | 'image' | 'address';

export interface Item {
  id: number;
  /** (066) CSS classes from ITEM_OPTIONS */
  template_options?: string[];
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
  /** action = menu: links ({label, page, items}), submit requests ({label, request}) and dynamic actions ({label, action}, 124) */
  menu?: MenuEntry[] | null;
  /** a badge: static text with &ITEM. substitutions, or a query's first value (badge_query wins) */
  badge?: string | null;
  badge_query?: string | null;
  /** (053) template options: CSS classes from BUTTON_OPTIONS (others are ignored) */
  template_options?: string[];
  /** (099) a region button's position: create, edit, change, copy, help, up, previous, close, delete, next or region (null) */
  slot?: string | null;
}

export interface MenuEntry {
  label: string;
  page?: number;
  items?: Record<string, string>;
  request?: string;
  /** (124) runs the dynamic actions of event menu_entry for this name (instead of page or request) */
  action?: string;
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

/** (102) An application computation: like a page's, for every page of the application. */
export interface AppComputation extends Omit<Computation, 'point'> {
  point: 'after_authentication' | 'before_header' | 'after_submit';
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
  event: 'change' | 'click' | 'load' | 'dialog_closed'
    /** (085) */
    | 'after_refresh' | 'selection_change' | 'focus' | 'blur' | 'key_release' | 'before_submit' | 'custom'
    /** (124) a menu button's entry {"action": NAME} was chosen (trigger: entry or menu button names) */
    | 'menu_entry';
  trigger_element: string | null;
  condition_type: 'equals' | 'not_equals' | 'in_list' | 'is_null' | 'is_not_null' | null;
  condition_value: string | null;
  action: 'show' | 'hide' | 'enable' | 'disable' | 'set_value' | 'execute_sql' | 'refresh_region' | 'refresh_item' | 'alert' | 'submit'
    | 'set_focus' | 'add_class' | 'remove_class' | 'show_success' | 'show_error' | 'clear_errors' | 'ai_generate'
    /** (068) code: the name of a function a static file registered (pgkiln.actions.register) */
    | 'execute_javascript'
    /** (074) turn on push notifications on this device (app.js) */
    | 'push_subscribe'
    /** (069) code: the name of a dynamic action plug-in; config.attributes its attribute values */
    | 'plugin'
    /** (085) */
    | 'confirm' | 'close_dialog' | 'cancel_dialog' | 'clear' | 'open_region' | 'close_region' | 'download' | 'print' | 'current_position' | 'share'
    /** (124) a modal "please wait" overlay (message: its text) until remove_wait_popup or the next page */
    | 'wait_popup' | 'remove_wait_popup';
  affected_items: string | null;
  affected_region_id: number | null;
  code: string | null;
  items_to_submit: string | null;
  message: string | null;
  /** add_class / remove_class: space separated class names (checked by the database) */
  css_classes?: string | null;
  /** (069) a plug-in action's attribute values: {"attributes": {…}} */
  config?: Record<string, any> | null;
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
  type: 'form_dml' | 'grid_dml' | 'sql' | 'data_load' | 'invoke_api' | 'download' | 'chain' | 'workflow' | 'ai_generate' | 'plugin' | 'send_push' | 'send_email';
  region_id: number | null;
  code: string | null;
  config: Record<string, unknown> | null;
  point: 'submit' | 'load' | 'ajax';
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
  /** (068) static files (.js, .css) this page loads after the application's */
  static_includes: StaticInclude[];
  /** (077) ask before leaving the page with unsaved changes */
  warn_unsaved: boolean;
  /** (087) 'minimal': no header and navigation */
  page_template: 'standard' | 'minimal' | 'left_side_column' | 'right_side_column';
}

/** The static files a list of names refers to, in that order, with their version. */
const includes = (names: string, appId: string) =>
  `coalesce((select jsonb_agg(jsonb_build_object('name', f.name, 'v', floor(extract(epoch from f.updated_at))::bigint) order by u.o)
               from unnest(${names}) with ordinality u(n, o) join meta.static_file f on f.app_id = ${appId} and f.name = u.n), '[]')`;

// Components whose build option is excluded are left out here, so the runtime
// neither renders nor runs them (meta.build_option_on, migration 029).
const agg = (table: string, fk: string, parent: string, appId: string) =>
  `coalesce((select jsonb_agg(to_jsonb(x) order by x.seq, x.id) from ${table} x where x.${fk} = ${parent}.id and meta.build_option_on(${appId}, x.build_option)), '[]')`;

// No caching on purpose: edits made in the builder show up on the next request.
export async function loadApp(alias: string) {
  return runtime.one<App>(
    `select a.id, a.alias, a.name, a.version, a.home_page, a.authentication, a.access_control, a.sso_providers, a.local_login, a.remember_me_days, a.login_page, a.password_reset, a.session_group, a.ldap_directories, a.header_name, a.header_auto_create, a.logout_url, a.db_auth_roles, a.db_auth_member_of, a.custom_auth_function, a.custom_auth_code, a.custom_auth_post_code, a.nav_list, a.navbar_list, a.pwa, a.pwa_short_name, a.pwa_icon is not null as pwa_has_icon, a.pwa_offline_pages, a.pwa_offline_submit, a.pwa_push, a.db_role, a.debug, a.debug_level, a.theme,
            a.availability, a.availability_message, a.availability_users, a.feedback, a.error_function, a.session_warning_seconds, a.component_settings,
            a.language, a.languages, a.language_from, a.date_format, a.timestamp_format, a.time_zone, a.time_zone_auto, a.currency,
            coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'query', l.query, 'rest_source', l.rest_source)) from meta.lov l where l.app_id = a.id), '[]') as lovs,
            coalesce((select jsonb_agg(jsonb_build_object('page_no', p.page_no, 'name', p.name, 'title', p.title,
                       'parent_page', p.parent_page, 'mode', p.mode, 'authz', p.authz, 'requires_auth', p.requires_auth,
                       'dialog_position', p.dialog_position, 'dialog_size', p.dialog_size))
                        from meta.page p where p.app_id = a.id and meta.build_option_on(a.id, p.build_option)), '[]') as pages,
            ${agg('meta.nav_entry', 'app_id', 'a', 'a.id')} as nav,
            coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'type', s.type, 'value', s.value, 'error_message', s.error_message))
                        from meta.authz_scheme s where s.app_id = a.id), '[]') as authz_schemes,
            coalesce((select jsonb_agg(i.name) from meta.app_item i where i.app_id = a.id), '[]') as app_items,
            ${agg('meta.app_process', 'app_id', 'a', 'a.id')} as app_processes,
            ${agg('meta.app_computation', 'app_id', 'a', 'a.id')} as app_computations,
            coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'type', s.type, 'value', s.value)) from meta.shortcut s where s.app_id = a.id), '[]') as shortcuts,
            ${includes('a.static_includes', 'a.id')} as static_includes,
            coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'install_sql') from meta.plugin x where x.app_id = a.id), '[]') as plugins,
            coalesce((select jsonb_agg(jsonb_build_object('name', f.name, 'v', floor(extract(epoch from f.updated_at))::bigint))
                        from meta.static_file f where f.app_id = a.id and exists (select 1 from meta.plugin x where x.app_id = a.id and f.name = any (x.files))), '[]') as static_files
       from meta.app a
      where a.alias = $1`,
    [alias],
  );
}

export async function loadPage(appId: number, pageNo: number) {
  return runtime.one<Page>(
    `select p.id, p.app_id, p.page_no, p.name, p.title, p.requires_auth, p.parent_page, p.mode,
            p.protection, p.authz, p.warn_unsaved, p.page_template,
            ${agg('meta.region', 'page_id', 'p', 'p.app_id')} as regions,
            ${agg('meta.item', 'page_id', 'p', 'p.app_id')} as items,
            ${agg('meta.button', 'page_id', 'p', 'p.app_id')} as buttons,
            ${agg('meta.dynamic_action', 'page_id', 'p', 'p.app_id')} as dynamic_actions,
            ${agg('meta.validation', 'page_id', 'p', 'p.app_id')} as validations,
            ${agg('meta.process', 'page_id', 'p', 'p.app_id')} as processes,
            ${agg('meta.computation', 'page_id', 'p', 'p.app_id')} as computations,
            ${agg('meta.branch', 'page_id', 'p', 'p.app_id')} as branches,
            ${includes('p.static_includes', 'p.app_id')} as static_includes
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
