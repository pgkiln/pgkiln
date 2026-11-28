import { runtime } from './db.ts';
import { rememberUrlEpoch } from './security.ts';
import type { Plugin } from './runtime/plugins.ts';
import type { PagePosition } from './page-positions.ts';

export interface AuthzScheme {
  name: string;
  type: 'role' | 'sql';
  value: string;
  error_message: string;
  /** (133) step-up: passes only when the session's last second step is at most this many minutes old */
  mfa_minutes?: number | null;
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
  /** (sprint 193, migration 170) /a/<app>/<alias> opens the page */
  alias?: string;
}

/** (068) a static application file a page loads: its name and a version (for the browser cache) */
export interface StaticInclude {
  name: string;
  v: number;
  /** (141) a static workspace file (the name without #WORKSPACE_FILES#) */
  ws?: boolean;
}

/** (141) The prefix of a static workspace file in a list of files to load. */
export const WORKSPACE_FILES = '#WORKSPACE_FILES#';

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
  /** (sprint 248, MG-21) a query with p_username returning the stored password hash, checked by the server */
  custom_auth_hash_query: string | null;
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
  /** (189, sprint 231) the sign-in form offers "Remember username" (src/remember-username.ts) */
  remember_username?: boolean;
  /** (087) the page that replaces the built-in sign-in page */
  login_page: number | null;
  /** (087) offer "Forgot password?" (with an enabled mail service) */
  password_reset: boolean;
  /** (067) session sharing group (src/sharedlogin.ts) */
  session_group: string | null;
  /** (132) two-step sign-in for the application's users (src/account-mfa.ts) */
  mfa: 'off' | 'optional' | 'required' | 'roles';
  mfa_roles: string[];
  /** (133) a code by e-mail at the second step, for users with another factor */
  mfa_email: boolean;
  /** (173, sprint 199) users may sign in with a passkey alone (user-verified): src/runtime/passkey-signin.ts */
  passkey_signin?: boolean;
  /** (133) users create their own REST API token on My account */
  api_self_tokens: boolean;
  /** LDAP directories the password form checks after local accounts */
  ldap_directories: string[];
  /** Progressive Web App: installable, offline pages, offline form queue */
  pwa: boolean;
  pwa_short_name: string | null;
  pwa_has_icon: boolean;
  pwa_offline_pages: boolean;
  /** (168) fetch every navigation page for offline use, again after this many hours; null: off */
  pwa_prefetch_hours: number | null;
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
  /** (154) the notification bell in the header */
  notifications: boolean;
  /** (154) refresh the badges every so many seconds (null: never) */
  live_badges_s: number | null;
  /** (107) the application's version (Release 1.0), shown in its pages' footer */
  version: string | null;
  /** (085) schema.function(jsonb) returns jsonb that rewrites error messages; seconds of the session timeout warning */
  error_function: string | null;
  session_warning_seconds: number;
  /** (169) the application's own idle time (minutes) and maximum session length (hours); null: the instance's */
  session_idle_minutes: number | null;
  session_max_hours: number | null;
  /** (169) a page without sign-in that opens when a session has ended */
  session_timeout_page: number | null;
  /** (169) false: every sign-in goes to the home page */
  deep_linking: boolean;
  /** (169) raised by Expire bookmarks */
  url_epoch: number;
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
    /** (sprint 254, MG-32) 'full' or a maximum in px: see contentWidth() in src/runtime/styles.ts */
    content_width?: string;
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

export interface Region extends FromGlobal {
  id: number;
  seq: number;
  title: string | null;
  /** (0.31, 073) optional, unique on the page */
  static_id?: string | null;
  type: 'login' | 'report' | 'form' | 'chart' | 'cards' | 'static' | 'grid' | 'calendar' | 'dynamic' | 'facets' | 'tasks' | 'workflows' | 'map' | 'tree' | 'template_component' | 'smart_filters' | 'display_selector' | 'list' | 'data_reporter' | 'ai_assistant' | 'plugin' | 'url' | 'search' | 'form_designer' | 'classic_report' | 'breadcrumb' | 'help_text' | 'workflow_diagram' | 'json_form';
  source: string | null;
  table_name: string | null;
  pk_column: string | null;
  pk_item: string | null;
  columns: number;
  template: 'standard' | 'plain' | 'collapsible' | 'hero' | 'title_bar' | 'buttons_container' | 'inline_dialog' | 'inline_drawer' | 'wizard' | 'tabs_container' | 'flex_container';
  condition: string | null;
  /** (147) the condition's type (null: `condition` is SQL) and value */
  condition_type?: ConditionType | null;
  condition_value?: string | null;
  authz: string | null;
  config: Record<string, any>;
  /** a REST data source the region reads (its source, if any, is SQL over the CTE "rest") */
  rest_source?: string | null;
  /** (053) template options: CSS classes from REGION_OPTIONS (others are ignored) */
  template_options?: string[];
  /** (099, sprint 234) where the region shows: a display position of page-positions.ts (null: body) */
  position?: PagePosition | null;
  /** (172) the region this one sits in (a sub region, one level deep); it shows only where its parent shows */
  parent_id?: number | null;
  // (sprint 230, migration 188, AX-9..11) Layout, Appearance, Accessibility, Advanced, Header and Footer, Read Only,
  // Customization and Comments: see src/runtime/region-props.ts
  new_row?: boolean | null;
  grid_column?: number | null;
  row_css_classes?: string | null;
  column_css_classes?: string | null;
  column_attributes?: string | null;
  css_classes?: string | null;
  icon?: string | null;
  render_components?: 'above' | 'below' | null;
  use_landmark?: boolean | null;
  landmark_type?: string | null;
  landmark_label?: string | null;
  dom_id?: string | null;
  custom_attributes?: string | null;
  title_no_translate?: boolean | null;
  header_text?: string | null;
  footer_text?: string | null;
  readonly_type?: string | null;
  readonly_expr?: string | null;
  readonly_value?: string | null;
  customization?: 'shown' | 'hidden' | null;
  customization_name?: string | null;
  comments?: string | null;
}

export type ItemType =
  | 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'radio'
  | 'checkbox' | 'switch' | 'hidden' | 'display' | 'password'
  | 'checkbox_group' | 'multiselect' | 'popup_lov' | 'email' | 'tel' | 'url' | 'color' | 'file' | 'location'
  | 'richtext' | 'markdown' | 'rating' | 'combobox' | 'daterange' | 'qrcode' | 'plugin'
  | 'shuttle' | 'select_one' | 'select_many'
  // (086) display image, geocoded address
  | 'image' | 'address'
  // (151) image upload and autocomplete (presets of file and combobox, see presetItem), percent graph, display map
  | 'image_upload' | 'autocomplete' | 'percent_graph' | 'display_map'
  // (195) a signature pad: a file item whose value is a PNG drawn on a canvas (see presetItem)
  | 'signature';

export interface Item extends FromGlobal {
  id: number;
  /** (066) CSS classes from ITEM_OPTIONS */
  template_options?: string[];
  region_id: number | null;
  seq: number;
  name: string;
  label: string | null;
  /** (197, sprint 241 MG-10) Value Placeholder: the hint in an empty field, a select list's empty choice */
  placeholder?: string | null;
  type: ItemType;
  lov: string | null;
  source_column: string | null;
  default_value: string | null;
  required: boolean;
  help: string | null;
  readonly_condition: string | null;
  /** (147) a server-side condition: when false the item is not rendered and not accepted */
  condition_type?: ConditionType | null;
  condition_expr?: string | null;
  condition_value?: string | null;
  authz: string | null;
  config: Record<string, any>;
}

export interface Button extends FromGlobal {
  id: number;
  /** (sprint 259, migration 209; APEX: CSS Classes) */
  css_classes?: string | null;
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
  /** (147) the condition's type (null: `condition` is SQL) and value */
  condition_type?: ConditionType | null;
  condition_value?: string | null;
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
  /** (sprint 238, migration 194) redirect: the static id of an inline dialog region it opens (on its target page, else this one) */
  target_region?: string | null;
  /** (sprint 240, MG-7) a submit from a modal dialog page shows the dialog page again instead of closing it */
  stay_in_dialog?: boolean | null;
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

/** (147) The server-side condition types every component shares (meta.condition_ok). */
export const CONDITION_TYPES = [
  'sql', 'exists', 'not_exists', 'function_body',
  'request_in', 'request_not_in',
  'item_null', 'item_not_null', 'item_zero', 'item_not_zero', 'item_null_or_zero', 'item_not_null_or_zero',
  'item_equals', 'item_not_equals', 'item_equals_item', 'item_not_equals_item', 'item_in_list', 'item_not_in_list',
  'item_contains', 'item_contains_any',
  'page_in', 'page_not_in', 'page_is_dialog', 'page_is_not_dialog',
  'user_signed_in', 'user_public', 'language_in', 'language_not_in', 'always', 'never',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

/** A server-side condition (migrations 029, 147). */
export interface Condition {
  condition_type: ConditionType | null;
  condition_expr: string | null;
  condition_value: string | null;
}

export interface Computation extends Condition, FromGlobal {
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
  target_type: 'page' | 'url' | 'function' | 'app' | 'item';
  target_page: number | null;
  target_items: Record<string, string> | null;
  target_url: string | null;
  /** function: a PL/pgSQL body returning a path inside the application (migration 039) */
  target_function?: string | null;
  /** app: the alias of another application of this installation */
  target_app?: string | null;
  authz: string | null;
  /** (sprint 238, migration 194) the static id of an inline dialog region the target page opens */
  open_region?: string | null;
  /** (sprint 240, MG-7) in a modal dialog page: go to the target inside the dialog instead of closing it */
  stay_in_dialog?: boolean | null;
  /** (sprint 249, MG-22, migration 205) item: the item holding the target page (number or alias; APP_PREVIOUS_PAGE too) */
  target_item?: string | null;
  /** (sprint 249, MG-23) in a modal dialog page: the dialog closes and the page below goes to the target */
  in_page_below?: boolean | null;
}

export interface DynamicAction extends FromGlobal {
  id: number;
  seq: number;
  name: string;
  event: 'change' | 'click' | 'load' | 'dialog_closed'
    /** (085) */
    | 'after_refresh' | 'selection_change' | 'focus' | 'blur' | 'key_release' | 'before_submit' | 'custom'
    /** (124) a menu button's entry {"action": NAME} was chosen (trigger: entry or menu button names) */
    | 'menu_entry'
    /** (149) */
    | 'double_click' | 'key_down' | 'key_press' | 'mouse_enter' | 'mouse_leave' | 'select' | 'resize' | 'scroll' | 'page_unload' | 'before_refresh' | 'facets_change'
    /** (153) component events: trigger = the grid, calendar, map or tree region */
    | 'grid_row_init' | 'grid_save' | 'calendar_date_select' | 'calendar_view_change' | 'map_object_click' | 'map_change' | 'tree_selection_change' | 'timer';
  trigger_element: string | null;
  condition_type: 'equals' | 'not_equals' | 'in_list' | 'is_null' | 'is_not_null' | 'greater' | 'greater_equal' | 'less' | 'less_equal' | 'not_in_list'
    | 'contains' | 'not_contains' | 'contains_any' | 'all_not_null' | null;
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
    | 'wait_popup' | 'remove_wait_popup'
    /** (149) */
    | 'cancel_event' | 'set_style' | 'collapse_tree' | 'expand_tree' | 'show_ai_assistant' | 'trigger_geocoding' | 'open_report_dialog';
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
  /** (147) a server-side condition: when false the dynamic action isn't on the page */
  server_condition_type?: ConditionType | null;
  server_condition_expr?: string | null;
  server_condition_value?: string | null;
}

export interface Validation extends FromGlobal {
  id: number;
  name: string;
  item_name: string | null;
  /** (148) APEX's validation types (migration 148) */
  type: 'sql' | 'exists' | 'not_exists' | 'function_body' | 'function_error'
    | 'not_null' | 'not_null_or_zero' | 'not_zero' | 'no_spaces' | 'alphanumeric' | 'numeric' | 'valid_date' | 'valid_timestamp'
    | 'equals' | 'not_equals' | 'in_list' | 'not_in_list' | 'chars_only' | 'chars_any' | 'chars_none' | 'regex';
  expression: string | null;
  message: string;
  when_button: string | null;
  /** (148) an authorization scheme; Always execute (also for DELETE); where the error shows */
  authz?: string | null;
  always_execute?: boolean;
  display_location?: 'inline_and_notification' | 'inline' | 'notification' | null;
  /** (147) a server-side condition: when false the validation is skipped */
  condition_type?: ConditionType | null;
  condition_expr?: string | null;
  condition_value?: string | null;
}

export interface Process extends FromGlobal {
  id: number;
  name: string;
  type: 'form_dml' | 'grid_dml' | 'sql' | 'data_load' | 'invoke_api' | 'download' | 'chain' | 'workflow' | 'ai_generate' | 'plugin' | 'send_push' | 'send_email'
    /** (150) */
    | 'close_dialog' | 'clear_session_state' | 'reset_pagination' | 'user_preferences' | 'server_geocoding' | 'print_report'
    | 'human_task_create' | 'human_task_manage' | 'form_init'
    /** (154) */
    | 'send_notification';
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
  /** (sprint 238, migration 194) the static id of an inline dialog region the page that comes back opens after this ran */
  open_region?: string | null;
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
  /** (087) 'minimal': no header and navigation; (197) 'no_navigation': Standard without header, menu and title bar */
  page_template: 'standard' | 'minimal' | 'left_side_column' | 'right_side_column' | 'no_navigation';
  /** (140) the page's help text (Markdown), shown by a help_text region */
  help: string | null;
  /** (sprint 254, MG-32) 'full' or a maximum in px; null: the application's theme.content_width */
  content_width?: string | null;
  /** (sprint 229, AX-8) merged from the Global Page (page 0): its page id, Authorization and Page requires sign-in */
  global?: { page_id: number; authz: string | null; requires_auth: boolean; applied?: boolean };
}

/**
 * The static files a list of names refers to, in that order, with their version; (141) a name
 * #WORKSPACE_FILES#x is the file x of the application's workspace (meta.workspace_file_versions:
 * its own workspace's only). Missing files are left out.
 */
const includes = (names: string, appId: string) =>
  `coalesce((select jsonb_agg(x.j order by x.o) from (
       select u.o, case when u.n like '#WORKSPACE\\_FILES#%'
                        then (select jsonb_build_object('name', substr(u.n, 18), 'v', (w.v ->> substr(u.n, 18))::bigint, 'ws', true) where w.v ? substr(u.n, 18))
                        else (select jsonb_build_object('name', f.name, 'v', floor(extract(epoch from f.updated_at))::bigint) from meta.static_file f where f.app_id = ${appId} and f.name = u.n) end as j
         from unnest(${names}) with ordinality u(n, o)
         left join lateral (select meta.workspace_file_versions(${appId}) as v where exists (select 1 from unnest(${names}) z where z like '#WORKSPACE\\_FILES#%')) w on true
     ) x where x.j is not null), '[]')`;

// Components whose build option is excluded are left out here, so the runtime
// neither renders nor runs them (meta.build_option_on, migration 029).
const agg = (table: string, fk: string, parent: string, appId: string) =>
  `coalesce((select jsonb_agg(to_jsonb(x) order by x.seq, x.id) from ${table} x where x.${fk} = ${parent}.id and meta.build_option_on(${appId}, x.build_option)), '[]')`;

// No caching on purpose: edits made in the builder show up on the next request.
export async function loadApp(alias: string) {
  const app = await loadAppRow(alias);
  // (sprint 189) the URL checksums of this request sign with the application's current epoch (Expire bookmarks)
  if (app) rememberUrlEpoch(app.id, app.url_epoch);
  return app;
}

async function loadAppRow(alias: string) {
  return runtime.one<App>(
    `select a.id, a.alias, a.name, a.version, a.home_page, a.authentication, a.access_control, a.sso_providers, a.local_login, a.remember_me_days, a.remember_username, a.login_page, a.password_reset, a.session_group, a.mfa, a.mfa_roles, a.mfa_email, a.passkey_signin, a.api_self_tokens, a.ldap_directories, a.header_name, a.header_auto_create, a.logout_url, a.db_auth_roles, a.db_auth_member_of, a.custom_auth_function, a.custom_auth_code, a.custom_auth_post_code, a.custom_auth_hash_query, a.nav_list, a.navbar_list, a.pwa, a.pwa_short_name, a.pwa_icon is not null as pwa_has_icon, a.pwa_offline_pages, a.pwa_prefetch_hours, a.pwa_offline_submit, a.pwa_push, a.db_role, a.debug, a.debug_level, a.theme,
            a.availability, a.availability_message, a.availability_users, a.feedback, a.notifications, a.live_badges_s, a.error_function, a.session_warning_seconds, a.component_settings,
            a.session_idle_minutes, a.session_max_hours, a.session_timeout_page, a.deep_linking, a.url_epoch,
            a.language, a.languages, a.language_from, a.date_format, a.timestamp_format, a.time_zone, a.time_zone_auto, a.currency,
            coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'query', l.query, 'rest_source', l.rest_source)) from meta.lov l where l.app_id = a.id), '[]') as lovs,
            coalesce((select jsonb_agg(jsonb_build_object('page_no', p.page_no, 'name', p.name, 'title', p.title,
                       'parent_page', p.parent_page, 'mode', p.mode, 'authz', p.authz, 'requires_auth', p.requires_auth,
                       'dialog_position', p.dialog_position, 'dialog_size', p.dialog_size, 'alias', p.alias))
                        from meta.page p where p.app_id = a.id and meta.build_option_on(a.id, p.build_option)), '[]') as pages,
            ${agg('meta.nav_entry', 'app_id', 'a', 'a.id')} as nav,
            coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'type', s.type, 'value', s.value, 'error_message', s.error_message, 'mfa_minutes', s.mfa_minutes))
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

/**
 * (151, CD-5) APEX's item types that are presets of pgkiln's: an Image Upload is a file item for pictures (image/*,
 * cropping, a maximum size before upload), a Text Field with autocomplete a one-value combobox. The runtime sees the
 * preset (every file and list check applies); the builder and exports keep the type as chosen. (sprint 239) A Signature is
 * a file item that takes one PNG drawn on a pad.
 */
export function presetItem(i: Item): Item {
  if (i.type === 'image_upload')
    return { ...i, type: 'file', config: { accept: 'image/*', crop: 'free', max_px: 1600, ...(i.config ?? {}), preset: 'image_upload' } };
  // (sprint 239, MG-12) a signature: the PNG drawn on the pad is the file (at most 1 MB, one file, no cropping or resizing)
  if (i.type === 'signature') {
    const { crop: _crop, max_px: _px, capture: _cap, multiple: _m, ...rest } = (i.config ?? {}) as Record<string, unknown>;
    return { ...i, type: 'file', config: { ...rest, accept: 'image/png', max_mb: Math.min(Number(rest.max_mb) || 1, 1), preset: 'signature' } };
  }
  if (i.type === 'autocomplete') return { ...i, type: 'combobox', config: { ...(i.config ?? {}), multiple: false, preset: 'autocomplete' } };
  return i;
}

export async function loadPage(appId: number, pageNo: number) {
  const rows = await loadPageRows(appId, pageNo);
  const page = rows.find((p) => p.page_no === pageNo);
  // (sprint 229, AX-8) the Global Page's components are part of every other page
  const global = pageNo !== 0 ? rows.find((p) => p.page_no === 0) : undefined;
  if (page && global) mergeGlobalPage(page, global);
  if (page) page.items = page.items.map(presetItem);
  return page;
}

/** (sprint 229, AX-8) Marks a component that comes from the Global Page (page 0) on the page it is merged into. */
export interface FromGlobal {
  global_page?: true;
}

/**
 * (sprint 229, AX-8; APEX: Global Page) The Global Page's regions, items, buttons, dynamic actions, computations,
 * validations and processes added to a page, each marked global_page, in sequence order with the page's own (the
 * page's own first at the same sequence); branches stay the page's own. A page's own item or button wins over the
 * Global Page's of the same name. page.global keeps page 0's Authorization and Page requires sign-in, which decide in
 * applyGlobalGate (runtime/authz.ts) whether the user gets them at all.
 */
export function mergeGlobalPage(page: Page, global: Page) {
  const mark = <T extends object>(xs: T[]) => xs.map((x) => Object.assign(x, { global_page: true as const }));
  const merge = <T extends { seq: number; id: number } & FromGlobal>(own: T[], g: T[]) =>
    [...own, ...mark(g)].sort((a, b) => a.seq - b.seq || (a.global_page ? 1 : 0) - (b.global_page ? 1 : 0) || a.id - b.id);
  const itemNames = new Set(page.items.map((i) => i.name));
  const buttonNames = new Set(page.buttons.map((b) => b.name));
  page.global = { page_id: global.id, authz: global.authz, requires_auth: global.requires_auth };
  page.regions = merge(page.regions, global.regions);
  page.items = merge(page.items, global.items.filter((i) => !itemNames.has(i.name)));
  page.buttons = merge(page.buttons, global.buttons.filter((b) => !buttonNames.has(b.name)));
  page.dynamic_actions = merge(page.dynamic_actions, global.dynamic_actions);
  page.computations = merge(page.computations, global.computations);
  page.validations = merge(page.validations as (Validation & { seq: number })[], global.validations as (Validation & { seq: number })[]);
  page.processes = merge(page.processes as (Process & { seq: number })[], global.processes as (Process & { seq: number })[]);
  page.static_includes = [...page.static_includes, ...global.static_includes.filter((g) => !page.static_includes.some((x) => x.name === g.name && !!x.ws === !!g.ws))];
}

async function loadPageRows(appId: number, pageNo: number) {
  return (await runtime.query<Page>(
    `select p.id, p.app_id, p.page_no, p.name, p.title, p.requires_auth, p.parent_page, p.mode, p.alias,
            p.protection, p.authz, p.warn_unsaved, p.page_template, p.help, p.content_width,
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
      where p.app_id = $1 and p.page_no in ($2, 0) and meta.build_option_on(p.app_id, p.build_option)`,
    [appId, pageNo],
  )).rows;
}

/** The roles an account has in an application (resolved once, at sign-in). */
export async function accountRoles(appId: number, username: string) {
  const r = await runtime.one<{ roles: string[] }>('select meta.account_roles($1, $2) as roles', [appId, username]);
  return r?.roles ?? [];
}
